/* Print only read-only metadata counts; never print transcript bodies. */
'use strict';
const Os = require('node:os');
const I18n = require('../src/i18n');
const Sessions = require('../src/sources/sessions');
const Bridge = require('../src/sources/bridge');
const Model = require('../src/model');

const startedAt = Date.now();
const options = { home: Os.homedir(), pollIntervalMs: 60000 };
const sessions = Sessions.createSessionCollector(options);
const bridge = Bridge.createBridgeCollector(options);
var pending = 2;
var failed = false;

function finished(error)
{
  if (error) { failed = true; console.error(error.code || I18n.t('cli.verifyLiveReadError')); }
  pending--;
  if (pending > 0) return;
  const native = sessions.snapshot();
  const deliveries = bridge.snapshot();
  const result = Model.buildGraph([native, deliveries], [], 1);
  const nativeIds = new Set(native.nodes.map(function(node) { return node.id; }));
  const grandchild = native.nodes.find(function(node) { return node.provider === 'claude' && node.spawnDepth >= 2; });
  const grandchildEdge = grandchild && result.edges.find(function(edge) { return edge.type === 'spawn' && edge.to === grandchild.id; });
  function counts(nodes)
  {
    const count = { claude: { sessions: 0, agents: 0 }, codex: { sessions: 0, agents: 0 } };
    nodes.filter(function(node) { return nativeIds.has(node.id); }).forEach(function(node)
    {
      if (count[node.provider]) count[node.provider][node.kind === 'agent' ? 'agents' : 'sessions']++;
    });
    return count;
  }
  const summary = {
    observedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    nativeCounts: counts(native.nodes),
    totalGraph: result.stats,
    bridgeEdges: deliveries.edges.length,
    nativeGrandchildren: native.nodes.filter(function(node) { return node.spawnDepth >= 2; }).length,
    grandchildExample: grandchild ? { id: grandchild.id, depth: grandchild.spawnDepth, parent: grandchildEdge && grandchildEdge.from, confidence: grandchildEdge && grandchildEdge.confidence, source: grandchildEdge && grandchildEdge.source } : null,
    unresolvedExamples: result.nodes.filter(function(node) { return !node.observed; }).slice(0, 3).map(function(node) { return { id: node.id, name: node.name, evidence: node.statusEvidence }; }),
    conflictExamples: result.nodes.filter(function(node) { return node.conflicts.length > 0; }).slice(0, 3).map(function(node) { return { id: node.id, conflicts: node.conflicts }; }),
    sampling: native.stats,
    bridge: deliveries.stats
  };
  console.log(JSON.stringify(summary, null, 2));
  sessions.stop();
  bridge.stop();
  if (failed) process.exitCode = 1;
}

sessions.start(finished);
bridge.start(finished);
