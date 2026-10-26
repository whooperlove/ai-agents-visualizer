'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const ChildProcess = require('node:child_process');
const Runtime = require('../src/sources/claude-runtime');

function processStart(pid)
{
    return ChildProcess.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' })
    }).trim();
}

function fixture(t)
{
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'claude-runtime-'));
    const procStart = processStart(process.pid);
    t.after(function() { Fs.rmSync(home, { recursive: true, force: true }); });
    function create(account, extra)
    {
        const root = { path: Path.join(home, account, 'projects'), provider: 'claude', account: account };
        const sessions = Path.join(home, account, 'sessions');
        const record = Object.assign({ sessionId: account, pid: process.pid, procStart: procStart, status: 'busy', updatedAt: Date.now(), statusUpdatedAt: Date.now() }, extra || {});
        const filePath = Path.join(sessions, String(record.pid) + '.json');
        Fs.mkdirSync(root.path, { recursive: true });
        Fs.mkdirSync(sessions, { recursive: true });
        Fs.writeFileSync(filePath, JSON.stringify(record));
        return { root: root, filePath: filePath, record: record };
    }
    return { home: home, procStart: procStart, create: create };
}

Test('verified live Claude runtime statuses expose only allowlisted metadata and a fresh observation', function(t, done)
{
    const f = fixture(t);
    const statuses = ['busy', 'idle', 'waiting', 'shell'];
    const files = statuses.map(function(status)
    {
        return f.create('runtime-' + status, {
            status: status, updatedAt: Date.now() - 10 * 60 * 1000, statusUpdatedAt: Date.now() - 10 * 60 * 1000,
            path: 'PRIVATE PATH', account: 'PRIVATE ACCOUNT', cwd: 'PRIVATE CWD', prompt: 'PRIVATE PROMPT', output: 'PRIVATE OUTPUT'
        });
    });
    const invalidPid = f.create('invalid-pid', { pid: Number.MAX_SAFE_INTEGER });
    const roots = files.map(function(file) { return file.root; }).concat([invalidPid.root]);
    const startedAt = Date.now();
    Runtime.readClaudeRuntime(roots, function(error, records)
    {
        Assert.ifError(error);
        Assert.equal(records.length, statuses.length);
        files.forEach(function(file, index)
        {
            const record = records.find(function(item) { return item.sessionId === file.record.sessionId; });
            Assert.deepEqual(Object.keys(record).sort(), ['account', 'observedAt', 'path', 'pid', 'sessionId', 'status']);
            Assert.equal(record.status, statuses[index]);
            Assert.equal(record.pid, process.pid);
            Assert.equal(record.account, file.root.account);
            Assert.equal(record.path, Fs.realpathSync(file.filePath));
            Assert.ok(Date.parse(record.observedAt) >= startedAt && Date.parse(record.observedAt) <= Date.now());
        });
        Assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
        done();
    });
});

Test('Claude runtime rejects invalid process generations, unsafe records and unverified activity', function(t, done)
{
    const f = fixture(t);
    const files = [
        f.create('wrong-generation', { procStart: 'Mon Jan  1 00:00:00 1990' }),
        f.create('missing-generation', { procStart: '' }),
        f.create('unsafe-session', { sessionId: '../../PRIVATE' }),
        f.create('unknown-status', { status: 'PRIVATE STATUS' }),
        f.create('alive-without-status', { status: null }),
        f.create('future-update', { updatedAt: Date.now() + 60 * 60 * 1000 }),
        f.create('invalid-status-time', { statusUpdatedAt: 'PRIVATE TIME' }),
        f.create('oversized', { padding: 'PRIVATE'.repeat(4000) }),
        f.create('wrong-filename'),
        f.create('symlink'),
        f.create('malformed')
    ];
    Fs.renameSync(files[8].filePath, Path.join(Path.dirname(files[8].filePath), String(process.pid + 1) + '.json'));
    const target = Path.join(f.home, 'runtime-target.json');
    Fs.renameSync(files[9].filePath, target);
    Fs.symlinkSync(target, files[9].filePath);
    Fs.writeFileSync(files[10].filePath, '{PRIVATE MALFORMED');
    Runtime.readClaudeRuntime(files.map(function(file) { return file.root; }), function(error, records)
    {
        Assert.ifError(error);
        Assert.deepEqual(records, []);
        done();
    });
});

Test('a Claude runtime record stops being verified when its process exits', function(t, done)
{
    const f = fixture(t);
    const child = ChildProcess.spawn(process.execPath, ['-e', 'setInterval(function() {}, 1000);'], { stdio: 'ignore' });
    t.after(function() { child.kill(); });
    child.once('error', done);
    child.once('spawn', function()
    {
        const file = f.create('child-process', { pid: child.pid, procStart: processStart(child.pid) });
        Runtime.readClaudeRuntime([file.root], function(error, records)
        {
            Assert.ifError(error);
            Assert.equal(records.length, 1);
            Assert.equal(records[0].pid, child.pid);
            child.once('exit', function()
            {
                Runtime.readClaudeRuntime([file.root], function(exitError, remaining)
                {
                    Assert.ifError(exitError);
                    Assert.deepEqual(remaining, []);
                    done();
                });
            });
            child.kill();
        });
    });
});
