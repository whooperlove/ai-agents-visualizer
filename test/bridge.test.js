const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Bridge = require('../src/sources/bridge');
const I18n = require('./helpers/i18n').loadNodeI18n();

function fixture(t)
{
    const home = Fs.mkdtempSync(Path.join(__dirname, '..', '.bridge-test-'));
    const root = Path.join(home, '.cross-agent');
    Fs.mkdirSync(Path.join(root, 'deliveries', 'in-flight'), { recursive: true });
    t.after(function() { Fs.rmSync(home, { recursive: true, force: true }); });
    return { home: home, root: root };
}

function writeJson(path, value)
{
    Fs.writeFileSync(path, JSON.stringify(value));
}

function delivery(id, extra)
{
    return Object.assign({
        delivery_id: id,
        state: 'queued',
        kind: 'request',
        sender_agent: 'claude',
        sender_session_id: 'sender-session',
        target_agent: 'codex',
        target_session_id: 'receiver-session',
        parent_delivery_id: null,
        return_delivery_id: null,
        created_at: 1792021674,
        accepted_at: null,
        finished_at: null,
        updated_at: 1792021674
    }, extra || {});
}

function waitFor(collector, predicate, callback)
{
    const deadline = Date.now() + 6000;
    function check()
    {
        const value = collector.snapshot();
        if (predicate(value))
        {
            callback(null, value);
            return;
        }
        if (Date.now() > deadline)
        {
            callback(new Error('Timed out waiting for bridge reconciliation'));
            return;
        }
        setTimeout(check, 20);
    }
    check();
}

Test('reads actual pin/outbox layouts, preserves request direction and excludes all bodies', function(t, done)
{
    const f = fixture(t);
    writeJson(Path.join(f.root, 'registry.json'), {
        version: 1,
        pins: { claude: { '/project/alpha': { session_id: 'sender-session', cwd: '/project/alpha', updated_at: 1792021600 } } },
        conversations: { private: { message: 'PRIVATE_CONVERSATION' } }
    });
    const request = delivery('req_100_abcdef', {
        state: 'delivered',
        finished_at: 1792021800,
        reply_length: 100,
        return_delivery_id: 'req_200_abcdef',
        summary: 'PRIVATE_SUMMARY',
        reply_preview: 'PRIVATE_REPLY',
        error: 'PRIVATE_ERROR',
        progress_note: 'PRIVATE_PROGRESS',
        payload: { token: 'PRIVATE_PAYLOAD' },
        body: 'PRIVATE_BODY',
        reply: 'PRIVATE_REPLY_BODY',
        tool_output: 'PRIVATE_TOOL_OUTPUT',
        env: { token: 'PRIVATE_ENV' },
        message: { summary: 'PRIVATE_NESTED_MESSAGE' }
    });
    writeJson(Path.join(f.root, 'deliveries', 'req_100_abcdef.json'), request);
    writeJson(Path.join(f.root, 'deliveries', 'in-flight', 'req_100_abcdef.json'), delivery('req_100_abcdef'));
    writeJson(Path.join(f.root, 'deliveries', 'req_200_abcdef.json'), delivery('req_200_abcdef', {
        state: 'delivered', kind: 'reply', sender_agent: 'codex', sender_session_id: 'receiver-session',
        target_agent: 'claude', target_session_id: 'sender-session', parent_delivery_id: 'req_100_abcdef'
    }));
    const collector = Bridge.createBridgeCollector({ home: f.home, pollIntervalMs: 50 });
    t.after(collector.stop);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.edges.length, 2);
        Assert.equal(snapshot.stats.deliveryFiles, 3);
        Assert.equal(snapshot.nodes.length, 2);
        const requestEdge = snapshot.edges.find(function(edge) { return edge.id === 'bridge:req_100_abcdef'; });
        const replyEdge = snapshot.edges.find(function(edge) { return edge.id === 'bridge:req_200_abcdef'; });
        Assert.equal(requestEdge.status, 'delivered');
        Assert.match(requestEdge.source.detail, /requestOutcome=reply-recorded/);
        Assert.match(requestEdge.source.detail, /returnDeliveryId=req_200_abcdef/);
        Assert.deepEqual(requestEdge.message, {
            deliveryId: 'req_100_abcdef',
            kind: 'request',
            createdAt: new Date(1792021674 * 1000).toISOString(),
            acceptedAt: null,
            finishedAt: new Date(1792021800 * 1000).toISOString(),
            expiresAt: null,
            parentDeliveryId: null,
            returnDeliveryId: 'req_200_abcdef',
            outcome: 'reply-recorded',
            expired: false
        });
        Assert.equal(replyEdge.from, 'codex:receiver-session');
        Assert.equal(replyEdge.to, 'claude:sender-session');
        Assert.equal(replyEdge.requestId, 'req_100_abcdef');
        Assert.equal(replyEdge.type, 'collaboration');
        Assert.equal(replyEdge.message.deliveryId, 'req_200_abcdef');
        Assert.equal(replyEdge.message.parentDeliveryId, 'req_100_abcdef');
        Assert.equal(replyEdge.message.kind, 'reply');
        Assert.equal(replyEdge.message.outcome, 'none');
        Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'claude:sender-session'; }).project, 'alpha');
        snapshot.nodes.forEach(function(node) { Assert.equal(node.status, 'unknown'); });
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
        done();
    });
});

Test('retains unresolved endpoints and raw delivery state without claiming queued work is running', function(t, done)
{
    const f = fixture(t);
    writeJson(Path.join(f.root, 'deliveries', 'in-flight', 'queued.json'), delivery('queued', { sender_session_id: null, expires_at: 1 }));
    Fs.writeFileSync(Path.join(f.root, 'deliveries', 'bad.json'), '{"PRIVATE_BROKEN_MESSAGE":');
    const collector = Bridge.createBridgeCollector({ home: f.home });
    t.after(collector.stop);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.edges[0].status, 'queued');
        Assert.equal(snapshot.edges[0].confidence, 'unresolved');
        Assert.match(snapshot.edges[0].from, /^unresolved:bridge:/);
        Assert.equal(snapshot.edges[0].to, 'codex:receiver-session');
        Assert.match(snapshot.edges[0].source.detail, /lease=expired/);
        Assert.equal(snapshot.edges[0].message.expiresAt, '1970-01-01T00:00:01.000Z');
        Assert.equal(snapshot.edges[0].message.expired, true);
        Assert.equal(snapshot.edges[0].message.outcome, 'none');
        Assert.equal(snapshot.stats.unresolvedEndpoints, 1);
        Assert.ok(snapshot.diagnostics.some(function(item) { return item.code === 'invalid-json'; }));
        const invalid = snapshot.diagnostics.find(function(item) { return item.code === 'invalid-json'; });
        Assert.equal(I18n.resolve(invalid.message, 'ko'), '브리지 JSON 형식이 올바르지 않습니다.');
        Assert.equal(I18n.resolve(invalid.message, 'en'), 'The bridge JSON format is invalid.');
        const preserved = snapshot.diagnostics.find(function(item) { return item.code === 'unresolved-endpoints'; });
        Assert.equal(I18n.resolve(preserved.message, 'ko'), '세션 식별자가 없는 전달 끝점 1개를 미해결로 보존했습니다.');
        Assert.equal(I18n.resolve(preserved.message, 'en'), 'Preserved 1 delivery endpoint without a session identifier as unresolved.');
        const placeholder = snapshot.nodes.find(function(node) { return /^unresolved:bridge:/.test(node.id); });
        Assert.equal(I18n.resolve(placeholder.name, 'ko'), '미해결 전달 끝점');
        Assert.equal(I18n.resolve(placeholder.name, 'en'), 'Unresolved delivery endpoint');
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_BROKEN_MESSAGE/);
        done();
    });
});

Test('reconciles changed, atomically replaced and deleted files without rereading unchanged metadata', function(t, done)
{
    const f = fixture(t);
    const path = Path.join(f.root, 'deliveries', 'in-flight', 'changing.json');
    writeJson(path, delivery('changing'));
    const collector = Bridge.createBridgeCollector({ home: f.home, pollIntervalMs: 40 });
    t.after(collector.stop);
    collector.start(function(error, initial)
    {
        Assert.ifError(error);
        const initialReads = initial.stats.readsTotal;
        Assert.equal(initial.edges[0].message.deliveryId, 'changing');
        Assert.equal(initial.edges[0].message.acceptedAt, null);
        waitFor(collector, function(value) { return value.stats.scansTotal >= 3; }, function(waitError, unchanged)
        {
            Assert.ifError(waitError);
            Assert.equal(unchanged.stats.readsTotal, initialReads);
            writeJson(path + '.tmp', delivery('changing', { state: 'awaiting-peer', accepted_at: 1792021700 }));
            Fs.renameSync(path + '.tmp', path);
            waitFor(collector, function(value) { return value.edges[0] && value.edges[0].status === 'awaiting-peer'; }, function(updateError, updated)
            {
                Assert.ifError(updateError);
                Assert.equal(updated.nodes[0].status, 'unknown');
                Assert.equal(updated.edges[0].id, initial.edges[0].id);
                Assert.equal(updated.edges[0].message.deliveryId, 'changing');
                Assert.equal(updated.edges[0].message.acceptedAt, new Date(1792021700 * 1000).toISOString());
                Assert.equal(updated.edges[0].message.outcome, 'none');
                writeJson(Path.join(f.root, 'deliveries', 'changing.json'), delivery('changing', {
                    state: 'delivered', accepted_at: 1792021700, finished_at: 1792021800, reply_length: 42
                }));
                waitFor(collector, function(value) { return value.edges[0] && value.edges[0].status === 'delivered'; }, function(finishError, finished)
                {
                    Assert.ifError(finishError);
                    Assert.equal(finished.edges.length, 1);
                    Assert.equal(finished.edges[0].id, initial.edges[0].id);
                    Assert.equal(finished.edges[0].message.deliveryId, 'changing');
                    Assert.equal(finished.edges[0].message.outcome, 'reply-recorded');
                    Assert.equal(finished.edges[0].message.finishedAt, new Date(1792021800 * 1000).toISOString());
                    Fs.unlinkSync(path);
                    Fs.unlinkSync(Path.join(f.root, 'deliveries', 'changing.json'));
                    waitFor(collector, function(value) { return value.edges.length === 0; }, function(deleteError, removed)
                    {
                        Assert.ifError(deleteError);
                        Assert.equal(removed.nodes.length, 0);
                        Assert.equal(removed.stats.deliveryRecords, 0);
                        done();
                    });
                });
            });
        });
    });
});

Test('discovers a bridge directory created after startup and refreshes a replaced directory', function(t, done)
{
    const f = fixture(t);
    Fs.rmSync(f.root, { recursive: true, force: true });
    const collector = Bridge.createBridgeCollector({ home: f.home, pollIntervalMs: 40 });
    t.after(collector.stop);
    collector.start(function(error)
    {
        Assert.ifError(error);
        Fs.mkdirSync(Path.join(f.root, 'deliveries'), { recursive: true });
        writeJson(Path.join(f.root, 'deliveries', 'first.json'), delivery('first'));
        waitFor(collector, function(value) { return value.edges.length === 1; }, function(firstError)
        {
            Assert.ifError(firstError);
            Fs.renameSync(f.root, f.root + '-previous');
            Fs.mkdirSync(Path.join(f.root, 'deliveries'), { recursive: true });
            writeJson(Path.join(f.root, 'deliveries', 'second.json'), delivery('second', { target_session_id: 'new-receiver' }));
            waitFor(collector, function(value) { return value.edges.length === 1 && value.edges[0].id === 'bridge:second'; }, function(secondError, replaced)
            {
                Assert.ifError(secondError);
                Assert.ok(!replaced.nodes.some(function(node) { return node.id === 'codex:receiver-session'; }));
                done();
            });
        });
    });
});

Test('records reply evidence without interpreting task success and preserves notice directions', function(t, done)
{
    const f = fixture(t);
    const records = [
        delivery('confirmed', { state: 'delivered', is_reply_confirmed_by_transcript: true, reply_length: 20 }),
        delivery('recovered', { state: 'failed', reply_length: 20 }),
        delivery('delivered-only', { state: 'delivered', return_delivery_id: 'notice' }),
        delivery('notice', {
            state: 'failed', kind: 'failure-notice', sender_agent: 'codex', sender_session_id: 'receiver-session',
            target_agent: 'claude', target_session_id: 'sender-session', parent_delivery_id: 'delivered-only'
        }),
        delivery('progress', {
            state: 'awaiting-peer', kind: 'progress-notice', sender_agent: 'codex', sender_session_id: 'receiver-session',
            target_agent: 'claude', target_session_id: 'sender-session', parent_delivery_id: 'delivered-only'
        }),
        delivery('unknown-kind', { kind: 'PRIVATE_UNKNOWN_KIND', created_at: 'PRIVATE_TIMESTAMP', accepted_at: -1, finished_at: 8640000000000 })
    ];
    records.forEach(function(record)
    {
        writeJson(Path.join(f.root, 'deliveries', record.delivery_id + '.json'), record);
    });
    const collector = Bridge.createBridgeCollector({ home: f.home });
    t.after(collector.stop);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const byIdDic = Object.create(null);
        snapshot.edges.forEach(function(edge) { byIdDic[edge.message.deliveryId] = edge; });
        Assert.equal(byIdDic.confirmed.message.outcome, 'transcript-confirmed');
        Assert.match(byIdDic.confirmed.source.detail, /requestOutcome=transcript-confirmed/);
        Assert.equal(byIdDic.recovered.status, 'failed');
        Assert.equal(byIdDic.recovered.message.outcome, 'reply-recorded');
        Assert.equal(byIdDic['delivered-only'].message.outcome, 'none');
        ['notice', 'progress'].forEach(function(id)
        {
            Assert.equal(byIdDic[id].from, 'codex:receiver-session');
            Assert.equal(byIdDic[id].to, 'claude:sender-session');
            Assert.equal(byIdDic[id].requestId, 'delivered-only');
            Assert.equal(byIdDic[id].message.parentDeliveryId, 'delivered-only');
            Assert.equal(byIdDic[id].message.outcome, 'none');
        });
        Assert.equal(byIdDic.notice.message.kind, 'failure-notice');
        Assert.equal(byIdDic.progress.message.kind, 'progress-notice');
        Assert.equal(byIdDic.progress.status, 'awaiting-peer');
        Assert.equal(byIdDic['unknown-kind'].message.kind, 'unknown');
        Assert.equal(byIdDic['unknown-kind'].message.createdAt, null);
        Assert.equal(byIdDic['unknown-kind'].message.acceptedAt, null);
        Assert.equal(byIdDic['unknown-kind'].message.finishedAt, null);
        Assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|requestOutcome=completed/);
        done();
    });
});

Test('refreshes expiry without rereading metadata and keeps finished epoch timestamps valid', function(t, done)
{
    const f = fixture(t);
    const expiresAt = (Date.now() + 400) / 1000;
    writeJson(Path.join(f.root, 'deliveries', 'in-flight', 'lease.json'), delivery('lease', { state: 'delivering', expires_at: expiresAt }));
    writeJson(Path.join(f.root, 'deliveries', 'epoch.json'), delivery('epoch', { created_at: 0, finished_at: 0, expires_at: 0 }));
    writeJson(Path.join(f.root, 'deliveries', 'in-flight', 'expired-epoch.json'), delivery('expired-epoch', { expires_at: 0 }));
    var expiryChanges = 0;
    const collector = Bridge.createBridgeCollector({ home: f.home, pollIntervalMs: 40 }, function(value)
    {
        const edge = value.edges.find(function(item) { return item.message.deliveryId === 'lease'; });
        if (edge && edge.message.expired) expiryChanges += 1;
    });
    t.after(collector.stop);
    collector.start(function(error, initial)
    {
        Assert.ifError(error);
        const initialReads = initial.stats.readsTotal;
        const epoch = initial.edges.find(function(edge) { return edge.message.deliveryId === 'epoch'; });
        const lease = initial.edges.find(function(edge) { return edge.message.deliveryId === 'lease'; });
        Assert.equal(epoch.message.createdAt, '1970-01-01T00:00:00.000Z');
        Assert.equal(epoch.message.finishedAt, '1970-01-01T00:00:00.000Z');
        Assert.equal(epoch.message.expired, false);
        Assert.equal(lease.status, 'delivering');
        Assert.equal(lease.message.expired, false);
        Assert.equal(initial.stats.expiredLeases, 1);
        waitFor(collector, function(value) { return value.stats.expiredLeases === 2; }, function(waitError, expired)
        {
            Assert.ifError(waitError);
            const updated = expired.edges.find(function(edge) { return edge.message.deliveryId === 'lease'; });
            Assert.equal(updated.status, 'delivering');
            Assert.equal(updated.message.expired, true);
            Assert.equal(updated.message.expiresAt, new Date(expiresAt * 1000).toISOString());
            Assert.equal(expired.stats.readsTotal, initialReads);
            Assert.equal(expiryChanges, 1);
            done();
        });
    });
});

Test('does not truncate a delivery collection larger than 3700 records', function(t, done)
{
    const f = fixture(t);
    for (var index = 0; index < 3710; index += 1)
    {
        writeJson(Path.join(f.root, 'deliveries', 'bulk-' + index + '.json'), delivery('bulk-' + index, { target_session_id: 'target-' + index }));
    }
    const collector = Bridge.createBridgeCollector({ home: f.home });
    t.after(collector.stop);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        Assert.equal(snapshot.edges.length, 3710);
        Assert.equal(snapshot.nodes.length, 3711);
        Assert.equal(snapshot.stats.deliveryRecords, 3710);
        done();
    });
});

Test('unresolved endpoint diagnostics use the plural form and pin text cannot forge a message token', function(t, done)
{
    const f = fixture(t);
    const forged = '⟦msg.node.noIdentifier⟧';
    writeJson(Path.join(f.root, 'registry.json'), {
        version: 1,
        pins: { claude: { ['/work/' + forged]: { session_id: 'sender-session', cwd: '/work/' + forged, updated_at: 1792021600 } } }
    });
    writeJson(Path.join(f.root, 'deliveries', 'in-flight', 'one.json'), delivery('one', { sender_session_id: null, target_session_id: null }));
    const collector = Bridge.createBridgeCollector({ home: f.home });
    t.after(collector.stop);
    collector.start(function(error, snapshot)
    {
        Assert.ifError(error);
        const preserved = snapshot.diagnostics.find(function(item) { return item.code === 'unresolved-endpoints'; });
        Assert.equal(I18n.resolve(preserved.message, 'en'), 'Preserved 2 delivery endpoints without a session identifier as unresolved.');
        Assert.equal(I18n.resolve(preserved.message, 'ko'), '세션 식별자가 없는 전달 끝점 2개를 미해결로 보존했습니다.');
        const pinned = snapshot.nodes.find(function(node) { return node.id === 'claude:sender-session'; });
        Assert.equal(pinned.cwd, '/work/[msg.node.noIdentifier]');
        Assert.equal(pinned.project, '[msg.node.noIdentifier]');
        Assert.equal(I18n.resolve(pinned.cwd, 'en'), '/work/[msg.node.noIdentifier]');
        done();
    });
});
