(function (root, factory)
{
  var parts = factory();
  if (typeof module === "object" && module.exports)
  {
    module.exports = parts;
  }
  else if (root.WasI18n)
  {
    root.WasI18n.addMessages(parts);
  }
})(typeof self !== "undefined" ? self : this, function ()
{
  "use strict";

  return {
    en: {
      "msg.redacted.privateKey": "[private value hidden]",
      "msg.redacted.credential": "[credential hidden]",
      "msg.redacted.value": "[hidden]",

      "msg.diagnostic.historySampled": "Only the beginning and end of a large record were read. The middle of its history is outside the initial collection range.",
      "msg.diagnostic.malformedJsonl": "Skipped a malformed JSONL record.",
      "msg.diagnostic.oversizedJsonlLine": "Records larger than 4 MiB were skipped and a diagnostic was left.",
      "msg.diagnostic.oversizedMetadata": "The metadata file exceeds the size limit.",
      "msg.diagnostic.malformedMetadata": "The metadata JSON could not be parsed.",
      "msg.diagnostic.fileUnreadable": "The record file could not be read.",
      "msg.diagnostic.fallback": "Collection diagnostic",
      "msg.diagnostic.sharedManagement": "Several sessions share logical management. This is separate from a spawn-parent conflict.",
      "msg.diagnostic.supplementNameStale": "The supplement JSON name \"{supplementName}\" differs from the observed name \"{observedName}\" of the same session ID. It is treated as a rename: the observed name is shown and the supplement name is kept as an alias. The supplement's archived flag is not applied, so check that the role and description are still current.",

      "msg.conflict.differentObserved": "Different observed values",
      "msg.conflict.aliasPointsToSeveral": "The same alias points to several sessions: {name}",
      "msg.conflict.aliasMappedToSeveral": "Alias mapped to several sessions",
      "msg.conflict.relationIdReused": "The relation ID is used by different connections.",
      "msg.conflict.duplicateRelationId": "Duplicate relation ID",
      "msg.conflict.multipleParents": "There are several parent relations.",
      "msg.conflict.managementCycle": "The logical management relations contain a cycle.",
      "msg.conflict.parentCycle": "The parent relations contain a cycle.",
      "msg.conflict.multipleParentsEdge": "Multiple-parent relation",
      "msg.conflict.managementCycleEdge": "Logical management cycle relation",
      "msg.conflict.cycleEdge": "Cycle relation",

      "msg.activity.unconfirmed": "The last activity time could not be determined.",
      "msg.activity.archived": "Marked as retired or archived in the supplement metadata.",
      "msg.activity.agentFinished": "A sub-agent that completed or was interrupted.",
      "msg.activity.recent": "Activity was recorded within the last 2 hours. This does not guarantee that it is running now.",
      "msg.activity.stale": "The latest recorded activity is more than 2 hours old. It has not been confirmed as ended.",

      "msg.node.noIdentifier": "No identifier",
      "msg.node.aliasConflict": "Alias conflict: cannot be resolved to a single session",
      "msg.node.relationWithoutSession": "A relation exists but no session record was found",

      "msg.source.supplementMetadata": "User supplement metadata",
      "msg.source.supplementRelation": "User supplement relation",
      "msg.source.managerMember": "manager → member supplement relation",

      "msg.supplement.locationDocument": "document",
      "msg.supplement.unknownField": "{location}: unknown field {field}",
      "msg.supplement.textLength": "{path}: must be a string of 1 to 2000 characters.",
      "msg.supplement.rootObject": "The top-level value must be a JSON object.",
      "msg.supplement.schemaVersion": "schemaVersion must be 1.",
      "msg.supplement.arrayRequired": "{path}: must be an array.",
      "msg.supplement.objectRequired": "{path}: must be an object.",
      "msg.supplement.booleanRequired": "{path}: must be a boolean.",
      "msg.supplement.idPrefix": "{path}: needs a \"claude:\" or \"codex:\" prefix.",
      "msg.supplement.duplicateSession": "{path}: duplicate session.",
      "msg.supplement.aliasesArray": "{path}: must be an array of non-empty strings.",
      "msg.supplement.relationType": "{path}: unsupported relation type.",
      "msg.supplement.confidenceLevel": "{path}: unsupported confidence level.",
      "msg.supplement.duplicateRelation": "{path}: duplicate relation.",
      "msg.supplement.fileTooLarge": "The supplement JSON must be a regular file of 16 MiB or less.",
      "msg.supplement.jsonSyntax": "JSON syntax error",

      "msg.supplementKeptLastValid": "Keeping the last valid version",
      "msg.supplementNotApplied": "Not applied",
      "msg.supplementReadError": "Could not read the supplement file ({code})",

      "msg.evidence.noActivity": "No activity events",
      "msg.evidence.claudeUserEvent": "Claude response in progress after a user event",
      "msg.evidence.claudeToolCall": "Claude tool call: {names}",
      "msg.evidence.claudeAssistantEvent": "Claude assistant event",
      "msg.evidence.claudeAssistantToolUse": "Claude assistant event (tool_use)",
      "msg.evidence.claudeInterrupted": "Claude interrupt event",
      "msg.evidence.claudeRuntimeStatus": "Claude live state: {status} · PID {pid}, process start time verified",
      "msg.evidence.codexToolCall": "Codex tool call: {name}",
      "msg.evidence.codexToolResult": "Codex tool result event: {name}",
      "msg.evidence.codexReasoning": "Codex reasoning event",
      "msg.evidence.codexAssistantEvent": "Codex assistant event",
      "msg.evidence.codexFinalAnswer": "Codex final answer",
      "msg.evidence.claudeAgentStopped": "Claude agent metadata stoppedByUser=true",
      "msg.evidence.claudeAgentFinished": "Claude agent metadata finished=true",
      "msg.evidence.staleEvent": "event older than 2 minutes, current status unknown",

      "msg.spawn.subagentsPath": "Session subagents path; no direct parent metadata",
      "msg.spawn.unknownParent": "Sub-agent record exists but no parent identifier; spawnDepth={depth}",
      "msg.spawn.selfReference": "{detail}; self-reference",

      "msg.bridge.directoryUnreadable": "Could not read the bridge directory.",
      "msg.bridge.metadataUnreadable": "Could not read the bridge metadata.",
      "msg.bridge.invalidJson": "The bridge JSON format is invalid.",
      "msg.bridge.unresolvedEndpointName": "Unresolved delivery endpoint",
      "msg.bridge.unresolvedEndpoints": {
        one: "Preserved {count} delivery endpoint without a session identifier as unresolved.",
        other: "Preserved {count} delivery endpoints without a session identifier as unresolved."
      }
    },
    ko: {
      "msg.redacted.privateKey": "[비공개 값 숨김]",
      "msg.redacted.credential": "[인증 값 숨김]",
      "msg.redacted.value": "[숨김]",

      "msg.diagnostic.historySampled": "대형 기록의 앞부분·끝부분만 읽었습니다. 중간 이력은 초기 수집 범위 밖입니다.",
      "msg.diagnostic.malformedJsonl": "잘못된 JSONL 레코드를 건너뛰었습니다.",
      "msg.diagnostic.oversizedJsonlLine": "4 MiB보다 큰 레코드는 진단을 남기고 건너뛰었습니다.",
      "msg.diagnostic.oversizedMetadata": "메타데이터 파일 크기 제한을 초과했습니다.",
      "msg.diagnostic.malformedMetadata": "메타데이터 JSON 문법을 확인할 수 없습니다.",
      "msg.diagnostic.fileUnreadable": "기록 파일을 읽을 수 없습니다.",
      "msg.diagnostic.fallback": "수집 진단",
      "msg.diagnostic.sharedManagement": "여러 세션이 논리적 관리를 공유합니다. 생성 부모 충돌과는 별개입니다.",
      "msg.diagnostic.supplementNameStale": "보충 JSON의 이름 \"{supplementName}\"이(가) 같은 세션 ID의 관측 이름 \"{observedName}\"과 다릅니다. 이름이 바뀐 것으로 보고 관측 이름을 표시하며, 보충 이름은 별칭으로 남깁니다. 보충의 은퇴(archived) 표시는 적용하지 않으니 역할·설명이 최신인지 확인하세요.",

      "msg.conflict.differentObserved": "서로 다른 관찰 값",
      "msg.conflict.aliasPointsToSeveral": "동일 별칭이 여러 세션을 가리킵니다: {name}",
      "msg.conflict.aliasMappedToSeveral": "여러 세션에 매핑된 별칭",
      "msg.conflict.relationIdReused": "관계 ID가 서로 다른 연결에 사용되었습니다.",
      "msg.conflict.duplicateRelationId": "중복 관계 ID",
      "msg.conflict.multipleParents": "부모 관계가 여러 개입니다.",
      "msg.conflict.managementCycle": "논리적 관리 관계에 순환이 있습니다.",
      "msg.conflict.parentCycle": "부모 관계에 순환이 있습니다.",
      "msg.conflict.multipleParentsEdge": "다중 부모 관계",
      "msg.conflict.managementCycleEdge": "논리적 관리 순환 관계",
      "msg.conflict.cycleEdge": "순환 관계",

      "msg.activity.unconfirmed": "마지막 활동 시각을 확인할 수 없습니다.",
      "msg.activity.archived": "보충 메타데이터에서 은퇴·보관한 세션으로 지정했습니다.",
      "msg.activity.agentFinished": "완료 또는 중단된 하위 에이전트입니다.",
      "msg.activity.recent": "최근 2시간 안에 활동 기록이 있습니다. 현재 실행을 보증하지 않습니다.",
      "msg.activity.stale": "최근 활동 기록이 2시간보다 오래되었습니다. 종료를 확정한 것은 아닙니다.",

      "msg.node.noIdentifier": "식별자 없음",
      "msg.node.aliasConflict": "별칭 충돌: 하나의 세션으로 확정할 수 없음",
      "msg.node.relationWithoutSession": "관계는 있으나 세션 기록 미확인",

      "msg.source.supplementMetadata": "사용자 보충 메타데이터",
      "msg.source.supplementRelation": "사용자 보충 관계",
      "msg.source.managerMember": "manager → member 보충 관계",

      "msg.supplement.locationDocument": "문서",
      "msg.supplement.unknownField": "{location}: 알 수 없는 필드 {field}",
      "msg.supplement.textLength": "{path}: 1~2000자 문자열이어야 합니다.",
      "msg.supplement.rootObject": "최상위 값은 JSON 객체여야 합니다.",
      "msg.supplement.schemaVersion": "schemaVersion은 1이어야 합니다.",
      "msg.supplement.arrayRequired": "{path}: 배열이어야 합니다.",
      "msg.supplement.objectRequired": "{path}: 객체이어야 합니다.",
      "msg.supplement.booleanRequired": "{path}: boolean이어야 합니다.",
      "msg.supplement.idPrefix": "{path}: claude: 또는 codex: 접두사가 필요합니다.",
      "msg.supplement.duplicateSession": "{path}: 중복 세션입니다.",
      "msg.supplement.aliasesArray": "{path}: 비어 있지 않은 문자열 배열이어야 합니다.",
      "msg.supplement.relationType": "{path}: 지원하지 않는 관계 종류입니다.",
      "msg.supplement.confidenceLevel": "{path}: 지원하지 않는 신뢰 구분입니다.",
      "msg.supplement.duplicateRelation": "{path}: 중복 관계입니다.",
      "msg.supplement.fileTooLarge": "보충 JSON은 16 MiB 이하 일반 파일이어야 합니다.",
      "msg.supplement.jsonSyntax": "JSON 문법 오류",

      "msg.supplementKeptLastValid": "마지막 유효본 유지 중",
      "msg.supplementNotApplied": "적용되지 않음",
      "msg.supplementReadError": "보충 파일을 읽을 수 없습니다 ({code})",

      "msg.evidence.noActivity": "활동 이벤트 없음",
      "msg.evidence.claudeUserEvent": "Claude user 이벤트 이후 응답 진행",
      "msg.evidence.claudeToolCall": "Claude 도구 호출: {names}",
      "msg.evidence.claudeAssistantEvent": "Claude assistant 이벤트",
      "msg.evidence.claudeAssistantToolUse": "Claude assistant 이벤트 (tool_use)",
      "msg.evidence.claudeInterrupted": "Claude 중단 이벤트",
      "msg.evidence.claudeRuntimeStatus": "Claude 실시간 상태: {status} · PID {pid}, 프로세스 시작 시각 검증됨",
      "msg.evidence.codexToolCall": "Codex 도구 호출: {name}",
      "msg.evidence.codexToolResult": "Codex 도구 결과 이벤트: {name}",
      "msg.evidence.codexReasoning": "Codex 추론 이벤트",
      "msg.evidence.codexAssistantEvent": "Codex assistant 이벤트",
      "msg.evidence.codexFinalAnswer": "Codex 최종 답변",
      "msg.evidence.claudeAgentStopped": "Claude agent 메타데이터 stoppedByUser=true",
      "msg.evidence.claudeAgentFinished": "Claude agent 메타데이터 finished=true",
      "msg.evidence.staleEvent": "2분 이상 지난 이벤트, 현재 상태 미확인",

      "msg.spawn.subagentsPath": "세션의 subagents 경로; 직접 부모 메타데이터 없음",
      "msg.spawn.unknownParent": "하위 에이전트 기록은 있으나 부모 식별자 없음; spawnDepth={depth}",
      "msg.spawn.selfReference": "{detail}; 자기 참조",

      "msg.bridge.directoryUnreadable": "브리지 디렉터리를 읽지 못했습니다.",
      "msg.bridge.metadataUnreadable": "브리지 메타데이터를 읽지 못했습니다.",
      "msg.bridge.invalidJson": "브리지 JSON 형식이 올바르지 않습니다.",
      "msg.bridge.unresolvedEndpointName": "미해결 전달 끝점",
      "msg.bridge.unresolvedEndpoints": {
        other: "세션 식별자가 없는 전달 끝점 {count}개를 미해결로 보존했습니다."
      }
    }
  };
});
