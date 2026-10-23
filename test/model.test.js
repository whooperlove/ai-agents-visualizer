'use strict';
const Test = require('node:test');
const Assert = require('node:assert/strict');
const Model = require('../src/model');
const Supplement = require('../src/supplement');
const I18n = require('./helpers/i18n').loadNodeI18n();

function ko(text)
{
  return I18n.resolve(text, 'ko');
}

function en(text)
{
  return I18n.resolve(text, 'en');
}

function node(id, extra)
{
  return Object.assign({ id: id, provider: id.split(':')[0], name: id, status: 'unknown', sources: [] }, extra);
}

function graph(nodes, edges, documents)
{
  return Model.buildGraph([{ nodes: nodes, edges: edges }], (documents || []).map(function(document) { return { path: '/fixture/supplement.json', document: document }; }), 1);
}

Test('보충 별칭 병합·미확인 endpoint 보존·도구 원문 제거', function()
{
  const document = { schemaVersion: 1, sessions: [{ id: 'claude:a', name: '부모', aliases: ['master'] }], relations: [{ id: 'wait', from: 'master', to: 'missing', type: 'dependency' }] };
  const result = graph([node('claude:a', { status: 'running', message: 'PRIVATE_RAW_TOOL_OUTPUT', description: 'token=abc123' })], [], [document]);
  Assert.equal(result.nodes.find(function(item) { return item.id === 'claude:a'; }).status, 'running');
  Assert.equal(result.edges[0].from, 'claude:a');
  Assert.equal(result.edges[0].confidence, 'unresolved');
  Assert.equal(result.nodes.find(function(item) { return item.id === 'missing'; }).kind, 'unresolved');
  Assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_TOOL_OUTPUT'), false);
  Assert.equal(JSON.stringify(result).includes('abc123'), false);
  const known = result.nodes.find(function(item) { return item.id === 'claude:a'; });
  Assert.equal(ko(known.description), 'token=[숨김]');
  Assert.equal(en(known.description), 'token=[hidden]');
  Assert.equal(ko(known.sources[0].detail), '사용자 보충 메타데이터');
  Assert.equal(en(known.sources[0].detail), 'User supplement metadata');
  const missing = result.nodes.find(function(item) { return item.id === 'missing'; });
  Assert.equal(ko(missing.statusEvidence), '관계는 있으나 세션 기록 미확인');
  Assert.equal(en(missing.statusEvidence), 'A relation exists but no session record was found');
  Assert.equal(ko(result.edges[0].source.detail), '사용자 보충 관계');
  Assert.equal(en(result.edges[0].source.detail), 'User supplement relation');
});

Test('서로 다른 부모·순환을 숨기거나 삭제하지 않음', function()
{
  const result = graph([node('claude:a'), node('codex:b'), node('codex:c')], [
    { id: 'ab', from: 'claude:a', to: 'codex:b', type: 'spawn' },
    { id: 'cb', from: 'codex:c', to: 'codex:b', type: 'spawn' },
    { id: 'bc', from: 'codex:b', to: 'codex:c', type: 'spawn' }
  ]);
  Assert.equal(result.edges.length, 3);
  Assert.ok(result.nodes.find(function(item) { return item.id === 'codex:b'; }).conflicts.some(function(item) { return item.field === 'parent'; }));
  Assert.equal(result.nodes.find(function(item) { return item.id === 'claude:a'; }).conflicts.length, 0);
  Assert.ok(result.edges.find(function(item) { return item.id === 'bc'; }).conflicts.some(function(item) { return item.field === 'cycle'; }));
  function conflictTexts(item, field, locale) { return item.conflicts.filter(function(conflict) { return conflict.field === field; }).map(function(conflict) { return I18n.resolve(conflict.message, locale); }); }
  const doubled = result.nodes.find(function(item) { return item.id === 'codex:b'; });
  Assert.deepEqual(conflictTexts(doubled, 'parent', 'ko'), ['부모 관계가 여러 개입니다.']);
  Assert.deepEqual(conflictTexts(doubled, 'parent', 'en'), ['There are several parent relations.']);
  Assert.deepEqual(conflictTexts(doubled, 'cycle', 'ko'), ['부모 관계에 순환이 있습니다.']);
  Assert.deepEqual(conflictTexts(doubled, 'cycle', 'en'), ['The parent relations contain a cycle.']);
  const bc = result.edges.find(function(item) { return item.id === 'bc'; });
  Assert.deepEqual(conflictTexts(bc, 'cycle', 'ko'), ['순환 관계']);
  Assert.deepEqual(conflictTexts(bc, 'cycle', 'en'), ['Cycle relation']);
  const ab = result.edges.find(function(item) { return item.id === 'ab'; });
  Assert.deepEqual(conflictTexts(ab, 'parent', 'ko'), ['다중 부모 관계']);
  Assert.deepEqual(conflictTexts(ab, 'parent', 'en'), ['Multiple-parent relation']);
});

Test('충돌 별칭은 임의 선택하지 않고 별도 미확인 노드로 유지', function()
{
  const result = graph([node('claude:a'), node('codex:b')], [], [{ schemaVersion: 1, sessions: [{ id: 'claude:a', aliases: ['shared'] }, { id: 'codex:b', aliases: ['shared'] }], relations: [{ id: 'x', from: 'shared', to: 'codex:b', type: 'handoff' }] }]);
  Assert.equal(result.edges[0].from, 'unresolved:alias:shared');
  Assert.ok(result.nodes.filter(function(item) { return item.conflicts.length > 0; }).length >= 3);
  const shared = result.nodes.find(function(item) { return item.id === 'claude:a'; });
  Assert.equal(ko(shared.conflicts[0].message), '동일 별칭이 여러 세션을 가리킵니다: shared');
  Assert.equal(en(shared.conflicts[0].message), 'The same alias points to several sessions: shared');
  const placeholder = result.nodes.find(function(item) { return item.id === 'unresolved:alias:shared'; });
  Assert.equal(ko(placeholder.statusEvidence), '별칭 충돌: 하나의 세션으로 확정할 수 없음');
  Assert.equal(en(placeholder.statusEvidence), 'Alias conflict: cannot be resolved to a single session');
  Assert.equal(ko(placeholder.conflicts[0].message), '여러 세션에 매핑된 별칭');
  Assert.equal(en(placeholder.conflicts[0].message), 'Alias mapped to several sessions');
});

Test('깊이 12000 계층을 재귀나 개수 제한 없이 처리', function()
{
  const nodes = [];
  const edges = [];
  for (var index = 0; index < 12000; index++)
  {
    nodes.push(node('codex:' + index, index === 0 ? { project: 'alpha' } : {}));
    if (index) edges.push({ id: 'e' + index, from: 'codex:' + (index - 1), to: 'codex:' + index, type: 'spawn' });
  }
  const result = graph(nodes, edges);
  Assert.equal(result.nodes.length, 12000);
  Assert.equal(result.nodes[11999].project, 'alpha');
  Assert.equal(result.stats.conflictNodes, 0);
});

Test('스키마는 상태 덮어쓰기·중복 ID·잘못된 구조를 거부', function()
{
  Assert.equal(Supplement.validateSupplement({ schemaVersion: 1, sessions: [], relations: [] }).length, 0);
  Assert.ok(Supplement.validateSupplement({ schemaVersion: 1, sessions: [{ id: 'codex:a', status: 'running' }], relations: [] }).length);
  Assert.ok(Supplement.validateSupplement({ schemaVersion: 1, sessions: [{ id: 'codex:a' }, { id: 'codex:a' }], relations: [] }).length);
  Assert.ok(Supplement.validateSupplement({ schemaVersion: 2, sessions: {}, relations: [null] }).length);
});

Test('보충 검증 오류는 메시지 토큰이며 언어별로 렌더링됨', function()
{
  function errors(document, locale) { return Supplement.validateSupplement(document).map(function(text) { return I18n.resolve(text, locale); }); }
  Assert.deepEqual(errors({ schemaVersion: 2, sessions: {}, relations: [null] }, 'ko'), ['schemaVersion은 1이어야 합니다.', 'sessions: 배열이어야 합니다.', 'relations[0]: 객체이어야 합니다.']);
  Assert.deepEqual(errors({ schemaVersion: 2, sessions: {}, relations: [null] }, 'en'), ['schemaVersion must be 1.', 'sessions: must be an array.', 'relations[0]: must be an object.']);
  Assert.deepEqual(errors([], 'ko'), ['최상위 값은 JSON 객체여야 합니다.']);
  Assert.deepEqual(errors('text', 'en'), ['The top-level value must be a JSON object.']);
  Assert.deepEqual(errors({ schemaVersion: 1, description: 5, extra: 1, sessions: [], relations: [] }, 'ko'), ['문서: 알 수 없는 필드 extra', '문서.description: 1~2000자 문자열이어야 합니다.']);
  Assert.deepEqual(errors({ schemaVersion: 1, description: 5, extra: 1, sessions: [], relations: [] }, 'en'), ['document: unknown field extra', 'document.description: must be a string of 1 to 2000 characters.']);
  const sessions = { schemaVersion: 1, relations: [], sessions: [{ id: 'codex:a', status: 'running', archived: 'no', aliases: [''], name: '' }, { id: 'codex:a' }, { id: 'plain' }, 7] };
  Assert.deepEqual(errors(sessions, 'en'), [
    'sessions[0]: unknown field status', 'sessions[0].archived: must be a boolean.', 'sessions[0].name: must be a string of 1 to 2000 characters.', 'sessions[0].aliases: must be an array of non-empty strings.',
    'sessions[1].id: duplicate session.', 'sessions[2].id: needs a "claude:" or "codex:" prefix.', 'sessions[3]: must be an object.'
  ]);
  Assert.equal(errors(sessions, 'ko')[1], 'sessions[0].archived: boolean이어야 합니다.');
  Assert.equal(errors(sessions, 'ko')[4], 'sessions[1].id: 중복 세션입니다.');
  Assert.equal(errors(sessions, 'ko')[5], 'sessions[2].id: claude: 또는 codex: 접두사가 필요합니다.');
  Assert.equal(errors(sessions, 'ko')[3], 'sessions[0].aliases: 비어 있지 않은 문자열 배열이어야 합니다.');
  const relations = { schemaVersion: 1, sessions: [], relations: [{ id: 'r', from: 'a', to: 'b', type: 'friend', confidence: 'sure', evidence: 5 }, { id: 'r', from: 'a', to: 'b', type: 'spawn' }] };
  Assert.deepEqual(errors(relations, 'en'), ['relations[0].type: unsupported relation type.', 'relations[0].confidence: unsupported confidence level.', 'relations[0].evidence: must be an object.', 'relations[1].id: duplicate relation.']);
  Assert.deepEqual(errors(relations, 'ko'), ['relations[0].type: 지원하지 않는 관계 종류입니다.', 'relations[0].confidence: 지원하지 않는 신뢰 구분입니다.', 'relations[0].evidence: 객체이어야 합니다.', 'relations[1].id: 중복 관계입니다.']);
  Assert.equal(I18n.missingKeys().length, 0);
});

Test('보충 필드 이름은 메시지 토큰을 위조하지 못하고 길이가 제한됨', function()
{
  const forged = '⟦msg.node.noIdentifier⟧';
  const document = { schemaVersion: 1, sessions: [], relations: [] };
  document[forged] = 1;
  document['k'.repeat(300)] = 1;
  const messages = Supplement.validateSupplement(document);
  Assert.equal(en(messages[0]), 'document: unknown field [msg.node.noIdentifier]');
  Assert.equal(en(messages[1]), 'document: unknown field ' + 'k'.repeat(80));
  Assert.equal(messages.join('').includes(forged), false);
});

Test('보충 파일 읽기 오류도 메시지 토큰이며 줄마다 렌더링됨', function(t, done)
{
  const Fs = require('node:fs');
  const Os = require('node:os');
  const Path = require('node:path');
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'supplement-test-'));
  t.after(function() { Fs.rmSync(directory, { recursive: true, force: true }); });
  Fs.writeFileSync(Path.join(directory, 'broken.json'), '{ not json');
  Fs.writeFileSync(Path.join(directory, 'invalid.json'), JSON.stringify({ schemaVersion: 2, sessions: [], relations: [], extra: true }));
  Supplement.loadSupplement(Path.join(directory, 'broken.json'), function(syntaxError)
  {
    Assert.equal(ko(syntaxError.message), 'JSON 문법 오류');
    Assert.equal(en(syntaxError.message), 'JSON syntax error');
    Supplement.loadSupplement(Path.join(directory, 'invalid.json'), function(invalidError)
    {
      Assert.deepEqual(ko(invalidError.message).split('\n'), ['문서: 알 수 없는 필드 extra', 'schemaVersion은 1이어야 합니다.']);
      Assert.deepEqual(en(invalidError.message).split('\n'), ['document: unknown field extra', 'schemaVersion must be 1.']);
      done();
    });
  });
});

Test('native agent 이름·종류·최신 상태는 bridge/과거 증거가 덮어쓰지 않음', function()
{
  const result = graph([
    node('codex:a', { sessionId: 'a', name: '현재 에이전트', kind: 'agent', status: 'running', statusEvidence: '최신', lastSeen: '2026-10-23T00:00:00Z' }),
    node('codex:a', { sessionId: 'a', name: 'a', kind: 'session', status: 'idle', statusEvidence: '과거', lastSeen: '2026-10-22T00:00:00Z' })
  ], []);
  Assert.equal(result.nodes[0].kind, 'agent');
  Assert.equal(result.nodes[0].name, '현재 에이전트');
  Assert.equal(result.nodes[0].status, 'running');
  Assert.equal(result.nodes[0].statusEvidence, '최신');
});

Test('동명이인 agent는 별칭 충돌이 아니며 긴 보충 이름의 참조는 정확히 해석', function()
{
  const longName = '가'.repeat(600);
  const result = graph([node('codex:a', { name: 'general-purpose' }), node('codex:b', { name: 'general-purpose' })], [], [{ schemaVersion: 1, sessions: [{ id: 'codex:a', name: longName }], relations: [{ id: 'name-ref', from: longName, to: 'codex:b', type: 'collaboration' }] }]);
  Assert.equal(result.nodes.length, 2);
  Assert.equal(result.stats.conflictNodes, 0);
  Assert.equal(result.edges[0].from, 'codex:a');
});

Test('최근 활동·비활성·명시 은퇴·시각 미확인은 실행 상태와 별도 분류', function()
{
  const now = Date.parse('2026-10-23T00:00:00Z');
  Assert.equal(Model.classifyActivity({ kind: 'session', status: 'idle', lastSeen: '2026-10-22T23:30:00Z' }, now).category, 'recent');
  Assert.equal(Model.classifyActivity({ kind: 'agent', status: 'completed', lastSeen: '2026-10-22T23:59:00Z' }, now).category, 'inactive');
  Assert.equal(Model.classifyActivity({ lastSeen: '2026-10-22T20:00:00Z' }, now).category, 'inactive');
  Assert.equal(Model.classifyActivity({ archived: true, lastSeen: '2026-10-22T23:59:00Z' }, now).category, 'inactive');
  Assert.equal(Model.classifyActivity({}, now).category, 'unconfirmed');
  Assert.equal(Model.classifyActivity({ lastSeen: '2026-10-24T00:00:00Z' }, now).category, 'unconfirmed');
});

Test('활동 분류 사유는 메시지 토큰이며 언어별로 렌더링됨', function()
{
  const now = Date.parse('2026-10-23T00:00:00Z');
  const cases = [
    [{}, '마지막 활동 시각을 확인할 수 없습니다.', 'The last activity time could not be determined.'],
    [{ archived: true }, '보충 메타데이터에서 은퇴·보관한 세션으로 지정했습니다.', 'Marked as retired or archived in the supplement metadata.'],
    [{ kind: 'agent', status: 'completed', lastSeen: '2026-10-22T23:59:00Z' }, '완료 또는 중단된 하위 에이전트입니다.', 'A sub-agent that completed or was interrupted.'],
    [{ lastSeen: '2026-10-22T23:30:00Z' }, '최근 2시간 안에 활동 기록이 있습니다. 현재 실행을 보증하지 않습니다.', 'Activity was recorded within the last 2 hours. This does not guarantee that it is running now.'],
    [{ lastSeen: '2026-10-22T20:00:00Z' }, '최근 활동 기록이 2시간보다 오래되었습니다. 종료를 확정한 것은 아닙니다.', 'The latest recorded activity is more than 2 hours old. It has not been confirmed as ended.']
  ];
  cases.forEach(function(item)
  {
    const reason = Model.classifyActivity(item[0], now).reason;
    Assert.equal(ko(reason), item[1]);
    Assert.equal(en(reason), item[2]);
  });
});

Test('논리적 관리와 생성 부모는 독립이며 공동 관리는 정보로 보존', function()
{
  const result = graph([node('claude:master'), node('codex:director'), node('codex:member')], [
    { id: 'native', from: 'codex:member', to: 'claude:master', type: 'spawn' },
    { id: 'managed-a', from: 'claude:master', to: 'codex:member', type: 'management', confidence: 'confirmed', source: { kind: 'document', path: '/fixture/team.md', detail: '4행' } },
    { id: 'managed-b', from: 'codex:director', to: 'codex:member', type: 'management', confidence: 'inferred', source: { kind: 'document', path: '/fixture/team.md', detail: '7행' } }
  ], [{ schemaVersion: 1, sessions: [{ id: 'claude:master', aliases: ['logical-master'], role: '전체 조정' }], relations: [] }]);
  Assert.equal(result.stats.relations.management, 2);
  Assert.equal(result.stats.conflictNodes, 0);
  Assert.equal(result.stats.conflictEdges, 0);
  Assert.equal(result.nodes.find(function(item) { return item.id === 'claude:master'; }).role, '전체 조정');
  const notice = result.diagnostics.find(function(item) { return item.code === 'shared-management'; });
  Assert.equal(notice.level, 'info');
  Assert.equal(ko(notice.message), '여러 세션이 논리적 관리를 공유합니다. 생성 부모 충돌과는 별개입니다.');
  Assert.equal(en(notice.message), 'Several sessions share logical management. This is separate from a spawn-parent conflict.');
  Assert.equal(ko(notice.source.detail), 'manager → member 보충 관계');
  Assert.equal(en(notice.source.detail), 'manager → member supplement relation');
  Assert.equal(notice.nodeId, 'codex:member');
  Assert.deepEqual(notice.managerIds, ['claude:master', 'codex:director']);
  Assert.equal(result.edges.find(function(item) { return item.id === 'managed-b'; }).confidence, 'inferred');
});

Test('논리적 관리 순환은 별도 충돌이며 중복 근거도 잃지 않음', function()
{
  const result = graph([node('claude:a'), node('codex:b'), node('codex:outside')], [
    { id: 'ab', from: 'claude:a', to: 'codex:b', type: 'management', source: { kind: 'document', path: '/fixture/one.md', detail: '1행' }, sources: [{ kind: 'document', path: '/fixture/one.md', detail: '1행' }] },
    { id: 'ab', from: 'claude:a', to: 'codex:b', type: 'management', source: { kind: 'document', path: '/fixture/two.md', detail: '2행' }, evidence: { path: '/fixture/evidence.md', detail: '3행' } },
    { id: 'ba', from: 'codex:b', to: 'claude:a', type: 'management' },
    { id: 'outer', from: 'codex:outside', to: 'claude:a', type: 'management' }
  ]);
  Assert.equal(result.edges.length, 3);
  const edge = result.edges.find(function(item) { return item.id === 'ab'; });
  Assert.deepEqual(edge.sources.map(function(source) { return source.path; }), ['/fixture/one.md', '/fixture/two.md', '/fixture/evidence.md']);
  Assert.deepEqual(edge.conflicts.map(function(item) { return item.field; }), ['management-cycle']);
  Assert.deepEqual(result.nodes.find(function(item) { return item.id === 'claude:a'; }).conflicts.map(function(item) { return item.field; }), ['management-cycle']);
  Assert.equal(ko(edge.conflicts[0].message), '논리적 관리 순환 관계');
  Assert.equal(en(edge.conflicts[0].message), 'Logical management cycle relation');
  Assert.equal(ko(result.nodes.find(function(item) { return item.id === 'claude:a'; }).conflicts[0].message), '논리적 관리 관계에 순환이 있습니다.');
  Assert.equal(en(result.nodes.find(function(item) { return item.id === 'claude:a'; }).conflicts[0].message), 'The logical management relations contain a cycle.');
  Assert.equal(result.edges.find(function(item) { return item.id === 'outer'; }).conflicts.length, 0);
  Assert.equal(result.nodes.find(function(item) { return item.id === 'codex:outside'; }).conflicts.length, 0);
});

Test('보충 관리 관계는 별칭·미관측 상대를 보존하고 역할만 선택적으로 허용', function()
{
  const document = { schemaVersion: 1, sessions: [{ id: 'claude:a', aliases: ['master'], role: '총괄' }], relations: [{ id: 'managed', from: 'master', to: 'codex:unobserved', type: 'management', confidence: 'confirmed', evidence: { path: '/fixture/team.md', detail: '10행' } }] };
  Assert.deepEqual(Supplement.validateSupplement(document), []);
  const result = graph([node('claude:a')], [], [document]);
  Assert.equal(result.edges[0].from, 'claude:a');
  Assert.equal(result.edges[0].to, 'codex:unobserved');
  Assert.equal(result.edges[0].confidence, 'unresolved');
  Assert.equal(result.edges[0].sources.length, 2);
  Assert.equal(result.stats.relations.spawn, undefined);
  Assert.ok(Supplement.validateSupplement({ schemaVersion: 1, sessions: [{ id: 'claude:a', role: { body: 'PRIVATE' } }], relations: [] }).length);
  Assert.ok(Supplement.validateSupplement({ schemaVersion: 1, sessions: [], relations: [{ id: 'x', from: 'a', to: 'b', type: 'management', message: { body: 'PRIVATE' } }] }).length);
});

Test('bridge 메시지는 허용한 식별자·종류·ISO 시각·결과만 공개', function()
{
  const result = graph([node('claude:a'), node('codex:b')], [{
    id: 'bridge', from: 'claude:a', to: 'codex:b', type: 'collaboration', requestId: 'request-1',
    message: {
      deliveryId: 'delivery-1', parentDeliveryId: 'delivery-0', returnDeliveryId: 'delivery-2', kind: 'reply',
      createdAt: '2026-10-23T09:00:00+09:00', acceptedAt: '2026-10-23T00:00:01Z', finishedAt: '2026-10-23T00:00:02.000Z', expiresAt: '2026-10-24T00:00:00Z',
      outcome: 'reply-recorded', expired: false, body: 'PRIVATE_BODY', transcript: 'PRIVATE_TRANSCRIPT', nested: { secret: 'PRIVATE_SECRET' }
    }
  }, {
    id: 'invalid', from: 'claude:a', to: 'codex:b', type: 'collaboration',
    message: { deliveryId: { body: 'PRIVATE_OBJECT' }, kind: 'PRIVATE_KIND', outcome: 'PRIVATE_OUTCOME', createdAt: 'tomorrow', acceptedAt: 1792713600000, finishedAt: '2026-99-99T99:99:99Z', expiresAt: '2026-02-30T00:00:00Z', expired: 'true' }
  }]);
  Assert.deepEqual(result.edges[0].message, {
    deliveryId: 'delivery-1', parentDeliveryId: 'delivery-0', returnDeliveryId: 'delivery-2',
    createdAt: '2026-10-23T00:00:00.000Z', acceptedAt: '2026-10-23T00:00:01.000Z', finishedAt: '2026-10-23T00:00:02.000Z', expiresAt: '2026-10-24T00:00:00.000Z',
    kind: 'reply', outcome: 'reply-recorded', expired: false
  });
  Assert.equal(result.edges[0].requestId, 'request-1');
  Assert.equal(result.edges[1].message, undefined);
  Assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  ['request', 'reply', 'failure-notice', 'progress-notice', 'unknown'].forEach(function(kind)
  {
    const item = graph([node('claude:a'), node('codex:b')], [{ id: kind, from: 'claude:a', to: 'codex:b', type: 'collaboration', message: { kind: kind, outcome: 'none', expired: true } }]);
    Assert.equal(item.edges[0].message.kind, kind);
    Assert.equal(item.edges[0].message.expired, true);
  });
});

Test('같은 세션 ID의 관측 이름은 보충 이름보다 우선하고 보충 이름은 별칭·진단으로 남음', function()
{
  const document = { schemaVersion: 1, sessions: [{ id: 'claude:a', name: 'director-g01', aliases: ['master'], archived: true, role: '이전 담당' }],
    relations: [{ id: 'old-name', from: 'director-g01', to: 'master', type: 'handoff' }] };
  const result = graph([node('claude:a', { name: 'director', nameHistory: ['director', 'director-g01', 'director'], status: 'idle', lastSeen: new Date().toISOString() })], [], [document]);
  const item = result.nodes.find(function(entry) { return entry.id === 'claude:a'; });
  Assert.equal(item.name, 'director');
  Assert.deepEqual(item.nameHistory, ['director', 'director-g01', 'director']);
  Assert.ok(item.aliases.includes('director-g01'));
  Assert.equal(item.archived, undefined);
  Assert.equal(item.activity.category, 'recent');
  Assert.equal(item.role, '이전 담당');
  Assert.equal(result.edges[0].from, 'claude:a');
  const stale = result.diagnostics.filter(function(entry) { return entry.code === 'supplement-name-stale'; });
  Assert.equal(stale.length, 1);
  Assert.equal(stale[0].level, 'info');
  Assert.match(ko(stale[0].message), /director-g01.*director/);
  Assert.equal(ko(stale[0].message), '보충 JSON의 이름 "director-g01"이(가) 같은 세션 ID의 관측 이름 "director"과 다릅니다. 이름이 바뀐 것으로 보고 관측 이름을 표시하며, 보충 이름은 별칭으로 남깁니다. 보충의 은퇴(archived) 표시는 적용하지 않으니 역할·설명이 최신인지 확인하세요.');
  Assert.match(en(stale[0].message), /^The supplement JSON name "director-g01" differs from the observed name "director" of the same session ID\./);
  Assert.match(en(stale[0].message), /archived flag is not applied/);
});

Test('보충 이름은 이름이 없거나 임시 이름뿐인 세션과 미관측 세션에만 적용', function()
{
  const document = { schemaVersion: 1, sessions: [{ id: 'claude:plain', name: '보충 이름', archived: true }, { id: 'claude:fallback', name: '보충 이름' }, { id: 'codex:missing', name: '미관측 이름' }], relations: [] };
  const result = graph([node('claude:plain'), node('claude:fallback', { name: 'Session abcd1234', nameFallback: true })], [], [document]);
  Assert.equal(result.nodes.find(function(entry) { return entry.id === 'claude:plain'; }).name, '보충 이름');
  Assert.equal(result.nodes.find(function(entry) { return entry.id === 'claude:plain'; }).archived, true);
  Assert.equal(result.nodes.find(function(entry) { return entry.id === 'claude:fallback'; }).name, '보충 이름');
  Assert.equal(result.nodes.find(function(entry) { return entry.id === 'codex:missing'; }).name, '미관측 이름');
  Assert.equal(result.diagnostics.filter(function(entry) { return entry.code === 'supplement-name-stale'; }).length, 0);
});

Test('보충 이름이 관측 이름과 같으면 은퇴 표시를 그대로 적용하고 진단을 만들지 않음', function()
{
  const result = graph([node('claude:a', { name: 'director-g01' })], [], [{ schemaVersion: 1, sessions: [{ id: 'claude:a', name: 'director-g01', archived: true }], relations: [] }]);
  Assert.equal(result.nodes[0].archived, true);
  Assert.equal(result.diagnostics.length, 0);
});

Test('수집 진단은 코드별 메시지 토큰으로 렌더링되고 수집기 메시지는 그대로 보존', function()
{
  const codes = ['history-sampled', 'malformed-jsonl', 'oversized-jsonl-line', 'oversized-metadata', 'malformed-metadata', 'file-unreadable'];
  const korean = [
    '대형 기록의 앞부분·끝부분만 읽었습니다. 중간 이력은 초기 수집 범위 밖입니다.', '잘못된 JSONL 레코드를 건너뛰었습니다.', '4 MiB보다 큰 레코드는 진단을 남기고 건너뛰었습니다.',
    '메타데이터 파일 크기 제한을 초과했습니다.', '메타데이터 JSON 문법을 확인할 수 없습니다.', '기록 파일을 읽을 수 없습니다.'
  ];
  const english = [
    'Only the beginning and end of a large record were read. The middle of its history is outside the initial collection range.', 'Skipped a malformed JSONL record.', 'Records larger than 4 MiB were skipped and a diagnostic was left.',
    'The metadata file exceeds the size limit.', 'The metadata JSON could not be parsed.', 'The record file could not be read.'
  ];
  const collectorMessage = I18n.token('msg.bridge.unresolvedEndpoints', { count: 3 });
  const diagnostics = codes.map(function(code) { return { code: code, path: '/fixture/' + code }; })
    .concat([{ path: '/fixture/none' }, { code: 'watch-error', path: '/fixture/watch' }, { code: 'unresolved-endpoints', source: 'bridge', message: collectorMessage }]);
  const result = Model.buildGraph([{ nodes: [], edges: [], diagnostics: diagnostics }], [], 1);
  Assert.equal(result.diagnostics.length, 9);
  codes.forEach(function(code, index)
  {
    Assert.equal(ko(result.diagnostics[index].message), korean[index]);
    Assert.equal(en(result.diagnostics[index].message), english[index]);
    Assert.equal(result.diagnostics[index].code, code);
  });
  Assert.equal(result.diagnostics[0].level, 'info');
  Assert.equal(result.diagnostics[1].level, 'warning');
  Assert.equal(ko(result.diagnostics[6].message), '수집 진단');
  Assert.equal(en(result.diagnostics[6].message), 'Collection diagnostic');
  Assert.equal(en(result.diagnostics[7].message), 'watch-error', 'an unknown code is shown as it is');
  Assert.equal(en(result.diagnostics[8].message), 'Preserved 3 delivery endpoints without a session identifier as unresolved.');
  Assert.equal(ko(result.diagnostics[8].message), '세션 식별자가 없는 전달 끝점 3개를 미해결로 보존했습니다.');
});

Test('충돌·식별자 없음 메시지가 토큰으로 렌더링됨', function()
{
  const result = graph([node('claude:a', { cwd: '/one' }), node('claude:a', { cwd: '/two' }), node('codex:b'), node('codex:c')], [
    { id: 'same', from: 'claude:a', to: 'codex:b', type: 'handoff' },
    { id: 'same', from: 'claude:a', to: 'codex:c', type: 'handoff' },
    { id: 'empty', from: '', to: 'codex:b', type: 'dependency' }
  ]);
  const first = result.nodes.find(function(item) { return item.id === 'claude:a'; });
  Assert.equal(ko(first.conflicts[0].message), '서로 다른 관찰 값');
  Assert.equal(en(first.conflicts[0].message), 'Different observed values');
  Assert.equal(ko(result.edges[0].conflicts[0].message), '관계 ID가 서로 다른 연결에 사용되었습니다.');
  Assert.equal(en(result.edges[0].conflicts[0].message), 'The relation ID is used by different connections.');
  Assert.equal(ko(result.edges[1].conflicts[0].message), '중복 관계 ID');
  Assert.equal(en(result.edges[1].conflicts[0].message), 'Duplicate relation ID');
  const empty = result.nodes.find(function(item) { return item.id === 'unresolved:empty'; });
  Assert.equal(ko(empty.name), '식별자 없음');
  Assert.equal(en(empty.name), 'No identifier');
});

Test('safeText는 비밀 값을 토큰으로 가리고 언어별로 렌더링하며 반복 적용해도 같음', function()
{
  const cases = [
    ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: [인증 값 숨김]', 'Authorization: [credential hidden]'],
    ['key sk-abcdefghijklmnop and ghp_abcdefghijklmnopqrst', 'key [인증 값 숨김] and [인증 값 숨김]', 'key [credential hidden] and [credential hidden]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[비공개 값 숨김]', '[private value hidden]'],
    ['password=hunter2, api_key: abc', 'password=[숨김], api_key: [숨김]', 'password=[hidden], api_key: [hidden]']
  ];
  cases.forEach(function(item)
  {
    const once = Model.safeText(item[0]);
    Assert.equal(ko(once), item[1]);
    Assert.equal(en(once), item[2]);
    Assert.equal(Model.safeText(once), once, 'sanitizing twice must not change the text');
    Assert.equal(Model.safeMessage(once), once);
  });
  Assert.equal(Model.safeText('plain text'), 'plain text');
  Assert.equal(Model.safeText(42), '42');
  Assert.equal(Model.safeText({}), '');
});

Test('safeText는 길이 제한에서 토큰을 자르지 않고 서로게이트 쌍을 보존', function()
{
  Assert.equal(Model.safeText('x'.repeat(1000), 50).length, 50);
  Assert.equal(Model.safeText('x'.repeat(1000)).length, 240);
  const cut = Model.safeText('password=' + 'x'.repeat(10), 15);
  Assert.equal(cut, 'password=', 'a redaction token cut by the limit is removed whole');
  Assert.equal(Model.safeText('password=' + 'x'.repeat(10), 40), 'password=' + I18n.token('msg.redacted.value'));
  Assert.equal(Model.safeText('가'.repeat(5) + '😀', 6), '가'.repeat(5), 'half a surrogate pair is dropped');
  Assert.equal(Model.safeText('a\ud800b'), 'a�b', 'a lone surrogate would break token encoding');
  const token = I18n.token('msg.conflict.aliasPointsToSeveral', { name: 'abc' });
  Assert.equal(Model.safeMessage(token, 20), '');
  Assert.equal(Model.safeMessage('ab' + token, 10), 'ab');
  Assert.equal(Model.safeMessage('ab' + token, token.length + 2), 'ab' + token);
  Assert.equal(Model.safeMessage(token + token), token + token);
});

Test('관측·보충 텍스트는 메시지 토큰을 위조하지 못함', function()
{
  const forged = '⟦msg.node.noIdentifier⟧';
  const open = '⟦msg.diagnostic.fallback?x=1';
  Assert.equal(Model.safeText(forged), '[msg.node.noIdentifier]');
  Assert.equal(en(Model.safeText('a ' + forged + ' b')), 'a [msg.node.noIdentifier] b');
  Assert.equal(Model.safeText(open), '[msg.diagnostic.fallback?x=1');
  Assert.equal(Model.safeMessage(open), '[msg.diagnostic.fallback?x=1', 'a half-open token is never trusted');
  const document = {
    schemaVersion: 1, description: 'Document ' + forged,
    sessions: [{ id: 'codex:missing', name: 'Name ' + forged, role: forged, description: forged, aliases: ['alias ' + forged], statusEvidence: forged }],
    relations: [{ id: 'link', from: 'alias ' + forged, to: 'codex:missing', type: 'dependency', description: 'Relation ' + forged, evidence: { path: '/fixture/' + forged, detail: 'Evidence ' + forged } }]
  };
  const result = graph([node('claude:a', { name: 'Observed ' + forged, cwd: '/work/' + forged, description: forged, sources: [{ kind: 'k' + forged, path: '/p/' + forged, detail: 'd' }] })], [{ id: 'native', from: 'claude:a', to: 'codex:missing', type: 'spawn', description: forged }], [document]);
  Assert.equal(JSON.stringify(result).includes(forged), false);
  Assert.equal(JSON.stringify(result).includes('⟦msg.node'), false);
  Assert.equal(result.nodes.find(function(item) { return item.id === 'claude:a'; }).name, 'Observed [msg.node.noIdentifier]');
  const supplemented = result.nodes.find(function(item) { return item.id === 'codex:missing'; });
  Assert.equal(supplemented.name, 'Name [msg.node.noIdentifier]');
  Assert.equal(supplemented.statusEvidence, '[msg.node.noIdentifier]');
  Assert.equal(en(supplemented.sources[0].detail), 'Document [msg.node.noIdentifier]');
  const edge = result.edges.find(function(item) { return item.id === 'supplement:/fixture/supplement.json:link'; });
  Assert.equal(en(edge.source.detail), 'Relation [msg.node.noIdentifier]');
  Assert.equal(edge.evidence.detail, 'Evidence [msg.node.noIdentifier]');
});

Test('수집기가 만든 메시지 토큰은 그대로 통과하고 고정 이름 토큰만 이름에 허용', function()
{
  const evidence = I18n.token('msg.evidence.claudeToolCall', { names: 'Read, Write' }) + ' · ' + I18n.token('msg.evidence.staleEvent');
  const endpoint = I18n.token('msg.bridge.unresolvedEndpointName');
  const detail = I18n.token('msg.spawn.selfReference', { detail: I18n.token('msg.spawn.subagentsPath') });
  const result = graph([node('claude:a', { statusEvidence: evidence, sources: [{ kind: 'claude-transcript', path: '/fixture/a.jsonl', detail: 'x' }] }), node('unresolved:bridge:x', { name: endpoint, kind: 'unresolved' })],
    [{ id: 'spawn-self', from: 'claude:a', to: 'claude:a', type: 'spawn', source: { kind: 'claude-transcript', path: '/fixture/a.jsonl', detail: detail } }]);
  const first = result.nodes.find(function(item) { return item.id === 'claude:a'; });
  Assert.equal(first.statusEvidence, evidence);
  Assert.equal(en(first.statusEvidence), 'Claude tool call: Read, Write · event older than 2 minutes, current status unknown');
  Assert.equal(ko(first.statusEvidence), 'Claude 도구 호출: Read, Write · 2분 이상 지난 이벤트, 현재 상태 미확인');
  Assert.equal(result.nodes.find(function(item) { return item.id === 'unresolved:bridge:x'; }).name, endpoint);
  Assert.equal(result.edges[0].source.detail, detail);
  Assert.equal(en(result.edges[0].source.detail), 'Session subagents path; no direct parent metadata; self-reference');
  Assert.equal(ko(result.edges[0].source.detail), '세션의 subagents 경로; 직접 부모 메타데이터 없음; 자기 참조');
});
