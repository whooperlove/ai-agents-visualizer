/* Evidence-preserving graph merge. Only allowlisted metadata leaves the server. */
'use strict';

const Path = require('node:path');
const I18n = require('./i18n');
const NODE_FIELDS = ['provider', 'sessionId', 'name', 'cwd', 'project', 'account', 'kind', 'status', 'statusEvidence', 'lastSeen', 'model', 'effort', 'description', 'role'];
const STATUSES = ['running', 'waiting', 'idle', 'completed', 'interrupted', 'unknown'];
const EDGE_TYPES = ['spawn', 'management', 'dependency', 'collaboration', 'handoff'];
const SOURCE_KEYS = Symbol('sourceKeys');
const TEXT_LIMIT = 240;
const GROUP_NAME_LIMIT = 120;
// The excluded sessions are named in one diagnostic; a longer list is cut here (the counts stay exact).
const EXCLUDED_LIST_LIMIT = 200;
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

// Supplement group patterns: * stands for any run of characters, ? for one character, everything else is literal. Case is ignored.
// The matcher walks the text once and remembers only the last *, so a pattern cannot blow up on a long name.
function globMatch(pattern, text)
{
  var p = 0;
  var t = 0;
  var star = -1;
  var mark = 0;
  while (t < text.length)
  {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

// The logical groups the supplement files define, in the order they are listed. A group id that a later file repeats is ignored.
function collectGroups(supplements, diagnostics)
{
  const groups = [];
  const seen = new Set();
  supplements.forEach(function(item)
  {
    (Array.isArray(item.document.groups) ? item.document.groups : []).forEach(function(raw)
    {
      const id = safeText(raw.id, 200);
      if (!id) return;
      if (seen.has(id))
      {
        diagnostics.push({ level: 'info', code: 'supplement-group-duplicate', message: I18n.token('msg.diagnostic.groupDuplicate', { id: limitText(id, 160) }), source: sourceMetadata({ kind: 'supplement', path: item.path, detail: id }) });
        return;
      }
      seen.add(id);
      const group = { id: id, name: safeText(raw.name, GROUP_NAME_LIMIT) || id, rank: Number.isInteger(raw.rank) ? raw.rank : 0, order: groups.length, origin: item.path, members: new Set((Array.isArray(raw.members) ? raw.members : []).map(function(member) { return safeText(member, 2000); })), patterns: (Array.isArray(raw.match) ? raw.match : []).map(function(pattern) { return String(pattern).toLowerCase(); }) };
      const description = safeText(raw.description, 500);
      if (description) group.description = description;
      groups.push(group);
    });
  });
  return groups;
}

// Puts every session into at most one group. A listed member beats a name pattern; after that the smaller rank wins (the group
// listed first when ranks tie). Sessions a grouped session spawned natively and no group claims follow their spawn parent, so a
// tree stays together. Returns the group records the viewer needs: id, name, rank and the optional description.
function assignGroups(nodes, edges, supplements, diagnostics)
{
  const groups = collectGroups(supplements, diagnostics);
  if (!groups.length) return [];
  const byId = new Map(groups.map(function(group) { return [group.id, group]; }));
  const before = function(first, second) { return first.rank - second.rank || first.order - second.order; };
  nodes.forEach(function(node)
  {
    const names = [node.name].concat(node.aliases || []).filter(Boolean).map(function(name) { return name.toLowerCase(); });
    const explicit = groups.filter(function(group) { return group.members.has(node.id); });
    const named = groups.filter(function(group) { return !group.members.has(node.id) && group.patterns.some(function(pattern) { return names.some(function(name) { return globMatch(pattern, name); }); }); });
    const candidates = explicit.sort(before).concat(named.sort(before));
    if (!candidates.length) return;
    node.group = candidates[0].id;
    if (candidates.length > 1)
    {
      const chosen = candidates[0];
      diagnostics.push({ level: 'info', code: 'supplement-group-overlap', nodeId: node.id, message: I18n.token('msg.diagnostic.groupOverlap', { name: limitText(node.name, 160), groups: limitText(candidates.map(function(group) { return group.name; }).join(', '), 240), chosen: limitText(chosen.name, 160) }), source: sourceMetadata({ kind: 'supplement', path: chosen.origin, detail: node.id }) });
    }
  });
  const children = new Map();
  edges.filter(function(edge) { return edge.type === 'spawn'; }).forEach(function(edge)
  {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from).push(edge.to);
  });
  const nodeById = new Map(nodes.map(function(node) { return [node.id, node]; }));
  const queue = nodes.filter(function(node) { return node.group !== undefined; }).sort(function(first, second)
  {
    return before(byId.get(first.group), byId.get(second.group)) || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
  });
  for (var index = 0; index < queue.length; index++)
  {
    (children.get(queue[index].id) || []).forEach(function(id)
    {
      const child = nodeById.get(id);
      if (child && child.group === undefined) { child.group = queue[index].group; queue.push(child); }
    });
  }
  return groups.map(function(group)
  {
    const record = { id: group.id, name: group.name, rank: group.rank };
    if (group.description) record.description = group.description;
    return record;
  });
}

// The sessions the supplement files ask to leave out of the graph (`exclude`). Several files add up: archived is on when any file
// turns it on, and the patterns and the unlisted project scopes of all files are used. Returns null when no file excludes anything.
function collectExclude(supplements)
{
  const rule = { archived: false, patterns: [], unlisted: [], origin: '' };
  supplements.forEach(function(item)
  {
    const raw = item.document.exclude;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const patterns = (Array.isArray(raw.match) ? raw.match : []).map(function(pattern) { return String(pattern).toLowerCase(); });
    // `unlisted` only counts with a project scope; without one it would reach every project the viewer shows.
    const scope = raw.unlisted === true && typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim().toLowerCase() : '';
    if (raw.archived !== true && !patterns.length && !scope) return;
    if (!rule.origin) rule.origin = item.path;
    if (raw.archived === true) rule.archived = true;
    rule.patterns = rule.patterns.concat(patterns);
    if (scope) rule.unlisted.push(scope);
  });
  return rule.origin ? rule : null;
}

// The nodes reachable from `start` through `children` (a Map of id to a Set of ids), visiting only ids that `allowed` accepts.
// The start nodes themselves count as reached only when `includeStart` is set.
function reachable(start, children, allowed, includeStart)
{
  const reached = new Set(includeStart ? start : []);
  const queue = start.slice();
  for (var index = 0; index < queue.length; index++)
  {
    (children.has(queue[index]) ? Array.from(children.get(queue[index])) : []).forEach(function(id)
    {
      if (reached.has(id) || !allowed(id)) return;
      reached.add(id);
      queue.push(id);
    });
  }
  return reached;
}

// Removes the excluded sessions before any relation is resolved, so no edge, conflict, count, group or floor can mention them.
// A session is excluded when the supplement marks it archived (rule.archived) or when its current name fits a pattern. Aliases are
// not matched: an alias is an older or another name, and a revived session can still carry a retired "-gNN" one. The archived mark
// counts even when the observed name differs from the file's (the display rule that ignores it for a renamed session does not
// apply: a retired session the map labels "x (g07)" while its title stays "x" must not stay on the screen). A session that a
// supplement lists with an up-to-date name and without archived is that file's own statement about it, so it wins over a name
// pattern (the same precedence as a listed group member). The sub-agents an excluded session spawned go with it, unless a
// session that stays spawned them too. With `unlisted` (limited to the projects it names) an observed session that no supplement
// file lists in `sessions` is excluded as well, unless a kept, listed session spawned it (directly or through other spawned
// sessions): the only thing that spares an unlisted session is being the child of a listed one, never its name or a group
// pattern. Returns the relations that remain; leaves one info diagnostic with the counts and the names.
function excludeSessions(rule, nodeDic, aliasDic, allEdges, listed, marked, declared, lookup, diagnostics)
{
  const reasons = new Map();
  nodeDic.forEach(function(node, id)
  {
    if (rule.archived && marked.has(id)) { reasons.set(id, 'archived'); return; }
    if (!rule.patterns.length || listed.has(id) && !marked.has(id)) return;
    const name = String(node.name).toLowerCase();
    if (rule.patterns.some(function(pattern) { return globMatch(pattern, name); })) reasons.set(id, 'match');
  });
  const ends = allEdges.map(function(raw) { return [lookup(raw.from), lookup(raw.to)]; });
  const children = new Map();
  const parents = new Map();
  allEdges.forEach(function(raw, index)
  {
    const from = ends[index][0];
    const to = ends[index][1];
    if (raw.type !== 'spawn' || !from || !to || from === to) return;
    if (!children.has(from)) children.set(from, new Set());
    children.get(from).add(to);
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to).add(from);
  });
  if (rule.unlisted.length)
  {
    const claimed = reachable(Array.from(nodeDic.keys()).filter(function(id) { return declared.has(id) && !reasons.has(id); }), children, function(id) { return !reasons.has(id); }, true);
    nodeDic.forEach(function(node, id)
    {
      if (reasons.has(id) || claimed.has(id)) return;
      const project = String(node.project || (node.cwd ? Path.basename(node.cwd) : '')).toLowerCase();
      if (rule.unlisted.some(function(scope) { return globMatch(scope, project); })) reasons.set(id, 'unlisted');
    });
  }
  if (!reasons.size) return allEdges;
  // Everything below an excluded session ("below"), then the part of it that a session which stays also reaches: a node survives when
  // a spawn parent outside the excluded sessions and their descendants spawned it (or a supplement lists it), and so does everything
  // that survivor spawned.
  const below = reachable(Array.from(reasons.keys()), children, function(id) { return !reasons.has(id); });
  const survivors = reachable(Array.from(below).filter(function(id)
  {
    return declared.has(id) || Array.from(parents.get(id)).some(function(parent) { return !reasons.has(parent) && !below.has(parent); });
  }), children, function(id) { return below.has(id); }, true);
  const removed = new Set(reasons.keys());
  below.forEach(function(id) { if (!survivors.has(id)) removed.add(id); });
  // An unlisted node that a removed session spawned counts as one of that session's sub-agents, not as a session of its own.
  const direct = Array.from(reasons.keys()).filter(function(id)
  {
    return reasons.get(id) !== 'unlisted' || !parents.has(id) || !Array.from(parents.get(id)).some(function(parent) { return removed.has(parent); });
  });
  const spawned = removed.size - direct.length;
  const shown = direct.slice(0, EXCLUDED_LIST_LIMIT).map(function(id) { return { id: safeText(id, 2000), name: safeText(nodeDic.get(id).name, 300), reason: reasons.get(id) }; });
  const count = function(reason) { return direct.filter(function(id) { return reasons.get(id) === reason; }).length; };
  const archived = count('archived');
  const unlisted = count('unlisted');
  removed.forEach(function(id) { nodeDic.delete(id); });
  aliasDic.forEach(function(ids, name)
  {
    ids.forEach(function(id) { if (removed.has(id)) ids.delete(id); });
    if (!ids.size) aliasDic.delete(name);
  });
  for (var position = diagnostics.length - 1; position >= 0; position--)
  {
    const item = diagnostics[position];
    if (item.code === 'supplement-name-stale' && item.source && removed.has(item.source.detail)) diagnostics.splice(position, 1);
  }
  const counts = { count: direct.length, archived: archived, matched: direct.length - archived - unlisted, spawned: spawned };
  // The wording only grows the "listed in no supplement file" part when `unlisted` is on, so the other settings keep their text.
  if (rule.unlisted.length) counts.unlisted = unlisted;
  diagnostics.push({ level: 'info', code: 'supplement-exclude', message: I18n.token(rule.unlisted.length ? 'msg.diagnostic.sessionsExcludedUnlisted' : 'msg.diagnostic.sessionsExcluded', counts), excluded: shown, source: sourceMetadata({ kind: 'supplement', path: rule.origin, detail: '' }) });
  return allEdges.filter(function(raw, position) { return !removed.has(ends[position][0]) && !removed.has(ends[position][1]); });
}

function buildGraph(snapshots, supplements, version)
{
  const nodeDic = new Map();
  const aliasDic = new Map();
  const explicitAliases = new Set();
  const fallbackNames = new Set();
  const diagnostics = [];
  var allEdges = [];
  // Sessions a supplement lists with an up-to-date name (a name pattern of `exclude` never hides them), and the ones it marks
  // archived whatever the observed name is (the last file that says so wins, like node.archived).
  const listed = new Set();
  const marked = new Set();
  // Every session some supplement file lists in `sessions`, whatever its name or archived state is.
  const declared = new Set();
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
    if (isSupplement && !staleName) listed.add(id);
    if (isSupplement) declared.add(id);
    if (isSupplement && typeof raw.archived === 'boolean') marked[raw.archived ? 'add' : 'delete'](id);
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
  const exclusion = collectExclude(supplements);
  if (exclusion) allEdges = excludeSessions(exclusion, nodeDic, aliasDic, allEdges, listed, marked, declared, lookup, diagnostics);
  aliasDic.forEach(function(ids, name)
  {
    if (ids.size < 2 || !explicitAliases.has(name)) return;
    ids.forEach(function(id) { addConflict(nodeDic.get(id), 'alias', Array.from(ids), I18n.token('msg.conflict.aliasPointsToSeveral', { name: safeText(name) })); });
  });
  // The session a relation endpoint names: an ID, or an alias that points at exactly one session. Null when there is none.
  function lookup(reference)
  {
    const ref = safeText(reference, 2000);
    if (nodeDic.has(ref)) return ref;
    const matches = aliasDic.get(ref);
    return matches && matches.size === 1 ? Array.from(matches)[0] : null;
  }
  function resolve(reference)
  {
    const known = lookup(reference);
    if (known) return known;
    const ref = safeText(reference, 2000);
    const matches = aliasDic.get(ref);
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
  const groups = assignGroups(nodes, edges, supplements, diagnostics);
  const stats = { nodes: nodes.length, edges: edges.length, loading: loading, unresolvedNodes: nodes.filter(function(node) { return !node.observed; }).length, conflictNodes: nodes.filter(function(node) { return node.conflicts.length > 0; }).length, conflictEdges: edges.filter(function(edge) { return edge.conflicts.length > 0; }).length, providers: {}, relations: {}, activity: { recent: 0, inactive: 0, unconfirmed: 0 } };
  nodes.forEach(function(node)
  {
    if (!stats.providers[node.provider]) stats.providers[node.provider] = { sessions: 0, agents: 0, unresolved: 0 };
    stats.providers[node.provider][!node.observed ? 'unresolved' : node.kind === 'agent' ? 'agents' : 'sessions']++;
    stats.activity[node.activity.category]++;
  });
  edges.forEach(function(edge) { stats.relations[edge.type] = (stats.relations[edge.type] || 0) + 1; });
  const graph = { version: version, generatedAt: new Date().toISOString(), nodes: nodes, edges: edges, diagnostics: diagnostics, stats: stats, sourceStatus: sourceStatus };
  // Only a supplement that lists groups adds this key, so a graph without groups looks exactly as before.
  if (groups.length) graph.groups = groups;
  return graph;
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
