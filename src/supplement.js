/* Local supplemental metadata; no writes to observed sources. */
'use strict';

const Fs = require('node:fs');
const I18n = require('./i18n');
const RELATION_TYPES = ['spawn', 'management', 'dependency', 'collaboration', 'handoff'];
const CONFIDENCES = ['confirmed', 'inferred', 'unresolved'];
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const FIELD_NAME_LIMIT = 80;
const GROUP_NAME_LIMIT = 120;
const PATTERN_LIMIT = 200;

// Field names come from the user's JSON: show them as plain text, so they can neither forge a message token nor grow without bound.
function plain(text)
{
  return I18n.stripMarkers(String(text)).toWellFormed().slice(0, FIELD_NAME_LIMIT).replace(/[\ud800-\udbff]$/, '');
}

function object(value)
{
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value, allowed, location, errors)
{
  Object.keys(value).forEach(function(key)
  {
    if (!allowed.includes(key)) errors.push(I18n.token('msg.supplement.unknownField', { location: location, field: plain(key) }));
  });
}

function checkText(value, key, location, errors, required)
{
  if (value[key] === undefined && !required) return;
  if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 2000)
  {
    errors.push(I18n.token('msg.supplement.textLength', { path: location + '.' + key }));
  }
}

function validateSupplement(document)
{
  const errors = [];
  if (!object(document)) return [I18n.token('msg.supplement.rootObject')];
  const documentLabel = I18n.token('msg.supplement.locationDocument');
  checkKeys(document, ['schemaVersion', 'description', 'sessions', 'relations', 'groups', 'exclude'], documentLabel, errors);
  if (document.schemaVersion !== 1) errors.push(I18n.token('msg.supplement.schemaVersion'));
  checkText(document, 'description', documentLabel, errors, false);
  ['sessions', 'relations'].forEach(function(key)
  {
    if (!Array.isArray(document[key])) errors.push(I18n.token('msg.supplement.arrayRequired', { path: key }));
  });
  const seenSessions = new Set();
  (Array.isArray(document.sessions) ? document.sessions : []).forEach(function(session, index)
  {
    const location = 'sessions[' + index + ']';
    if (!object(session)) return errors.push(I18n.token('msg.supplement.objectRequired', { path: location }));
    checkKeys(session, ['id', 'name', 'aliases', 'project', 'description', 'archived', 'role'], location, errors);
    if (session.archived !== undefined && typeof session.archived !== 'boolean') errors.push(I18n.token('msg.supplement.booleanRequired', { path: location + '.archived' }));
    checkText(session, 'id', location, errors, true);
    if (typeof session.id === 'string' && !/^(claude|codex):[^\s]+$/.test(session.id)) errors.push(I18n.token('msg.supplement.idPrefix', { path: location + '.id' }));
    if (seenSessions.has(session.id)) errors.push(I18n.token('msg.supplement.duplicateSession', { path: location + '.id' }));
    seenSessions.add(session.id);
    ['name', 'project', 'description', 'role'].forEach(function(key) { checkText(session, key, location, errors, false); });
    if (session.aliases !== undefined && (!Array.isArray(session.aliases) || session.aliases.some(function(alias) { return typeof alias !== 'string' || !alias.trim() || alias.length > 2000; }))) errors.push(I18n.token('msg.supplement.aliasesArray', { path: location + '.aliases' }));
  });
  const seenRelations = new Set();
  (Array.isArray(document.relations) ? document.relations : []).forEach(function(relation, index)
  {
    const location = 'relations[' + index + ']';
    if (!object(relation)) return errors.push(I18n.token('msg.supplement.objectRequired', { path: location }));
    checkKeys(relation, ['id', 'from', 'to', 'type', 'description', 'requestId', 'status', 'confidence', 'evidence'], location, errors);
    ['id', 'from', 'to'].forEach(function(key) { checkText(relation, key, location, errors, true); });
    ['description', 'requestId', 'status'].forEach(function(key) { checkText(relation, key, location, errors, false); });
    if (!RELATION_TYPES.includes(relation.type)) errors.push(I18n.token('msg.supplement.relationType', { path: location + '.type' }));
    if (relation.confidence !== undefined && !CONFIDENCES.includes(relation.confidence)) errors.push(I18n.token('msg.supplement.confidenceLevel', { path: location + '.confidence' }));
    if (seenRelations.has(relation.id)) errors.push(I18n.token('msg.supplement.duplicateRelation', { path: location + '.id' }));
    seenRelations.add(relation.id);
    if (relation.evidence !== undefined)
    {
      if (!object(relation.evidence)) errors.push(I18n.token('msg.supplement.objectRequired', { path: location + '.evidence' }));
      else
      {
        checkKeys(relation.evidence, ['path', 'detail'], location + '.evidence', errors);
        ['path', 'detail'].forEach(function(key) { checkText(relation.evidence, key, location + '.evidence', errors, false); });
      }
    }
  });
  validateGroups(document.groups, errors);
  validateExclude(document.exclude, errors);
  return errors;
}

// Logical groups are optional. A group needs an id, a name and a rank (an integer; a smaller rank is a more important group and
// takes the lower floors); its sessions come from listed member IDs, from name patterns, or from both.
function validateGroups(groups, errors)
{
  if (groups === undefined) return;
  if (!Array.isArray(groups)) return errors.push(I18n.token('msg.supplement.arrayRequired', { path: 'groups' }));
  const seen = new Set();
  groups.forEach(function(group, index)
  {
    const location = 'groups[' + index + ']';
    if (!object(group)) return errors.push(I18n.token('msg.supplement.objectRequired', { path: location }));
    checkKeys(group, ['id', 'name', 'rank', 'description', 'members', 'match'], location, errors);
    ['id', 'description'].forEach(function(key) { checkText(group, key, location, errors, key === 'id'); });
    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > GROUP_NAME_LIMIT) errors.push(I18n.token('msg.supplement.groupNameLength', { path: location + '.name' }));
    if (!Number.isSafeInteger(group.rank)) errors.push(I18n.token('msg.supplement.integerRequired', { path: location + '.rank' }));
    if (seen.has(group.id)) errors.push(I18n.token('msg.supplement.duplicateGroup', { path: location + '.id' }));
    seen.add(group.id);
    if (group.members !== undefined && (!Array.isArray(group.members) || group.members.some(function(member) { return typeof member !== 'string' || !/^(claude|codex):[^\s]+$/.test(member) || member.length > 2000; }))) errors.push(I18n.token('msg.supplement.membersArray', { path: location + '.members' }));
    if (group.match !== undefined && (!Array.isArray(group.match) || group.match.some(function(pattern) { return typeof pattern !== 'string' || !pattern.trim() || pattern.length > PATTERN_LIMIT; }))) errors.push(I18n.token('msg.supplement.matchArray', { path: location + '.match' }));
  });
}

// `exclude` is optional. It leaves sessions out of the graph altogether: `archived: true` drops the sessions this file marks archived,
// `match` drops the sessions whose current name fits one of the patterns (same pattern syntax as a group's `match`), and
// `unlisted` (with `project`) drops the observed sessions of those projects that no supplement file lists and that no listed session spawned.
function validateExclude(exclude, errors)
{
  if (exclude === undefined) return;
  if (!object(exclude)) return errors.push(I18n.token('msg.supplement.objectRequired', { path: 'exclude' }));
  checkKeys(exclude, ['archived', 'match', 'unlisted', 'project'], 'exclude', errors);
  if (exclude.archived !== undefined && typeof exclude.archived !== 'boolean') errors.push(I18n.token('msg.supplement.booleanRequired', { path: 'exclude.archived' }));
  if (exclude.unlisted !== undefined && typeof exclude.unlisted !== 'boolean') errors.push(I18n.token('msg.supplement.booleanRequired', { path: 'exclude.unlisted' }));
  checkText(exclude, 'project', 'exclude', errors, false);
  // `unlisted` reaches every observed session that no file lists, so it must say which projects it looks at (a pattern; * = all).
  if (exclude.unlisted === true && exclude.project === undefined) errors.push(I18n.token('msg.supplement.unlistedNeedsProject', { path: 'exclude.project' }));
  if (exclude.match !== undefined && (!Array.isArray(exclude.match) || exclude.match.some(function(pattern) { return typeof pattern !== 'string' || !pattern.trim() || pattern.length > PATTERN_LIMIT; }))) errors.push(I18n.token('msg.supplement.matchArray', { path: 'exclude.match' }));
}

function loadSupplement(path, callback)
{
  Fs.stat(path, function(error, stat)
  {
    if (error) return callback(error);
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return callback(new Error(I18n.token('msg.supplement.fileTooLarge')));
    Fs.readFile(path, 'utf8', function(readError, text)
    {
      if (readError) return callback(readError);
      var document = null;
      try { document = JSON.parse(text); }
      catch (parseError) { return callback(new Error(I18n.token('msg.supplement.jsonSyntax'))); }
      const errors = validateSupplement(document);
      if (errors.length) return callback(new Error(errors.join('\n')));
      callback(null, document);
    });
  });
}

module.exports = { validateSupplement: validateSupplement, loadSupplement: loadSupplement };
