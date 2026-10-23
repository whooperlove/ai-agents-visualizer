/* Evidence-preserving graph merge. Only allowlisted metadata leaves the server. */
'use strict';

const Path = require('node:path');
const I18n = require('./i18n');
const NODE_FIELDS = ['provider', 'sessionId', 'name', 'cwd', 'project', 'account', 'kind', 'status', 'statusEvidence', 'lastSeen', 'model', 'effort', 'description', 'role'];
const STATUSES = ['running', 'waiting', 'idle', 'completed', 'interrupted', 'unknown'];
const EDGE_TYPES = ['spawn', 'management', 'dependency', 'collaboration', 'handoff'];
const SOURCE_KEYS = Symbol('sourceKeys');
const TEXT_LIMIT = 240;
// Text that carries message tokens (evidence, diagnostics, source details) is longer than the plain text it renders to,
// because every token parameter is percent-encoded. Producers bound their parameters before tokenizing.
const MESSAGE_LIMIT = 2000;
const TOKEN_OPEN = '⟦';
const TOKEN_CLOSE = '⟧';
const REDACTED_PRIVATE = I18n.token('msg.redacted.privateKey');
const REDACTED_CREDENTIAL = I18n.token('msg.redacted.credential');
const REDACTED_VALUE = I18n.token('msg.redacted.value');
const UNRESOLVED_NAME = I18n.token('msg.bridge.unresolvedEndpointName');
// Parameterless messages may appear inside any text, so sanitizing stays idempotent and the collectors can name placeholders.
// Every other message token has to be created by this server; observed or supplement text can never forge one.
const FIXED_TOKEN_PATTERN = new RegExp('(' + [REDACTED_PRIVATE, REDACTED_CREDENTIAL, REDACTED_VALUE, UNRESOLVED_NAME].map(escapeRegExp).join('|') + ')');
const COMPLETE_TOKEN_PATTERN = /(⟦[A-Za-z0-9_.-]+(?:\?[^⟦⟧]*)?⟧)/;

function escapeRegExp(text)
{
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(text)
{
  return text
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*/g, REDACTED_PRIVATE)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, REDACTED_CREDENTIAL)
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1' + REDACTED_VALUE);
}

// Cuts text to the limit without leaving half a message token or half a surrogate pair behind.
function limitText(text, limit)
{
  if (text.length <= limit) return text;
  var result = text.slice(0, limit);
  const open = result.lastIndexOf(TOKEN_OPEN);
  if (open > result.lastIndexOf(TOKEN_CLOSE)) result = result.slice(0, open);
  if (/[\ud800-\udbff]$/.test(result)) result = result.slice(0, -1);
  return result;
}

// trustTokens keeps the message tokens this server created; all other text is stripped of token delimiters first.
function cleanText(value, limit, trustTokens)
{
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').toWellFormed();
  if (text.indexOf(TOKEN_OPEN) < 0 && text.indexOf(TOKEN_CLOSE) < 0) return limitText(redact(text), limit);
  const pieces = text.split(trustTokens ? COMPLETE_TOKEN_PATTERN : FIXED_TOKEN_PATTERN);
  return limitText(pieces.map(function(piece, index) { return index % 2 ? piece : redact(I18n.stripMarkers(piece)); }).join(''), limit);
}

// Plain text from observed records or the user's supplement.
function safeText(value, limit)
{
  return cleanText(value, limit || TEXT_LIMIT, false);
}

// Text produced by this server's own collectors, which may contain message tokens.
function safeMessage(value, limit)
{
  return cleanText(value, limit || MESSAGE_LIMIT, true);
}

function sourceMetadata(source)
{
  // Source details come from this server's collectors (or were sanitized as plain text before they got here), so tokens stay.
  return { kind: safeText(source && source.kind, 80), path: safeText(source && source.path, 2000), detail: safeMessage(source && source.detail) };
}

function messageMetadata(raw)
{
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const message = {};
  ['deliveryId', 'parentDeliveryId', 'returnDeliveryId'].forEach(function(field)
  {
    if (typeof raw[field] === 'string' && raw[field]) message[field] = safeText(raw[field], 500);
  });
  ['createdAt', 'acceptedAt', 'finishedAt', 'expiresAt'].forEach(function(field)
  {
    if (typeof raw[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw[field])) return;
    const timestamp = Date.parse(raw[field]);
    const calendar = Date.parse(raw[field].slice(0, 19) + 'Z');
    if (!Number.isFinite(timestamp) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== raw[field].slice(0, 19)) return;
    message[field] = new Date(timestamp).toISOString();
  });
  if (['request', 'reply', 'failure-notice', 'progress-notice', 'unknown'].includes(raw.kind)) message.kind = raw.kind;
  if (['reply-recorded', 'transcript-confirmed', 'none'].includes(raw.outcome)) message.outcome = raw.outcome;
  if (typeof raw.expired === 'boolean') message.expired = raw.expired;
  return Object.keys(message).length ? message : null;
}

function diagnosticMessage(code)
{
  const messages = {
    'history-sampled': I18n.token('msg.diagnostic.historySampled'),
    'malformed-jsonl': I18n.token('msg.diagnostic.malformedJsonl'),
    'oversized-jsonl-line': I18n.token('msg.diagnostic.oversizedJsonlLine'),
    'oversized-metadata': I18n.token('msg.diagnostic.oversizedMetadata'),
    'malformed-metadata': I18n.token('msg.diagnostic.malformedMetadata'),
    'file-unreadable': I18n.token('msg.diagnostic.fileUnreadable')
  };
  return messages[code] || code || I18n.token('msg.diagnostic.fallback');
}

function addSource(node, source)
{
  const clean = sourceMetadata(source);
  const key = JSON.stringify(clean);
  if (!node[SOURCE_KEYS]) node[SOURCE_KEYS] = new Set();
  if (!node[SOURCE_KEYS].has(key)) { node[SOURCE_KEYS].add(key); node.sources.push(clean); }
}

function addConflict(item, field, values, message)
{
  if (!item.conflicts.some(function(conflict) { return conflict.field === field && conflict.message === message; }))
  {
    item.conflicts.push({ field: field, values: values.map(function(value) { return safeText(value, 2000); }), message: message });
  }
}

function buildGraph(snapshots, supplements, version)
{
  const nodeDic = new Map();
  const aliasDic = new Map();
  const explicitAliases = new Set();
  const fallbackNames = new Set();
  const diagnostics = [];
  const allEdges = [];
  const sourceStatus = [];
  var loading = false;
  function alias(name, id)
  {
    if (!name) return;
    if (!aliasDic.has(name)) aliasDic.set(name, new Set());
    aliasDic.get(name).add(id);
  }
  function mergeNode(raw, isSupplement, origin)
  {
    const id = safeText(raw.id, 2000);
    if (!id) return;
    var node = nodeDic.get(id);
    if (!node)
    {
      node = { id: id, name: id, provider: id.split(':')[0], kind: isSupplement || raw.kind === 'unresolved' || id.startsWith('unresolved:') ? 'unresolved' : 'session', status: 'unknown', sources: [], conflicts: [], aliases: [], observed: !isSupplement && raw.kind !== 'unresolved' && !id.startsWith('unresolved:') };
      nodeDic.set(id, node);
    }
    // A hand-written supplement label never replaces the name a session actually carries: the same session ID
    // keeps following its observed (renamed) title, and the older supplement name stays reachable as an alias.
    const supplementName = isSupplement ? safeText(raw.name, 2000) : '';
    const staleName = !!supplementName && node.observed && node.name !== id && !fallbackNames.has(id) && supplementName !== node.name;
    NODE_FIELDS.forEach(function(field)
    {
      if (raw[field] === undefined || raw[field] === null || raw[field] === '') return;
      if (staleName && field === 'name') return;
      // Only the collectors write status evidence; a supplement cannot, so its text is never trusted to carry tokens.
      const value = field === 'statusEvidence' && !isSupplement ? safeMessage(raw[field]) : safeText(raw[field], field === 'cwd' || field === 'name' ? 2000 : 500);
      if (field === 'status' && (!STATUSES.includes(value) || value === 'unknown' && node.status !== 'unknown')) return;
      if ((field === 'status' || field === 'statusEvidence') && raw.lastSeen && node.lastSeen && raw.lastSeen < node.lastSeen) return;
      if (field === 'kind' && node.kind === 'agent' && value === 'session') return;
      if (field === 'project' && node.project && !isSupplement) return;
      if (field === 'lastSeen' && node.lastSeen && node.lastSeen > value) return;
      if (['cwd', 'provider', 'sessionId', 'model'].includes(field) && node[field] && node[field] !== value)
      {
        addConflict(node, field, [node[field], value], I18n.token('msg.conflict.differentObserved'));
        if (!isSupplement) return;
      }
      if (field === 'name' && (value === id || value === raw.sessionId) && node.name !== id) return;
      if (field === 'name' && node.name !== id && node.name !== value) alias(node.name, id);
      node[field] = value;
    });
    if (Number.isInteger(raw.spawnDepth) && raw.spawnDepth >= 0) node.spawnDepth = raw.spawnDepth;
    if (!isSupplement)
    {
      if (raw.nameFallback === true) fallbackNames.add(id);
      else if (raw.name && raw.name !== id) fallbackNames.delete(id);
      if (Array.isArray(raw.nameHistory)) node.nameHistory = raw.nameHistory.map(function(name) { return safeText(name, 300); }).filter(Boolean).slice(-12);
    }
    if (staleName && !node.aliases.includes(supplementName))
    {
      alias(supplementName, id);
      node.aliases.push(supplementName);
      diagnostics.push({ level: 'info', code: 'supplement-name-stale', message: I18n.token('msg.diagnostic.supplementNameStale', { supplementName: limitText(supplementName, 160), observedName: limitText(node.name, 160) }), source: sourceMetadata({ kind: 'supplement', path: origin, detail: id }) });
    }
    if (isSupplement && typeof raw.archived === 'boolean' && !staleName) node.archived = raw.archived;
    (raw.sources || []).forEach(function(source) { addSource(node, source); });
    if (!isSupplement && raw.kind !== 'unresolved' && !id.startsWith('unresolved:')) node.observed = true;
    if (!node.observed) node.kind = 'unresolved';
    (raw.aliases || []).forEach(function(name)
    {
      const clean = safeText(name, 2000);
      explicitAliases.add(clean);
      alias(clean, id);
      if (!node.aliases.includes(clean)) node.aliases.push(clean);
    });
    alias(id, id);
    if (node.kind !== 'agent' || id === node.provider + ':' + node.sessionId) alias(node.sessionId, id);
    alias(node.name, id);
    return node;
  }
  snapshots.forEach(function(snapshot)
  {
    (snapshot.nodes || []).forEach(function(node) { mergeNode(node, false); });
    (snapshot.edges || []).forEach(function(edge) { allEdges.push(edge); });
    (snapshot.diagnostics || []).forEach(function(item)
    {
      diagnostics.push({ level: safeText(item.level || (item.code === 'history-sampled' ? 'info' : 'warning')), code: safeText(item.code), message: safeMessage(item.message || diagnosticMessage(item.code)), source: sourceMetadata(item.source && typeof item.source === 'object' ? item.source : { kind: item.provider || item.source || 'collector', path: item.path }) });
    });
    loading = loading || !!(snapshot.stats && snapshot.stats.loading);
    sourceStatus.push(snapshot.stats || {});
  });
  supplements.forEach(function(item)
  {
    (item.document.sessions || []).forEach(function(raw)
    {
      const node = mergeNode(raw, true, item.path);
      addSource(node, { kind: 'supplement', path: item.path, detail: safeText(item.document.description, 500) || I18n.token('msg.source.supplementMetadata') });
    });
    (item.document.relations || []).forEach(function(raw)
    {
      const evidence = raw.evidence && typeof raw.evidence === 'object' ? { path: safeText(raw.evidence.path, 2000), detail: safeText(raw.evidence.detail, 500) } : raw.evidence;
      allEdges.push(Object.assign({}, raw, { id: 'supplement:' + item.path + ':' + raw.id, source: { kind: 'supplement', path: item.path, detail: safeText(raw.description, 500) || safeText(raw.evidence && raw.evidence.detail, 500) || I18n.token('msg.source.supplementRelation') }, evidence: evidence }));
    });
  });
  aliasDic.forEach(function(ids, name)
  {
    if (ids.size < 2 || !explicitAliases.has(name)) return;
    ids.forEach(function(id) { addConflict(nodeDic.get(id), 'alias', Array.from(ids), I18n.token('msg.conflict.aliasPointsToSeveral', { name: safeText(name) })); });
  });
  function resolve(reference)
  {
    const ref = safeText(reference, 2000);
    if (nodeDic.has(ref)) return ref;
    const matches = aliasDic.get(ref);
    if (matches && matches.size === 1) return Array.from(matches)[0];
    const id = matches ? 'unresolved:alias:' + ref : ref || 'unresolved:empty';
    if (!nodeDic.has(id))
    {
      const node = { id: id, name: ref || I18n.token('msg.node.noIdentifier'), provider: /^(claude|codex):/.test(ref) ? ref.split(':')[0] : 'unknown', kind: 'unresolved', status: 'unknown', statusEvidence: matches ? I18n.token('msg.node.aliasConflict') : I18n.token('msg.node.relationWithoutSession'), sources: [], conflicts: [], observed: false };
      if (matches) addConflict(node, 'alias', Array.from(matches), I18n.token('msg.conflict.aliasMappedToSeveral'));
      nodeDic.set(id, node);
    }
    return id;
  }
  const edgeDic = new Map();
  allEdges.forEach(function(raw, index)
  {
    if (!EDGE_TYPES.includes(raw.type)) return;
    const edge = { id: safeText(raw.id || 'relation:' + index, 2500), from: resolve(raw.from), to: resolve(raw.to), type: raw.type, source: sourceMetadata(raw.source), sources: [], confidence: ['confirmed', 'inferred', 'unresolved'].includes(raw.confidence) ? raw.confidence : 'inferred', requestId: safeText(raw.requestId), status: safeText(raw.status), description: safeText(raw.description, 500), lastSeen: safeText(raw.lastSeen), conflicts: [] };
    if (raw.source) addSource(edge, raw.source);
    if (Array.isArray(raw.sources)) raw.sources.forEach(function(source) { addSource(edge, source); });
    const message = messageMetadata(raw.message);
    if (message) edge.message = message;
    if (edge.type === 'spawn' && !edge.lastSeen) edge.lastSeen = nodeDic.get(edge.to).lastSeen || '';
    if (raw.evidence) { edge.evidence = sourceMetadata(raw.evidence); addSource(edge, raw.evidence); }
    if (!nodeDic.get(edge.from).observed || !nodeDic.get(edge.to).observed) edge.confidence = 'unresolved';
    if (edgeDic.has(edge.id))
    {
      const existing = edgeDic.get(edge.id);
      if (existing.from === edge.from && existing.to === edge.to && existing.type === edge.type)
      {
        edge.sources.forEach(function(source) { addSource(existing, source); });
        return;
      }
      addConflict(existing, 'id', [existing.from + ' → ' + existing.to, edge.from + ' → ' + edge.to], I18n.token('msg.conflict.relationIdReused'));
      addConflict(edge, 'id', [existing.id], I18n.token('msg.conflict.duplicateRelationId'));
      edge.id += ':variant:' + index;
    }
    edgeDic.set(edge.id, edge);
  });
  const nodes = Array.from(nodeDic.values());
  const edges = Array.from(edgeDic.values());
  markHierarchyConflicts(nodeDic, edges);
  markManagementConflicts(nodeDic, edges, diagnostics);
  nodes.forEach(function(node)
  {
    if (!node.project && node.cwd) node.project = Path.basename(node.cwd);
    node.activity = classifyActivity(node);
  });
  // Propagate project labels across native nesting without recursion or depth limits.
  const childrenDic = new Map();
  edges.filter(function(edge) { return edge.type === 'spawn'; }).forEach(function(edge)
  {
    if (!childrenDic.has(edge.from)) childrenDic.set(edge.from, []);
    childrenDic.get(edge.from).push(edge.to);
  });
  const queue = nodes.filter(function(node) { return !!node.project; });
  for (var index = 0; index < queue.length; index++)
  {
    const node = queue[index];
    (childrenDic.get(node.id) || []).forEach(function(id)
    {
      const child = nodeDic.get(id);
      if (!child.project) { child.project = node.project; queue.push(child); }
    });
  }
  const stats = { nodes: nodes.length, edges: edges.length, loading: loading, unresolvedNodes: nodes.filter(function(node) { return !node.observed; }).length, conflictNodes: nodes.filter(function(node) { return node.conflicts.length > 0; }).length, conflictEdges: edges.filter(function(edge) { return edge.conflicts.length > 0; }).length, providers: {}, relations: {}, activity: { recent: 0, inactive: 0, unconfirmed: 0 } };
  nodes.forEach(function(node)
  {
    if (!stats.providers[node.provider]) stats.providers[node.provider] = { sessions: 0, agents: 0, unresolved: 0 };
    stats.providers[node.provider][!node.observed ? 'unresolved' : node.kind === 'agent' ? 'agents' : 'sessions']++;
    stats.activity[node.activity.category]++;
  });
  edges.forEach(function(edge) { stats.relations[edge.type] = (stats.relations[edge.type] || 0) + 1; });
  return { version: version, generatedAt: new Date().toISOString(), nodes: nodes, edges: edges, diagnostics: diagnostics, stats: stats, sourceStatus: sourceStatus };
}

function classifyActivity(node, now)
{
  const timestamp = Date.parse(node.lastSeen || '');
  const elapsed = (now === undefined ? Date.now() : now) - timestamp;
  const result = { category: 'unconfirmed', reason: I18n.token('msg.activity.unconfirmed'), windowMinutes: 120 };
  if (node.archived)
  {
    result.category = 'inactive'; result.reason = I18n.token('msg.activity.archived');
  }
  else if (node.kind === 'agent' && ['completed', 'interrupted'].includes(node.status))
  {
    result.category = 'inactive'; result.reason = I18n.token('msg.activity.agentFinished');
  }
  else if (Number.isFinite(timestamp) && elapsed >= -5 * 60 * 1000)
  {
    result.category = elapsed <= 120 * 60 * 1000 ? 'recent' : 'inactive';
    result.reason = result.category === 'recent' ? I18n.token('msg.activity.recent') : I18n.token('msg.activity.stale');
  }
  return result;
}

function markHierarchyConflicts(nodeDic, edges)
{
  markDirectedConflicts(nodeDic, edges, 'spawn', null);
}

function markManagementConflicts(nodeDic, edges, diagnostics)
{
  markDirectedConflicts(nodeDic, edges, 'management', diagnostics);
}

function markDirectedConflicts(nodeDic, edges, type, diagnostics)
{
  const outgoingDic = new Map();
  const incomingDic = new Map();
  const relationEdges = edges.filter(function(edge) { return edge.type === type; });
  const cycleField = type === 'management' ? 'management-cycle' : 'cycle';
  nodeDic.forEach(function(node, id) { outgoingDic.set(id, []); incomingDic.set(id, []); });
  relationEdges.forEach(function(edge)
  {
    outgoingDic.get(edge.from).push(edge.to);
    incomingDic.get(edge.to).push(edge.from);
  });
  incomingDic.forEach(function(parents, id)
  {
    const unique = Array.from(new Set(parents));
    if (unique.length < 2) return;
    if (type === 'management')
    {
      diagnostics.push({ level: 'info', code: 'shared-management', nodeId: id, managerIds: unique, message: I18n.token('msg.diagnostic.sharedManagement'), source: { kind: 'management', path: '', detail: I18n.token('msg.source.managerMember') } });
    }
    else addConflict(nodeDic.get(id), 'parent', unique, I18n.token('msg.conflict.multipleParents'));
  });
  const visited = new Set();
  const order = [];
  nodeDic.forEach(function(node, start)
  {
    if (visited.has(start)) return;
    const stack = [[start, false]];
    while (stack.length)
    {
      const entry = stack.pop();
      if (entry[1]) { order.push(entry[0]); continue; }
      if (visited.has(entry[0])) continue;
      visited.add(entry[0]);
      stack.push([entry[0], true]);
      outgoingDic.get(entry[0]).forEach(function(id) { if (!visited.has(id)) stack.push([id, false]); });
    }
  });
  const componentDic = new Map();
  const cycleComponents = new Set();
  while (order.length)
  {
    const start = order.pop();
    if (componentDic.has(start)) continue;
    const members = [];
    const stack = [start];
    componentDic.set(start, start);
    while (stack.length)
    {
      const id = stack.pop();
      members.push(id);
      incomingDic.get(id).forEach(function(parent)
      {
        if (!componentDic.has(parent)) { componentDic.set(parent, start); stack.push(parent); }
      });
    }
    if (members.length > 1 || outgoingDic.get(start).includes(start))
    {
      cycleComponents.add(start);
      members.forEach(function(id) { addConflict(nodeDic.get(id), cycleField, [start], type === 'management' ? I18n.token('msg.conflict.managementCycle') : I18n.token('msg.conflict.parentCycle')); });
    }
  }
  relationEdges.forEach(function(edge)
  {
    if (type === 'spawn' && new Set(incomingDic.get(edge.to)).size > 1) addConflict(edge, 'parent', incomingDic.get(edge.to), I18n.token('msg.conflict.multipleParentsEdge'));
    if (componentDic.get(edge.from) === componentDic.get(edge.to) && cycleComponents.has(componentDic.get(edge.from))) addConflict(edge, cycleField, [edge.from, edge.to], type === 'management' ? I18n.token('msg.conflict.managementCycleEdge') : I18n.token('msg.conflict.cycleEdge'));
  });
}

module.exports = { buildGraph: buildGraph, safeText: safeText, safeMessage: safeMessage, classifyActivity: classifyActivity };
