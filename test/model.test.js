'use strict';
const Test = require('node:test');
const Assert = require('node:assert/strict');
const Model = require('../src/model');
const Supplement = require('../src/supplement');
const Office = require('../public/office-model');
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

function groupDocument(groups, sessions, relations)
{
  return { schemaVersion: 1, sessions: sessions || [], relations: relations || [], groups: groups };
}

function groupOf(result, id)
{
  return result.nodes.find(function(item) { return item.id === id; }).group;
}

Test('논리 그룹: 문서에 groups가 없으면 그래프에 group·groups가 전혀 생기지 않음', function()
{
  const result = graph([node('codex:a', { name: 'codex-koppa-i18n-a' })], [], [{ schemaVersion: 1, sessions: [], relations: [] }]);
  Assert.equal('groups' in result, false);
  Assert.equal(result.nodes.some(function(item) { return 'group' in item; }), false);
  Assert.equal(result.diagnostics.some(function(item) { return /^supplement-group/.test(item.code); }), false);
});

Test('논리 그룹: 소속(members)·이름 패턴(match)으로 들어가고 그룹 목록은 순위·이름과 함께 나감', function()
{
  const document = groupDocument([
    { id: 'i18n', name: 'Translation', rank: 20, description: 'Codex translators', match: ['codex-koppa-i18n-*'] },
    { id: 'core', name: 'Core', rank: 10, members: ['claude:master'] }
  ]);
  const result = graph([node('claude:master', { name: 'claude-koppa-master' }), node('codex:t1', { name: 'codex-koppa-i18n-ja' }), node('codex:t2', { name: 'CODEX-KOPPA-I18N-EN' }), node('codex:other', { name: 'codex-koppa-story' })], [], [document]);
  Assert.equal(groupOf(result, 'claude:master'), 'core');
  Assert.equal(groupOf(result, 'codex:t1'), 'i18n');
  Assert.equal(groupOf(result, 'codex:t2'), 'i18n', '패턴은 대소문자를 가리지 않음');
  Assert.equal(groupOf(result, 'codex:other'), undefined);
  Assert.deepEqual(result.groups, [{ id: 'i18n', name: 'Translation', rank: 20, description: 'Codex translators' }, { id: 'core', name: 'Core', rank: 10 }]);
});

Test('논리 그룹: 패턴은 * ? 만 특별하고 별칭에도 맞으며 긴 이름에서도 멈춤', function()
{
  const document = groupDocument([{ id: 'g', name: 'G', rank: 1, match: ['a?c-*-z', '[x]*', 'old-name'] }], [{ id: 'codex:b', aliases: ['old-name'] }]);
  const result = graph([node('codex:a', { name: 'abc-middle-z' }), node('codex:b', { name: 'new-name' }), node('codex:c', { name: 'x-literal' }), node('codex:d', { name: '[x]-literal' }), node('codex:e', { name: 'a'.repeat(5000) })], [], [document]);
  Assert.equal(groupOf(result, 'codex:a'), 'g');
  Assert.equal(groupOf(result, 'codex:b'), 'g', '별칭으로 맞음');
  Assert.equal(groupOf(result, 'codex:c'), undefined, '[x]는 문자 그대로 비교');
  Assert.equal(groupOf(result, 'codex:d'), 'g');
  const started = Date.now();
  const long = graph([node('codex:e', { name: 'a'.repeat(5000) })], [], [groupDocument([{ id: 'g', name: 'G', rank: 1, match: ['*a*a*a*a*a*a*a*a*b'] }])]);
  Assert.ok(Date.now() - started < 1000);
  Assert.equal(groupOf(long, 'codex:e'), undefined);
});

Test('논리 그룹: 두 그룹에 걸리면 소속이 패턴보다, 그다음 순위가 작은 그룹이 이기고 info 진단을 남김', function()
{
  const document = groupDocument([
    { id: 'wide', name: 'Wide', rank: 1, match: ['codex-*'] },
    { id: 'narrow', name: 'Narrow', rank: 50, members: ['codex:listed'] },
    { id: 'second', name: 'Second', rank: 5, match: ['codex-koppa-*'] },
    { id: 'tie-a', name: 'TieA', rank: 70, members: ['codex:tie'] },
    { id: 'tie-b', name: 'TieB', rank: 60, members: ['codex:tie'] }
  ]);
  const result = graph([node('codex:listed', { name: 'codex-koppa-x' }), node('codex:both', { name: 'codex-koppa-y' }), node('codex:tie', { name: 'plain' }), node('codex:single', { name: 'codex-zzz' })], [], [document]);
  Assert.equal(groupOf(result, 'codex:listed'), 'narrow', '소속은 순위가 더 작은 패턴 그룹보다 앞섬');
  Assert.equal(groupOf(result, 'codex:both'), 'wide', '둘 다 패턴이면 순위가 작은 그룹');
  Assert.equal(groupOf(result, 'codex:tie'), 'tie-b', '둘 다 소속이면 순위가 작은 그룹');
  Assert.equal(groupOf(result, 'codex:single'), 'wide');
  const overlaps = result.diagnostics.filter(function(item) { return item.code === 'supplement-group-overlap'; });
  Assert.deepEqual(overlaps.map(function(item) { return item.nodeId; }).sort(), ['codex:both', 'codex:listed', 'codex:tie']);
  overlaps.forEach(function(item) { Assert.equal(item.level, 'info'); });
  const listed = overlaps.find(function(item) { return item.nodeId === 'codex:listed'; });
  Assert.match(en(listed.message), /"codex-koppa-x" fits several groups \(Narrow, Wide, Second\)\. It is placed in "Narrow"/);
  Assert.match(ko(listed.message), /"codex-koppa-x"이\(가\) 여러 그룹\(Narrow, Wide, Second\)에 해당합니다\. "Narrow" 그룹에 둡니다/);
  Assert.equal(listed.source.kind, 'supplement');
});

Test('논리 그룹: 순위가 같은 그룹은 문서에 적힌 순서로 고름', function()
{
  const document = groupDocument([{ id: 'first', name: 'First', rank: 3, match: ['x-*'] }, { id: 'second', name: 'Second', rank: 3, match: ['x-*'] }]);
  Assert.equal(groupOf(graph([node('codex:x', { name: 'x-1' })], [], [document]), 'codex:x'), 'first');
});

Test('논리 그룹: 그룹에 못 든 세션이 낳은 하위 세션은 부모 그룹을 따라가고, 스스로 그룹이 있으면 그대로', function()
{
  const document = groupDocument([{ id: 'a', name: 'A', rank: 1, members: ['claude:root'] }, { id: 'b', name: 'B', rank: 2, members: ['claude:own'] }]);
  const nodes = [node('claude:root'), node('claude:kid', { kind: 'agent' }), node('claude:grandkid', { kind: 'agent' }), node('claude:own', { kind: 'agent' }), node('claude:free')];
  const edges = [{ id: 's1', from: 'claude:root', to: 'claude:kid', type: 'spawn' }, { id: 's2', from: 'claude:kid', to: 'claude:grandkid', type: 'spawn' }, { id: 's3', from: 'claude:root', to: 'claude:own', type: 'spawn' }, { id: 'm1', from: 'claude:root', to: 'claude:free', type: 'management' }];
  const result = graph(nodes, edges, [document]);
  Assert.equal(groupOf(result, 'claude:kid'), 'a');
  Assert.equal(groupOf(result, 'claude:grandkid'), 'a');
  Assert.equal(groupOf(result, 'claude:own'), 'b');
  Assert.equal(groupOf(result, 'claude:free'), undefined, '관리 관계는 그룹을 옮기지 않음');
});

Test('논리 그룹: 같은 그룹 ID를 뒤 파일이 다시 정의하면 앞 정의만 쓰고 info 진단', function()
{
  const first = groupDocument([{ id: 'g', name: 'First', rank: 1, members: ['codex:a'] }]);
  const second = groupDocument([{ id: 'g', name: 'Second', rank: 9, members: ['codex:b'] }, { id: 'h', name: 'Other', rank: 2, members: ['codex:b'] }]);
  const result = graph([node('codex:a'), node('codex:b')], [], [first, second]);
  Assert.deepEqual(result.groups.map(function(item) { return item.name; }), ['First', 'Other']);
  Assert.equal(groupOf(result, 'codex:a'), 'g');
  Assert.equal(groupOf(result, 'codex:b'), 'h');
  Assert.ok(result.diagnostics.some(function(item) { return item.code === 'supplement-group-duplicate' && item.level === 'info'; }));
});

Test('논리 그룹: 이름은 메시지 토큰을 위조하지 못하고 길이가 제한됨', function()
{
  const forged = '⟦msg.node.noIdentifier⟧';
  const result = graph([node('codex:a')], [], [groupDocument([{ id: 'g', name: forged + 'x'.repeat(300), rank: 1, members: ['codex:a'], description: forged }])]);
  Assert.equal(JSON.stringify(result.groups).includes('⟦'), false);
  Assert.ok(result.groups[0].name.length <= 120);
});

Test('논리 그룹: 검증은 필수 항목·순위 정수·중복 ID·소속과 패턴 모양을 확인하고 오류는 언어별로 렌더링됨', function()
{
  function errors(groups, locale) { return Supplement.validateSupplement(groupDocument(groups)).map(function(text) { return I18n.resolve(text, locale); }); }
  Assert.deepEqual(errors([], 'en'), []);
  Assert.deepEqual(errors([{ id: 'g', name: 'G', rank: 1, description: 'd', members: ['codex:a', 'claude:b'], match: ['x-*'] }, { id: 'h', name: 'H', rank: -3 }], 'en'), []);
  Assert.deepEqual(errors({}, 'en'), ['groups: must be an array.']);
  Assert.deepEqual(errors([{ id: 'g', name: 'G', rank: 1.5, extra: 1 }, { id: 'g', name: '', rank: 'x', members: ['plain'], match: [''] }, 3], 'en'), [
    'groups[0]: unknown field extra', 'groups[0].rank: must be an integer.',
    'groups[1].name: must be a string of 1 to 120 characters.', 'groups[1].rank: must be an integer.', 'groups[1].id: duplicate group.',
    'groups[1].members: must be an array of session IDs with a "claude:" or "codex:" prefix.', 'groups[1].match: must be an array of non-empty name patterns of up to 200 characters.',
    'groups[2]: must be an object.'
  ]);
  Assert.deepEqual(errors([{ name: 'G', rank: 1 }], 'ko'), ['groups[0].id: 1~2000자 문자열이어야 합니다.']);
  Assert.deepEqual(errors([{ id: 'g', name: 'G' }], 'ko'), ['groups[0].rank: 정수이어야 합니다.']);
  Assert.deepEqual(errors([{ id: 'g', name: 'G', rank: 1, match: 'x-*' }], 'ko'), ['groups[0].match: 200자 이하의 비어 있지 않은 이름 패턴 배열이어야 합니다.']);
});

Test('논리 그룹: 그래프 결과가 그대로 사무실 층이 되어 중요한 그룹이 아래층, 미소속은 맨 위', function()
{
  const document = groupDocument([
    { id: 'story', name: 'Story', rank: 20, match: ['codex-story-*'] },
    { id: 'core', name: 'Core', rank: 10, members: ['claude:master'] }
  ], [], [{ id: 'm1', from: 'claude:master', to: 'codex:s1', type: 'management' }, { id: 'm2', from: 'claude:master', to: 'codex:s2', type: 'management' }, { id: 'm3', from: 'codex:s1', to: 'codex:s3', type: 'management' }]);
  const nodes = ['claude:master', 'codex:s1', 'codex:s2', 'codex:s3', 'codex:free'].map(function(id) { return node(id, { project: 'p', status: 'idle', lastSeen: new Date().toISOString() }); });
  nodes[1].name = 'codex-story-lead'; nodes[2].name = 'codex-story-b'; nodes[3].name = 'codex-story-c';
  const result = graph(nodes, [], [document]);
  const office = Office.buildOffice(result, { project: 'p', activity: 'all' });
  Assert.deepEqual(office.floors.map(function(floor) { return floor.groupId; }), ['core', 'story', 'story', undefined]);
  Assert.deepEqual(office.floors.map(function(floor) { return floor.nodeIds; }), [['claude:master'], ['codex:s1', 'codex:s3'], ['codex:s2'], ['codex:free']]);
  Assert.deepEqual(office.floors.map(function(floor) { return en(floor.name); }), ['Core', 'Story · codex-story-lead', 'Story · Independent sessions', 'Independent sessions']);
});

function excludeDocument(exclude, sessions, relations)
{
  return { schemaVersion: 1, sessions: sessions || [], relations: relations || [], exclude: exclude };
}

function nodeIds(result)
{
  return result.nodes.map(function(item) { return item.id; }).sort();
}

function excludeDiagnostic(result)
{
  return result.diagnostics.find(function(item) { return item.code === 'supplement-exclude'; });
}

Test('세션 빼기: exclude가 없거나 아무것도 켜지 않으면 그래프가 그대로이고 진단도 없음', function()
{
  const nodes = [node('codex:a', { name: 'x-koppa-y-g01' }), node('codex:b')];
  const plain = graph(nodes, [], [{ schemaVersion: 1, sessions: [{ id: 'codex:b', archived: true }], relations: [] }]);
  [{}, { archived: false }, { match: [] }, { archived: false, match: [] }].forEach(function(exclude)
  {
    const result = graph(nodes, [], [excludeDocument(exclude, [{ id: 'codex:b', archived: true }])]);
    Assert.deepEqual(nodeIds(result), ['codex:a', 'codex:b']);
    Assert.equal(excludeDiagnostic(result), undefined);
    Assert.deepEqual(result.stats, plain.stats);
  });
});

Test('세션 빼기: archived: true는 보충 파일이 은퇴로 표시한 세션(관측 안 된 것 포함)과 그 관계를 통째로 뺌', function()
{
  const document = excludeDocument({ archived: true }, [
    { id: 'claude:retired', name: 'retired-one', aliases: ['old-one'], archived: true },
    { id: 'claude:ghost', name: 'ghost', archived: true },
    { id: 'claude:live', name: 'live-one' },
    { id: 'claude:kept', name: 'kept-flag', archived: false }
  ], [
    { id: 'm1', from: 'claude:live', to: 'old-one', type: 'management' },
    { id: 'm2', from: 'claude:live', to: 'claude:kept', type: 'management' },
    { id: 'm3', from: 'claude:ghost', to: 'claude:live', type: 'handoff' }
  ]);
  const result = graph([node('claude:retired', { name: 'retired-one', status: 'idle' }), node('claude:live'), node('claude:kept')], [{ id: 'o1', from: 'claude:retired', to: 'claude:live', type: 'collaboration' }], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:kept', 'claude:live']);
  Assert.deepEqual(result.edges.map(function(item) { return item.type + ':' + item.from + '>' + item.to; }), ['management:claude:live>claude:kept']);
  Assert.equal(result.nodes.some(function(item) { return item.kind === 'unresolved'; }), false, '빠진 세션 때문에 미확인 자리 표시 노드가 생기지 않음');
  Assert.equal(result.stats.nodes, 2);
  Assert.equal(result.stats.edges, 1);
  Assert.equal(result.stats.unresolvedNodes, 0);
  const item = excludeDiagnostic(result);
  Assert.equal(item.level, 'info');
  Assert.equal(item.source.kind, 'supplement');
  Assert.deepEqual(item.excluded.map(function(entry) { return entry.id + ':' + entry.reason; }).sort(), ['claude:ghost:archived', 'claude:retired:archived']);
  Assert.equal(en(item.message), 'Sessions left out by the supplement\'s exclude setting: 2 (2 marked archived, 0 by name pattern), plus 0 sub-agents they started. They appear nowhere: not in the sessions, floors, counts or relations.');
  Assert.match(ko(item.message), /^보충 파일의 exclude 설정으로 뺀 세션: 2개\(은퇴 표시 2개, 이름 패턴 0개\)와 그 세션이 띄운 하위 에이전트 0개\./);
  Assert.equal(JSON.stringify(result).includes('retired-one'), true, '진단 목록에는 이름이 남음');
  Assert.equal(JSON.stringify(result.nodes).includes('retired-one'), false);
});

Test('세션 빼기: archived를 켜지 않으면 은퇴 표시 세션은 그대로 있고 활동만 inactive', function()
{
  const result = graph([node('claude:a')], [], [excludeDocument({ match: ['nothing-*'] }, [{ id: 'claude:a', archived: true }])]);
  Assert.deepEqual(nodeIds(result), ['claude:a']);
  Assert.equal(result.nodes[0].activity.category, 'inactive');
  Assert.equal(excludeDiagnostic(result), undefined);
});

Test('세션 빼기: match는 현재 이름에만 맞고(대소문자 무시, 별칭은 무시) 관측만 된 옛 세대를 뺌', function()
{
  const document = excludeDocument({ match: ['*-koppa-*-g??', '*-koppa-* (g??)'] }, [{ id: 'codex:fresh', name: 'codex-koppa-fresh', aliases: ['codex-koppa-fresh-g01'] }]);
  const result = graph([
    node('claude:m13', { name: 'claude-koppa-master-g13' }), node('claude:t7', { name: 'Claude-Koppa-Tools (G07)' }), node('claude:other', { name: 'claude-cross-agent-mcp-g01' }),
    node('claude:short', { name: 'claude-koppa-tools-g5' }), node('claude:plain', { name: 'claude-koppa-master' }), node('codex:fresh', { name: 'codex-koppa-fresh' })
  ], [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:other', 'claude:plain', 'claude:short', 'codex:fresh']);
  Assert.deepEqual(excludeDiagnostic(result).excluded.map(function(entry) { return entry.reason; }), ['match', 'match']);
  Assert.match(en(excludeDiagnostic(result).message), /: 2 \(0 marked archived, 2 by name pattern\)/);
});

Test('세션 빼기: 보충 파일이 은퇴 표시 없이 올린 세션은 이름 패턴보다 앞서고, 은퇴 표시가 붙으면 패턴으로도 빠짐', function()
{
  const document = excludeDocument({ match: ['*-g??'] }, [
    { id: 'claude:listed', name: 'worker-g01' },
    { id: 'claude:explicit', name: 'helper-g02', archived: false },
    { id: 'claude:retired', name: 'old-g03', archived: true }
  ]);
  const result = graph([node('claude:listed', { name: 'worker-g01' }), node('claude:explicit', { name: 'helper-g02' }), node('claude:retired', { name: 'old-g03' }), node('claude:unknown', { name: 'stray-g04' })], [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:explicit', 'claude:listed']);
  Assert.deepEqual(excludeDiagnostic(result).excluded.map(function(entry) { return entry.id; }).sort(), ['claude:retired', 'claude:unknown']);
});

Test('세션 빼기: 은퇴 표시는 관측 이름이 달라도 적용하고, 이름 패턴은 현재 이름으로만 가림', function()
{
  const document = excludeDocument({ archived: true, match: ['*-g??'] }, [
    { id: 'claude:tools', name: 'tools (g07)', archived: true },
    { id: 'claude:revived', name: 'thumb-g01', archived: true },
    { id: 'claude:just-retired', name: 'helper' },
    { id: 'claude:working', name: 'writer-g01' }
  ]);
  const result = graph([node('claude:tools', { name: 'tools' }), node('claude:revived', { name: 'thumb' }), node('claude:just-retired', { name: 'helper-g02' }), node('claude:working', { name: 'writer-g01' })], [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:working']);
  Assert.deepEqual(excludeDiagnostic(result).excluded.map(function(entry) { return entry.id + ':' + entry.reason; }).sort(), ['claude:just-retired:match', 'claude:revived:archived', 'claude:tools:archived']);
  Assert.equal(result.diagnostics.some(function(item) { return item.code === 'supplement-name-stale'; }), false, '빠진 세션의 이름 불일치 진단은 남기지 않음');
});

Test('세션 빼기: 별칭에만 -gNN이 남은 세션(되살린 세션)은 패턴에 걸리지 않고, 나중 파일의 archived: false가 앞 파일의 은퇴 표시를 거둠', function()
{
  const first = excludeDocument({ archived: true, match: ['*-g??'] }, [{ id: 'claude:revived', name: 'thumb', aliases: ['thumb-g01'] }, { id: 'claude:back', name: 'back', archived: true }]);
  const second = { schemaVersion: 1, sessions: [{ id: 'claude:back', name: 'back', archived: false }], relations: [] };
  const result = graph([node('claude:revived', { name: 'thumb' }), node('claude:back', { name: 'back' })], [], [first, second]);
  Assert.deepEqual(nodeIds(result), ['claude:back', 'claude:revived']);
  Assert.equal(excludeDiagnostic(result), undefined);
});

Test('세션 빼기: 빠진 세션이 낳은 하위 에이전트는 함께 빠지고, 남는 세션도 낳은 것은 남음', function()
{
  const document = excludeDocument({ match: ['old-*'] });
  const nodes = [node('claude:old', { name: 'old-root' }), node('claude:keep', { name: 'keep-root' }), node('claude:kid', { kind: 'agent' }), node('claude:grandkid', { kind: 'agent' }), node('claude:shared', { kind: 'agent' }), node('claude:mine', { kind: 'agent' })];
  const edges = [
    { id: 's1', from: 'claude:old', to: 'claude:kid', type: 'spawn' }, { id: 's2', from: 'claude:kid', to: 'claude:grandkid', type: 'spawn' },
    { id: 's3', from: 'claude:old', to: 'claude:shared', type: 'spawn' }, { id: 's4', from: 'claude:keep', to: 'claude:shared', type: 'spawn' },
    { id: 's5', from: 'claude:keep', to: 'claude:mine', type: 'spawn' }, { id: 'c1', from: 'claude:old', to: 'claude:keep', type: 'collaboration' }
  ];
  const result = graph(nodes, edges, [document]);
  Assert.deepEqual(nodeIds(result), ['claude:keep', 'claude:mine', 'claude:shared']);
  Assert.deepEqual(result.edges.map(function(item) { return item.id; }).sort(), ['s4', 's5']);
  const shared = result.nodes.find(function(item) { return item.id === 'claude:shared'; });
  Assert.deepEqual(shared.conflicts, [], '빠진 부모는 다중 부모 충돌에서도 빠짐');
  const item = excludeDiagnostic(result);
  Assert.equal(item.excluded.length, 1);
  Assert.match(en(item.message), /: 1 \(0 marked archived, 1 by name pattern\), plus 2 sub-agents they started/);
});

Test('세션 빼기: 서로를 낳는 순환이어도 끝나고, 순환 밖 부모가 남아 있으면 그 세션은 남음', function()
{
  const document = excludeDocument({ match: ['old-*'] });
  const nodes = [node('claude:old', { name: 'old-root' }), node('claude:a', { kind: 'agent' }), node('claude:b', { kind: 'agent' }), node('claude:c', { kind: 'agent' }), node('claude:keep', { name: 'keep-root' })];
  const edges = [
    { id: 'o-a', from: 'claude:old', to: 'claude:a', type: 'spawn' }, { id: 'a-b', from: 'claude:a', to: 'claude:b', type: 'spawn' }, { id: 'b-a', from: 'claude:b', to: 'claude:a', type: 'spawn' },
    { id: 'o-c', from: 'claude:old', to: 'claude:c', type: 'spawn' }, { id: 'k-c', from: 'claude:keep', to: 'claude:c', type: 'spawn' }
  ];
  const result = graph(nodes, edges, [document]);
  Assert.deepEqual(nodeIds(result), ['claude:c', 'claude:keep']);
  Assert.deepEqual(result.edges.map(function(item) { return item.id; }), ['k-c']);
});

Test('세션 빼기: 별칭으로 적은 관계 끝점도 빠진 세션이면 관계째 뺌, 같은 별칭을 쓰던 남은 세션에는 별칭 충돌이 남지 않음', function()
{
  const document = excludeDocument({ archived: true }, [
    { id: 'claude:gone', name: 'gone', aliases: ['team-lead', 'shared-nick'], archived: true },
    { id: 'claude:stay', name: 'stay', aliases: ['shared-nick'] }
  ], [
    { id: 'r1', from: 'team-lead', to: 'claude:stay', type: 'management' },
    { id: 'r2', from: 'shared-nick', to: 'claude:stay', type: 'dependency' }
  ]);
  const result = graph([node('claude:gone', { name: 'gone' }), node('claude:stay', { name: 'stay' })], [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:stay']);
  Assert.deepEqual(result.nodes[0].conflicts, [], '빠진 세션과 같은 별칭을 나눠 쓴다는 충돌은 만들지 않음');
  Assert.deepEqual(result.edges.map(function(item) { return item.id.slice(-2); }), ['r2'], '이제 한 세션만 가리키는 별칭은 남은 세션으로 풀림');
  Assert.equal(result.edges[0].from, 'claude:stay');
  Assert.equal(result.edges[0].to, 'claude:stay');
});

Test('세션 빼기: 여러 보충 파일의 설정은 합쳐 쓰고, 그룹 층 계산에도 빠진 세션은 없음', function()
{
  const first = { schemaVersion: 1, sessions: [{ id: 'claude:one', name: 'one', archived: true }], relations: [], exclude: { archived: true } };
  const second = { schemaVersion: 1, sessions: [], relations: [], exclude: { match: ['two-*'] }, groups: [{ id: 'g', name: 'G', rank: 1, match: ['*'] }] };
  const result = graph([node('claude:one', { name: 'one' }), node('claude:two', { name: 'two-x' }), node('claude:three', { name: 'three' })], [], [first, second]);
  Assert.deepEqual(nodeIds(result), ['claude:three']);
  Assert.equal(result.nodes[0].group, 'g');
  Assert.equal(result.diagnostics.filter(function(item) { return item.code === 'supplement-exclude'; }).length, 1, '진단은 한 번만 남김');
  Assert.equal(excludeDiagnostic(result).source.path, '/fixture/supplement.json');
  Assert.equal(result.diagnostics.some(function(item) { return item.code === 'supplement-group-overlap'; }), false);
});

Test('세션 빼기: 진단의 이름 목록은 200개에서 끊기고 개수는 정확하며 메시지 토큰을 위조하지 못함', function()
{
  const nodes = [];
  for (var number = 0; number < 250; number++) nodes.push(node('codex:old' + number, { name: number === 0 ? '⟦msg.node.noIdentifier⟧ old-' + number : 'old-' + number }));
  const result = graph(nodes, [], [excludeDocument({ match: ['*old-*'] })]);
  Assert.equal(result.nodes.length, 0);
  const item = excludeDiagnostic(result);
  Assert.equal(item.excluded.length, 200);
  Assert.match(en(item.message), /: 250 \(0 marked archived, 250 by name pattern\)/);
  Assert.equal(JSON.stringify(item.excluded).includes('⟦'), false);
});

Test('세션 빼기: 빠진 세션은 활동 필터(all)에서도 층에 나오지 않음', function()
{
  const now = new Date().toISOString();
  const document = excludeDocument({ archived: true, match: ['*-g??'] }, [{ id: 'claude:retired', name: 'retired', archived: true }, { id: 'claude:team-lead', name: 'lead' }], [{ id: 'm1', from: 'claude:team-lead', to: 'claude:retired', type: 'management' }, { id: 'm2', from: 'claude:team-lead', to: 'claude:member', type: 'management' }]);
  const nodes = [node('claude:retired', { name: 'retired' }), node('claude:team-lead', { name: 'lead' }), node('claude:member', { name: 'member' }), node('claude:old', { name: 'old-g03' })].map(function(item) { return Object.assign(item, { project: 'p', status: 'idle', lastSeen: now }); });
  const result = graph(nodes, [], [document]);
  ['recent', 'all'].forEach(function(activity)
  {
    const office = Office.buildOffice(result, { project: 'p', activity: activity });
    const placed = [].concat.apply([], office.floors.map(function(floor) { return floor.nodeIds; })).sort();
    Assert.deepEqual(placed, ['claude:member', 'claude:team-lead'], activity);
  });
});

Test('세션 빼기: 검증은 모양·종류·패턴 문자열을 확인하고 오류는 언어별로 렌더링됨', function()
{
  function errors(exclude, locale) { return Supplement.validateSupplement(excludeDocument(exclude)).map(function(text) { return I18n.resolve(text, locale); }); }
  Assert.deepEqual(errors(undefined, 'en'), []);
  Assert.deepEqual(errors({}, 'en'), []);
  Assert.deepEqual(errors({ archived: true, match: ['*-g??', 'x (g??)'] }, 'en'), []);
  Assert.deepEqual(errors([], 'en'), ['exclude: must be an object.']);
  Assert.deepEqual(errors('yes', 'ko'), ['exclude: 객체이어야 합니다.']);
  Assert.deepEqual(errors({ archived: 'yes', match: 'x', extra: 1 }, 'en'), ['exclude: unknown field extra', 'exclude.archived: must be a boolean.', 'exclude.match: must be an array of non-empty name patterns of up to 200 characters.']);
  Assert.deepEqual(errors({ match: ['ok', ' '] }, 'ko'), ['exclude.match: 200자 이하의 비어 있지 않은 이름 패턴 배열이어야 합니다.']);
  Assert.deepEqual(errors({ match: ['x'.repeat(201)] }, 'ko'), ['exclude.match: 200자 이하의 비어 있지 않은 이름 패턴 배열이어야 합니다.']);
});

function unlistedRule(extra)
{
  return Object.assign({ unlisted: true, project: 'koppa' }, extra);
}

function reasonsOf(result)
{
  const item = excludeDiagnostic(result);
  return item ? item.excluded.map(function(entry) { return entry.id + ':' + entry.reason; }).sort() : [];
}

Test('지도 밖 세션: unlisted가 없으면 목록에 없는 관측 세션도 그대로이고, project 없는 unlisted는 검증 오류', function()
{
  const nodes = [node('claude:listed', { name: 'listed', project: 'koppa' }), node('claude:stray', { name: 'stray', project: 'koppa' })];
  const document = excludeDocument({ archived: true }, [{ id: 'claude:listed', name: 'listed' }]);
  Assert.deepEqual(nodeIds(graph(nodes, [], [document])), ['claude:listed', 'claude:stray']);
  Assert.deepEqual(nodeIds(graph(nodes, [], [excludeDocument({ unlisted: false, project: 'koppa' }, [{ id: 'claude:listed', name: 'listed' }])])), ['claude:listed', 'claude:stray']);
  // A rule without a project scope would reach every project, so it is not applied (the validator reports it).
  Assert.deepEqual(nodeIds(graph(nodes, [], [excludeDocument({ unlisted: true }, [{ id: 'claude:listed', name: 'listed' }])])), ['claude:listed', 'claude:stray']);
  Assert.deepEqual(Supplement.validateSupplement(excludeDocument({ unlisted: true })).map(function(text) { return en(text); }), ['exclude.project: required when unlisted is true: the project pattern the setting is limited to (* for every project).']);
  Assert.deepEqual(Supplement.validateSupplement(excludeDocument({ unlisted: true })).map(function(text) { return ko(text); }), ['exclude.project: unlisted가 true이면 필요합니다: 이 설정을 적용할 프로젝트 패턴(전체 프로젝트는 *).']);
});

Test('지도 밖 세션: 이 프로젝트의 목록에 없는 관측 세션만 빠지고, 이름이나 그룹 패턴으로는 살지 못하며 다른 프로젝트는 그대로', function()
{
  const document = Object.assign(excludeDocument(unlistedRule(), [{ id: 'claude:listed', name: 'claude-koppa-listed' }, { id: 'claude:retired', name: 'old', archived: true }, { id: 'claude:stale', name: 'was-this' }]), { groups: [{ id: 'g', name: 'G', rank: 1, match: ['claude-koppa-*'] }] });
  const nodes = [
    node('claude:listed', { name: 'claude-koppa-listed', project: 'koppa' }), node('claude:retired', { name: 'old', project: 'koppa' }), node('claude:stale', { name: 'renamed-now', project: 'koppa' }),
    node('claude:lookalike', { name: 'claude-koppa-looks-like-work', project: 'koppa' }), node('claude:temp', { name: 'Session 1234abcd', cwd: '/Users/me/project/KOPPA' }),
    node('codex:other', { name: 'other-project', project: 'kdating' }), node('codex:nowhere', { name: 'no-project' })
  ];
  const result = graph(nodes, [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:listed', 'claude:retired', 'claude:stale', 'codex:nowhere', 'codex:other'], '목록에 있는 세션(은퇴 표시·이름 불일치 포함)과 다른 프로젝트·프로젝트 불명은 그대로');
  Assert.deepEqual(reasonsOf(result), ['claude:lookalike:unlisted', 'claude:temp:unlisted']);
  Assert.equal(result.nodes.find(function(item) { return item.id === 'claude:lookalike'; }), undefined);
  Assert.deepEqual(result.groups.map(function(group) { return group.id; }), ['g']);
  const item = excludeDiagnostic(result);
  Assert.match(en(item.message), /: 2 \(0 marked archived, 0 by name pattern, 2 outside the session map: no supplement file lists them and no listed session started them\), plus 0 sub-agents they started\./);
  Assert.match(ko(item.message), /^보충 파일의 exclude 설정으로 뺀 세션: 2개\(은퇴 표시 0개, 이름 패턴 0개, 지도 밖 2개: /);
  Assert.equal(result.stats.nodes, 5);
});

Test('지도 밖 세션: 목록에 있는 남는 세션의 spawn 자손은 남고, 지도 밖 세션의 자식과 둘 다 낳은 것의 처리는 부모 기준', function()
{
  const document = excludeDocument(unlistedRule({ archived: true }), [{ id: 'claude:root', name: 'root' }, { id: 'claude:gone', name: 'gone', archived: true }]);
  const base = { project: 'koppa' };
  const nodes = ['claude:root', 'claude:gone', 'claude:kid', 'claude:grandkid', 'claude:stray', 'claude:strayKid', 'claude:shared', 'claude:orphan', 'claude:fromGone'].map(function(id) { return node(id, Object.assign({ name: id.slice(7), kind: /Kid|kid|shared|orphan|fromGone/.test(id) ? 'agent' : 'session' }, base)); });
  const edges = [
    { id: 'a', from: 'claude:root', to: 'claude:kid', type: 'spawn' }, { id: 'b', from: 'claude:kid', to: 'claude:grandkid', type: 'spawn' },
    { id: 'c', from: 'claude:stray', to: 'claude:strayKid', type: 'spawn' }, { id: 'd', from: 'claude:stray', to: 'claude:shared', type: 'spawn' }, { id: 'e', from: 'claude:root', to: 'claude:shared', type: 'spawn' },
    { id: 'f', from: 'claude:gone', to: 'claude:fromGone', type: 'spawn' }
  ];
  const result = graph(nodes, edges, [document]);
  Assert.deepEqual(nodeIds(result), ['claude:grandkid', 'claude:kid', 'claude:root', 'claude:shared']);
  Assert.deepEqual(result.edges.map(function(item) { return item.id; }).sort(), ['a', 'b', 'e']);
  Assert.deepEqual(reasonsOf(result), ['claude:gone:archived', 'claude:orphan:unlisted', 'claude:stray:unlisted']);
  Assert.match(en(excludeDiagnostic(result).message), /\(1 marked archived, 0 by name pattern, 2 outside the session map/);
  Assert.match(en(excludeDiagnostic(result).message), /plus 2 sub-agents they started/);
});

Test('지도 밖 세션: 목록에 있는 세션을 낳은 것이 빠져도 그 목록 세션은 남고, 목록 세션의 자손은 그 사이에 지도 밖 세션이 있어도 이어서 남음', function()
{
  const document = excludeDocument(unlistedRule({ match: ['old-*'] }), [{ id: 'claude:listedChild', name: 'listed-child' }, { id: 'claude:root', name: 'root' }]);
  const nodes = [node('claude:old', { name: 'old-parent', project: 'koppa' }), node('claude:listedChild', { name: 'listed-child', project: 'koppa' }), node('claude:root', { name: 'root', project: 'koppa' }), node('claude:mid', { name: 'mid', project: 'koppa', kind: 'agent' }), node('claude:leaf', { name: 'leaf', project: 'koppa', kind: 'agent' })];
  const edges = [{ id: 'a', from: 'claude:old', to: 'claude:listedChild', type: 'spawn' }, { id: 'b', from: 'claude:root', to: 'claude:mid', type: 'spawn' }, { id: 'c', from: 'claude:mid', to: 'claude:leaf', type: 'spawn' }];
  const result = graph(nodes, edges, [document]);
  Assert.deepEqual(nodeIds(result), ['claude:leaf', 'claude:listedChild', 'claude:mid', 'claude:root']);
  Assert.deepEqual(reasonsOf(result), ['claude:old:match']);
});

Test('지도 밖 세션: project는 대소문자를 가리지 않는 패턴이고 *는 모든 프로젝트, 여러 파일은 합쳐 쓰며 다른 파일이 올린 세션도 목록에 든 것', function()
{
  const lister = { schemaVersion: 1, sessions: [{ id: 'codex:listed', name: 'x' }], relations: [] };
  const nodes = [node('codex:listed', { name: 'x', project: 'alpha' }), node('codex:a', { name: 'a', project: 'Alpha-One' }), node('codex:b', { name: 'b', project: 'beta' }), node('codex:c', { name: 'c', project: 'gamma' })];
  Assert.deepEqual(nodeIds(graph(nodes, [], [lister, excludeDocument(unlistedRule({ project: 'ALPHA*' }))])), ['codex:b', 'codex:c', 'codex:listed']);
  Assert.deepEqual(nodeIds(graph(nodes, [], [lister, excludeDocument(unlistedRule({ project: '*' }))])), ['codex:listed']);
  Assert.deepEqual(nodeIds(graph(nodes, [], [lister, excludeDocument(unlistedRule({ project: 'alpha*' })), excludeDocument(unlistedRule({ project: 'beta' }))])), ['codex:c', 'codex:listed']);
  Assert.equal(excludeDiagnostic(graph(nodes, [], [lister, excludeDocument(unlistedRule({ project: 'alpha*' })), excludeDocument(unlistedRule({ project: 'beta' }))])).excluded.length, 2);
});

Test('지도 밖 세션: 빠진 세션의 관계와 별칭 충돌도 없고 다른 설정(은퇴 표시·패턴)과 함께 써도 사유가 나뉨', function()
{
  const document = excludeDocument(unlistedRule({ archived: true, match: ['*-g??'] }), [{ id: 'claude:keep', name: 'keep', aliases: ['dup'] }, { id: 'claude:retired', name: 'retired', archived: true }], [{ id: 'm1', from: 'claude:keep', to: 'claude:stray', type: 'management' }, { id: 'm2', from: 'claude:keep', to: 'claude:retired', type: 'collaboration' }]);
  const nodes = [node('claude:keep', { name: 'keep', project: 'koppa' }), node('claude:retired', { name: 'retired', project: 'koppa' }), node('claude:stray', { name: 'stray', project: 'koppa' }), node('claude:old', { name: 'old-g03', project: 'koppa' })];
  const result = graph(nodes, [], [document]);
  Assert.deepEqual(nodeIds(result), ['claude:keep']);
  Assert.deepEqual(result.edges, []);
  Assert.equal(result.nodes.some(function(item) { return item.kind === 'unresolved'; }), false);
  Assert.deepEqual(reasonsOf(result), ['claude:old:match', 'claude:retired:archived', 'claude:stray:unlisted']);
  Assert.match(en(excludeDiagnostic(result).message), /: 3 \(1 marked archived, 1 by name pattern, 1 outside the session map/);
});

Test('지도 밖 세션: 검증은 unlisted·project의 종류를 확인하고 스키마와 같은 필수 관계를 요구함', function()
{
  function errors(exclude) { return Supplement.validateSupplement(excludeDocument(exclude)).map(function(text) { return en(text); }); }
  Assert.deepEqual(errors({ unlisted: true, project: 'koppa' }), []);
  Assert.deepEqual(errors({ unlisted: false }), []);
  Assert.deepEqual(errors({ unlisted: 'yes', project: 3 }), ['exclude.unlisted: must be a boolean.', 'exclude.project: must be a string of 1 to 2000 characters.']);
  Assert.deepEqual(errors({ unlisted: true, project: ' ' }), ['exclude.project: must be a string of 1 to 2000 characters.']);
  const schema = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'schema', 'supplement.schema.json'), 'utf8'));
  Assert.deepEqual(Object.keys(schema.$defs.exclude.properties).sort(), ['archived', 'match', 'project', 'unlisted']);
  Assert.deepEqual(schema.$defs.exclude.then.required, ['project']);
});
