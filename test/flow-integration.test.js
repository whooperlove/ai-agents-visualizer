'use strict';

const Test = require('node:test');
const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Http = require('node:http');
const Server = require('../server');

Test('the control API streams logical management and real request/reply state changes over SSE and leaves bodies out', function(t, done)
{
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'visualizer-flow-'));
  const deliveries = Path.join(home, '.cross-agent', 'deliveries');
  const pendingPath = Path.join(deliveries, 'in-flight', 'req_fixture_request.json');
  const supplementPath = Path.join(home, 'team.json');
  Fs.mkdirSync(Path.dirname(pendingPath), { recursive: true });
  const seconds = Date.now() / 1000;
  const initial = {
    delivery_id: 'req_fixture_request', kind: 'request', state: 'queued',
    sender_agent: 'claude', sender_session_id: 'master',
    target_agent: 'codex', target_session_id: 'worker',
    created_at: seconds, updated_at: seconds, expires_at: seconds + 3600,
    summary: 'PRIVATE_BODY', reply_preview: 'PRIVATE_BODY', error: 'PRIVATE_BODY'
  };
  Fs.writeFileSync(pendingPath, JSON.stringify(initial));
  Fs.writeFileSync(supplementPath, JSON.stringify({
    schemaVersion: 1,
    sessions: [
      { id: 'claude:master', name: 'Control master', project: 'fixture', role: 'master' },
      { id: 'codex:worker', name: 'Logical owner', project: 'fixture', role: 'worker' }
    ],
    relations: [{ id: 'team', from: 'claude:master', to: 'codex:worker', type: 'management', confidence: 'confirmed' }]
  }));
  const app = Server.createObserverServer({ home: home, port: 0, pollIntervalMs: 50, supplements: [supplementPath] });
  var events = null;
  var stage = 0;
  const deadline = setTimeout(function() { done(new Error('control flow update timeout: ' + stage)); }, 7000);
  t.after(function(context, next)
  {
    clearTimeout(deadline);
    if (events) events.destroy();
    app.stop(function()
    {
      Fs.rmSync(home, { recursive: true, force: true });
      next();
    });
  });
  app.start(function(error, address)
  {
    Assert.ifError(error);
    events = Http.get({ host: '127.0.0.1', port: address.port, path: '/api/events' }, function(response)
    {
      response.on('data', function()
      {
        const snapshot = app.snapshot();
        const request = snapshot.edges.find(function(edge) { return edge.id === 'bridge:req_fixture_request'; });
        if (!request || snapshot.stats.loading) return;
        if (stage === 0)
        {
          Assert.equal(request.message.kind, 'request');
          Assert.equal(request.status, 'queued');
          Assert.equal(request.from, 'claude:master');
          Assert.equal(request.to, 'codex:worker');
          Assert.equal(snapshot.edges.filter(function(edge) { return edge.type === 'management'; }).length, 1);
          Assert.equal(snapshot.edges.filter(function(edge) { return edge.type === 'spawn'; }).length, 0);
          Assert.equal(snapshot.nodes.find(function(node) { return node.id === 'claude:master'; }).role, 'master');
          stage = 1;
          Fs.writeFileSync(pendingPath, JSON.stringify(Object.assign({}, initial, { state: 'awaiting-peer', accepted_at: seconds + 1, updated_at: seconds + 1 })));
        }
        else if (stage === 1 && request.status === 'awaiting-peer')
        {
          Assert.equal(request.message.acceptedAt, new Date((seconds + 1) * 1000).toISOString());
          stage = 2;
          Fs.writeFileSync(Path.join(deliveries, 'req_fixture_request.json'), JSON.stringify(Object.assign({}, initial, { state: 'delivered', finished_at: seconds + 2, reply_length: 12, return_delivery_id: 'req_fixture_reply' })));
          Fs.unlinkSync(pendingPath);
          Fs.writeFileSync(Path.join(deliveries, 'req_fixture_reply.json'), JSON.stringify({
            delivery_id: 'req_fixture_reply', kind: 'reply', state: 'delivered',
            sender_agent: 'codex', sender_session_id: 'worker', target_agent: 'claude', target_session_id: 'master',
            parent_delivery_id: 'req_fixture_request', created_at: seconds + 2, finished_at: seconds + 3,
            body: 'PRIVATE_BODY', reply: 'PRIVATE_BODY'
          }));
        }
        else if (stage === 2 && request.status === 'delivered' && snapshot.edges.some(function(edge) { return edge.id === 'bridge:req_fixture_reply'; }))
        {
          stage = 3;
          const reply = snapshot.edges.find(function(edge) { return edge.id === 'bridge:req_fixture_reply'; });
          Assert.equal(request.message.outcome, 'reply-recorded');
          Assert.equal(reply.from, 'codex:worker');
          Assert.equal(reply.to, 'claude:master');
          Assert.equal(reply.message.parentDeliveryId, request.message.deliveryId);
          Assert.equal(reply.message.kind, 'reply');
          Assert.equal(snapshot.edges.filter(function(edge) { return edge.id === request.id; }).length, 1);
          Http.get({ host: '127.0.0.1', port: address.port, path: '/api/snapshot' }, function(apiResponse)
          {
            var text = '';
            apiResponse.on('data', function(chunk) { text += chunk; });
            apiResponse.on('end', function()
            {
              Assert.equal(apiResponse.statusCode, 200);
              Assert.equal(text.includes('PRIVATE_BODY'), false);
              const body = JSON.parse(text);
              Assert.equal(body.stats.relations.management, 1);
              Assert.equal(body.stats.relations.collaboration, 2);
              done();
            });
          }).on('error', done);
        }
      });
    });
    events.on('error', done);
  });
});
