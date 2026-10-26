/* Local session files are observed read-only; transcript bodies never leave this module. */
'use strict';

const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Reader = require('./reader');
const ClaudeRuntime = require('./claude-runtime');
const I18n = require('../i18n');

const DEFAULT_POLL_INTERVAL_MS = 3000;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const MAX_METADATA_BYTES = 128 * 1024;
const READ_CONCURRENCY = 8;
const TOOL_NAMES_LIMIT = 240;
// A message token percent-encodes its parameters, so a bounded text can still grow; the whole token must fit this size.
const EVIDENCE_TOKEN_LIMIT = 1200;

/* Cuts to the limit without leaving half a surrogate pair, which could not be encoded into a message token. */
function clip(text, limit)
{
    return text.slice(0, limit).replace(/[\ud800-\udbff]$/, '');
}

/* Observed text can never forge a message token: delimiters are replaced before the text goes anywhere. */
function safeText(value, limit)
{
    if (typeof value !== 'string')
    {
        return null;
    }
    return clip(I18n.stripMarkers(value.replace(/[\u0000-\u001f\u007f]/g, ' ').toWellFormed()).trim(), limit || 160) || null;
}

/* The tool names are bounded before they are tokenized, then shortened further until the whole token fits. */
function toolCallToken(names)
{
    var text = clip(names.join(', '), TOOL_NAMES_LIMIT);
    var token = I18n.token('msg.evidence.claudeToolCall', { names: text });
    while (token.length > EVIDENCE_TOKEN_LIMIT && text.length > 1)
    {
        text = clip(text, Math.floor(text.length * 0.75));
        token = I18n.token('msg.evidence.claudeToolCall', { names: text });
    }
    return token;
}

function safeIdentifier(value)
{
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

function eventTime(value)
{
    if (typeof value !== 'string' && typeof value !== 'number')
    {
        return null;
    }
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time > 0 && time <= Date.now() + 60000 ? new Date(time).toISOString() : null;
}

function readMetadataFile(filePath, callback)
{
    const chunks = [];
    const stream = Fs.createReadStream(filePath, { start: 0, end: MAX_METADATA_BYTES });
    var completed = false;
    stream.on('data', function(chunk)
    {
        chunks.push(chunk);
    });
    stream.on('error', function(error)
    {
        if (!completed)
        {
            completed = true;
            callback(error);
        }
    });
    stream.on('end', function()
    {
        if (completed)
        {
            return;
        }
        completed = true;
        const buffer = Buffer.concat(chunks);
        if (buffer.length > MAX_METADATA_BYTES)
        {
            const error = new Error('Metadata exceeds the bounded reader limit');
            error.code = 'EFBIG';
            callback(error);
            return;
        }
        callback(null, buffer.toString('utf8'));
    });
}

function eachSeries(items, iterator, callback)
{
    var index = 0;
    function next(error)
    {
        if (error || index >= items.length)
        {
            callback(error || null);
            return;
        }
        const item = items[index];
        index += 1;
        iterator(item, function(error)
        {
            setImmediate(next, error);
        });
    }
    next(null);
}

function eachLimit(items, limit, iterator, callback)
{
    var index = 0;
    var active = 0;
    var finished = 0;
    var complete = false;
    function launch()
    {
        if (complete)
        {
            return;
        }
        if (finished === items.length)
        {
            complete = true;
            callback();
            return;
        }
        while (active < limit && index < items.length)
        {
            const item = items[index];
            index += 1;
            active += 1;
            iterator(item, function()
            {
                active -= 1;
                finished += 1;
                setImmediate(launch);
            });
        }
    }
    launch();
}

function createSessionCollector(config, onChange)
{
    config = config || {};
    const home = config.home || Os.homedir();
    const codexRoot = config.codexRoot || Path.join(home, '.codex');
    const accountConfigPath = Path.join(home, '.config', 'claude-multi-accounts', 'claude-accounts.json');
    const pollIntervalMs = config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    var fileDic = Object.create(null);
    var diagnosticDic = Object.create(null);
    var indexDic = Object.create(null);
    // Names this running collector has actually seen per node. Large histories are only sampled at the head and tail,
    // so renames that happen while observing are remembered here and merged into the chain.
    const seenNameDic = Object.create(null);
    var accountAssignmentDic = Object.create(null);
    var claudeRuntime = [];
    var watchers = [];
    var watchingDic = Object.create(null);
    var timer = null;
    var debounceTimer = null;
    var running = false;
    var scanning = false;
    var scanAgain = false;
    var firstCallback = null;
    var lastSignature = null;
    var completedScans = 0;
    var lastScanAt = null;

    function addDiagnostic(diagnostic)
    {
        const key = diagnostic.code + ':' + diagnostic.path;
        diagnosticDic[key] = { code: diagnostic.code, path: diagnostic.path, provider: diagnostic.provider || null };
    }

    function clearFileDiagnostics(filePath)
    {
        Object.keys(diagnosticDic).forEach(function(key)
        {
            if (diagnosticDic[key].path === filePath)
            {
                delete diagnosticDic[key];
            }
        });
    }

    function watch(root)
    {
        if (!running || watchingDic[root])
        {
            return;
        }
        var watcher = null;
        try
        {
            watcher = Fs.watch(root, { recursive: true }, scheduleScan);
        }
        catch (error)
        {
            try
            {
                watcher = Fs.watch(root, scheduleScan);
            }
            catch (fallbackError)
            {
                addDiagnostic({ code: 'watch-unavailable', path: root });
                return;
            }
        }
        watchingDic[root] = true;
        watchers.push(watcher);
        watcher.on('error', function()
        {
            addDiagnostic({ code: 'watch-error', path: root });
        });
    }

    function scheduleScan()
    {
        if (!running || debounceTimer)
        {
            return;
        }
        debounceTimer = setTimeout(function()
        {
            debounceTimer = null;
            scan();
        }, 80);
    }

    function getRoots(callback)
    {
        const roots = [];
        if (Array.isArray(config.claudeRoots))
        {
            config.claudeRoots.forEach(function(root)
            {
                if (typeof root === 'string')
                {
                    roots.push({ path: root, provider: 'claude', account: accountForRoot(root) });
                }
                else if (root && typeof root.path === 'string')
                {
                    roots.push({ path: root.path, provider: 'claude', account: safeText(root.account) || accountForRoot(root.path) });
                }
            });
            addCodexRoots();
            return;
        }
        roots.push({ path: Path.join(home, '.claude', 'projects'), provider: 'claude', account: 'default' });
        Fs.readdir(Path.join(home, '.claude-accounts'), { withFileTypes: true }, function(error, entries)
        {
            if (!error)
            {
                entries.forEach(function(entry)
                {
                    if (entry.isDirectory() || entry.isSymbolicLink())
                    {
                        roots.push({ path: Path.join(home, '.claude-accounts', entry.name, 'projects'), provider: 'claude', account: I18n.stripMarkers(entry.name) });
                    }
                });
            }
            addCodexRoots();
        });
        function addCodexRoots()
        {
            roots.push({ path: Path.join(codexRoot, 'sessions'), provider: 'codex', account: null });
            callback(roots);
        }
    }

    function accountForRoot(root)
    {
        const match = root.match(/[/\\]\.claude-accounts[/\\]([^/\\]+)[/\\]projects[/\\]?$/);
        return match ? I18n.stripMarkers(match[1]) : 'default';
    }

    function classify(root, relativePath)
    {
        const parts = relativePath.split(Path.sep);
        const name = parts[parts.length - 1];
        if (root.provider === 'codex')
        {
            if (!/^rollout.*\.jsonl$/.test(name))
            {
                return null;
            }
            const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
            return { provider: 'codex', kind: 'rollout', sessionId: match ? match[1] : null };
        }
        if (parts.length === 2 && /\.jsonl$/.test(name))
        {
            return { provider: 'claude', kind: 'transcript', sessionId: I18n.stripMarkers(name.slice(0, -6)), project: I18n.stripMarkers(parts[0]) };
        }
        if (parts.length >= 3 && name === 'custom-title.json')
        {
            return { provider: 'claude', kind: 'title', sessionId: I18n.stripMarkers(parts[1]), project: I18n.stripMarkers(parts[0]) };
        }
        if (parts.length >= 4 && parts.indexOf('subagents') !== -1 && /^agent-.+\.(jsonl|meta\.json)$/.test(name))
        {
            var parentAgentId = null;
            parts.slice(2, -1).forEach(function(part)
            {
                if (/^agent-/.test(part))
                {
                    parentAgentId = I18n.stripMarkers(part.slice(6));
                }
            });
            return {
                provider: 'claude', kind: /\.meta\.json$/.test(name) ? 'agent-meta' : 'agent-transcript',
                sessionId: I18n.stripMarkers(parts[1]), agentId: I18n.stripMarkers(name.replace(/^agent-/, '').replace(/\.(meta\.json|jsonl)$/, '')),
                parentAgentId: parentAgentId, project: I18n.stripMarkers(parts[0])
            };
        }
        return null;
    }

    function discover(callback)
    {
        const foundDic = Object.create(null);
        const canonicalDic = Object.create(null);
        getRoots(function(roots)
        {
            eachSeries(roots, function(root, next)
            {
                Fs.realpath(root.path, function(error, canonical)
                {
                    if (error)
                    {
                        if (error.code !== 'ENOENT')
                        {
                            addDiagnostic({ code: 'root-unreadable', path: root.path, provider: root.provider });
                        }
                        next();
                        return;
                    }
                    if (!canonicalDic[canonical])
                    {
                        canonicalDic[canonical] = { path: canonical, aliases: [], provider: root.provider };
                    }
                    canonicalDic[canonical].aliases.push(root);
                    watch(canonical);
                    next();
                });
            }, function()
            {
                eachSeries(Object.keys(canonicalDic), function(canonical, next)
                {
                    const group = canonicalDic[canonical];
                    walk(group, '', foundDic, next);
                }, function()
                {
                    const indexPath = Path.join(codexRoot, 'session_index.jsonl');
                    Fs.stat(indexPath, function(error, stat)
                    {
                        if (!error && stat.isFile())
                        {
                            foundDic[indexPath] = { path: indexPath, provider: 'codex', kind: 'index', sources: [] };
                        }
                        Fs.stat(accountConfigPath, function(accountError, accountStat)
                        {
                            if (!accountError && accountStat.isFile())
                            {
                                foundDic[accountConfigPath] = { path: accountConfigPath, provider: 'claude', kind: 'accounts', sources: [] };
                                watch(Path.dirname(accountConfigPath));
                            }
                            callback(foundDic, roots);
                        });
                    });
                });
            });
        });
    }

    function walk(group, relativePath, foundDic, callback)
    {
        const directory = Path.join(group.path, relativePath);
        Fs.readdir(directory, { withFileTypes: true }, function(error, entries)
        {
            if (error)
            {
                addDiagnostic({ code: 'directory-unreadable', path: directory, provider: group.provider });
                callback();
                return;
            }
            eachSeries(entries, function(entry, next)
            {
                const relative = Path.join(relativePath, entry.name);
                if (entry.isDirectory())
                {
                    walk(group, relative, foundDic, next);
                    return;
                }
                if (!entry.isFile())
                {
                    next();
                    return;
                }
                const descriptor = classify(group, relative);
                if (descriptor)
                {
                    descriptor.path = Path.join(group.path, relative);
                    descriptor.sources = group.aliases.map(function(alias)
                    {
                        return { kind: descriptor.provider + '-' + descriptor.kind, path: Path.join(alias.path, relative), detail: alias.account ? 'observed root profile=' + alias.account : descriptor.kind, account: alias.account };
                    });
                    foundDic[descriptor.path] = descriptor;
                }
                next();
            }, callback);
        });
    }

    const NAME_HISTORY_LIMIT = 12;

    /* Keeps the newest observed name and the ordered, de-duplicated chain of earlier names for the same session. */
    function recordName(data, name)
    {
        if (!name)
        {
            return;
        }
        data.name = name;
        if (data.names[data.names.length - 1] !== name)
        {
            data.names.push(name);
            if (data.names.length > NAME_HISTORY_LIMIT * 2)
            {
                data.names.shift();
            }
        }
    }

    function mergeNameHistory(current, incoming)
    {
        const result = current ? current.slice() : [];
        (incoming || []).forEach(function(name)
        {
            if (name && result[result.length - 1] !== name)
            {
                result.push(name);
            }
        });
        return result;
    }

    /* Appends only the part of a later observation list that the chain does not already end with. */
    function appendObserved(chain, observed)
    {
        const result = (chain || []).slice();
        var overlap = Math.min(result.length, observed.length);
        while (overlap > 0 && !observed.slice(0, overlap).every(function(name, index) { return name === result[result.length - overlap + index]; }))
        {
            overlap -= 1;
        }
        return mergeNameHistory(result, observed.slice(overlap));
    }

    /* The chain always ends at the name now shown, and a single-name chain is dropped because it records no rename. */
    function finishNameHistory(chain, currentName)
    {
        const result = (chain || []).filter(function(name, index, list) { return name && name !== list[index - 1]; });
        if (currentName && result[result.length - 1] !== currentName)
        {
            result.push(currentName);
        }
        const trimmed = result.slice(-NAME_HISTORY_LIMIT);
        return trimmed.length > 1 ? trimmed : undefined;
    }

    function emptyData(descriptor)
    {
        return {
            names: [],
            sessionId: descriptor.sessionId || null, name: null, cwd: null, model: null, effort: null,
            description: null, parentId: descriptor.parentAgentId || null, spawnDepth: null,
            agent: Boolean(descriptor.agentId), lastSeen: null, status: 'unknown', statusEvidence: I18n.token('msg.evidence.noActivity')
        };
    }

    function setEvent(state, status, evidence, timestamp)
    {
        const time = eventTime(timestamp);
        if (!time || (state.data.lastSeen && time < state.data.lastSeen))
        {
            return;
        }
        state.data.lastSeen = time;
        state.data.status = status;
        state.data.statusEvidence = evidence;
    }

    function readClaudeRecord(state, record)
    {
        const data = state.data;
        data.cwd = safeText(record.cwd, 2048) || data.cwd;
        if (record.type === 'custom-title')
        {
            recordName(data, safeText(record.customTitle));
        }
        if (record.type === 'agent-name')
        {
            recordName(data, safeText(record.agentName));
        }
        data.model = safeText(record.requestedModel) || data.model;
        data.effort = safeText(record.effort || record.perTurnEffort, 40) || data.effort;
        if (safeIdentifier(record.parentAgentId))
        {
            data.parentId = record.parentAgentId;
        }
        if (Number.isInteger(record.spawnDepth))
        {
            data.spawnDepth = record.spawnDepth;
        }
        if (record.type === 'api-request')
        {
            setEvent(state, 'running', 'Claude api-request', record.timestamp);
        }
        // A queued prompt can be written to the transcript before the session actually consumes it.
        else if (record.type === 'user' && record.queueTranscriptOnly !== true)
        {
            setEvent(state, 'running', I18n.token('msg.evidence.claudeUserEvent'), record.timestamp);
        }
        else if (record.type === 'assistant' && record.message)
        {
            data.model = safeText(record.message.model) || data.model;
            const stopReason = record.message.stop_reason;
            if (stopReason === 'end_turn' || stopReason === 'stop_sequence')
            {
                setEvent(state, data.agent ? 'completed' : 'idle', 'Claude assistant ' + stopReason, record.timestamp);
            }
            else
            {
                const toolNames = Array.isArray(record.message.content) ? record.message.content.filter(function(block)
                {
                    return block && block.type === 'tool_use';
                }).map(function(block)
                {
                    return safeText(block.name, 80);
                }).filter(function(name)
                {
                    return Boolean(name);
                }) : [];
                const evidence = toolNames.length ? toolCallToken(toolNames) : stopReason === 'tool_use' ? I18n.token('msg.evidence.claudeAssistantToolUse') : I18n.token('msg.evidence.claudeAssistantEvent');
                setEvent(state, 'running', evidence, record.timestamp);
            }
        }
        else if (record.type === 'system' && /interrupt|abort/.test(record.subtype || ''))
        {
            setEvent(state, 'interrupted', I18n.token('msg.evidence.claudeInterrupted'), record.timestamp);
        }
    }

    function readCodexRecord(state, record)
    {
        const data = state.data;
        const payload = record.payload;
        if (!payload || typeof payload !== 'object')
        {
            return;
        }
        if (record.type === 'session_meta')
        {
            data.sessionId = safeIdentifier(payload.id || payload.session_id) || data.sessionId;
            data.cwd = safeText(payload.cwd, 2048) || data.cwd;
            recordName(data, safeText(payload.agent_nickname || payload.agent_name));
            const subagent = payload.source && typeof payload.source === 'object' ? payload.source.subagent : null;
            const spawn = subagent && typeof subagent === 'object' ? (subagent.thread_spawn || subagent.spawn || subagent) : null;
            data.parentId = safeIdentifier(payload.parent_thread_id || payload.parent_session_id || (spawn && (spawn.parent_thread_id || spawn.parent_session_id))) || data.parentId;
            if (spawn || payload.thread_source === 'subagent' || data.parentId)
            {
                data.agent = true;
            }
            if (spawn && Number.isInteger(spawn.depth))
            {
                data.spawnDepth = spawn.depth;
            }
            recordName(data, safeText(spawn && spawn.agent_nickname));
            data.description = safeText(payload.agent_path || (spawn && spawn.agent_path)) || data.description;
        }
        if (record.type === 'turn_context')
        {
            data.cwd = safeText(payload.cwd, 2048) || data.cwd;
            data.model = safeText(payload.model) || data.model;
            data.effort = safeText(payload.effort || payload.reasoning_effort, 40) || data.effort;
        }
        if (record.type === 'event_msg')
        {
            const type = payload.type;
            if (type === 'task_started' || type === 'turn_started')
            {
                setEvent(state, 'running', 'Codex ' + type, record.timestamp || payload.started_at);
            }
            else if (type === 'task_complete' || type === 'task_completed' || type === 'turn_complete' || type === 'turn_completed')
            {
                setEvent(state, data.agent ? 'completed' : 'idle', 'Codex ' + type, record.timestamp);
            }
            else if (type === 'turn_aborted' || type === 'task_interrupted' || type === 'turn_interrupted')
            {
                setEvent(state, 'interrupted', 'Codex ' + type, record.timestamp);
            }
            else if (type === 'approval_requested' || type === 'request_user_input')
            {
                setEvent(state, 'waiting', 'Codex ' + type, record.timestamp);
            }
        }
        if (record.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call'))
        {
            const waiting = /(^|[._])request_user_input$/.test(payload.name || '');
            const name = safeText(payload.name, 100);
            const callId = safeIdentifier(payload.call_id);
            if (callId && name)
            {
                state.toolNameDic[callId] = name;
            }
            setEvent(state, waiting ? 'waiting' : 'running', name ? I18n.token('msg.evidence.codexToolCall', { name: name }) : 'Codex ' + payload.type, record.timestamp);
        }
        if (record.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output'))
        {
            const callId = safeIdentifier(payload.call_id);
            const name = callId ? state.toolNameDic[callId] : null;
            setEvent(state, 'running', name ? I18n.token('msg.evidence.codexToolResult', { name: name }) : 'Codex ' + payload.type, record.timestamp);
            if (callId)
            {
                delete state.toolNameDic[callId];
            }
        }
        if (record.type === 'response_item' && payload.type === 'reasoning')
        {
            setEvent(state, 'running', I18n.token('msg.evidence.codexReasoning'), record.timestamp);
        }
        if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant')
        {
            const status = payload.phase === 'final_answer' ? (data.agent ? 'completed' : 'idle') : 'running';
            setEvent(state, status, I18n.token(payload.phase === 'final_answer' ? 'msg.evidence.codexFinalAnswer' : 'msg.evidence.codexAssistantEvent'), record.timestamp);
        }
    }

    function readIndexRecord(record)
    {
        const id = safeIdentifier(record.id || record.session_id);
        if (id)
        {
            const name = safeText(record.thread_name || record.title || record.name);
            const entry = indexDic[id] || { name: '', names: [] };
            if (name)
            {
                entry.name = name;
                if (entry.names[entry.names.length - 1] !== name)
                {
                    entry.names.push(name);
                }
            }
            indexDic[id] = entry;
        }
    }

    function readAccountAssignments(metadata)
    {
        accountAssignmentDic = Object.create(null);
        if (!metadata || typeof metadata !== 'object' || !metadata.profiles || !metadata.sessions)
        {
            return;
        }
        const profiles = Object.create(null);
        if (Array.isArray(metadata.profiles))
        {
            metadata.profiles.forEach(function(profile)
            {
                const id = profile && safeIdentifier(profile.id);
                if (id)
                {
                    profiles[id] = safeText(profile.name);
                }
            });
        }
        else if (typeof metadata.profiles === 'object')
        {
            Object.keys(metadata.profiles).forEach(function(id)
            {
                if (safeIdentifier(id))
                {
                    const profile = metadata.profiles[id];
                    profiles[id] = profile && typeof profile === 'object' ? safeText(profile.name) : null;
                }
            });
        }
        function accept(sessionId, value)
        {
            const profile = safeIdentifier(typeof value === 'string' ? value : value && value.profile);
            if (safeIdentifier(sessionId) && profile && Object.prototype.hasOwnProperty.call(profiles, profile))
            {
                accountAssignmentDic[sessionId] = { profile: profile, name: profiles[profile] };
            }
        }
        if (Array.isArray(metadata.sessions))
        {
            metadata.sessions.forEach(function(session)
            {
                if (session && typeof session === 'object')
                {
                    accept(session.id, session);
                }
            });
        }
        else if (typeof metadata.sessions === 'object')
        {
            Object.keys(metadata.sessions).forEach(function(id)
            {
                accept(id, metadata.sessions[id]);
            });
        }
    }

    function createFileState(descriptor)
    {
        const state = { descriptor: descriptor, data: emptyData(descriptor), reader: null, stamp: null, toolNameDic: Object.create(null) };
        if (descriptor.kind !== 'title' && descriptor.kind !== 'agent-meta' && descriptor.kind !== 'accounts')
        {
            state.reader = Reader.createJsonlReader(descriptor.path, {
                fullInitialRead: descriptor.kind === 'index',
                onRecord: function(record)
                {
                    if (descriptor.kind === 'index')
                    {
                        readIndexRecord(record);
                    }
                    else if (descriptor.provider === 'claude')
                    {
                        readClaudeRecord(state, record);
                    }
                    else
                    {
                        readCodexRecord(state, record);
                    }
                },
                onReset: function()
                {
                    state.data = emptyData(state.descriptor);
                    state.toolNameDic = Object.create(null);
                    clearFileDiagnostics(descriptor.path);
                    if (descriptor.kind === 'index')
                    {
                        indexDic = Object.create(null);
                    }
                },
                onDiagnostic: addDiagnostic
            });
        }
        return state;
    }

    function readMetadata(state, callback)
    {
        Fs.stat(state.descriptor.path, function(error, stat)
        {
            if (error)
            {
                callback(error);
                return;
            }
            const stamp = String(stat.ino) + ':' + stat.size + ':' + stat.mtimeMs;
            if (stamp === state.stamp)
            {
                callback();
                return;
            }
            if (stat.size > MAX_METADATA_BYTES)
            {
                addDiagnostic({ code: 'oversized-metadata', path: state.descriptor.path });
                if (state.descriptor.kind === 'accounts')
                {
                    accountAssignmentDic = Object.create(null);
                }
                callback();
                return;
            }
            readMetadataFile(state.descriptor.path, function(readError, text)
            {
                if (readError)
                {
                    if (state.descriptor.kind === 'accounts')
                    {
                        accountAssignmentDic = Object.create(null);
                    }
                    callback(readError);
                    return;
                }
                var metadata = null;
                try
                {
                    metadata = JSON.parse(text);
                }
                catch (parseError)
                {
                    addDiagnostic({ code: 'malformed-metadata', path: state.descriptor.path });
                    if (state.descriptor.kind === 'accounts')
                    {
                        accountAssignmentDic = Object.create(null);
                    }
                    callback();
                    return;
                }
                state.data = emptyData(state.descriptor);
                state.stamp = stamp;
                clearFileDiagnostics(state.descriptor.path);
                const data = state.data;
                if (state.descriptor.kind === 'accounts')
                {
                    readAccountAssignments(metadata);
                }
                else if (state.descriptor.kind === 'title')
                {
                    data.name = null;
                    recordName(data, safeText(typeof metadata === 'string' ? metadata : metadata && (metadata.customTitle || metadata.title || metadata.name)));
                }
                else if (metadata && typeof metadata === 'object')
                {
                    data.name = null;
                    recordName(data, safeText(metadata.agentName || metadata.name || metadata.agentType));
                    data.description = safeText(metadata.description);
                    data.model = safeText(metadata.model);
                    data.effort = safeText(metadata.effort, 40);
                    data.parentId = safeIdentifier(metadata.parentAgentId) || data.parentId;
                    data.spawnDepth = Number.isInteger(metadata.spawnDepth) ? metadata.spawnDepth : null;
                    if (metadata.stoppedByUser === true)
                    {
                        data.status = 'interrupted';
                        data.statusEvidence = I18n.token('msg.evidence.claudeAgentStopped');
                    }
                    else if (metadata.finished === true)
                    {
                        data.status = 'completed';
                        data.statusEvidence = I18n.token('msg.evidence.claudeAgentFinished');
                    }
                }
                callback();
            });
        });
    }

    function scan()
    {
        if (!running)
        {
            return;
        }
        if (scanning)
        {
            scanAgain = true;
            return;
        }
        scanning = true;
        discover(function(foundDic, roots)
        {
            ClaudeRuntime.readClaudeRuntime(roots, function(error, records)
            {
                if (!running)
                {
                    scanning = false;
                    return;
                }
                claudeRuntime = error ? [] : records;
                claudeRuntime.forEach(function(record) { watch(Path.dirname(record.path)); });
                readFound(foundDic);
            });
        });
        function readFound(foundDic)
        {
            if (!running)
            {
                scanning = false;
                return;
            }
            Object.keys(fileDic).forEach(function(filePath)
            {
                if (!foundDic[filePath])
                {
                    if (fileDic[filePath].reader)
                    {
                        fileDic[filePath].reader.stop();
                    }
                    if (fileDic[filePath].descriptor.kind === 'index')
                    {
                        indexDic = Object.create(null);
                    }
                    if (fileDic[filePath].descriptor.kind === 'accounts')
                    {
                        accountAssignmentDic = Object.create(null);
                    }
                    delete fileDic[filePath];
                    clearFileDiagnostics(filePath);
                }
            });
            eachLimit(Object.keys(foundDic), READ_CONCURRENCY, function(filePath, next)
            {
                if (!running)
                {
                    next();
                    return;
                }
                var state = fileDic[filePath];
                if (!state)
                {
                    state = createFileState(foundDic[filePath]);
                    fileDic[filePath] = state;
                }
                state.descriptor = foundDic[filePath];
                function finish(error)
                {
                    if (error && error.code !== 'ENOENT')
                    {
                        addDiagnostic({ code: 'file-unreadable', path: filePath, provider: state.descriptor.provider });
                    }
                    next();
                }
                if (state.reader)
                {
                    state.reader.poll(finish);
                }
                else
                {
                    readMetadata(state, finish);
                }
            }, function()
            {
                scanning = false;
                if (!running)
                {
                    return;
                }
                completedScans += 1;
                lastScanAt = new Date().toISOString();
                const result = snapshot();
                const signature = JSON.stringify({ nodes: result.nodes, edges: result.edges, diagnostics: result.diagnostics });
                if (signature !== lastSignature)
                {
                    lastSignature = signature;
                    if (typeof onChange === 'function')
                    {
                        onChange(result);
                    }
                }
                if (firstCallback)
                {
                    const callback = firstCallback;
                    firstCallback = null;
                    callback(null, result);
                }
                if (scanAgain)
                {
                    scanAgain = false;
                    setImmediate(scan);
                }
            });
        }
    }

    function snapshot()
    {
        const nodeDic = Object.create(null);
        const parentDic = Object.create(null);
        const runtimeDic = Object.create(null);
        const runtimeStatuses = { busy: 'running', idle: 'idle', waiting: 'waiting', shell: 'idle' };
        claudeRuntime.forEach(function(record)
        {
            if (Date.now() - Date.parse(record.observedAt) > Math.max(ACTIVE_WINDOW_MS, pollIntervalMs * 2))
            {
                return;
            }
            if (!runtimeDic[record.sessionId])
            {
                runtimeDic[record.sessionId] = [];
            }
            runtimeDic[record.sessionId].push(record);
        });
        const stats = { files: 0, nodes: 0, edges: 0, bytesRead: 0, skippedHistoryBytes: 0, malformedLines: 0, oversizedLines: 0, scans: completedScans, lastScanAt: lastScanAt, loading: completedScans === 0, scanning: scanning };
        Object.keys(fileDic).sort().forEach(function(filePath)
        {
            const state = fileDic[filePath];
            const descriptor = state.descriptor;
            const data = state.data;
            stats.files += 1;
            if (state.reader)
            {
                const readerStats = state.reader.snapshot();
                stats.bytesRead += readerStats.bytesRead;
                stats.skippedHistoryBytes += readerStats.skippedBytes;
                stats.malformedLines += readerStats.malformedLines;
                stats.oversizedLines += readerStats.oversizedLines;
            }
            if (descriptor.kind === 'index' || descriptor.kind === 'accounts' || !data.sessionId)
            {
                return;
            }
            const id = descriptor.provider + ':' + data.sessionId + (descriptor.agentId ? ':agent:' + descriptor.agentId : '');
            if (!nodeDic[id])
            {
                nodeDic[id] = {
                    id: id, provider: descriptor.provider, sessionId: data.sessionId,
                    name: null, cwd: null, project: descriptor.project || null, account: null,
                    kind: data.agent ? 'agent' : 'session', status: 'unknown', statusEvidence: I18n.token('msg.evidence.noActivity'),
                    lastSeen: null, model: null, effort: null, description: null, spawnDepth: null, sources: []
                };
            }
            const node = nodeDic[id];
            ['name', 'cwd', 'model', 'effort', 'description', 'spawnDepth'].forEach(function(key)
            {
                if (data[key] !== null && data[key] !== undefined)
                {
                    node[key] = data[key];
                }
            });
            const history = descriptor.provider === 'codex' && indexDic[data.sessionId] && indexDic[data.sessionId].name ? indexDic[data.sessionId].names : data.names;
            if (descriptor.provider === 'codex' && indexDic[data.sessionId] && indexDic[data.sessionId].name)
            {
                node.name = indexDic[data.sessionId].name;
            }
            node.nameHistory = mergeNameHistory(node.nameHistory, history);
            node.kind = data.agent ? 'agent' : node.kind;
            if ((data.lastSeen && (!node.lastSeen || data.lastSeen >= node.lastSeen)) ||
                (descriptor.kind === 'agent-meta' && (data.status === 'completed' || data.status === 'interrupted')))
            {
                node.status = data.status;
                node.statusEvidence = data.statusEvidence;
                node.lastSeen = data.lastSeen || node.lastSeen;
            }
            descriptor.sources.forEach(function(source)
            {
                if (!node.sources.some(function(existing) { return existing.path === source.path && existing.kind === source.kind; }))
                {
                    const assignment = descriptor.provider === 'claude' ? accountAssignmentDic[data.sessionId] : null;
                    const detail = descriptor.provider === 'claude' && !assignment ? 'account assignment unknown; ' + source.detail : source.detail;
                    node.sources.push({ kind: source.kind, path: source.path, detail: detail });
                }
            });
            if (data.parentId || data.agent || descriptor.agentId)
            {
                if (!parentDic[id])
                {
                    parentDic[id] = [];
                }
                parentDic[id].push({ descriptor: descriptor, data: data });
            }
        });
        const nodes = Object.keys(nodeDic).sort().map(function(id)
        {
            const node = nodeDic[id];
            const assignment = node.provider === 'claude' ? accountAssignmentDic[node.sessionId] : null;
            if (assignment)
            {
                node.account = assignment.profile;
                node.sources.push({ kind: 'claude-account-assignment', path: accountConfigPath, detail: 'session=' + node.sessionId + '; profile=' + assignment.profile + (assignment.name ? '; name=' + assignment.name : '') });
            }
            const agentId = node.id.indexOf(':agent:') !== -1 ? node.id.split(':agent:')[1] : node.sessionId;
            node.nameFallback = !node.name;
            node.name = node.name || (node.kind === 'agent' ? 'Agent ' + agentId.slice(0, 12) : 'Session ' + node.sessionId.slice(0, 8));
            if (!node.nameFallback)
            {
                const seen = seenNameDic[node.id] || (seenNameDic[node.id] = []);
                if (seen[seen.length - 1] !== node.name)
                {
                    seen.push(node.name);
                    if (seen.length > NAME_HISTORY_LIMIT)
                    {
                        seen.shift();
                    }
                }
                node.nameHistory = appendObserved(node.nameHistory, seen);
            }
            node.nameHistory = finishNameHistory(node.nameHistory, node.nameFallback ? null : node.name);
            const rootNode = node.provider === 'claude' && node.kind === 'agent' ? nodeDic['claude:' + node.sessionId] : null;
            if (!node.cwd && rootNode && rootNode.cwd)
            {
                node.cwd = rootNode.cwd;
            }
            var workspaceProject = null;
            if (node.cwd)
            {
                ['project', 'projects'].some(function(directory)
                {
                    const relative = Path.relative(Path.join(home, directory), node.cwd);
                    if (relative && !Path.isAbsolute(relative) && relative !== '..' && relative.indexOf('..' + Path.sep) !== 0)
                    {
                        workspaceProject = relative.split(Path.sep)[0];
                        return true;
                    }
                    return false;
                });
            }
            if (workspaceProject)
            {
                node.project = workspaceProject;
            }
            else if (node.project)
            {
                const encodedPrefix = Path.join(home, 'project').replace(/[/\\]/g, '-') + '-';
                if (node.project.indexOf(encodedPrefix) === 0)
                {
                    node.project = node.project.slice(encodedPrefix.length);
                }
                else if (node.cwd)
                {
                    node.project = Path.basename(node.cwd);
                }
            }
            else if (node.cwd)
            {
                node.project = Path.basename(node.cwd);
            }
            const liveRecords = node.provider === 'claude' && node.kind === 'session' ? runtimeDic[node.sessionId] || [] : [];
            const liveStatus = liveRecords.length ? runtimeStatuses[liveRecords[0].status] : null;
            if (liveStatus && liveRecords.every(function(record) { return runtimeStatuses[record.status] === liveStatus; }))
            {
                node.status = liveStatus;
                node.statusEvidence = liveRecords.map(function(record)
                {
                    return I18n.token('msg.evidence.claudeRuntimeStatus', { status: record.status, pid: String(record.pid) });
                }).join(' · ');
                liveRecords.forEach(function(record)
                {
                    if (!node.lastSeen || record.observedAt > node.lastSeen)
                    {
                        node.lastSeen = record.observedAt;
                    }
                    node.sources.push({ kind: 'claude-runtime', path: record.path, detail: I18n.token('msg.evidence.claudeRuntimeStatus', { status: record.status, pid: String(record.pid) }) });
                });
            }
            if (node.status === 'running' &&
                (!node.lastSeen || Date.now() - Date.parse(node.lastSeen) > ACTIVE_WINDOW_MS))
            {
                node.status = 'unknown';
                node.statusEvidence += ' · ' + I18n.token('msg.evidence.staleEvent');
            }
            return node;
        });
        const edges = [];
        Object.keys(parentDic).sort().forEach(function(id)
        {
            const candidates = parentDic[id];
            const explicit = candidates.filter(function(parent)
            {
                return Boolean(parent.data.parentId);
            });
            const depthMetadata = candidates.filter(function(parent)
            {
                return parent.data.spawnDepth !== null;
            });
            const selected = explicit.length ? explicit : depthMetadata.length ? depthMetadata : candidates;
            selected.forEach(function(parent)
            {
                const descriptor = parent.descriptor;
                const data = parent.data;
                var from = null;
                var confidence = 'confirmed';
                var detail = null;
                if (data.parentId)
                {
                    from = descriptor.provider === 'codex' ? 'codex:' + data.parentId : 'claude:' + data.sessionId + ':agent:' + data.parentId;
                    detail = descriptor.provider === 'codex' ? 'session_meta parent_thread_id / source.subagent.thread_spawn' : 'parentAgentId';
                }
                else if (descriptor.provider === 'claude' && (data.spawnDepth === null || data.spawnDepth <= 1))
                {
                    from = 'claude:' + data.sessionId;
                    confidence = 'inferred';
                    detail = I18n.token('msg.spawn.subagentsPath');
                }
                else
                {
                    from = descriptor.provider + ':' + data.sessionId + ':unknown-parent:' + (descriptor.agentId || 'subagent');
                    confidence = 'unresolved';
                    detail = I18n.token('msg.spawn.unknownParent', { depth: String(data.spawnDepth) });
                }
                if (from === id)
                {
                    confidence = 'unresolved';
                    detail = I18n.token('msg.spawn.selfReference', { detail: detail });
                }
                const sourceKey = descriptor.kind + ':' + encodeURIComponent(descriptor.path);
                edges.push({ id: 'spawn:' + from + ':' + id + ':' + sourceKey, from: from, to: id, type: 'spawn', source: { kind: descriptor.provider + '-' + descriptor.kind, path: descriptor.path, detail: detail }, confidence: confidence });
            });
        });
        stats.nodes = nodes.length;
        stats.edges = edges.length;
        return { nodes: nodes, edges: edges, diagnostics: Object.keys(diagnosticDic).sort().map(function(key) { return Object.assign({}, diagnosticDic[key]); }), stats: stats };
    }

    function start(callback)
    {
        if (running)
        {
            if (callback)
            {
                callback(null, snapshot());
            }
            return;
        }
        running = true;
        firstCallback = callback || null;
        timer = setInterval(scan, pollIntervalMs);
        scan();
    }

    function stop()
    {
        running = false;
        clearInterval(timer);
        clearTimeout(debounceTimer);
        timer = null;
        debounceTimer = null;
        watchers.forEach(function(watcher) { watcher.close(); });
        watchers = [];
        watchingDic = Object.create(null);
        Object.keys(fileDic).forEach(function(filePath)
        {
            if (fileDic[filePath].reader)
            {
                fileDic[filePath].reader.stop();
            }
        });
        fileDic = Object.create(null);
        accountAssignmentDic = Object.create(null);
        claudeRuntime = [];
    }

    return { start: start, stop: stop, snapshot: snapshot };
}

module.exports = { createSessionCollector: createSessionCollector };
