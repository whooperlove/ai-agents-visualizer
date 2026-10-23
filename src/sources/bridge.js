/*
 * Read-only cross-agent bridge metadata collector.
 * Delivery bodies, previews, summaries, errors and environments never leave the parser.
 */
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const I18n = require('../i18n');

const DEFAULT_POLL_INTERVAL_MS = 3000;
const READ_CONCURRENCY = 12;
const DELIVERY_STATES = ['queued', 'delivering', 'awaiting-peer', 'delivered', 'failed', 'running', 'completed'];
const DELIVERY_KINDS = ['request', 'reply', 'failure-notice', 'progress-notice'];

function createBridgeCollector(config, onChange)
{
    const options = config || {};
    const home = options.home || Os.homedir();
    const root = Path.resolve(options.bridgeRoot || Path.join(home, '.cross-agent'));
    const registryPath = Path.join(root, 'registry.json');
    const deliveriesPath = Path.join(root, 'deliveries');
    const inFlightPath = Path.join(deliveriesPath, 'in-flight');
    const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const fileDic = Object.create(null);
    const watcherDic = Object.create(null);
    var current = { nodes: [], edges: [], diagnostics: [], stats: {} };
    var stopped = true;
    var scanning = false;
    var rescanRequested = false;
    var timer = null;
    var debounceTimer = null;
    var readsTotal = 0;
    var scansTotal = 0;
    var initialCallback = null;

    function snapshot()
    {
        return current;
    }

    function start(callback)
    {
        if (!stopped)
        {
            if (typeof callback === 'function') callback(null, current);
            return;
        }
        stopped = false;
        initialCallback = callback;
        timer = setInterval(requestScan, pollIntervalMs);
        if (timer.unref) timer.unref();
        scan();
    }

    function stop()
    {
        stopped = true;
        clearInterval(timer);
        clearTimeout(debounceTimer);
        timer = null;
        debounceTimer = null;
        Object.keys(watcherDic).forEach(function(directory)
        {
            watcherDic[directory].watcher.close();
            delete watcherDic[directory];
        });
    }

    function requestScan()
    {
        if (stopped) return;
        if (scanning)
        {
            rescanRequested = true;
            return;
        }
        scan();
    }

    function watchChanged()
    {
        if (stopped || debounceTimer) return;
        debounceTimer = setTimeout(function()
        {
            debounceTimer = null;
            requestScan();
        }, 30);
        if (debounceTimer.unref) debounceTimer.unref();
    }

    function refreshWatchers(callback)
    {
        const directories = [Path.dirname(root), root, deliveriesPath, inFlightPath];
        eachLimit(directories, READ_CONCURRENCY, function(directory, next)
        {
            Fs.stat(directory, function(error, stat)
            {
                const previous = watcherDic[directory];
                const signature = !error && stat.isDirectory() ? String(stat.dev) + ':' + stat.ino : null;
                if (previous && previous.signature !== signature)
                {
                    previous.watcher.close();
                    delete watcherDic[directory];
                }
                if (signature && !watcherDic[directory] && !stopped)
                {
                    try
                    {
                        const watcher = Fs.watch(directory, { persistent: false }, watchChanged);
                        watcherDic[directory] = { signature: signature, watcher: watcher };
                        watcher.on('error', function()
                        {
                            watcher.close();
                            if (watcherDic[directory] && watcherDic[directory].watcher === watcher)
                            {
                                delete watcherDic[directory];
                            }
                        });
                    }
                    catch (watchError)
                    {
                        // Polling remains available on filesystems without fs.watch support.
                    }
                }
                next();
            });
        }, callback);
    }

    function scan()
    {
        scanning = true;
        rescanRequested = false;
        const seenDic = Object.create(null);
        const discovered = [{ path: registryPath, kind: 'registry' }];
        const discoveryDiagnostics = [];
        var changed = scansTotal === 0;
        refreshWatchers(function()
        {
            eachLimit([deliveriesPath, inFlightPath], READ_CONCURRENCY, function(directory, next)
            {
                Fs.readdir(directory, { withFileTypes: true }, function(error, entries)
                {
                    if (error)
                    {
                        if (error.code !== 'ENOENT')
                        {
                            discoveryDiagnostics.push(diagnostic('directory-unreadable', directory, I18n.token('msg.bridge.directoryUnreadable')));
                        }
                        next();
                        return;
                    }
                    entries.forEach(function(entry)
                    {
                        if (entry.isFile() && entry.name.endsWith('.json'))
                        {
                            discovered.push({ path: Path.join(directory, entry.name), kind: 'delivery', finished: directory === deliveriesPath });
                        }
                    });
                    next();
                });
            }, function()
            {
                eachLimit(discovered, READ_CONCURRENCY, readEntry, finishScan);
            });
        });

        function readEntry(entry, next)
        {
            seenDic[entry.path] = true;
            Fs.stat(entry.path, function(error, stat)
            {
                if (error || !stat.isFile())
                {
                    if (fileDic[entry.path]) changed = true;
                    delete fileDic[entry.path];
                    if (error && error.code !== 'ENOENT')
                    {
                        discoveryDiagnostics.push(diagnostic('file-unreadable', entry.path, I18n.token('msg.bridge.metadataUnreadable')));
                    }
                    next();
                    return;
                }
                const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
                if (fileDic[entry.path] && fileDic[entry.path].signature === signature)
                {
                    next();
                    return;
                }
                changed = true;
                readsTotal += 1;
                Fs.readFile(entry.path, 'utf8', function(readError, contents)
                {
                    const cached = { signature: signature, kind: entry.kind, finished: entry.finished, data: null, diagnostics: [] };
                    fileDic[entry.path] = cached;
                    if (readError)
                    {
                        cached.diagnostics.push(diagnostic('file-unreadable', entry.path, I18n.token('msg.bridge.metadataUnreadable')));
                        next();
                        return;
                    }
                    try
                    {
                        const data = JSON.parse(contents);
                        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid metadata shape');
                        cached.data = entry.kind === 'registry' ? sanitizeRegistry(data) : sanitizeDelivery(data);
                        if (!cached.data) throw new Error('Invalid metadata shape');
                    }
                    catch (parseError)
                    {
                        // Parse errors can contain input excerpts; expose a fixed message only.
                        cached.diagnostics.push(diagnostic('invalid-json', entry.path, I18n.token('msg.bridge.invalidJson')));
                    }
                    next();
                });
            });
        }

        function finishScan()
        {
            Object.keys(fileDic).forEach(function(file)
            {
                if (!seenDic[file])
                {
                    delete fileDic[file];
                    changed = true;
                }
            });
            scansTotal += 1;
            const nextSnapshot = buildSnapshot(fileDic, discoveryDiagnostics, root);
            nextSnapshot.stats.readsTotal = readsTotal;
            nextSnapshot.stats.scansTotal = scansTotal;
            nextSnapshot.stats.lastScanAt = new Date().toISOString();
            if (JSON.stringify(nextSnapshot.diagnostics) !== JSON.stringify(current.diagnostics)) changed = true;
            if (nextSnapshot.stats.expiredLeases !== current.stats.expiredLeases) changed = true;
            current = nextSnapshot;
            scanning = false;
            if (!stopped && changed && typeof onChange === 'function') onChange(current);
            if (initialCallback)
            {
                const callback = initialCallback;
                initialCallback = null;
                callback(null, current);
            }
            if (!stopped && rescanRequested) requestScan();
        }
    }

    return { start: start, stop: stop, snapshot: snapshot };
}

///////////////////////////////////////////////////////////////////////////////

function sanitizeRegistry(data)
{
    const pins = [];
    ['claude', 'codex'].forEach(function(provider)
    {
        const providerPins = data.pins && data.pins[provider];
        if (!providerPins || typeof providerPins !== 'object') return;
        Object.keys(providerPins).forEach(function(directory)
        {
            const pin = providerPins[directory];
            if (!pin || typeof pin !== 'object') return;
            const id = metadataId(pin.session_id);
            if (!id) return;
            pins.push({ provider: provider, sessionId: id, cwd: metadataText(pin.cwd || directory, 2048), updatedAt: timestamp(pin.updated_at) });
        });
    });
    return { pins: pins };
}

/*
 * outbox.Job.describe() is persisted in deliveries/ and deliveries/in-flight/.
 * parent_delivery_id identifies the request answered by reply/progress/notice traffic.
 * summary, reply_preview, progress_note and error are deliberately excluded.
 */
function sanitizeDelivery(data)
{
    const id = metadataId(data.delivery_id);
    if (!id) return null;
    return {
        id: id,
        senderProvider: providerName(data.sender_agent),
        senderSessionId: metadataId(data.sender_session_id),
        targetProvider: providerName(data.target_agent),
        targetSessionId: metadataId(data.resolved_session_id || data.target_session_id),
        state: DELIVERY_STATES.indexOf(data.state) !== -1 ? data.state : 'unknown',
        kind: DELIVERY_KINDS.indexOf(data.kind) !== -1 ? data.kind : 'unknown',
        parentDeliveryId: metadataId(data.parent_delivery_id),
        returnDeliveryId: metadataId(data.return_delivery_id),
        requestId: metadataId(data.request_id),
        createdAt: timestamp(data.created_at),
        acceptedAt: timestamp(data.accepted_at),
        finishedAt: timestamp(data.finished_at),
        expiresAt: timestamp(data.expires_at),
        updatedAt: timestamp(data.updated_at),
        hasReply: typeof data.reply_length === 'number' && data.reply_length > 0,
        replyConfirmed: data.is_reply_confirmed_by_transcript === true,
        undelivered: data.is_undelivered === true
    };
}

function buildSnapshot(fileDic, discoveryDiagnostics, root)
{
    const nodeDic = Object.create(null);
    const deliveryDic = Object.create(null);
    const diagnostics = discoveryDiagnostics.slice();
    const edges = [];
    var deliveryFileCount = 0;
    Object.keys(fileDic).sort().forEach(function(file)
    {
        const entry = fileDic[file];
        entry.diagnostics.forEach(function(item) { diagnostics.push(item); });
        if (!entry.data) return;
        if (entry.kind === 'registry')
        {
            entry.data.pins.forEach(function(pin)
            {
                addNode(nodeDic, pin.provider, pin.sessionId, pin.cwd, { kind: 'bridge-registry', path: file, detail: 'session pin; updatedAt=' + printableTime(pin.updatedAt) });
            });
            return;
        }
        deliveryFileCount += 1;
        const previous = deliveryDic[entry.data.id];
        // Finished records are written before their in-flight counterpart is removed.
        if (!previous || (entry.finished && !previous.finished) ||
            (entry.finished === previous.finished && (entry.data.updatedAt || 0) > (previous.data.updatedAt || 0)))
        {
            deliveryDic[entry.data.id] = { data: entry.data, path: file, finished: entry.finished };
        }
    });
    var unresolvedEndpoints = 0;
    var expiredLeases = 0;
    Object.keys(deliveryDic).sort().forEach(function(id)
    {
        const entry = deliveryDic[id];
        const delivery = entry.data;
        const message = deliveryMessage(delivery);
        const source = { kind: 'bridge-delivery', path: entry.path, detail: deliveryDetail(delivery, message) };
        const fromResolved = Boolean(delivery.senderProvider && delivery.senderSessionId);
        const toResolved = Boolean(delivery.targetProvider && delivery.targetSessionId);
        const from = addNode(nodeDic, delivery.senderProvider, delivery.senderSessionId, '', source, id + ':sender');
        const to = addNode(nodeDic, delivery.targetProvider, delivery.targetSessionId, '', source, id + ':target');
        if (!fromResolved) unresolvedEndpoints += 1;
        if (!toResolved) unresolvedEndpoints += 1;
        if (message.expired) expiredLeases += 1;
        edges.push({
            id: 'bridge:' + id,
            from: from,
            to: to,
            type: 'collaboration',
            source: source,
            confidence: fromResolved && toResolved ? 'confirmed' : 'unresolved',
            requestId: delivery.parentDeliveryId || delivery.requestId || id,
            lastSeen: printableTime(delivery.finishedAt || delivery.acceptedAt || delivery.createdAt),
            status: delivery.state,
            message: message
        });
    });
    if (unresolvedEndpoints)
    {
        diagnostics.push(diagnostic('unresolved-endpoints', root, I18n.token('msg.bridge.unresolvedEndpoints', { count: unresolvedEndpoints })));
    }
    diagnostics.sort(function(left, right) { return (left.path + left.code).localeCompare(right.path + right.code); });
    return {
        nodes: Object.keys(nodeDic).sort().map(function(id) { return nodeDic[id]; }),
        edges: edges,
        diagnostics: diagnostics,
        stats: { files: Object.keys(fileDic).length, deliveryFiles: deliveryFileCount, deliveryRecords: edges.length, unresolvedEndpoints: unresolvedEndpoints, expiredLeases: expiredLeases }
    };
}

function addNode(nodeDic, provider, sessionId, cwd, source, unresolvedId)
{
    const resolved = Boolean(provider && sessionId);
    const id = resolved ? provider + ':' + sessionId : 'unresolved:bridge:' + unresolvedId;
    if (!nodeDic[id])
    {
        nodeDic[id] = {
            id: id,
            provider: provider || 'unknown',
            sessionId: sessionId || '',
            name: resolved ? sessionId : I18n.token('msg.bridge.unresolvedEndpointName'),
            cwd: cwd || '',
            project: cwd ? Path.basename(cwd) : '',
            kind: 'session',
            status: 'unknown',
            sources: []
        };
    }
    const node = nodeDic[id];
    if (cwd && !node.cwd)
    {
        node.cwd = cwd;
        node.project = Path.basename(cwd);
    }
    node.sources.push(source);
    return id;
}

function deliveryMessage(delivery)
{
    var outcome = 'none';
    if (delivery.kind === 'request')
    {
        if (delivery.replyConfirmed) outcome = 'transcript-confirmed';
        else if (delivery.hasReply) outcome = 'reply-recorded';
    }
    return {
        deliveryId: delivery.id,
        kind: delivery.kind,
        createdAt: delivery.createdAt === null ? null : printableTime(delivery.createdAt),
        acceptedAt: delivery.acceptedAt === null ? null : printableTime(delivery.acceptedAt),
        finishedAt: delivery.finishedAt === null ? null : printableTime(delivery.finishedAt),
        expiresAt: delivery.expiresAt === null ? null : printableTime(delivery.expiresAt),
        parentDeliveryId: delivery.parentDeliveryId,
        returnDeliveryId: delivery.returnDeliveryId,
        outcome: outcome,
        expired: hasExpiredLease(delivery)
    };
}

function deliveryDetail(delivery, message)
{
    const parts = ['deliveryId=' + delivery.id, 'kind=' + delivery.kind, 'recordedState=' + delivery.state];
    ['parentDeliveryId', 'returnDeliveryId', 'requestId'].forEach(function(key)
    {
        if (delivery[key]) parts.push(key + '=' + delivery[key]);
    });
    ['createdAt', 'acceptedAt', 'finishedAt', 'expiresAt'].forEach(function(key)
    {
        if (delivery[key] !== null) parts.push(key + '=' + printableTime(delivery[key]));
    });
    if (message.outcome !== 'none') parts.push('requestOutcome=' + message.outcome);
    if (delivery.undelivered) parts.push('undelivered=true');
    // An expired lease is evidence of stale metadata, never current work activity.
    if (message.expired) parts.push('lease=expired');
    return parts.join('; ');
}

function hasExpiredLease(delivery)
{
    return delivery.expiresAt !== null && delivery.finishedAt === null && delivery.expiresAt * 1000 < Date.now();
}

function providerName(value)
{
    return value === 'claude' || value === 'codex' ? value : null;
}

function metadataId(value)
{
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null;
}

function metadataText(value, limit)
{
    return typeof value === 'string' ? I18n.stripMarkers(value.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, limit) : '';
}

function timestamp(value)
{
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 8640000000000 ? value : null;
}

function printableTime(value)
{
    return value === null ? 'unknown' : new Date(value * 1000).toISOString();
}

function diagnostic(code, path, message)
{
    return { level: 'warning', source: 'bridge', code: code, path: path, message: message };
}

function eachLimit(items, limit, worker, callback)
{
    var index = 0;
    var active = 0;
    var completed = 0;
    if (!items.length)
    {
        callback();
        return;
    }
    function runNext()
    {
        while (active < limit && index < items.length)
        {
            const item = items[index];
            index += 1;
            active += 1;
            worker(item, function()
            {
                active -= 1;
                completed += 1;
                if (completed === items.length) callback();
                else runNext();
            });
        }
    }
    runNext();
}

module.exports = { createBridgeCollector: createBridgeCollector };
