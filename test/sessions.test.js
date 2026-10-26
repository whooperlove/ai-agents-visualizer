'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const ChildProcess = require('node:child_process');
const Sessions = require('../src/sources/sessions');
const Reader = require('../src/sources/reader');
const I18n = require('./helpers/i18n').loadNodeI18n();

Test('stopping a large discovered queue does not recursively drain the stack', function(t, done)
{
    const f = fixture(t);
    const project = Path.join(f.claudeRoot, 'project');
    Fs.mkdirSync(project);
    for (var index = 0; index < 12000; index += 1)
    {
        Fs.writeFileSync(Path.join(project, 'stop-' + index + '.jsonl'), '');
    }
    const original = Reader.createJsonlReader;
    const collector = f.create();
    t.after(function() { Reader.createJsonlReader = original; });
    Reader.createJsonlReader = function()
    {
        return {
            poll: function(callback)
            {
                collector.stop();
                callback();
                setImmediate(done);
            },
            stop: function() {}
        };
    };
    collector.start(function() { done(new Error('A stopped collector must not finish startup')); });
});

Test('periodic reconciliation does not report initial loading again', function(t, done)
{
    const f = fixture(t);
    write(Path.join(f.claudeRoot, 'project', 'root.jsonl'), { type: 'user', timestamp: now() });
    const original = Reader.createJsonlReader;
    const collector = f.create();
    var initialized = false;
    var checked = false;
    t.after(function() { Reader.createJsonlReader = original; });
    Reader.createJsonlReader = function(path, options)
    {
        const reader = original(path, options);
        const poll = reader.poll;
        reader.poll = function(callback)
        {
            if (initialized && !checked)
            {
                checked = true;
                Assert.equal(collector.snapshot().stats.scanning, true);
                Assert.equal(collector.snapshot().stats.loading, false);
                poll(function(error) { callback(error); setImmediate(done); });
                return;
            }
            poll(callback);
        };
        return reader;
    };
    collector.start(function(error)
    {
        Assert.ifError(error);
        initialized = true;
    });
});

function fixture(t)
{
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'agent-sessions-'));
    const claudeRoot = Path.join(home, '.claude', 'projects');
    const codexRoot = Path.join(home, '.codex');
    Fs.mkdirSync(claudeRoot, { recursive: true });
    Fs.mkdirSync(Path.join(codexRoot, 'sessions'), { recursive: true });
    const collectors = [];
    t.after(function()
    {
        collectors.forEach(function(collector) { collector.stop(); });
        Fs.rmSync(home, { recursive: true, force: true });
    });
    function create(onChange)
    {
        const collector = Sessions.createSessionCollector({ home: home, claudeRoots: [claudeRoot], codexRoot: codexRoot, pollIntervalMs: 30 }, onChange);
        collectors.push(collector);
        return collector;
    }
    return { home: home, claudeRoot: claudeRoot, codexRoot: codexRoot, create: create, collectors: collectors };
}

function write(filePath, value)
{
    Fs.mkdirSync(Path.dirname(filePath), { recursive: true });
    Fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
}

function now()
{
    return new Date().toISOString();
}

function until(check, callback)
{
    const deadline = Date.now() + 4000;
    function poll()
    {
        try
        {
            if (check())
            {
                callback(null);
                return;
            }
        }
        catch (error)
        {
            callback(error);
            return;
        }
        if (Date.now() > deadline)
        {
            callback(new Error('Timed out waiting for the collector'));
            return;
        }
        setTimeout(poll, 15);
    }
    poll();
}

Test('Claude grandchildren retain their explicit parent, metadata and unresolved ancestry', function(t, done)
{
    const f = fixture(t);
    const root = Path.join(f.claudeRoot, 'project', 'root');
    write(root + '.jsonl', { type: 'user', timestamp: now(), cwd: '/work/project', message: { content: 'PRIVATE PROMPT' } });
    write(Path.join(root, 'custom-title.json'), { customTitle: 'Chosen title' });
    write(Path.join(root, 'subagents', 'agent-parent.jsonl'), { type: 'user', timestamp: now(), message: { content: 'PRIVATE CHILD PROMPT' } });
    write(Path.join(root, 'subagents', 'agent-parent.meta.json'), { spawnDepth: 1, model: 'model-a', effort: 'xhigh', description: 'Allowed metadata', finished: false });
    write(Path.join(root, 'subagents', 'agent-child.jsonl'), { type: 'assistant', timestamp: now(), message: { model: 'model-b', content: 'PRIVATE RESULT', stop_reason: 'end_turn' } });
    write(Path.join(root, 'subagents', 'agent-child.meta.json'), { parentAgentId: 'parent', spawnDepth: 2, finished: true });
    write(Path.join(root, 'subagents', 'agent-unknown.meta.json'), { spawnDepth: 3, stoppedByUser: true });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.stats.loading, false);
        Assert.equal(snapshot.nodes.length, 4);
        const child = snapshot.nodes.find(function(node) { return node.id === 'claude:root:agent:child'; });
        Assert.equal(child.status, 'completed');
        Assert.equal(child.spawnDepth, 2);
        Assert.equal(child.cwd, '/work/project');
        Assert.equal(child.project, 'project');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'claude:root:agent:unknown'; }).name, 'Agent unknown');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'claude:root:agent:unknown'; }).status, 'interrupted');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'claude:root'; }).name, 'Chosen title');
        const edge = snapshot.edges.find(function(item) { return item.to === child.id; });
        Assert.equal(edge.from, 'claude:root:agent:parent');
        Assert.equal(edge.confidence, 'confirmed');
        const unknownEdge = snapshot.edges.find(function(item) { return item.to === 'claude:root:agent:unknown'; });
        Assert.match(unknownEdge.from, /unknown-parent/);
        Assert.equal(unknownEdge.confidence, 'unresolved');
        Assert.equal(I18n.resolve(unknownEdge.source.detail, 'ko'), '하위 에이전트 기록은 있으나 부모 식별자 없음; spawnDepth=3');
        Assert.equal(I18n.resolve(unknownEdge.source.detail, 'en'), 'Sub-agent record exists but no parent identifier; spawnDepth=3');
        const stopped = snapshot.nodes.find(function(node) { return node.id === 'claude:root:agent:unknown'; });
        Assert.equal(I18n.resolve(stopped.statusEvidence, 'ko'), 'Claude agent 메타데이터 stoppedByUser=true');
        Assert.equal(I18n.resolve(stopped.statusEvidence, 'en'), 'Claude agent metadata stoppedByUser=true');
        const inferredEdge = snapshot.edges.find(function(item) { return item.to === 'claude:root:agent:parent'; });
        Assert.equal(inferredEdge.confidence, 'inferred');
        Assert.equal(I18n.resolve(inferredEdge.source.detail, 'ko'), '세션의 subagents 경로; 직접 부모 메타데이터 없음');
        Assert.equal(I18n.resolve(inferredEdge.source.detail, 'en'), 'Session subagents path; no direct parent metadata');
        Assert.equal(edge.source.detail, 'parentAgentId');
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        done();
    });
});

Test('Codex native parent metadata produces nested links, index names and factual recent status', function(t, done)
{
    const f = fixture(t);
    const rootId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';
    const grandchildId = '33333333-3333-3333-3333-333333333333';
    const ids = [rootId, childId, grandchildId];
    ids.forEach(function(id, index)
    {
        const parentId = index > 0 ? ids[index - 1] : null;
        const payload = { id: id, cwd: '/work/codex', base_instructions: 'SECRET INSTRUCTIONS', source: parentId ? { subagent: { thread_spawn: { parent_thread_id: parentId, depth: index, agent_nickname: 'Named agent' } } } : 'vscode' };
        const records = [
            { type: 'session_meta', timestamp: now(), payload: payload },
            { type: 'turn_context', payload: { model: 'gpt-model', effort: 'xhigh' } },
            { type: 'event_msg', timestamp: now(), payload: { type: index === 2 ? 'task_complete' : 'task_started' } }
        ];
        write(Path.join(f.codexRoot, 'sessions', '2026', 'rollout-' + id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    write(Path.join(f.codexRoot, 'session_index.jsonl'), { id: rootId, thread_name: 'Main task' });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, 3);
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'codex:' + rootId; }).name, 'Main task');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'codex:' + childId; }).status, 'running');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'codex:' + grandchildId; }).status, 'completed');
        Assert.equal(snapshot.edges.find(function(edge) { return edge.to === 'codex:' + grandchildId; }).from, 'codex:' + childId);
        Assert.equal(snapshot.nodes[0].model, 'gpt-model');
        Assert.doesNotMatch(JSON.stringify(snapshot), /SECRET INSTRUCTIONS/);
        done();
    });
});

Test('different physical account metadata preserves conflicting explicit parents and their sources', function(t, done)
{
    const f = fixture(t);
    const accountA = Path.join(f.home, '.claude-accounts', 'account-a', 'projects');
    const accountB = Path.join(f.home, '.claude-accounts', 'account-b', 'projects');
    const metaA = Path.join(accountA, 'project', 'root', 'subagents', 'agent-child.meta.json');
    const metaB = Path.join(accountB, 'project', 'root', 'subagents', 'agent-child.meta.json');
    write(metaA, { parentAgentId: 'parent-a', spawnDepth: 2 });
    write(metaB, { parentAgentId: 'parent-b', spawnDepth: 2 });
    write(Path.join(accountA, 'project', 'root', 'subagents', 'agent-child.jsonl'), { type: 'user', timestamp: now() });
    const collector = Sessions.createSessionCollector({ home: f.home, claudeRoots: [accountA, accountB], codexRoot: f.codexRoot, pollIntervalMs: 30 });
    f.collectors.push(collector);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, 1);
        Assert.equal(snapshot.nodes[0].sources.length, 3);
        const edges = snapshot.edges.filter(function(edge) { return edge.to === 'claude:root:agent:child'; });
        Assert.equal(edges.length, 2);
        Assert.deepEqual(edges.map(function(edge) { return edge.from; }).sort(), ['claude:root:agent:parent-a', 'claude:root:agent:parent-b']);
        Assert.deepEqual(edges.map(function(edge) { return edge.source.path; }).sort(), [Fs.realpathSync(metaA), Fs.realpathSync(metaB)].sort());
        Assert.equal(edges.every(function(edge) { return edge.confidence === 'confirmed'; }), true);
        Assert.equal(new Set(edges.map(function(edge) { return edge.id; })).size, 2);
        done();
    });
});

Test('incremental partial lines, malformed records, replacement and deletion update the collector', function(t, done)
{
    const f = fixture(t);
    const filePath = Path.join(f.claudeRoot, 'project', 'live.jsonl');
    write(filePath, '{bad json}\n{"type":"user","timestamp":');
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.stats.malformedLines, 1);
        Assert.equal(snapshot.nodes[0].status, 'unknown');
        Fs.appendFileSync(filePath, JSON.stringify(now()) + ',"cwd":"/new/project"}\n');
        until(function()
        {
            return collector.snapshot().nodes[0].status === 'running';
        }, function(waitError)
        {
            Assert.ifError(waitError);
            Fs.renameSync(filePath, filePath + '.old');
            write(filePath, { type: 'assistant', timestamp: now(), message: { stop_reason: 'end_turn' } });
            until(function()
            {
                const node = collector.snapshot().nodes[0];
                return node.status === 'idle' && node.cwd === null;
            }, function(rotationError)
            {
                Assert.ifError(rotationError);
                Fs.unlinkSync(filePath);
                until(function() { return collector.snapshot().nodes.length === 0; }, done);
            });
        });
    });
});

Test('old running events and fresh mtimes do not claim a live process; sources survive account aliases', function(t, done)
{
    const f = fixture(t);
    const filePath = Path.join(f.claudeRoot, 'project', 'old.jsonl');
    write(filePath, { type: 'user', timestamp: '2020-01-01T00:00:00.000Z', message: { content: 'PRIVATE' } });
    const accountRoot = Path.join(f.home, '.claude-accounts', 'biz', 'projects');
    Fs.mkdirSync(Path.dirname(accountRoot), { recursive: true });
    Fs.symlinkSync(f.claudeRoot, accountRoot, 'dir');
    const collector = Sessions.createSessionCollector({ home: f.home, pollIntervalMs: 30 });
    f.collectors.push(collector);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, 1);
        Assert.equal(snapshot.nodes[0].status, 'unknown');
        Assert.equal(snapshot.nodes[0].lastSeen, '2020-01-01T00:00:00.000Z');
        Assert.equal(snapshot.nodes[0].sources.length, 2);
        Assert.equal(snapshot.nodes[0].account, null);
        Assert.match(snapshot.nodes[0].sources[0].detail, /account assignment unknown/);
        Assert.equal(snapshot.stats.files, 1);
        done();
    });
});

Test('Claude queued-only user records preserve completed and running activity until execution starts', function(t, done)
{
    const f = fixture(t);
    const baseTime = Date.now();
    const completedAt = new Date(baseTime - 10 * 60 * 1000).toISOString();
    const expiredQueueAt = new Date(baseTime - 3 * 60 * 1000).toISOString();
    const runningAt = new Date(baseTime - 2000).toISOString();
    const queuedAt = new Date(baseTime - 1000).toISOString();
    const cases = [
        { id: 'queued-user', queuedAt: expiredQueueAt, resumedType: 'user' },
        { id: 'queued-api', queuedAt: queuedAt, resumedType: 'api-request' },
        { id: 'running-queue', queuedAt: queuedAt, running: true }
    ];
    cases.forEach(function(item)
    {
        const records = [{ type: 'assistant', timestamp: completedAt, message: { stop_reason: 'end_turn', content: 'PRIVATE RESPONSE' } }];
        if (item.running)
        {
            records.push({ type: 'api-request', timestamp: runningAt });
        }
        records.push({ type: 'user', timestamp: item.queuedAt, queueTranscriptOnly: true, message: { content: 'PRIVATE QUEUED PROMPT' } });
        write(Path.join(f.claudeRoot, 'project', item.id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, cases.length);
        cases.forEach(function(item)
        {
            const node = snapshot.nodes.find(function(node) { return node.id === 'claude:' + item.id; });
            Assert.equal(node.status, item.running ? 'running' : 'idle', item.id);
            Assert.equal(node.lastSeen, item.running ? runningAt : completedAt, item.id);
            Assert.equal(I18n.resolve(node.statusEvidence, 'en'), item.running ? 'Claude api-request' : 'Claude assistant end_turn', item.id);
        });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        const resumedAt = now();
        cases.filter(function(item) { return !item.running; }).forEach(function(item)
        {
            Fs.appendFileSync(Path.join(f.claudeRoot, 'project', item.id + '.jsonl'), JSON.stringify({ type: item.resumedType, timestamp: resumedAt, message: { content: 'PRIVATE EXECUTION PROMPT' } }) + '\n');
        });
        until(function()
        {
            return cases.every(function(item)
            {
                const node = collector.snapshot().nodes.find(function(node) { return node.id === 'claude:' + item.id; });
                return node.status === 'running' && node.lastSeen === (item.running ? runningAt : resumedAt);
            });
        }, function(resumeError)
        {
            Assert.ifError(resumeError);
            Assert.doesNotMatch(JSON.stringify(collector.snapshot()), /PRIVATE/);
            done();
        });
    });
});

Test('verified Claude runtime overrides stale root events and disappears without affecting child agents', function(t, done)
{
    const f = fixture(t);
    const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const root = Path.join(f.claudeRoot, 'project', 'runtime-root');
    write(root + '.jsonl', [
        { type: 'api-request', timestamp: oldAt },
        { type: 'user', timestamp: now(), queueTranscriptOnly: true, message: { content: 'PRIVATE QUEUED PROMPT' } }
    ].map(JSON.stringify).join('\n') + '\n');
    write(Path.join(root, 'subagents', 'agent-child.jsonl'), { type: 'api-request', timestamp: oldAt });
    write(Path.join(root, 'subagents', 'agent-child.meta.json'), { spawnDepth: 1 });
    const procStart = ChildProcess.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
        encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' })
    }).trim();
    const runtimePath = Path.join(Path.dirname(f.claudeRoot), 'sessions', String(process.pid) + '.json');
    const runtime = {
        pid: process.pid, sessionId: 'runtime-root', status: 'busy', procStart: procStart,
        updatedAt: Date.now(), statusUpdatedAt: Date.now(), prompt: 'PRIVATE RUNTIME PROMPT', path: 'PRIVATE PATH', cwd: 'PRIVATE CWD'
    };
    write(runtimePath, runtime);
    const observedAfter = Date.now();
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const node = snapshot.nodes.find(function(node) { return node.id === 'claude:runtime-root'; });
        Assert.equal(node.status, 'running');
        Assert.ok(Date.parse(node.lastSeen) >= observedAfter);
        Assert.match(I18n.resolve(node.statusEvidence, 'en'), /busy/);
        Assert.match(I18n.resolve(node.statusEvidence, 'en'), new RegExp(String(process.pid)));
        Assert.ok(node.sources.some(function(source) { return source.kind === 'claude-runtime' && source.path === Fs.realpathSync(runtimePath); }));
        checkChild(snapshot);
        const steps = [
            { extra: { status: 'idle' }, expected: 'idle' },
            { extra: { status: 'waiting' }, expected: 'waiting' },
            { extra: { status: 'shell' }, expected: 'idle' },
            { extra: { procStart: 'Mon Jan  1 00:00:00 1990' }, expected: 'unknown' },
            { extra: { status: 'busy' }, expected: 'running' },
            { remove: true, expected: 'unknown' }
        ];
        var index = 0;
        function advance()
        {
            if (index >= steps.length)
            {
                done();
                return;
            }
            const step = steps[index];
            index += 1;
            const changedAt = Date.now();
            if (step.remove)
            {
                Fs.unlinkSync(runtimePath);
            }
            else
            {
                write(runtimePath, Object.assign({}, runtime, step.extra));
            }
            until(function()
            {
                return collector.snapshot().nodes.find(function(node) { return node.id === 'claude:runtime-root'; }).status === step.expected;
            }, function(updateError)
            {
                Assert.ifError(updateError);
                const current = collector.snapshot();
                const parent = current.nodes.find(function(node) { return node.id === 'claude:runtime-root'; });
                Assert.equal(parent.sources.some(function(source) { return source.kind === 'claude-runtime'; }), step.expected !== 'unknown');
                if (step.expected === 'unknown')
                {
                    Assert.equal(parent.lastSeen, oldAt);
                }
                else
                {
                    Assert.ok(Date.parse(parent.lastSeen) >= changedAt);
                }
                checkChild(current);
                advance();
            });
        }
        advance();
    });
    function checkChild(snapshot)
    {
        const child = snapshot.nodes.find(function(node) { return node.id === 'claude:runtime-root:agent:child'; });
        Assert.equal(child.status, 'unknown');
        Assert.equal(child.lastSeen, oldAt);
        Assert.equal(child.sources.some(function(source) { return source.kind === 'claude-runtime'; }), false);
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
    }
});

Test('an exited Claude runtime process restores the stale transcript status', function(t, done)
{
    const f = fixture(t);
    const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    write(Path.join(f.claudeRoot, 'project', 'exited-runtime.jsonl'), { type: 'api-request', timestamp: oldAt });
    const child = ChildProcess.spawn(process.execPath, ['-e', 'setInterval(function() {}, 1000);'], { stdio: 'ignore' });
    t.after(function() { child.kill(); });
    child.once('error', done);
    child.once('spawn', function()
    {
        const procStart = ChildProcess.execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], {
            encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' })
        }).trim();
        write(Path.join(Path.dirname(f.claudeRoot), 'sessions', String(child.pid) + '.json'), {
            sessionId: 'exited-runtime', pid: child.pid, procStart: procStart, status: 'busy', statusUpdatedAt: Date.now(), updatedAt: Date.now()
        });
        const collector = f.create();
        collector.start(function(error, snapshot)
        {
            Assert.ifError(error);
            Assert.equal(snapshot.nodes[0].status, 'running');
            child.once('exit', function()
            {
                until(function() { return collector.snapshot().nodes[0].status === 'unknown'; }, function(exitError)
                {
                    Assert.ifError(exitError);
                    const node = collector.snapshot().nodes[0];
                    Assert.equal(node.lastSeen, oldAt);
                    Assert.equal(node.sources.some(function(source) { return source.kind === 'claude-runtime'; }), false);
                    done();
                });
            });
            child.kill();
        });
    });
});

Test('explicit session account assignments override two observed aliases and follow config edits and deletion', function(t, done)
{
    const f = fixture(t);
    const root = Path.join(f.claudeRoot, 'project', 'assigned');
    write(root + '.jsonl', { type: 'user', timestamp: now() });
    write(Path.join(root, 'subagents', 'agent-child.meta.json'), { spawnDepth: 1 });
    const accountRoot = Path.join(f.home, '.claude-accounts', 'biz', 'projects');
    Fs.mkdirSync(Path.dirname(accountRoot), { recursive: true });
    Fs.symlinkSync(f.claudeRoot, accountRoot, 'dir');
    const configPath = Path.join(f.home, '.config', 'claude-multi-accounts', 'claude-accounts.json');
    const profiles = { biz: { name: 'Business', verified_email: 'PRIVATE EMAIL', token: 'PRIVATE TOKEN' }, dev2: { name: 'Development' } };
    write(configPath, { profiles: profiles, sessions: { assigned: 'dev2' } });
    const collector = Sessions.createSessionCollector({ home: f.home, pollIntervalMs: 30 });
    f.collectors.push(collector);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, 2);
        snapshot.nodes.forEach(function(node)
        {
            Assert.equal(node.account, 'dev2');
            Assert.equal(node.sources.filter(function(source) { return /observed root profile/.test(source.detail); }).length, 2);
            Assert.equal(node.sources.filter(function(source) { return source.kind === 'claude-account-assignment'; }).length, 1);
        });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        write(configPath, { profiles: profiles, sessions: { assigned: { profile: 'biz' } } });
        until(function()
        {
            return collector.snapshot().nodes.every(function(node) { return node.account === 'biz'; });
        }, function(updateError)
        {
            Assert.ifError(updateError);
            Fs.unlinkSync(configPath);
            until(function()
            {
                return collector.snapshot().nodes.every(function(node)
                {
                    return node.account === null && node.sources.every(function(source) { return /account assignment unknown/.test(source.detail); });
                });
            }, function(deleteError)
            {
                Assert.ifError(deleteError);
                write(configPath, { profiles: profiles, sessions: { assigned: 'dev2' } });
                until(function()
                {
                    return collector.snapshot().nodes.every(function(node) { return node.account === 'dev2'; });
                }, done);
            });
        });
    });
});

Test('nested workspace cwd keeps the project name while the original cwd is preserved', function(t, done)
{
    const f = fixture(t);
    const cwd = Path.join(f.home, 'project', 'alpha', 'source_code', 'nested');
    const encoded = Path.join(f.home, 'project', 'alpha').replace(/[/\\]/g, '-');
    write(Path.join(f.claudeRoot, encoded, 'root.jsonl'), { type: 'user', timestamp: now(), cwd: cwd });
    write(Path.join(f.claudeRoot, encoded, 'root', 'subagents', 'agent-child.meta.json'), { spawnDepth: 1 });
    write(Path.join(f.codexRoot, 'sessions', 'rollout-codex.jsonl'), { type: 'session_meta', payload: { id: 'codex', cwd: Path.join(f.home, 'projects', 'other-project', 'tmp', 'foo') } });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const root = snapshot.nodes.find(function(node) { return node.id === 'claude:root'; });
        const child = snapshot.nodes.find(function(node) { return node.id === 'claude:root:agent:child'; });
        Assert.equal(root.project, 'alpha');
        Assert.equal(root.cwd, cwd);
        Assert.equal(child.project, 'alpha');
        Assert.equal(child.cwd, cwd);
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'codex:codex'; }).project, 'other-project');
        done();
    });
});

Test('tool names appear as sanitized status metadata without inputs, outputs or prompts', function(t, done)
{
    const f = fixture(t);
    write(Path.join(f.claudeRoot, 'project', 'tool.jsonl'), { type: 'assistant', timestamp: now(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read\nFile', input: { prompt: 'PRIVATE INPUT' } }, { type: 'text', text: 'PRIVATE RESPONSE' }] } });
    const records = [
        { type: 'session_meta', payload: { id: 'codex-tool' } },
        { type: 'response_item', timestamp: now(), payload: { type: 'function_call', call_id: 'call_1', name: 'functions.exec\ncommand', arguments: 'PRIVATE ARGUMENTS' } },
        { type: 'response_item', timestamp: now(), payload: { type: 'function_call_output', call_id: 'call_1', output: 'PRIVATE OUTPUT' } }
    ];
    write(Path.join(f.codexRoot, 'sessions', 'rollout-tool.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const claudeEvidence = snapshot.nodes.find(function(node) { return node.id === 'claude:tool'; }).statusEvidence;
        const codexEvidence = snapshot.nodes.find(function(node) { return node.id === 'codex:codex-tool'; }).statusEvidence;
        Assert.equal(I18n.resolve(claudeEvidence, 'ko'), 'Claude 도구 호출: Read File');
        Assert.equal(I18n.resolve(codexEvidence, 'ko'), 'Codex 도구 결과 이벤트: functions.exec command');
        Assert.equal(I18n.resolve(claudeEvidence, 'en'), 'Claude tool call: Read File');
        Assert.equal(I18n.resolve(codexEvidence, 'en'), 'Codex tool result event: functions.exec command');
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        done();
    });
});

Test('recent Codex function and custom tool activity refreshes an old task without exposing content', function(t, done)
{
    const f = fixture(t);
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const activeAt = new Date(Date.now() - 1000).toISOString();
    const cases = [
        { type: 'function_call', output: false },
        { type: 'function_call', output: true },
        { type: 'custom_tool_call', output: false },
        { type: 'custom_tool_call', output: true }
    ];
    cases.forEach(function(item, index)
    {
        const call = { type: item.type, call_id: 'call_' + index, name: 'functions.exec\ncommand' };
        call[item.type === 'function_call' ? 'arguments' : 'input'] = 'PRIVATE INPUT';
        const records = [
            { type: 'session_meta', payload: { id: 'tool-' + index } },
            { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started' } },
            { type: 'response_item', timestamp: activeAt, payload: call }
        ];
        if (item.output)
        {
            records.push({ type: 'response_item', timestamp: activeAt, payload: { type: item.type + '_output', call_id: call.call_id, output: 'PRIVATE OUTPUT' } });
        }
        write(Path.join(f.codexRoot, 'sessions', 'rollout-tool-' + index + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        cases.forEach(function(item, index)
        {
            const node = snapshot.nodes.find(function(node) { return node.id === 'codex:tool-' + index; });
            Assert.equal(node.status, 'running');
            Assert.equal(node.lastSeen, activeAt);
            Assert.equal(I18n.resolve(node.statusEvidence, 'en'), 'Codex tool ' + (item.output ? 'result event' : 'call') + ': functions.exec command');
        });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        done();
    });
});

Test('Codex reasoning and assistant messages refresh activity while final answers finish the correct node', function(t, done)
{
    const f = fixture(t);
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const activeAt = new Date(Date.now() - 1000).toISOString();
    const cases = [
        { id: 'reasoning', status: 'running', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE REASONING' }], encrypted_content: 'PRIVATE ENCRYPTED' } },
        { id: 'commentary', status: 'running', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'PRIVATE COMMENTARY' }] } },
        { id: 'final-root', status: 'idle', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'PRIVATE FINAL' }] } },
        { id: 'final-child', status: 'completed', parent: 'final-root', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'PRIVATE CHILD FINAL' }] } }
    ];
    cases.forEach(function(item)
    {
        const records = [
            { type: 'session_meta', payload: { id: item.id, parent_thread_id: item.parent } },
            { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started' } },
            { type: 'response_item', timestamp: activeAt, payload: item.payload }
        ];
        write(Path.join(f.codexRoot, 'sessions', 'rollout-' + item.id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        cases.forEach(function(item)
        {
            const node = snapshot.nodes.find(function(node) { return node.id === 'codex:' + item.id; });
            Assert.equal(node.status, item.status, item.id);
            Assert.equal(node.lastSeen, activeAt, item.id);
        });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        done();
    });
});

Test('Codex approval and user-input waits remain waiting until a new turn or tool result arrives', function(t, done)
{
    const f = fixture(t);
    const startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const waitingAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const cases = [
        { id: 'approval', recordType: 'event_msg', payload: { type: 'approval_requested' }, resumed: { type: 'event_msg', payload: { type: 'turn_started' } } },
        { id: 'input-event', recordType: 'event_msg', payload: { type: 'request_user_input' }, resumed: { type: 'event_msg', payload: { type: 'task_started' } } },
        { id: 'input-function', recordType: 'response_item', payload: { type: 'function_call', name: 'functions.request_user_input', call_id: 'function_input', arguments: 'PRIVATE QUESTION' }, resumed: { type: 'response_item', payload: { type: 'function_call_output', call_id: 'function_input', output: 'PRIVATE ANSWER' } } },
        { id: 'input-custom', recordType: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.request_user_input', call_id: 'custom_input', input: 'PRIVATE QUESTION' }, resumed: { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom_input', output: 'PRIVATE ANSWER' } } }
    ];
    cases.forEach(function(item)
    {
        const records = [
            { type: 'session_meta', payload: { id: item.id } },
            { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started' } },
            { type: item.recordType, timestamp: waitingAt, payload: item.payload }
        ];
        write(Path.join(f.codexRoot, 'sessions', 'rollout-' + item.id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        cases.forEach(function(item)
        {
            const node = snapshot.nodes.find(function(node) { return node.id === 'codex:' + item.id; });
            Assert.equal(node.status, 'waiting', item.id);
            Assert.equal(node.lastSeen, waitingAt, item.id);
        });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
        const resumedAt = now();
        cases.forEach(function(item)
        {
            item.resumed.timestamp = resumedAt;
            Fs.appendFileSync(Path.join(f.codexRoot, 'sessions', 'rollout-' + item.id + '.jsonl'), JSON.stringify(item.resumed) + '\n');
        });
        until(function()
        {
            return collector.snapshot().nodes.every(function(node) { return node.status === 'running' && node.lastSeen === resumedAt; });
        }, function(resumeError)
        {
            Assert.ifError(resumeError);
            Assert.doesNotMatch(JSON.stringify(collector.snapshot()), /PRIVATE/);
            done();
        });
    });
});

Test('incremental Codex custom tools and reasoning restore stale running sessions immediately', function(t, done)
{
    const f = fixture(t);
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const activeAt = new Date(Date.now() - 1000).toISOString();
    const cases = [
        { id: 'live-tool', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'live_call', input: 'PRIVATE INPUT' } },
        { id: 'live-reasoning', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE REASONING' }] } }
    ];
    cases.forEach(function(item)
    {
        const records = [
            { type: 'session_meta', payload: { id: item.id } },
            { type: 'event_msg', timestamp: startedAt, payload: { type: 'task_started' } }
        ];
        write(Path.join(f.codexRoot, 'sessions', 'rollout-' + item.id + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    });
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.length, cases.length);
        snapshot.nodes.forEach(function(node) { Assert.equal(node.status, 'unknown'); });
        cases.forEach(function(item)
        {
            Fs.appendFileSync(Path.join(f.codexRoot, 'sessions', 'rollout-' + item.id + '.jsonl'), JSON.stringify({ type: 'response_item', timestamp: activeAt, payload: item.payload }) + '\n');
        });
        until(function()
        {
            return collector.snapshot().nodes.every(function(node) { return node.status === 'running' && node.lastSeen === activeAt; });
        }, function(activityError)
        {
            Assert.ifError(activityError);
            const outputAt = now();
            Fs.appendFileSync(Path.join(f.codexRoot, 'sessions', 'rollout-live-tool.jsonl'), JSON.stringify({ type: 'response_item', timestamp: outputAt, payload: { type: 'custom_tool_call_output', call_id: 'live_call', output: 'PRIVATE OUTPUT' } }) + '\n');
            until(function()
            {
                const node = collector.snapshot().nodes.find(function(node) { return node.id === 'codex:live-tool'; });
                return node.status === 'running' && node.lastSeen === outputAt && I18n.resolve(node.statusEvidence, 'en') === 'Codex tool result event: functions.exec';
            }, function(outputError)
            {
                Assert.ifError(outputError);
                Assert.doesNotMatch(JSON.stringify(collector.snapshot()), /PRIVATE/);
                done();
            });
        });
    });
});

Test('JSONL reads use bounded head and tail regions, preserve UTF-8 fragments and reset after truncation', function(t, done)
{
    const f = fixture(t);
    const filePath = Path.join(f.home, 'bounded.jsonl');
    const middle = JSON.stringify({ ignored: 'x'.repeat(256) }) + '\n';
    write(filePath, JSON.stringify({ marker: 'head' }) + '\n' + middle.repeat(100) + JSON.stringify({ marker: 'tail' }) + '\n');
    const records = [];
    var resets = 0;
    const reader = Reader.createJsonlReader(filePath, { headBytes: 64, tailBytes: 64, onRecord: function(record) { records.push(record); }, onReset: function() { resets += 1; records.length = 0; } });
    t.after(function() { reader.stop(); });
    reader.poll(function(error)
    {
        Assert.ifError(error);
        Assert.equal(records[0].marker, 'head');
        Assert.equal(records[1].marker, 'tail');
        Assert.equal(reader.snapshot().bytesRead, 128);
        Assert.ok(reader.snapshot().skippedBytes > 25000);
        const line = Buffer.from(JSON.stringify({ marker: '한글' }) + '\n');
        const split = line.indexOf(Buffer.from('한')) + 1;
        Fs.appendFileSync(filePath, line.subarray(0, split));
        reader.poll(function(partialError)
        {
            Assert.ifError(partialError);
            Assert.equal(records.length, 2);
            Fs.appendFileSync(filePath, line.subarray(split));
            reader.poll(function(appendError)
            {
                Assert.ifError(appendError);
                Assert.equal(records[2].marker, '한글');
                write(filePath, { marker: 'reset' });
                reader.poll(function(resetError)
                {
                    Assert.ifError(resetError);
                    Assert.equal(resets, 1);
                    Assert.equal(records[0].marker, 'reset');
                    write(filePath, { marker: 'rewritten after truncate and regrowth', padding: 'x'.repeat(200) });
                    reader.poll(function(regrowthError)
                    {
                        Assert.ifError(regrowthError);
                        Assert.equal(resets, 2);
                        Assert.equal(records[0].marker, 'rewritten after truncate and regrowth');
                        done();
                    });
                });
            });
        });
    });
});

Test('a native metadata first line crossing the sampled header is completed within the line limit', function(t, done)
{
    const f = fixture(t);
    const filePath = Path.join(f.home, 'long-header.jsonl');
    const head = JSON.stringify({ type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent', base_instructions: 'x'.repeat(1000) } }) + '\n';
    const middle = JSON.stringify({ ignored: 'x'.repeat(100) }) + '\n';
    write(filePath, head + middle.repeat(200) + JSON.stringify({ tail: true }) + '\n');
    const records = [];
    const reader = Reader.createJsonlReader(filePath, { headBytes: 64, tailBytes: 64, onRecord: function(record) { records.push(record); } });
    t.after(function() { reader.stop(); });
    reader.poll(function(error)
    {
        Assert.ifError(error);
        Assert.equal(records[0].payload.parent_thread_id, 'parent');
        Assert.equal(records[1].tail, true);
        Assert.ok(reader.snapshot().skippedBytes > 20000);
        done();
    });
});

Test('only meaningful metadata changes emit updates, including title edits and newly discovered files', function(t, done)
{
    const f = fixture(t);
    const root = Path.join(f.claudeRoot, 'project', 'named');
    write(root + '.jsonl', { type: 'assistant', timestamp: now(), message: { stop_reason: 'end_turn' } });
    var changes = 0;
    const collector = f.create(function() { changes += 1; });
    collector.start(function(error)
    {
        Assert.ifError(error);
        const originalChanges = changes;
        setTimeout(function()
        {
            Assert.equal(changes, originalChanges);
            write(Path.join(root, 'custom-title.json'), { customTitle: 'New title' });
            write(Path.join(f.claudeRoot, 'project', 'other.jsonl'), { type: 'user', timestamp: now() });
            until(function()
            {
                const snapshot = collector.snapshot();
                return snapshot.nodes.length === 2 && snapshot.nodes.some(function(node) { return node.name === 'New title'; });
            }, done);
        }, 100);
    });
});

Test('a Claude session keeps its rename chain and follows a later rename of the same session ID', function(t, done)
{
    const f = fixture(t);
    const file = Path.join(f.claudeRoot, 'project', 'renamed') + '.jsonl';
    const title = function(name) { return JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: 'renamed' }); };
    write(file, [title('director'), title('director'), title('director-g01'), title('director'), JSON.stringify({ type: 'user', timestamp: now() })].join('\n') + '\n');
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const node = snapshot.nodes.find(function(item) { return item.sessionId === 'renamed'; });
        Assert.equal(node.name, 'director');
        Assert.deepEqual(node.nameHistory, ['director', 'director-g01', 'director']);
        Assert.equal(node.nameFallback, false);
        Fs.appendFileSync(file, title('director-g02') + '\n');
        until(function()
        {
            const current = collector.snapshot().nodes.find(function(item) { return item.sessionId === 'renamed'; });
            return current.name === 'director-g02' && current.nameHistory[current.nameHistory.length - 1] === 'director-g02';
        }, function(waitError)
        {
            Assert.ifError(waitError);
            const current = collector.snapshot().nodes.find(function(item) { return item.sessionId === 'renamed'; });
            Assert.deepEqual(current.nameHistory, ['director', 'director-g01', 'director', 'director-g02']);
            done();
        });
    });
});

Test('a Codex thread renamed in the session index shows the latest name and the whole chain', function(t, done)
{
    const f = fixture(t);
    const id = '44444444-4444-4444-4444-444444444444';
    write(Path.join(f.codexRoot, 'sessions', '2026', 'rollout-' + id + '.jsonl'), [
        { type: 'session_meta', timestamp: now(), payload: { id: id, cwd: '/work/codex' } },
        { type: 'event_msg', timestamp: now(), payload: { type: 'task_started' } }
    ].map(JSON.stringify).join('\n') + '\n');
    const index = Path.join(f.codexRoot, 'session_index.jsonl');
    write(index, [{ id: id, thread_name: 'thumb', updated_at: '2026-10-22T13:57:08Z' }, { id: id, thread_name: 'thumb-g01', updated_at: '2026-10-22T22:58:00Z' }].map(JSON.stringify).join('\n') + '\n');
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const node = snapshot.nodes.find(function(item) { return item.sessionId === id; });
        Assert.equal(node.name, 'thumb-g01');
        Assert.deepEqual(node.nameHistory, ['thumb', 'thumb-g01']);
        Fs.appendFileSync(index, JSON.stringify({ id: id, thread_name: 'thumb', updated_at: '2026-10-23T08:00:00Z' }) + '\n');
        until(function()
        {
            const current = collector.snapshot().nodes.find(function(item) { return item.sessionId === id; });
            return current.name === 'thumb' && current.nameHistory.length === 3;
        }, function(waitError)
        {
            Assert.ifError(waitError);
            Assert.deepEqual(collector.snapshot().nodes.find(function(item) { return item.sessionId === id; }).nameHistory, ['thumb', 'thumb-g01', 'thumb']);
            done();
        });
    });
});

Test('an untitled session reports a fallback label and no rename history', function(t, done)
{
    const f = fixture(t);
    write(Path.join(f.claudeRoot, 'project', 'untitled') + '.jsonl', { type: 'user', timestamp: now() });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        const node = snapshot.nodes.find(function(item) { return item.sessionId === 'untitled'; });
        Assert.equal(node.nameFallback, true);
        Assert.equal(node.nameHistory, undefined);
        done();
    });
});

Test('a rename observed while running is remembered even when the sampled history cannot show it', function(t, done)
{
    const f = fixture(t);
    const file = Path.join(f.claudeRoot, 'project', 'live') + '.jsonl';
    const title = function(name) { return JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: 'live' }); };
    write(file, [title('lead'), JSON.stringify({ type: 'user', timestamp: now() })].join('\n') + '\n');
    const collector = f.create();
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.nodes.find(function(item) { return item.sessionId === 'live'; }).nameHistory, undefined);
        write(Path.join(f.claudeRoot, 'project', 'live', 'custom-title.json'), { customTitle: 'lead-g01' });
        until(function()
        {
            const current = collector.snapshot().nodes.find(function(item) { return item.sessionId === 'live'; });
            return current.name === 'lead-g01' && current.nameHistory && current.nameHistory.length === 2;
        }, function(waitError)
        {
            Assert.ifError(waitError);
            Assert.deepEqual(collector.snapshot().nodes.find(function(item) { return item.sessionId === 'live'; }).nameHistory, ['lead', 'lead-g01']);
            write(Path.join(f.claudeRoot, 'project', 'live', 'custom-title.json'), { customTitle: 'lead' });
            until(function()
            {
                const current = collector.snapshot().nodes.find(function(item) { return item.sessionId === 'live'; });
                return current.name === 'lead' && current.nameHistory.length === 3;
            }, function(secondError)
            {
                Assert.ifError(secondError);
                Assert.deepEqual(collector.snapshot().nodes.find(function(item) { return item.sessionId === 'live'; }).nameHistory, ['lead', 'lead-g01', 'lead']);
                done();
            });
        });
    });
});

Test('evidence is a message token that renders per language, including the stale-event note', function(t, done)
{
    const f = fixture(t);
    write(Path.join(f.claudeRoot, 'project', 'old') + '.jsonl', { type: 'user', timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    write(Path.join(f.claudeRoot, 'project', 'titled', 'custom-title.json'), { customTitle: 'Only a title' });
    write(Path.join(f.claudeRoot, 'project', 'stop') + '.jsonl', [
        { type: 'user', timestamp: now() },
        { type: 'system', subtype: 'interrupt', timestamp: now() }
    ].map(JSON.stringify).join('\n') + '\n');
    write(Path.join(f.claudeRoot, 'project', 'plain') + '.jsonl', { type: 'assistant', timestamp: now(), message: { stop_reason: 'tool_use', content: [] } });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        function evidence(sessionId, locale) { return I18n.resolve(snapshot.nodes.find(function(node) { return node.sessionId === sessionId; }).statusEvidence, locale); }
        const old = snapshot.nodes.find(function(node) { return node.sessionId === 'old'; });
        Assert.equal(old.status, 'unknown');
        Assert.equal(evidence('old', 'ko'), 'Claude user 이벤트 이후 응답 진행 · 2분 이상 지난 이벤트, 현재 상태 미확인');
        Assert.equal(evidence('old', 'en'), 'Claude response in progress after a user event · event older than 2 minutes, current status unknown');
        Assert.equal(evidence('titled', 'ko'), '활동 이벤트 없음');
        Assert.equal(evidence('titled', 'en'), 'No activity events');
        Assert.equal(evidence('stop', 'ko'), 'Claude 중단 이벤트');
        Assert.equal(evidence('stop', 'en'), 'Claude interrupt event');
        Assert.equal(evidence('plain', 'ko'), 'Claude assistant 이벤트 (tool_use)');
        Assert.equal(evidence('plain', 'en'), 'Claude assistant event (tool_use)');
        done();
    });
});

Test('text from transcripts and file names cannot forge a message token', function(t, done)
{
    const f = fixture(t);
    const forged = '⟦msg.node.noIdentifier⟧';
    write(Path.join(f.claudeRoot, 'project', 'forge') + '.jsonl', [
        { type: 'custom-title', customTitle: 'Name ' + forged },
        { type: 'assistant', timestamp: now(), cwd: '/work/' + forged, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Tool' + forged }] } }
    ].map(JSON.stringify).join('\n') + '\n');
    write(Path.join(f.claudeRoot, 'project', 'file' + forged) + '.jsonl', { type: 'user', timestamp: now() });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        const node = snapshot.nodes.find(function(item) { return item.sessionId === 'forge'; });
        Assert.equal(node.name, 'Name [msg.node.noIdentifier]');
        Assert.equal(node.cwd, '/work/[msg.node.noIdentifier]');
        Assert.equal(I18n.resolve(node.statusEvidence, 'en'), 'Claude tool call: Tool[msg.node.noIdentifier]');
        Assert.ok(snapshot.nodes.some(function(item) { return item.id === 'claude:file[msg.node.noIdentifier]'; }));
        snapshot.nodes.forEach(function(item)
        {
            ['id', 'sessionId', 'name', 'cwd', 'project'].forEach(function(field) { Assert.equal(String(item[field]).includes('⟦'), false, field + ' must not carry a token delimiter'); });
            item.sources.forEach(function(source) { Assert.equal(String(source.detail).includes(forged), false); });
        });
        done();
    });
});

Test('long, non-ASCII or malformed tool names keep the evidence token whole', function(t, done)
{
    const f = fixture(t);
    const wide = [1, 2, 3, 4, 5].map(function(index) { return { type: 'tool_use', name: '가'.repeat(70) + index }; });
    write(Path.join(f.claudeRoot, 'project', 'wide') + '.jsonl', { type: 'assistant', timestamp: now(), message: { stop_reason: 'tool_use', content: wide } });
    write(Path.join(f.claudeRoot, 'project', 'pair') + '.jsonl', { type: 'assistant', timestamp: now(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'a'.repeat(79) + '😀' }] } });
    write(Path.join(f.claudeRoot, 'project', 'lone') + '.jsonl', { type: 'assistant', timestamp: now(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Tool\ud800' }] } });
    f.create().start(function(error, snapshot)
    {
        Assert.ifError(error);
        function find(sessionId) { return snapshot.nodes.find(function(node) { return node.sessionId === sessionId; }); }
        const long = find('wide').statusEvidence;
        Assert.ok(long.length <= 1200, 'the token stays within its size budget');
        Assert.ok(long.startsWith('⟦msg.evidence.claudeToolCall?') && long.endsWith('⟧'));
        Assert.match(I18n.resolve(long, 'ko'), /^Claude 도구 호출: 가{70}1, 가+/);
        Assert.equal(I18n.resolve(find('pair').statusEvidence, 'en'), 'Claude tool call: ' + 'a'.repeat(79));
        Assert.equal(I18n.resolve(find('lone').statusEvidence, 'en'), 'Claude tool call: Tool�');
        done();
    });
});
