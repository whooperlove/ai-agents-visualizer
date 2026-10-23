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
      "scene.activity.inactive": "Inactive",
      "scene.activity.recent": "Recent",
      "scene.activity.unconfirmed": "Time unknown",
      "scene.status.running": "Working",
      "scene.status.waiting": "Waiting for reply",
      "scene.status.idle": "Idle",
      "scene.status.completed": "Completed",
      "scene.status.interrupted": "Interrupted",
      "scene.status.error": "Error",
      "scene.status.unknown": "Status unknown",
      "scene.label.providerUnknown": "Provider unknown",
      "scene.stage.regionLabel": "Side-scrolling office. Drag or use the wheel to move left and right, Shift and the wheel to change floors, arrow keys to select a session. Phone animations are an illustration based on delivery records and are not real calls.",
      "scene.stage.canvasLabel": "3D character office. Drag sideways or use the wheel to move, Shift and the wheel to change floors, Home or double-click to fit the view, arrow keys to select a session.",
      "scene.stage.empty": "No sessions to show.",
      "scene.stage.help": "Drag left or right · Wheel to move · Shift+wheel to change floor · Double-click to fit the view · Click a name tag to open details, click again to close",
      "scene.stage.zoneLounge": "Sofa lounge  ·  inactive sessions",
      "scene.stage.zoneWork": "Work area  ·  one desk per session",
      "scene.stage.zoneEmpty": "Session office",
      "scene.stage.counterLounge": "{total} on this floor · {visible} on screen · {inactive} inactive",
      "scene.stage.counterWork": "{total} on this floor · {visible} on screen · scroll sideways to explore",
      "scene.floor.position": "Floor {index} of {total}",
      "scene.floor.independent": "Independent sessions",
      "scene.floor.all": "Entire office",
      "scene.index.summary": "All sessions on this floor",
      "scene.index.summaryCount": "All sessions on this floor · {count}",
      "scene.partner.stackLabel": { one: "{count} session recently in contact with {name}", other: "{count} sessions recently in contact with {name}" },
      "scene.fallback.modelMissing": "The character model could not be loaded. The full session list is still available.",
      "scene.fallback.webglUnavailable": "WebGL 3D characters cannot be shown in this browser. You can check names and statuses in the full session list.",
      "scene.fallback.contextLost": "The 3D graphics connection was lost. Please use the full session list while it recovers."
    },
    ko: {
      "scene.activity.inactive": "비활성",
      "scene.activity.recent": "최근",
      "scene.activity.unconfirmed": "시각 미확인",
      "scene.status.running": "작업 중",
      "scene.status.waiting": "응답 대기",
      "scene.status.idle": "유휴",
      "scene.status.completed": "완료",
      "scene.status.interrupted": "중단",
      "scene.status.error": "오류",
      "scene.status.unknown": "상태 미확인",
      "scene.label.providerUnknown": "제공자 미확인",
      "scene.stage.regionLabel": "가로 탐색 오피스. 드래그나 휠로 좌우 이동, Shift와 휠로 층 전환, 방향키로 세션 선택. 전화 동작은 전달 기록을 바탕으로 한 표시이며 실제 통화가 아닙니다.",
      "scene.stage.canvasLabel": "3D 캐릭터 오피스. 가로 드래그와 휠로 이동, Shift와 휠로 층 전환, Home이나 더블클릭으로 화면 맞춤, 방향키로 세션 선택.",
      "scene.stage.empty": "표시할 세션이 없습니다.",
      "scene.stage.help": "좌우 드래그 · 휠 이동 · Shift+휠 층 전환 · 더블클릭 화면 맞춤 · 이름표를 누르면 상세 열기, 다시 누르면 닫기",
      "scene.stage.zoneLounge": "소파 라운지  ·  비활성 세션",
      "scene.stage.zoneWork": "업무 공간  ·  세션별 책상",
      "scene.stage.zoneEmpty": "세션 오피스",
      "scene.stage.counterLounge": "이 층 {total}명 · 화면 {visible}명 · 비활성 {inactive}명",
      "scene.stage.counterWork": "이 층 {total}명 · 화면 {visible}명 · 좌우로 계속 탐색",
      "scene.floor.position": "{index} / {total}층",
      "scene.floor.independent": "독립 세션",
      "scene.floor.all": "전체 사무실",
      "scene.index.summary": "이 층 전체 세션",
      "scene.index.summaryCount": "이 층 전체 세션 · {count}",
      "scene.partner.stackLabel": { other: "{name}와 최근 통신한 세션 {count}개" },
      "scene.fallback.modelMissing": "캐릭터 모델을 불러오지 못했습니다. 전체 세션 목록을 사용할 수 있습니다.",
      "scene.fallback.webglUnavailable": "이 브라우저에서 WebGL 3D 캐릭터를 표시할 수 없습니다. 전체 세션 목록에서 이름과 상태를 확인할 수 있습니다.",
      "scene.fallback.contextLost": "3D 그래픽 연결이 중단되었습니다. 복구하는 동안 전체 세션 목록을 이용해 주세요."
    }
  };
});
