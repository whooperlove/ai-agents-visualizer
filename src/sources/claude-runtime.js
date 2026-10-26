/* Live Claude registry metadata is read without inspecting transcripts or process arguments. */
'use strict';

const ChildProcess = require('node:child_process');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const MAX_METADATA_BYTES = 16 * 1024;
const READ_CONCURRENCY = 8;
const PS_BATCH_SIZE = 256;
const MAX_PID = 2147483647;
const READ_FLAGS = Fs.constants.O_RDONLY | (Fs.constants.O_NOFOLLOW || 0) | (Fs.constants.O_NONBLOCK || 0);
const STATUSES = ['busy', 'idle', 'waiting', 'shell'];

function eachLimit(items, limit, iterator, callback)
{
    var index = 0;
    var active = 0;
    var completed = 0;
    var finished = false;
    function next()
    {
        if (finished)
        {
            return;
        }
        if (completed === items.length)
        {
            finished = true;
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
                completed += 1;
                setImmediate(next);
            });
        }
    }
    next();
}

function safeIdentifier(value)
{
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

function validTimestamp(value, now)
{
    return value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= now);
}

function statIdentity(stat)
{
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

/* The fd is opened without following links, and the stream reads at most the limit plus one byte. */
function readMetadata(filePath, callback)
{
    Fs.open(filePath, READ_FLAGS, function(error, fd)
    {
        if (error)
        {
            callback(null);
            return;
        }
        Fs.fstat(fd, function(error, stat)
        {
            if (error || !stat.isFile() || stat.nlink < 1 || stat.size > MAX_METADATA_BYTES)
            {
                Fs.close(fd, function() { callback(null); });
                return;
            }
            const chunks = [];
            const stream = Fs.createReadStream(filePath, { fd: fd, autoClose: true, start: 0, end: MAX_METADATA_BYTES });
            var finished = false;
            function finish(value)
            {
                if (!finished)
                {
                    finished = true;
                    callback(value);
                }
            }
            stream.on('data', function(chunk) { chunks.push(chunk); });
            stream.on('error', function() { finish(null); });
            stream.on('end', function()
            {
                const buffer = Buffer.concat(chunks);
                if (buffer.length > MAX_METADATA_BYTES)
                {
                    finish(null);
                    return;
                }
                var record = null;
                try
                {
                    record = JSON.parse(buffer.toString('utf8'));
                }
                catch (error)
                {
                    finish(null);
                    return;
                }
                finish({ record: record, identity: statIdentity(stat), digest: Crypto.createHash('sha256').update(buffer).digest('hex') });
            });
        });
    });
}

function collectFiles(roots, callback)
{
    const files = [];
    const directoryDic = Object.create(null);
    const claudeRoots = (Array.isArray(roots) ? roots : []).filter(function(root)
    {
        return root && root.provider === 'claude' && typeof root.path === 'string';
    });
    eachLimit(claudeRoots, READ_CONCURRENCY, function(root, next)
    {
        // Projects may be shared by profiles while their live registries remain separate.
        const directory = Path.join(Path.dirname(root.path), 'sessions');
        Fs.realpath(directory, function(error, canonical)
        {
            if (error || directoryDic[canonical])
            {
                next();
                return;
            }
            directoryDic[canonical] = true;
            Fs.readdir(canonical, { withFileTypes: true }, function(error, entries)
            {
                if (!error)
                {
                    entries.forEach(function(entry)
                    {
                        if (entry.isFile() && /^[1-9][0-9]*\.json$/.test(entry.name))
                        {
                            const pid = Number(entry.name.slice(0, -5));
                            if (Number.isSafeInteger(pid) && pid <= MAX_PID)
                            {
                                files.push({ path: Path.join(canonical, entry.name), pid: pid, account: safeIdentifier(root.account) });
                            }
                        }
                    });
                }
                next();
            });
        });
    }, function() { callback(files); });
}

function readCandidates(files, callback)
{
    const candidates = [];
    eachLimit(files, READ_CONCURRENCY, function(file, next)
    {
        readMetadata(file.path, function(snapshot)
        {
            const record = snapshot && snapshot.record;
            const now = Date.now();
            if (record && !Array.isArray(record) && record.pid === file.pid && safeIdentifier(record.sessionId) &&
                typeof record.procStart === 'string' && record.procStart.length > 0 && record.procStart.length <= 100 &&
                STATUSES.indexOf(record.status) !== -1 && validTimestamp(record.updatedAt, now) && validTimestamp(record.statusUpdatedAt, now))
            {
                candidates.push({
                    path: file.path, pid: file.pid, account: file.account, sessionId: record.sessionId,
                    status: record.status, procStart: record.procStart, identity: snapshot.identity, digest: snapshot.digest
                });
            }
            next();
        });
    }, function() { callback(candidates); });
}

function inspectProcesses(candidates, callback)
{
    const pidDic = Object.create(null);
    candidates.forEach(function(candidate) { pidDic[candidate.pid] = true; });
    const pids = Object.keys(pidDic);
    const batches = [];
    const processDic = Object.create(null);
    for (var index = 0; index < pids.length; index += PS_BATCH_SIZE)
    {
        batches.push(pids.slice(index, index + PS_BATCH_SIZE));
    }
    eachLimit(batches, 1, function(batch, next)
    {
        ChildProcess.execFile('/bin/ps', ['-p', batch.join(','), '-o', 'pid=,lstart='], {
            env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }),
            timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true
        }, function(error, stdout)
        {
            if (!error && typeof stdout === 'string')
            {
                const observedAt = new Date().toISOString();
                stdout.split('\n').forEach(function(line)
                {
                    const match = line.match(/^\s*([1-9][0-9]*)\s+(.+?)\s*$/);
                    if (match && pidDic[match[1]])
                    {
                        processDic[match[1]] = { procStart: match[2], observedAt: observedAt };
                    }
                });
            }
            next();
        });
    }, function() { callback(processDic); });
}

function readClaudeRuntime(roots, callback)
{
    collectFiles(roots, function(files)
    {
        readCandidates(files, function(candidates)
        {
            inspectProcesses(candidates, function(processDic)
            {
                const records = [];
                eachLimit(candidates, READ_CONCURRENCY, function(candidate, next)
                {
                    const processRecord = processDic[candidate.pid];
                    if (!processRecord || processRecord.procStart !== candidate.procStart)
                    {
                        next();
                        return;
                    }
                    // A registry removed or rewritten during the process check cannot authorize a state.
                    readMetadata(candidate.path, function(snapshot)
                    {
                        if (snapshot && snapshot.identity === candidate.identity && snapshot.digest === candidate.digest)
                        {
                            records.push({
                                sessionId: candidate.sessionId, pid: candidate.pid, status: candidate.status,
                                observedAt: processRecord.observedAt, path: candidate.path, account: candidate.account
                            });
                        }
                        next();
                    });
                }, function()
                {
                    records.sort(function(left, right) { return left.path.localeCompare(right.path); });
                    callback(null, records);
                });
            });
        });
    });
}

module.exports = { readClaudeRuntime: readClaudeRuntime };
