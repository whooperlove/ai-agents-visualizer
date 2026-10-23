"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var vm = require("node:vm");
var helpers = require("./helpers/i18n");

// The directly required module reads the global catalog at call time; the sandboxes below load their own copy.
var catalog = helpers.loadNodeI18n();
catalog.setLocale("ko");
globalThis.WasI18n = catalog;
var frontend = require("../public/app.js");

function runtimeElement(value)
{
  var events = new Map();
  return {
    value: value || "", checked: true, textContent: "", scrollTop: 0, children: [],
    appendChild: function (child)
    {
      this.children.push(child);
      this.firstChild = this.children[0];
      return child;
    },
    setAttribute: function () {},
    querySelectorAll: function () { return []; },
    addEventListener: function (name, callback) { events.set(name, callback); },
    dispatch: function (name) { if (events.has(name)) events.get(name)(); }
  };
}

function frontendRuntime(locale)
{
  var runtime = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  helpers.loadBrowserI18n(runtime, locale || "ko");
  vm.runInContext(fs.readFileSync(require.resolve("../public/app.js"), "utf8"), runtime);
  runtime.document = { hidden: false };
  runtime.wasCreateElement = function (tag, className, value)
  {
    var element = runtimeElement();
    element.textContent = value || "";
    return element;
  };
  runtime.wasClearElement = function (element) { element.children = []; element.firstChild = null; };
  return runtime;
}

function node(id, extra)
{
  return Object.assign({ id: id, name: id, project: "alpha", provider: "codex", status: "running", kind: "session" }, extra);
}

function edge(id, from, to, extra)
{
  return Object.assign({ id: id, from: from, to: to, type: "spawn", confidence: "confirmed" }, extra);
}

function filters(extra)
{
  return Object.assign({ query: "", project: "alpha", provider: "", activity: "all", status: "", kind: "" }, extra);
}

test("retired diagram and dimension preferences migrate to the single character stage", function ()
{
  [{ view: "spatial" }, { view: "office3d" }, { view: "office", officeMode: "3d" }].forEach(function (preference)
  {
    var runtime = frontendRuntime();
    runtime.sessionStorage = { getItem: function () { return JSON.stringify(Object.assign({}, preference, { filters: { project: "alpha", activity: "all" } })); } };
    runtime.wasState = { savedFilters: {} };
    runtime.wasElements = {};
    ["search", "status", "kind", "activity", "edgeScope", "graphLayout", "showQuiet", "officeGrouped", "officeQuiet"].forEach(function (key)
    {
      runtime.wasElements[key] = runtimeElement();
    });
    runtime.wasRestorePreferences();
    assert.equal(runtime.wasState.viewMode, "office");
    assert.equal(runtime.wasElements.activity.value, "all");
    assert.equal(runtime.wasState.savedFilters.project, "alpha");
  });
  var html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.doesNotMatch(html, /spatial-(?:model|scene)|was-view-spatial|was-office-[23]d/);
  assert.ok(html.indexOf('/character-model.js') < html.indexOf('/office-scene.js'));
});

test("character snapshots preserve the renderer and full names while delivery metadata updates", function ()
{
  var runtime = frontendRuntime();
  var calls = [];
  var actors = [node("one", { name: "codex-alpha-full-session-name" }), node("two", { name: "claude-alpha-full-session-name" })];
  var floor = { id: "first", name: "팀", nodeIds: ["one", "two"] };
  var office = { actors: actors, actorById: new Map(actors.map(function (actor) { return [actor.id, actor]; })), floors: [floor], floorById: new Map([[floor.id, floor]]), project: "alpha", stats: { matched: 2, context: 0, hidden: 0 } };
  var delivery = edge("delivery", "one", "two", { type: "collaboration", message: { deliveryId: "delivery" } });
  runtime.WasOfficeModel = { buildOffice: function () { return office; } };
  runtime.wasReadFilters = filters;
  runtime.wasRenderOfficeFloor = function () {};
  runtime.wasRenderViewScope = function () {};
  runtime.wasState = {
    model: frontend.wasBuildModel({ nodes: actors, edges: [delivery] }), snapshot: {}, viewMode: "office", officeFloorId: "first",
    reducedMotion: { matches: false }, projectMessages: [delivery],
    officeScene: { setOffice: function (value) { calls.push(value.edges[0].status || "initial"); }, setPartners: function () {}, setMotion: function () {}, setVisible: function () {}, getState: function () { return { floorId: "first" }; } }
  };
  runtime.wasElements = {};
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeFloor", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasElements.activity.value = "all";
  runtime.wasElements.relationFilters.querySelectorAll = function () { return [{ value: "collaboration" }]; };
  runtime.wasUpdateOffice();
  runtime.wasUpdateOffice();
  assert.deepEqual(calls, ["initial"]);
  assert.equal(runtime.wasState.officeData.actors[0].name, "codex-alpha-full-session-name");
  runtime.wasState.model.edges[0].status = "completed";
  runtime.wasUpdateOffice();
  assert.deepEqual(calls, ["initial", "completed"]);
});

test("connection details preserve every raw record and string or object conflict", function ()
{
  var runtime = frontendRuntime();
  var raw = edge("actual", "one", "two");
  var pair = frontend.wasBundleConnections([raw, Object.assign({}, raw, { id: "other" })])[0];
  var conflict = { field: "parent", message: "서로 다른 부모가 기록되었습니다.", values: ["one", "two"] };
  pair.conflicts = ["원본 생성 관계의 순환", conflict];
  runtime.wasState = { selectedPairId: pair.id, viewMode: "graph", detailLimit: 20, model: frontend.wasBuildModel({ nodes: [node("one"), node("two")], edges: pair.edges }), graphEdges: [pair] };
  runtime.wasElements = { detail: runtimeElement() };
  runtime.wasRenderConnectionDetails();
  assert.equal(runtime.wasElements.detail.children[0].textContent, "", "the close button comes first");
  assert.equal(runtime.wasElements.detail.children[1].textContent, "세션 간 연결 · 원본 2개");
  var rendered = runtime.wasElements.detail.children.find(function (element) { return element.textContent.indexOf("관계 충돌\n") === 0; });
  assert.equal(rendered.textContent, "관계 충돌\n원본 생성 관계의 순환\n" + JSON.stringify(conflict));
});

test("phone candidates retain all visible deliveries and honor activity, relation layers and endpoints", function ()
{
  var runtime = frontendRuntime();
  var now = new Date().toISOString();
  var messages = [];
  for (var index = 0; index < 30; index += 1) messages.push(edge("m" + index, "one", "two", { type: "collaboration", lastSeen: now }));
  messages.push(edge("old", "one", "two", { type: "collaboration", lastSeen: "2020-01-01T00:00:00Z" }));
  messages.push(edge("hidden-endpoint", "one", "three", { type: "collaboration", lastSeen: now }));
  messages.push(edge("hidden-layer", "one", "two", { type: "handoff", lastSeen: now, message: { deliveryId: "handoff" } }));
  messages.push(edge("document", "one", "two", { type: "dependency", requestId: "not-a-delivery", lastSeen: now }));
  runtime.wasState = { officeData: { actorById: new Map([["one", {}], ["two", {}]]) } };
  runtime.wasElements = { activity: runtimeElement("recent"), relationFilters: { querySelectorAll: function () { return [{ value: "collaboration" }]; } } };
  assert.equal(runtime.wasOfficeDeliveryEdges(messages).length, 30);
  assert.equal(runtime.wasOfficeDeliveryEdges(messages)[29], messages[29]);
  runtime.wasElements.activity.value = "all";
  assert.equal(runtime.wasOfficeDeliveryEdges(messages).length, 31);
});

test("phone observations start after a baseline and replay stays in the stage with explicit replay metadata", function ()
{
  var runtime = frontendRuntime();
  var observed = [];
  var timers = [];
  var now = new Date().toISOString();
  var old = edge("initial", "one", "two", { type: "collaboration", lastSeen: now, message: { deliveryId: "initial", createdAt: now } });
  var fresh = edge("fresh", "one", "two", { type: "collaboration", lastSeen: now, message: { deliveryId: "fresh", createdAt: now } });
  var hidden = edge("hidden", "one", "two", { type: "handoff", lastSeen: now, message: { deliveryId: "hidden", createdAt: now } });
  runtime.setTimeout = function (callback, delay) { timers.push({ callback: callback, delay: delay }); return timers.length; };
  runtime.wasUpdateOptions = function () {};
  runtime.wasRenderHealth = function () {};
  runtime.wasRenderDiagnostics = function () {};
  runtime.wasRequestGraphDraw = function () {};
  runtime.wasSetView = function () { assert.fail("phone replay must stay in the character stage"); };
  runtime.wasUpdateView = function () { runtime.wasState.officeData = { actorById: new Map([["one", {}], ["two", {}]]) }; };
  runtime.wasState = { snapshot: null, messageState: null, flowPulses: [], savedFilters: {}, viewMode: "office", reducedMotion: { matches: false }, officeScene: { observe: function (edges, options) { observed.push({ edges: edges, options: options }); } } };
  runtime.wasElements = { project: runtimeElement(), provider: runtimeElement(), activity: runtimeElement("recent"), relationFilters: { querySelectorAll: function () { return [{ value: "collaboration" }]; } }, messageFeed: runtimeElement(), replayFlow: runtimeElement(), officeReplay: runtimeElement(), announcement: runtimeElement() };
  runtime.wasUpdateSnapshot({ version: 1, nodes: [node("one"), node("two")], edges: [old] });
  assert.equal(observed.length, 0);
  runtime.wasUpdateSnapshot({ version: 2, nodes: [node("one"), node("two")], edges: [old, fresh, hidden] });
  assert.equal(observed.length, 1);
  assert.deepEqual(Array.from(observed[0].edges, function (entry) { return entry.id; }), ["fresh"]);
  assert.equal(observed[0].options.replay, false);
  runtime.wasState.projectMessages = [fresh, old, hidden];
  runtime.wasStartReplay();
  assert.equal(runtime.wasState.replayStatus.total, 2);
  assert.equal(observed[1].options.replay, true);
  assert.equal(timers[0].delay, 1200);
  assert.match(runtime.wasElements.announcement.textContent, /실시간 전송이 아닙니다/);
  timers.shift().callback();
  timers.shift().callback();
  assert.equal(timers[0].delay, 4000);
});

function phoneScopeRuntime()
{
  var runtime = frontendRuntime();
  var elements = {};
  runtime.wasElements = new Proxy(elements, { get: function (target, key)
  {
    if (!target[key]) target[key] = runtimeElement();
    return target[key];
  } });
  runtime.window = { addEventListener: function () {} };
  runtime.document.addEventListener = function () {};
  runtime.clearTimeout = function () {};
  runtime.wasRequestGraphDraw = function () {};
  runtime.wasFitGraph = function () {};
  runtime.wasBindOfficeEvents = function () {};
  runtime.wasUpdateView = function () { assert.equal(runtime.wasState.replayStatus, null, "scope must stop replay before rebuilding the view"); };
  runtime.wasState = {
    viewMode: "office", selectedId: "one", focusId: "one", expanded: new Set(["one"]), flowPulses: [],
    replayStatus: { index: 0, total: 1 }, replayQueue: [], replayTimer: 3,
    reducedMotion: { matches: false, addEventListener: function () {} },
    officeData: { actorById: new Map([["one", {}], ["two", {}]]) },
    officeScene: { stopReplay: function () {}, fit: function () {}, observe: function () { assert.fail("an excluded delivery must never reach observe"); } }
  };
  runtime.wasElements.activity.value = "all";
  runtime.wasElements.relationFilters.querySelectorAll = function () { return [{ value: "collaboration" }]; };
  return runtime;
}

test("filter reset cancels the old project replay before the current scope is rebuilt", function ()
{
  var runtime = phoneScopeRuntime();
  runtime.wasElements.project.value = "other";
  runtime.wasState.replayQueue = [edge("other-project", "outside", "two", { type: "collaboration" })];
  runtime.wasResetFilters(false);
  assert.equal(runtime.wasState.replayStatus, null);
  assert.equal(runtime.wasState.replayQueue.length, 0);
  assert.equal(runtime.wasElements.project.value, "");
  assert.equal(runtime.wasElements.activity.value, "recent");
  runtime.wasReplayNext();
});

test("branch focus, clearing focus and resetting the view stop replay before changing the scope", function ()
{
  var runtime = phoneScopeRuntime();
  runtime.wasBindEvents();
  ["focusBranch", "clearFocus", "resetView"].forEach(function (name)
  {
    runtime.wasState.replayStatus = { index: 0, total: 1 };
    runtime.wasState.replayQueue = [edge("old-scope", "one", "two", { type: "collaboration" })];
    runtime.wasElements[name].dispatch("click");
    assert.equal(runtime.wasState.replayStatus, null, name);
    assert.equal(runtime.wasState.replayQueue.length, 0, name);
  });
});

test("the X button in the detail panel's corner closes the detail", function ()
{
  var runtime = phoneScopeRuntime();
  var handlers = [];
  var closed = 0;
  runtime.wasCreateElement = function (tag, className, value)
  {
    var element = runtimeElement();
    element.tag = tag;
    element.className = className;
    element.attributes = {};
    element.setAttribute = function (name, text) { element.attributes[name] = text; };
    return element;
  };
  runtime.wasElements.detail.addEventListener = function (name, callback) { if (name === "click") handlers.push(callback); };
  runtime.wasBindEvents();
  runtime.wasCloseDetail = function () { closed += 1; };
  var button = runtime.wasCreateDetailClose();
  assert.equal(button.tag, "button");
  assert.equal(button.type, "button");
  assert.equal(button.className, "was-detail-close");
  assert.equal(button.attributes["data-was-action"], "close-detail");
  assert.equal(button.attributes["aria-label"], "상세 닫기");
  assert.equal(button.title, "상세 닫기");
  assert.equal(handlers.length, 1);
  handlers[0]({ target: { closest: function (selector) { return selector === "[data-was-action='close-detail']" ? button : null; } } });
  assert.equal(closed, 1);
  handlers[0]({ target: { closest: function () { return null; } } });
  assert.equal(closed, 1, "clicks elsewhere in the panel do not close it");
});

test("each phone replay tick rechecks the current endpoint, relation layer and activity scope", function ()
{
  ["endpoint", "layer", "activity"].forEach(function (scope)
  {
    var runtime = phoneScopeRuntime();
    var delivery = edge("queued", scope === "endpoint" ? "outside" : "one", "two", { type: "collaboration", lastSeen: new Date().toISOString() });
    if (scope === "layer") runtime.wasElements.relationFilters.querySelectorAll = function () { return []; };
    if (scope === "activity")
    {
      runtime.wasElements.activity.value = "recent";
      delivery.lastSeen = "2020-01-01T00:00:00Z";
    }
    runtime.wasState.replayQueue = [delivery];
    assert.equal(runtime.wasOfficeDeliveryEdges([delivery]).length, 0);
    runtime.wasReplayNext();
    assert.equal(runtime.wasState.replayStatus, null);
    assert.equal(runtime.wasState.flowPulses.length, 0);
    assert.equal(runtime.wasElements.officeTravel.textContent, "기록 기반 · 실제 통화 아님", "a stopped replay returns the note to its plain form");
  });
});

test("character controls pan and zoom through the existing office scene API", function ()
{
  var runtime = frontendRuntime();
  var calls = [];
  runtime.window = { addEventListener: function () {} };
  runtime.wasState = { officeScene: { pan: function (value) { calls.push(["pan", value]); }, zoom: function (value) { calls.push(["zoom", value]); }, fit: function () { calls.push(["fit"]); } } };
  runtime.wasElements = {};
  ["viewOffice", "officeGrouped", "officeQuiet", "officeFloor", "officeDown", "officeUp", "officeLeft", "officeRight", "officeZoomIn", "officeZoomOut"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasBindOfficeEvents();
  ["officeLeft", "officeRight", "officeZoomIn", "officeZoomOut"].forEach(function (key) { runtime.wasElements[key].dispatch("click"); });
  assert.deepEqual(calls, [["pan", -0.7], ["pan", 0.7], ["zoom", 1.2], ["zoom", 1 / 1.2]]);
});

test("the stage keeps one bottom note for phone movements and page cleanup preserves live pulse history", function ()
{
  var runtime = frontendRuntime();
  var options = null;
  var calls = [];
  runtime.WasOfficeModel = {};
  runtime.WasOfficeScene = { create: function (value) { options = value; return { setMode: function () {}, stopReplay: function () { calls.push("stopReplay"); }, destroy: function () { calls.push("destroy"); } }; } };
  runtime.wasState = { officeScene: null, officeResizeFrame: 7, replayStatus: {}, replayTimer: 9, replayQueue: [{}], flowPulses: [{ replay: true }, { replay: false }], viewMode: "office" };
  runtime.wasElements = { officeStage: runtimeElement(), officeTravel: runtimeElement(), officeReplay: runtimeElement(), replayFlow: runtimeElement(), messageFeed: runtimeElement() };
  runtime.wasRequestGraphDraw = function () {};
  runtime.cancelAnimationFrame = function (id) { calls.push("cancel:" + id); };
  runtime.clearTimeout = function () {};
  runtime.wasEnsureOffice();
  options.onTravel({ text: "a → b", phase: "outgoing", replay: false, illustrative: true });
  assert.equal(runtime.wasElements.officeTravel.textContent, "기록 기반 · 실제 통화 아님 · a → b");
  options.onTravel({ text: "a → b", phase: "done", replay: true, illustrative: true });
  assert.equal(runtime.wasElements.officeTravel.textContent, "기록 기반 · 실제 통화 아님", "a finished movement returns to the plain note");
  options.onTravel({ text: "WebGL을 쓸 수 없습니다.", phase: "fallback", illustrative: false });
  assert.equal(runtime.wasElements.officeTravel.textContent, "WebGL을 쓸 수 없습니다.", "other notices are shown as they are");
  runtime.wasDestroyOffice();
  assert.deepEqual(calls, ["cancel:7", "stopReplay", "destroy"]);
  assert.equal(runtime.wasState.officeScene, null);
  assert.equal(runtime.wasState.officeResizeFrame, null);
  assert.equal(runtime.wasState.replayStatus, null);
  assert.equal(runtime.wasState.flowPulses.length, 1);
  assert.equal(runtime.wasState.flowPulses[0].replay, false);
});

test("wide character stage measures the final layout before height fit", function ()
{
  var runtime = frontendRuntime();
  var frames = [];
  var calls = [];
  var width = 100;
  runtime.requestAnimationFrame = function (callback) { frames.push(callback); return frames.length; };
  runtime.cancelAnimationFrame = function () {};
  runtime.wasState = { viewMode: "office", officeResizeFrame: null, presentation: {}, officeScene: { resize: function () { calls.push(["resize", width]); }, fit: function () { calls.push(["fit", width]); } } };
  runtime.wasResizeOfficeAfterLayout(true);
  frames.shift()();
  assert.equal(calls.length, 0);
  width = 1439;
  frames.shift()();
  assert.deepEqual(calls, [["resize", 1439], ["fit", 1439]]);
});

test("deep hierarchies remain complete without recursion or an arbitrary depth cutoff", function ()
{
  var nodes = [];
  var edges = [];
  for (var index = 0; index < 12000; index += 1)
  {
    nodes.push(node("n" + index));
    if (index > 0)
    {
      edges.push(edge("e" + index, "n" + (index - 1), "n" + index));
    }
  }
  var model = frontend.wasBuildModel({ nodes: nodes, edges: edges });
  assert.equal(model.nodes.length, 12000);
  assert.equal(model.descendants.get("n0"), 11999);
  var collapsed = frontend.wasBuildView(model, filters(), new Set(), null);
  assert.equal(collapsed.rows.length, 1);
  assert.equal(collapsed.included.size, 12000);
  var expanded = frontend.wasBuildView(model, filters(), new Set(model.order), null);
  assert.equal(expanded.rows.length, 12000);
  assert.equal(expanded.rows[11999].depth, 11999);
});

test("search finds a collapsed descendant and reveals the full ancestor chain", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("parent"), node("middle"), node("child", { description: "배경 이미지 검증" })], edges: [edge("a", "parent", "middle"), edge("b", "middle", "child")] });
  var view = frontend.wasBuildView(model, filters({ query: "이미지 검증" }), new Set(), null);
  assert.equal(view.matched.size, 1);
  assert.deepEqual(view.rows.map(function (row) { return row.id; }), ["parent", "middle", "child"]);
  assert.equal(view.rows[0].context, true);
  assert.equal(view.rows[2].context, false);
});

test("cycles, opposing parents and self references preserve every relation", function ()
{
  var relations = [edge("a", "one", "two"), edge("b", "two", "one"), edge("c", "three", "two"), edge("d", "three", "three")];
  var model = frontend.wasBuildModel({ nodes: [node("one"), node("two"), node("three")], edges: relations });
  assert.equal(model.edges.length, 4);
  assert.equal(model.order.length, 3);
  assert.equal(model.edgeIssues.size, 3);
  assert.equal(model.incident.get("two").length, 3);
  assert.equal(frontend.wasBuildView(model, filters(), new Set(model.order), null).rows.length, 3);
});

test("missing relation endpoints become inspectable unresolved nodes", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("known")], edges: [edge("link", "known", "missing", { type: "dependency", source: { kind: "bridge", path: "/local/record" } })] });
  assert.equal(model.nodeMap.get("missing").kind, "unresolved");
  assert.equal(model.nodeMap.get("missing").sources[0].kind, "bridge");
  assert.equal(model.edges.length, 1);
  var view = frontend.wasBuildView(model, filters({ project: "", kind: "unresolved" }), new Set(), null);
  assert.equal(view.matched.size, 1);
});

test("provider/status/kind filters match descendants while retaining contextual ancestors", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("parent"), node("child", { provider: "claude", status: "waiting", kind: "agent" }), node("other", { project: "other" })], edges: [edge("a", "parent", "child")] });
  var view = frontend.wasBuildView(model, filters({ provider: "claude", status: "waiting", kind: "agent" }), new Set(), null);
  assert.deepEqual(Array.from(view.matched), ["child"]);
  assert.deepEqual(view.rows.map(function (row) { return row.id; }), ["parent", "child"]);
});

test("branch focus includes all descendants and excludes sibling branches", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("root"), node("left"), node("leaf"), node("right")], edges: [edge("a", "root", "left"), edge("b", "left", "leaf"), edge("c", "root", "right")] });
  var view = frontend.wasBuildView(model, filters(), new Set(model.order), "left");
  assert.deepEqual(view.rows.map(function (row) { return row.id; }), ["left", "leaf"]);
  assert.equal(view.rows[0].depth, 0);
  assert.equal(frontend.wasGetBranch(model, "left").size, 2);
});

test("snapshot rebuild keeps user expansion choices and retains unknown relation types", function ()
{
  var expanded = new Set(["root"]);
  var model = frontend.wasBuildModel({ nodes: [node("root"), node("child")], edges: [edge("a", "root", "child"), edge("b", "child", "root", { type: "future-type" })] });
  var view = frontend.wasBuildView(model, filters(), expanded, null);
  assert.equal(view.rows.length, 2);
  assert.equal(expanded.size, 1);
  assert.equal(model.edges[1].type, "future-type");
});

test("activity defaults to recent and exposes excluded categories without dropping old records", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("fresh", { activity: { category: "recent", reason: "recent", windowMinutes: 120 } }), node("old", { activity: { category: "inactive", reason: "old", windowMinutes: 120 } }), node("unclear")], edges: [] });
  var view = frontend.wasBuildView(model, filters({ activity: undefined }), new Set(), null);
  assert.deepEqual(Array.from(view.matched), ["fresh"]);
  assert.deepEqual(view.hiddenByActivity, { recent: 0, inactive: 1, unconfirmed: 1 });
  assert.equal(model.nodes.length, 3);
  assert.equal(frontend.wasBuildView(model, filters({ activity: "all" }), new Set(), null).matched.size, 3);
  assert.deepEqual(Array.from(frontend.wasBuildView(model, filters({ activity: "inactive", query: "old" }), new Set(), null).matched), ["old"]);
});

test("inactive context parents reveal recent descendants and count filtered completed children", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("old-parent", { activity: { category: "inactive", reason: "old" } }), node("fresh-child", { activity: { category: "recent", reason: "recent" } }), node("completed-child", { kind: "agent", status: "completed", lastSeen: new Date().toISOString() })], edges: [edge("a", "old-parent", "fresh-child"), edge("b", "fresh-child", "completed-child")] });
  var view = frontend.wasBuildView(model, filters({ activity: "recent" }), new Set(), null);
  assert.deepEqual(view.rows.map(function (row) { return row.id; }), ["old-parent", "fresh-child"]);
  assert.equal(view.rows[0].context, true);
  assert.equal(view.contextActivity.inactive, 1);
  assert.equal(view.hiddenByActivity.inactive, 1);
  assert.equal(view.hiddenActivityDescendants.get("fresh-child"), 1);
});

test("fallback activity distinguishes recent, old, terminal agents and absent timestamps", function ()
{
  var now = Date.parse("2026-10-23T12:00:00.000Z");
  assert.equal(frontend.wasGetActivity(node("recent", { lastSeen: "2026-10-23T11:30:00Z" }), now).category, "recent");
  assert.equal(frontend.wasGetActivity(node("old", { lastSeen: "2026-10-23T09:00:00Z" }), now).category, "inactive");
  assert.equal(frontend.wasGetActivity(node("completed", { kind: "agent", status: "completed", lastSeen: "2026-10-23T11:59:00Z" }), now).category, "inactive");
  assert.equal(frontend.wasGetActivity(node("unknown"), now).category, "unconfirmed");
});

test("recent graph policy retains hierarchy and separates historical or documented bridge links", function ()
{
  var now = Date.parse("2026-10-23T12:00:00.000Z");
  assert.equal(frontend.wasGetEdgeHistory(edge("spawn", "a", "b"), now), false);
  assert.equal(frontend.wasGetEdgeHistory(edge("old", "a", "b", { type: "collaboration", lastSeen: "2026-10-23T08:00:00Z" }), now), true);
  assert.equal(frontend.wasGetEdgeHistory(edge("recent", "a", "b", { type: "collaboration", lastSeen: "2026-10-23T11:59:00Z" }), now), false);
  assert.equal(frontend.wasGetEdgeHistory(edge("document", "a", "b", { type: "dependency", status: "documented-waiting", lastSeen: "2026-10-23T11:59:00Z" }), now), true);
  assert.equal(frontend.wasGetEdgeHistory(edge("handoff", "a", "b", { type: "handoff", lastSeen: "2026-10-23T11:59:00Z" }), now), false);
  assert.equal(frontend.wasGetEdgeHistory(edge("undated", "a", "b", { type: "handoff" }), now), true);
});

test("logical management topology preserves cycles, shared managers and native parentage separately", function ()
{
  var nodes = [node("master", { name: "plain title" }), node("director"), node("writer"), node("second"), node("native")];
  var edges = [edge("m1", "master", "director", { type: "management" }), edge("m2", "director", "writer", { type: "management" }), edge("m3", "writer", "master", { type: "management" }), edge("m4", "second", "writer", { type: "management" }), edge("s1", "master", "native")];
  var model = frontend.wasBuildModel({ nodes: nodes, edges: edges });
  var view = frontend.wasBuildView(model, filters(), new Set(["master"]), null);
  var operating = frontend.wasBuildOperatingView(model, view, filters(), new Set(["master"]), true);
  assert.equal(model.parent.has("director"), false);
  assert.equal(model.parent.get("native"), "master");
  assert.equal(operating.rows.length, 5);
  assert.equal(new Set(operating.rows.map(function (row) { return row.id; })).size, 5);
  assert.equal(operating.management.length, 4);
  assert.equal(model.edges.length, 5);
  operating.rows.forEach(function (row)
  {
    var seen = new Set();
    var id = row.id;
    while (id)
    {
      assert.equal(seen.has(id), false);
      seen.add(id);
      id = operating.parent.get(id);
    }
  });
  assert.equal(operating.rows.find(function (row) { return row.id === "master"; }).manager, true);
});

test("quiet configured team is visible as context without returning archived nodes or native children", function ()
{
  var nodes = [node("master", { activity: { category: "recent" } }), node("quiet", { activity: { category: "inactive" } }), node("archived", { archived: true, activity: { category: "inactive" } })];
  var edges = [edge("m1", "master", "quiet", { type: "management" }), edge("m2", "master", "archived", { type: "management" })];
  for (var index = 0; index < 1000; index += 1)
  {
    nodes.push(node("child" + index, { kind: "agent", status: "completed", activity: { category: "inactive" } }));
    edges.push(edge("spawn" + index, "quiet", "child" + index));
  }
  var model = frontend.wasBuildModel({ nodes: nodes, edges: edges });
  var recent = filters({ activity: "recent" });
  var view = frontend.wasBuildView(model, recent, new Set(), null);
  var operating = frontend.wasBuildOperatingView(model, view, recent, new Set(), true);
  assert.deepEqual(operating.rows.map(function (row) { return row.id; }), ["master", "quiet"]);
  assert.equal(operating.rows[1].context, true);
  assert.equal(operating.quiet.size, 1);
  assert.equal(model.descendants.get("quiet"), 1000);
  assert.equal(view.matched.size, 1);
  assert.equal(view.hiddenByActivity.inactive, 1002);
  assert.deepEqual(frontend.wasBuildOperatingView(model, view, recent, new Set(), false).rows.map(function (row) { return row.id; }), ["master"]);
  assert.deepEqual(frontend.wasBuildOperatingView(model, view, filters({ activity: "recent", focusId: "master" }), new Set(), true).rows.map(function (row) { return row.id; }), ["master"]);
});

test("message observation establishes a complete baseline, deduplicates polls and records status transitions", function ()
{
  var now = Date.parse("2026-10-23T12:00:00Z");
  var request = edge("message", "master", "worker", { type: "collaboration", status: "queued", message: { deliveryId: "d1", kind: "request", createdAt: new Date(now - 60000).toISOString(), outcome: "none" } });
  var observation = frontend.wasObserveMessages(null, [], now, { loading: true });
  observation = frontend.wasObserveMessages(observation.state, [request], now + 1000, { loading: true });
  assert.equal(observation.fresh.length, 0);
  assert.equal(observation.state.baseline, false);
  observation = frontend.wasObserveMessages(observation.state, [request], now + 2000, { loading: false });
  assert.equal(observation.fresh.length, 0);
  assert.equal(observation.state.baseline, true);
  observation = frontend.wasObserveMessages(observation.state, [Object.assign({}, request)], now + 3000);
  assert.equal(observation.fresh.length, 0);
  var delivered = Object.assign({}, request, { status: "delivered", message: Object.assign({}, request.message, { acceptedAt: new Date(now + 4000).toISOString() }) });
  observation = frontend.wasObserveMessages(observation.state, [delivered], now + 5000);
  assert.equal(observation.fresh.length, 1);
  assert.equal(observation.fresh[0].transition, true);
  observation = frontend.wasObserveMessages(observation.state, [delivered], now + 6000);
  assert.equal(observation.fresh.length, 0);
  assert.equal(observation.state.events.length, 1);
  var older = Object.assign({}, request, { id: "old", message: Object.assign({}, request.message, { deliveryId: "old" }) });
  observation = frontend.wasObserveMessages(observation.state, [delivered, older], now + 7000);
  assert.equal(observation.fresh.length, 0);
  var fresh = Object.assign({}, request, { id: "new", message: Object.assign({}, request.message, { deliveryId: "new", createdAt: new Date(now + 7000).toISOString() }) });
  observation = frontend.wasObserveMessages(observation.state, [delivered, older, fresh], now + 8000);
  assert.equal(observation.fresh.length, 1);
  assert.equal(observation.fresh[0].transition, false);
  observation = frontend.wasObserveMessages(observation.state, [delivered, older, fresh], now + 9000, { reset: true });
  assert.equal(observation.fresh.length, 0);
  assert.equal(observation.state.events.length, 0);
});

test("message bundles retain direction, distinguish replies and count unresolved outbound queues once", function ()
{
  var edges = [edge("a", "master", "worker", { type: "collaboration", status: "queued", message: { deliveryId: "a", kind: "request", outcome: "none" } }), edge("b", "master", "worker", { type: "collaboration", status: "delivered", message: { deliveryId: "b", kind: "request", outcome: "reply-recorded", finishedAt: "2026-10-23T12:00:00Z" } }), edge("c", "worker", "master", { type: "collaboration", status: "delivered", message: { deliveryId: "c", kind: "reply", finishedAt: "2026-10-23T12:00:00Z", parentDeliveryId: "b" } })];
  var summary = frontend.wasSummarizeMessages(edges.concat([edges[0]]));
  assert.equal(summary.deliveries.size, 3);
  assert.equal(summary.bundles.size, 2);
  assert.deepEqual(summary.nodes.get("master"), { sent: 2, received: 1, unresolved: 1 });
  assert.deepEqual(summary.nodes.get("worker"), { sent: 1, received: 2, unresolved: 0 });
  assert.equal(summary.bundles.get(JSON.stringify(["master", "worker"])).count, 2);
  assert.equal(frontend.wasMessageResolved(edge("expired", "a", "b", { message: { expired: true } })), true);
  assert.equal(frontend.wasGetEdgeHistory(edge("management", "a", "b", { type: "management" })), false);
});

test("observation memory is bounded and older event count remains inspectable", function ()
{
  var now = Date.parse("2026-10-23T12:00:00Z");
  var observation = frontend.wasObserveMessages(null, [], now);
  for (var index = 0; index < 250; index += 1)
  {
    observation = frontend.wasObserveMessages(observation.state, [edge("delivery" + index, "a", "b", { type: "collaboration", message: { deliveryId: "d" + index, createdAt: new Date(now + index).toISOString() } })], now + index + 1);
  }
  assert.equal(observation.state.events.length, 200);
  assert.equal(observation.state.older, 50);
  assert.equal(observation.state.events[0].id, "d50");
  assert.equal(observation.state.signatures.size, 250);
});

test("nonmessage hierarchy and documented request references never become deliveries or replay on polling", function ()
{
  var edges = [];
  for (var index = 0; index < 3200; index += 1)
  {
    edges.push(edge("s" + index, "master", "child" + index));
  }
  edges.push(edge("management", "master", "worker", { type: "management", status: "documented-management" }));
  edges.push(edge("documented", "master", "worker", { type: "dependency", requestId: "shared", status: "documented-waiting" }));
  edges.push(edge("request", "master", "worker", { type: "collaboration", requestId: "shared", message: { deliveryId: "shared", kind: "request", finishedAt: "2026-10-18T12:00:00Z" } }));
  edges.push(edge("reply", "worker", "master", { type: "collaboration", requestId: "shared", message: { deliveryId: "reply", kind: "reply", parentDeliveryId: "shared", finishedAt: "2026-10-18T12:01:00Z" } }));
  var observed = frontend.wasObserveMessages(null, edges, Date.parse("2026-10-23T12:00:00Z"));
  observed = frontend.wasObserveMessages(observed.state, edges, Date.parse("2026-10-23T12:01:00Z"));
  assert.equal(observed.fresh.length, 0);
  assert.equal(observed.state.events.length, 0);
  assert.equal(observed.state.signatures.size, 2);
  var summary = frontend.wasSummarizeMessages(edges);
  assert.equal(summary.deliveries.size, 2);
  assert.equal(summary.nodes.has("child1"), false);
  assert.deepEqual(summary.nodes.get("master"), { sent: 1, received: 1, unresolved: 0 });
});

test("a logical-team search retains management ancestors without adding unrelated quiet teammates", function ()
{
  var model = frontend.wasBuildModel({ nodes: [node("master"), node("director"), node("writer", { description: "needle" }), node("other")], edges: [edge("a", "master", "director", { type: "management" }), edge("b", "director", "writer", { type: "management" }), edge("c", "master", "other", { type: "management" })] });
  var search = filters({ query: "needle" });
  var view = frontend.wasBuildView(model, search, new Set(), null);
  var logical = frontend.wasBuildOperatingView(model, view, search, new Set(), true);
  assert.deepEqual(logical.rows.map(function (row) { return row.id; }), ["master", "director", "writer"]);
  assert.equal(logical.rows[0].context, true);
  assert.equal(logical.rows[2].context, false);
  assert.equal(view.matched.size, 1);
});

test("fifty parallel deliveries produce one connection while preserving every raw record", function ()
{
  var messages = [];
  for (var index = 0; index < 50; index += 1)
  {
    messages.push(edge("message-" + index, "master", "worker", { type: "collaboration", status: index < 7 ? "queued" : "completed", source: { path: "/record/" + index }, message: { deliveryId: "delivery-" + index, kind: "request" } }));
  }
  var pairs = frontend.wasBundleConnections(messages);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].edges.length, 50);
  assert.equal(pairs[0].deliveryCount, 50);
  assert.equal(pairs[0].unresolved, 7);
  assert.deepEqual(pairs[0].edges, messages);
  assert.match(frontend.wasConnectionLabel(pairs[0]), /협업 · 전달 50 · 미해결 7/);
});

test("one unordered connection retains request, reply, structural provenance and mixed confidence", function ()
{
  var records = [
    edge("manager", "z-master", "a-worker", { type: "management", confidence: "inferred", source: { path: "/team" } }),
    edge("native", "z-master", "a-worker", { type: "spawn", source: { path: "/native" } }),
    edge("wait", "z-master", "a-worker", { type: "dependency", requestId: "thread", confidence: "unresolved" }),
    edge("request", "z-master", "a-worker", { type: "collaboration", requestId: "thread", status: "queued", message: { deliveryId: "request-delivery", kind: "request" } }),
    edge("reply", "a-worker", "z-master", { type: "collaboration", requestId: "thread", status: "reply-recorded", conflicts: ["opposing evidence"], message: { deliveryId: "reply-delivery", kind: "reply", parentDeliveryId: "request-delivery" } }),
    edge("handoff", "a-worker", "z-master", { type: "handoff", confidence: "confirmed" })
  ];
  var pair = frontend.wasBundleConnections(records, new Map([["native", "multiple parents"]]))[0];
  assert.deepEqual([pair.from, pair.to], ["a-worker", "z-master"]);
  assert.equal(pair.edges.length, 6);
  assert.deepEqual(pair.types, ["management", "spawn", "dependency", "collaboration", "handoff"]);
  assert.equal(pair.deliveryCount, 2);
  assert.equal(pair.unresolved, 1);
  assert.equal(pair.forward.edges.length, 2);
  assert.equal(pair.reverse.edges.length, 4);
  assert.equal(pair.forward.messages[0].message.kind, "reply");
  assert.equal(pair.reverse.messages[0].message.kind, "request");
  assert.deepEqual(pair.confidenceCounts, { confirmed: 4, inferred: 1, unresolved: 1 });
  assert.deepEqual(pair.conflicts, ["multiple parents", "opposing evidence"]);
  assert.match(frontend.wasConnectionLabel(pair), /관리·생성·대기·협업·인계/);
  assert.match(frontend.wasConnectionLabel(pair), /추정 1 · 미확인 1 · ⚠ 충돌 2/);
  var duplicate = Object.assign({}, records[3], { id: "second-source" });
  var deduplicated = frontend.wasBundleConnections(records.concat([duplicate]))[0];
  assert.equal(deduplicated.edges.length, 7);
  assert.equal(deduplicated.deliveryCount, 2);
});

test("same-column routing uses bottom and top ports for adjacent cards and a compact lane around a middle card", function ()
{
  var positions = new Map([
    ["a", { x: 38, y: 38, width: 228, height: 77 }],
    ["b", { x: 38, y: 146, width: 228, height: 77 }],
    ["c", { x: 38, y: 254, width: 228, height: 77 }]
  ]);
  var adjacent = frontend.wasRouteConnection({ from: "a", to: "b" }, positions);
  assert.deepEqual(adjacent.points[0], { x: 152, y: 115 });
  assert.deepEqual(adjacent.points[adjacent.points.length - 1], { x: 152, y: 146 });
  assert.equal(adjacent.length, 31);
  var skipping = frontend.wasRouteConnection({ from: "a", to: "c" }, positions);
  assert.equal(skipping.points[0].y, 76.5);
  assert.equal(skipping.points[skipping.points.length - 1].y, 292.5);
  assert.ok(skipping.points.every(function (point) { return point.x >= 20 && point.x <= 284; }));
  for (var index = 1; index < skipping.points.length; index += 1)
  {
    var start = skipping.points[index - 1];
    var end = skipping.points[index];
    assert.equal(Math.max(start.x, end.x) > 38 && Math.min(start.x, end.x) < 266 && Math.max(start.y, end.y) > 146 && Math.min(start.y, end.y) < 223, false);
  }
});

test("direction counts and replay coordinates follow the same leftward or upward connection", function ()
{
  var pair = frontend.wasBundleConnections([
    edge("out", "a", "z", { type: "collaboration", message: { deliveryId: "out" } }),
    edge("back", "z", "a", { type: "collaboration", message: { deliveryId: "back" } })
  ])[0];
  var positions = new Map([["a", { x: 350, y: 38, width: 228, height: 77 }], ["z", { x: 38, y: 38, width: 228, height: 77 }]]);
  var route = frontend.wasRouteConnection(pair, positions);
  assert.equal(frontend.wasConnectionDirectionLabel(pair, route), "← 1  ·  → 1");
  assert.deepEqual(frontend.wasPointOnRoute(route, 0), { x: 350, y: 76.5, angle: Math.PI });
  assert.equal(frontend.wasPointOnRoute(route, 1).x, 266);
  assert.ok(frontend.wasPointOnRoute(route, .25).x > frontend.wasPointOnRoute(route, .75).x);
  positions.set("a", { x: 38, y: 254, width: 228, height: 77 });
  route = frontend.wasRouteConnection(pair, positions);
  assert.equal(frontend.wasConnectionDirectionLabel(pair, route), "↑ 1  ·  ↓ 1");
  assert.ok(frontend.wasPointOnRoute(route, .25).y > frontend.wasPointOnRoute(route, .75).y);
});

test("pressing the selected character again closes its detail, and reopens it when the wide overlay was hidden by hand", function ()
{
  var runtime = frontendRuntime();
  var options = null;
  var calls = [];
  var classes = new Set();
  var expanded = null;
  runtime.document = { hidden: false, body: { classList: { add: function (name) { classes.add(name); }, remove: function (name) { classes.delete(name); }, contains: function (name) { return classes.has(name); } } } };
  runtime.WasOfficeModel = {};
  runtime.WasOfficeScene = { create: function (value) { options = value; return { setMode: function () {}, select: function (id) { calls.push("scene:" + id); } }; } };
  runtime.wasState = { officeScene: null, selectedId: null, selectedPairId: null, presentation: null, viewMode: "office" };
  runtime.wasElements = { officeStage: runtimeElement(), focusBranch: runtimeElement(), announcement: runtimeElement(),
    presentationDetail: Object.assign(runtimeElement(), { setAttribute: function (name, value) { expanded = value; } }) };
  runtime.wasSelectNode = function (id) { runtime.wasState.selectedId = id; calls.push("select:" + id); };
  ["wasRenderTree", "wasRenderDetails", "wasUpdateGraphEdges", "wasRequestGraphDraw", "wasRenderOfficeFloor"].forEach(function (name)
  {
    runtime[name] = function () { calls.push(name); };
  });
  runtime.wasEnsureOffice();

  options.onSelect("one", { again: false });
  assert.equal(runtime.wasState.selectedId, "one");
  options.onSelect("one", { again: true });
  assert.equal(runtime.wasState.selectedId, null);
  assert.equal(runtime.wasElements.focusBranch.disabled, true);
  assert.ok(calls.includes("scene:null") && calls.includes("wasRenderDetails"));
  options.onSelect("one", { again: false });
  assert.equal(runtime.wasState.selectedId, "one");

  runtime.wasState.presentation = {};
  options.onSelect("one", { again: false });
  assert.ok(classes.has("was-presentation-detail-open"));
  options.onSelect("one", { again: true });
  assert.equal(classes.has("was-presentation-detail-open"), false);
  assert.equal(expanded, "false");
  assert.equal(runtime.wasState.selectedId, null);

  options.onSelect("one", { again: false });
  classes.delete("was-presentation-detail-open");
  options.onSelect("one", { again: true });
  assert.equal(runtime.wasState.selectedId, "one");
  assert.ok(classes.has("was-presentation-detail-open"));
});

function partnerRuntime(edges)
{
  var runtime = frontendRuntime();
  var longName = "claude-alpha-a-very-long-session-name-that-must-stay-completely-readable-without-any-ellipsis";
  var nodes = [node("one", { name: "codex-alpha-center" }), node("two", { name: longName, provider: "claude" }), node("three", { name: "codex-alpha-third", status: "idle" }), node("four", { name: "codex-alpha-fourth" }), node("five", { name: "codex-alpha-silent" })];
  var pushed = [];
  runtime.wasState = { model: frontend.wasBuildModel({ nodes: nodes, edges: edges }), viewMode: "office", officePartnersSignature: null,
    officeScene: { setPartners: function (cards) { pushed.push(cards); } },
    officeData: { edges: edges, actorById: new Map(nodes.map(function (entry) { return [entry.id, entry]; })) } };
  return { runtime: runtime, longName: longName, pushed: pushed };
}

function minutesAgo(minutes)
{
  return new Date(Date.now() - minutes * 60000).toISOString();
}

test("every character gets a card per messaging counterpart, newest first, with the full session name", function ()
{
  var edges = [
    edge("d1", "one", "two", { type: "collaboration", lastSeen: minutesAgo(30), message: { deliveryId: "d1", outcome: "none" } }),
    edge("d2", "two", "one", { type: "collaboration", lastSeen: minutesAgo(5), message: { deliveryId: "d2", finishedAt: minutesAgo(5) } }),
    edge("d3", "one", "three", { type: "collaboration", lastSeen: minutesAgo(90), message: { deliveryId: "d3", finishedAt: minutesAgo(90) } }),
    edge("d4", "four", "one", { type: "collaboration", lastSeen: minutesAgo(60), message: { deliveryId: "d4", outcome: "none" } }),
    edge("spawn", "one", "five", { type: "spawn" })
  ];
  var setup = partnerRuntime(edges);
  var cards = setup.runtime.wasOfficePartnerMap();
  assert.deepEqual(Object.keys(cards).sort(), ["four", "one", "three", "two"], "sessions with no recorded message get no cards, spawn links are not messages");
  assert.deepEqual(Array.from(cards.one, function (card) { return card.id; }), ["two", "four", "three"], "most recent counterpart first");
  assert.equal(cards.one[0].name, setup.longName, "the name is passed through untouched");
  assert.equal(cards.one[0].meta, "5분 전 · 미해결 1", "only the age and the unresolved count remain");
  assert.equal(cards.one[1].meta, "1시간 전 · 미해결 1");
  assert.equal(cards.one[2].meta, "1시간 전", "nothing unresolved, so only the age");
  assert.equal(cards.one[2].status, "idle");
  cards.one.forEach(function (card) { assert.deepEqual(Object.keys(card).sort(), ["id", "lastTime", "meta", "name", "status"], "no provider and no sent/received counts"); });
  assert.ok(Math.abs(cards.one[0].lastTime - (Date.now() - 5 * 60000)) < 5000, "the stage ages each card by this timestamp");
  assert.deepEqual(Array.from(cards.two, function (card) { return card.id; }), ["one"], "the conversation shows on both characters");
  assert.equal(cards.two[0].meta, "5분 전 · 미해결 1", "the age is that of the latest message between the two");
});

test("the stage receives counterpart cards only when they changed and only in the character view", function ()
{
  var edges = [edge("d1", "one", "two", { type: "collaboration", lastSeen: minutesAgo(3), message: { deliveryId: "d1" } })];
  var setup = partnerRuntime(edges);
  var runtime = setup.runtime;
  runtime.wasRenderOfficePartners();
  runtime.wasRenderOfficePartners();
  assert.equal(setup.pushed.length, 1);
  assert.deepEqual(Object.keys(setup.pushed[0]).sort(), ["one", "two"]);
  runtime.wasState.officeData.edges = edges.concat([edge("d2", "two", "three", { type: "collaboration", lastSeen: minutesAgo(1), message: { deliveryId: "d2" } })]);
  runtime.wasRenderOfficePartners();
  assert.equal(setup.pushed.length, 2);
  assert.deepEqual(Object.keys(setup.pushed[1]).sort(), ["one", "three", "two"]);
  runtime.wasState.viewMode = "tree";
  runtime.wasState.officeData.edges = [];
  runtime.wasRenderOfficePartners();
  assert.equal(setup.pushed.length, 2, "other views never touch the stage");
});

test("the character stage replays recent calls on its own, once per opening, without a button", function ()
{
  var runtime = frontendRuntime();
  var observed = [];
  var timers = [];
  var recent = [];
  var index;
  for (index = 0; index < 15; index += 1)
  {
    recent.push(edge("recent" + index, "one", "two", { type: "collaboration", lastSeen: minutesAgo(index + 1), message: { deliveryId: "recent" + index, createdAt: minutesAgo(index + 1) } }));
  }
  var stale = edge("stale", "one", "two", { type: "collaboration", lastSeen: minutesAgo(600), message: { deliveryId: "stale", createdAt: minutesAgo(600) } });
  runtime.setTimeout = function (callback, delay) { timers.push({ callback: callback, delay: delay }); return timers.length; };
  runtime.wasRequestGraphDraw = function () {};
  runtime.wasSetView = function () { assert.fail("replay must stay in the character stage"); };
  runtime.wasState = { viewMode: "office", officeAutoReplay: true, replayStatus: null, replayQueue: [], flowPulses: [], reducedMotion: { matches: false },
    snapshot: { stats: { loading: true } }, projectMessages: recent.concat([stale]),
    officeScene: { observe: function (edges, options) { observed.push({ id: edges[0].id, replay: options.replay }); } },
    officeData: { actorById: new Map([["one", {}], ["two", {}]]) } };
  runtime.wasElements = { activity: runtimeElement("all"), relationFilters: { querySelectorAll: function () { return [{ value: "collaboration" }]; } }, replayFlow: runtimeElement(), announcement: runtimeElement(), messageFeed: runtimeElement(), officeTravel: runtimeElement() };
  runtime.wasAutoReplayOffice();
  assert.equal(observed.length, 0, "wait until the first snapshot has finished loading");
  assert.equal(runtime.wasState.officeAutoReplay, true);
  runtime.wasState.snapshot = { stats: { loading: false } };
  runtime.wasAutoReplayOffice();
  assert.equal(runtime.wasState.officeAutoReplay, false);
  assert.equal(runtime.wasState.replayStatus.total, 12, "the latest twelve deliveries inside the two-hour window");
  assert.deepEqual(observed[0], { id: "recent11", replay: true }, "oldest of those first");
  assert.equal(runtime.wasElements.announcement.textContent, "", "the automatic replay does not interrupt screen readers");
  runtime.wasStopReplay();
  runtime.wasAutoReplayOffice();
  assert.equal(runtime.wasState.replayStatus, null, "it does not restart until the stage is opened again");
  runtime.wasStopReplay();
  runtime.wasState.officeAutoReplay = true;
  runtime.wasState.replayStatus = { total: 1, index: 0 };
  runtime.wasAutoReplayOffice();
  assert.equal(runtime.wasState.replayStatus.total, 1, "a running replay is never toggled off by the automatic start");
});

/* ---- Language support: English and Korean output, language switch, server message tokens ---- */

var HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

function fakeElement(tag)
{
  var events = new Map();
  return {
    tag: tag || "div", nodeType: 1, value: "", checked: true, textContent: "", title: "", className: "", hidden: false, disabled: false,
    scrollTop: 0, clientHeight: 500, children: [], firstChild: null, attributes: {}, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    appendChild: function (child) { this.children.push(child); this.firstChild = this.children[0]; return child; },
    removeChild: function (child) { this.children = this.children.filter(function (entry) { return entry !== child; }); this.firstChild = this.children[0] || null; return child; },
    insertBefore: function (child) { this.children.unshift(child); this.firstChild = this.children[0]; return child; },
    setAttribute: function (name, value) { this.attributes[name] = String(value); },
    getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute: function (name) { delete this.attributes[name]; },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 0, height: 0 }; },
    getContext: function () { return null; },
    focus: function () {},
    addEventListener: function (name, callback) { events.set(name, callback); },
    dispatch: function (name) { if (events.has(name)) events.get(name)({ target: this }); }
  };
}

/* Every text a node shows: its text, title and attributes, and those of everything below it. */
function collectStrings(element, found)
{
  found = found || [];
  if (!element)
  {
    return found;
  }
  [element.textContent, element.title].concat(Object.keys(element.attributes || {}).map(function (name) { return element.attributes[name]; })).forEach(function (text)
  {
    if (typeof text === "string" && text) found.push(text);
  });
  (element.children || []).forEach(function (child) { collectStrings(child, found); });
  return found;
}

/* A page-like sandbox: wasInitialize runs against fake elements, so rendering and the language switch go through the real code paths. */
function pageRuntime(languages)
{
  var runtime = frontendRuntime("ko");
  var elements = {};
  var storage = {};
  var span = fakeElement("span");
  runtime.elements = elements;
  runtime.storage = storage;
  runtime.navigator = { languages: languages };
  runtime.location = { search: "" };
  runtime.localStorage = { getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; }, setItem: function (key, value) { storage[key] = String(value); } };
  runtime.sessionStorage = { getItem: function () { return null; }, setItem: function () {} };
  runtime.fetch = function () { return new Promise(function () {}); };
  runtime.setInterval = function () { return 0; };
  runtime.setTimeout = function () { return 1; };
  runtime.clearTimeout = function () {};
  runtime.requestAnimationFrame = function () { return 1; };
  runtime.cancelAnimationFrame = function () {};
  runtime.window = { matchMedia: function () { return { matches: false, addEventListener: function () {} }; }, addEventListener: function () {}, devicePixelRatio: 1 };
  runtime.wasCreateElement = function (tag, className, value)
  {
    var element = fakeElement(tag);
    element.className = className || "";
    if (typeof value !== "undefined") element.textContent = runtime.wasText(value);
    return element;
  };
  runtime.wasClearElement = function (element) { element.children = []; element.firstChild = null; };
  runtime.document = {
    hidden: false, body: fakeElement("body"), documentElement: fakeElement("html"),
    getElementById: function (id)
    {
      if (!elements[id])
      {
        elements[id] = fakeElement(id === "was-locale" || /^was-(project|provider|activity|status|kind)$/.test(id) ? "select" : "div");
        if (id === "was-detail") elements[id].appendChild(fakeElement("div"));
        if (id === "was-sidebar-toggle") elements[id].querySelector = function () { return span; };
        if (id === "was-relation-filters") elements[id].querySelectorAll = function () { return ["management", "spawn", "dependency", "collaboration", "handoff"].map(function (value) { return { value: value }; }); };
      }
      return elements[id];
    },
    createElement: fakeElement, createDocumentFragment: function () { return fakeElement("fragment"); }, createTextNode: function (text) { return { textContent: text, nodeType: 3 }; },
    querySelectorAll: function () { return []; }, addEventListener: function () {}
  };
  return runtime;
}

function startPage(languages)
{
  var runtime = pageRuntime(languages);
  runtime.wasInitialize();
  runtime.elements["was-activity"].value = "all";
  runtime.elements["was-graph-layout"].value = "operating";
  runtime.elements["was-edge-scope"].value = "all";
  return runtime;
}

function demoSnapshot(runtime)
{
  var token = runtime.WasI18n.token;
  var now = new Date().toISOString();
  var message = function (id, kind, extra) { return Object.assign({ deliveryId: id, kind: kind, outcome: "none" }, extra); };
  return {
    version: 1, generatedAt: now, stats: { loading: false },
    nodes: [
      node("main", { name: "alpha-main", description: token("test.note", { who: "Ada" }), lastSeen: now, role: "coordinator" }),
      node("worker", { name: "alpha-worker", kind: "agent", status: "completed", lastSeen: "2020-01-01T00:00:00Z" }),
      node("quiet", { name: "alpha-quiet", status: "idle", provider: "claude" })
    ],
    edges: [
      edge("s1", "main", "worker"), edge("s2", "quiet", "worker"), edge("s3", "worker", "main"), edge("s4", "main", "main"),
      edge("dep", "main", "ghost", { type: "dependency", confidence: "inferred", source: { kind: "bridge", path: "/record" } }),
      edge("mgmt", "main", "quiet", { type: "management", confidence: "unresolved" }),
      edge("req", "main", "quiet", { type: "collaboration", status: "queued", lastSeen: now, message: message("d1", "request") }),
      edge("rep", "quiet", "main", { type: "collaboration", status: "reply-recorded", lastSeen: now, message: message("d2", "reply", { parentDeliveryId: "d1", finishedAt: now, outcome: "reply-recorded" }) })
    ],
    diagnostics: [{ level: "warning", code: "demo", message: token("test.note", { who: "Bob" }), source: { kind: "demo", path: "/tmp/demo" } }],
    sourceStatus: [{ provider: "claude", files: 3, filesScanned: 1, bytesRead: 2048, skippedHistoryBytes: 4096, lastScanAt: now, status: "ok" }]
  };
}

function addTestMessages(runtime)
{
  runtime.WasI18n.addMessages({ en: { "test.note": "Waiting on {who}", "test.floor": "Team Alpha" }, ko: { "test.note": "{who} 대기 중", "test.floor": "알파 팀" } });
}

function renderedStrings(runtime)
{
  return Object.keys(runtime.elements).reduce(function (found, id) { return collectStrings(runtime.elements[id], found); }, []);
}

test("relative time uses plural forms in English and the original wording in Korean", function ()
{
  var english = frontendRuntime("en");
  assert.equal(english.wasRelativeTime(minutesAgo(0)), "Just now");
  assert.equal(english.wasRelativeTime(minutesAgo(1)), "1 minute ago");
  assert.equal(english.wasRelativeTime(minutesAgo(5)), "5 minutes ago");
  assert.equal(english.wasRelativeTime(minutesAgo(60)), "1 hour ago");
  assert.equal(english.wasRelativeTime(minutesAgo(180)), "3 hours ago");
  assert.equal(english.wasRelativeTime(minutesAgo(60 * 24)), "1 day ago");
  assert.equal(english.wasRelativeTime(minutesAgo(60 * 24 * 3)), "3 days ago");
  assert.equal(english.wasRelativeTime("not a date"), "Not recorded");
  var korean = frontendRuntime("ko");
  assert.equal(korean.wasRelativeTime(minutesAgo(1)), "1분 전");
  assert.equal(korean.wasRelativeTime(minutesAgo(180)), "3시간 전");
  assert.equal(korean.wasRelativeTime(minutesAgo(60 * 24 * 3)), "3일 전");
  assert.equal(korean.wasRelativeTime(""), "기록 없음");
});

test("numbers and dates follow the active language and degrade without a catalog", function ()
{
  var english = frontendRuntime("en");
  var korean = frontendRuntime("ko");
  assert.equal(english.wasFormatNumber(1234567), "1,234,567");
  assert.equal(korean.wasFormatNumber(1234567), "1,234,567");
  assert.equal(english.wasFormatNumber(undefined), "0");
  assert.match(english.wasDateTime("2026-10-23T14:05:09"), /14:05:09/);
  assert.match(korean.wasDateTime("2026-10-23T14:05:09"), /14\D+5\D+9/, "the time of day is shown in 24-hour form");
  assert.equal(english.wasDateTime("nope"), "Not recorded");
  var plain = { console: console };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/app.js"), "utf8") + "\nthis.t = wasT; this.n = wasFormatNumber; this.r = wasResolveText; this.k = wasStatusName;", plain);
  assert.equal(plain.t("app.travel.note"), "app.travel.note", "without a catalog the key comes back and nothing throws");
  assert.equal(plain.n(1234), "1,234");
  assert.equal(plain.r("plain"), "plain");
  assert.equal(plain.k("running"), "running");
});

test("activity reasons, relation issues and unresolved targets are produced in the active language", function ()
{
  var now = Date.parse("2026-10-23T12:00:00.000Z");
  var snapshot = { nodes: [node("a"), node("b")], edges: [edge("self", "a", "a"), edge("one", "a", "b"), edge("two", "b", "a"), edge("missing", "a", "ghost", { type: "dependency" })] };
  var english = frontendRuntime("en");
  assert.equal(english.wasGetActivity(node("recent", { lastSeen: "2026-10-23T11:30:00Z" }), now).reason, "An event was observed within the last 2 hours. This does not guarantee that it is running now.");
  assert.equal(english.wasGetActivity(node("old", { lastSeen: "2026-10-23T09:00:00Z" }), now).reason, "The last observed event is outside the 2-hour window.");
  assert.equal(english.wasGetActivity(node("none"), now).reason, "There is no last-event time, so recent activity cannot be confirmed.");
  assert.equal(english.wasGetActivity(node("done", { kind: "agent", status: "completed", lastSeen: "2026-10-23T11:59:00Z" }), now).reason, "A sub-agent observed as completed or interrupted.");
  assert.equal(english.wasGetActivity(node("old", { archived: true }), now).reason, "This is an archived session record.");
  var model = english.wasBuildModel(snapshot);
  assert.equal(model.nodeMap.get("ghost").name, "Unresolved target · ghost");
  assert.match(model.nodeMap.get("ghost").description, /^Referenced by a relation/);
  var issues = Array.from(model.edgeIssues.values());
  assert.ok(issues.some(function (text) { return /^A spawn relation that references itself/.test(text); }));
  assert.ok(issues.some(function (text) { return /^The spawn relations form a cycle/.test(text); }));
  [].concat(issues, [model.nodeMap.get("ghost").name, model.nodeMap.get("ghost").description]).forEach(function (text) { assert.doesNotMatch(text, HANGUL); });
  var korean = frontendRuntime("ko").wasBuildModel(snapshot);
  assert.equal(korean.nodeMap.get("ghost").name, "미확인 대상 · ghost");
  assert.ok(Array.from(korean.edgeIssues.values()).some(function (text) { return text.indexOf("생성 관계가 순환합니다.") === 0; }));
});

test("connection labels and direction text read naturally in English", function ()
{
  var english = frontendRuntime("en");
  var messages = [];
  for (var index = 0; index < 50; index += 1)
  {
    messages.push(edge("message-" + index, "master", "worker", { type: "collaboration", status: index < 7 ? "queued" : "completed", message: { deliveryId: "delivery-" + index, kind: "request" } }));
  }
  assert.match(english.wasConnectionLabel(frontend.wasBundleConnections(messages)[0]), /^Collaboration · 50 deliveries · 7 unresolved$/);
  var single = frontend.wasBundleConnections([edge("one", "a", "b", { type: "collaboration", message: { deliveryId: "one" } })])[0];
  assert.equal(english.wasConnectionLabel(single), "Collaboration · 1 delivery · 1 unresolved");
  var mixed = frontend.wasBundleConnections([edge("m", "z", "a", { type: "management", confidence: "inferred" }), edge("s", "z", "a", { type: "spawn", confidence: "unresolved", conflicts: ["x", "y"] })])[0];
  assert.equal(english.wasConnectionLabel(mixed), "Management·Spawn · 1 inferred · 1 unconfirmed · ⚠ 2 conflicts");
  var self = frontend.wasBundleConnections([edge("self", "a", "a", { type: "collaboration", message: { deliveryId: "self" } })])[0];
  assert.equal(english.wasConnectionDirectionLabel(self, { points: [] }), "1 self-delivery");
  assert.equal(frontendRuntime("ko").wasConnectionDirectionLabel(self, { points: [] }), "자기 전달 1");
});

test("the connection details panel is rendered in English with every raw record preserved", function ()
{
  var runtime = frontendRuntime("en");
  var raw = edge("actual", "one", "two");
  var pair = frontend.wasBundleConnections([raw, Object.assign({}, raw, { id: "other" })])[0];
  var conflict = { field: "parent", message: "two parents", values: ["one", "two"] };
  pair.conflicts = ["spawn cycle", conflict];
  runtime.wasState = { selectedPairId: pair.id, viewMode: "graph", detailLimit: 20, model: runtime.wasBuildModel({ nodes: [node("one"), node("two")], edges: pair.edges }), graphEdges: [pair] };
  runtime.wasElements = { detail: runtimeElement() };
  runtime.wasRenderConnectionDetails();
  assert.equal(runtime.wasElements.detail.children[1].textContent, "Connection between sessions · 2 original relations");
  var rendered = runtime.wasElements.detail.children.find(function (element) { return element.textContent.indexOf("Relation conflicts\n") === 0; });
  assert.equal(rendered.textContent, "Relation conflicts\nspawn cycle\n" + JSON.stringify(conflict));
  var texts = collectStrings(runtime.wasElements.detail);
  assert.ok(texts.indexOf("Original relations · 2 / 2") !== -1);
  assert.ok(texts.indexOf("Spawn · Confirmed") !== -1);
  assert.ok(texts.some(function (text) { return text.indexOf("Relation ID actual\nStatus Not recorded") === 0; }));
  assert.ok(texts.indexOf("one session details") !== -1);
  texts.forEach(function (text) { assert.doesNotMatch(text, HANGUL); });
});

test("the character cards, the stage note and the close button use the active language", function ()
{
  var english = partnerRuntimeIn("en");
  var edges = [edge("d1", "one", "two", { type: "collaboration", lastSeen: minutesAgo(5), message: { deliveryId: "d1", outcome: "none" } }), edge("d2", "one", "three", { type: "collaboration", lastSeen: minutesAgo(120), message: { deliveryId: "d2", finishedAt: minutesAgo(120) } }), edge("d3", "one", "four", { type: "collaboration", message: { deliveryId: "d3", outcome: "none" } })];
  english.wasState.officeData.edges = edges;
  var cards = english.wasOfficePartnerMap();
  assert.equal(cards.one[0].meta, "5 minutes ago · 1 unresolved");
  assert.equal(cards.one[1].meta, "2 hours ago");
  assert.equal(cards.one[2].meta, "Time unknown · 1 unresolved");
  english.wasElements = { officeTravel: runtimeElement() };
  english.wasState.officeTravel = null;
  english.wasRenderOfficeTravel();
  assert.equal(english.wasElements.officeTravel.textContent, "Record-based · not a real call");
  english.wasSetOfficeTravel("reduced");
  assert.equal(english.wasElements.officeTravel.textContent, "Record-based · not a real call · The call animation was skipped because of the reduced-motion setting.");
  var button = english.wasCreateDetailClose();
  assert.equal(button.title, "Close details");
});

function partnerRuntimeIn(locale)
{
  var runtime = frontendRuntime(locale);
  var nodes = [node("one", { name: "alpha-center" }), node("two", { name: "alpha-two" }), node("three", { name: "alpha-three" }), node("four", { name: "alpha-four" })];
  runtime.wasCreateElement = function (tag, className, value) { var element = runtimeElement(); element.attributes = {}; element.setAttribute = function (name, text) { element.attributes[name] = text; }; return element; };
  runtime.wasState = { model: runtime.wasBuildModel({ nodes: nodes, edges: [] }), viewMode: "office", officePartnersSignature: null, officeScene: { setPartners: function () {} }, officeData: { edges: [], actorById: new Map(nodes.map(function (entry) { return [entry.id, entry]; })) } };
  return runtime;
}

test("a stage graphics notice follows the language while a call description is dropped", function ()
{
  var runtime = frontendRuntime("en");
  var options = null;
  runtime.WasOfficeModel = {};
  runtime.WasOfficeScene = { create: function (value) { options = value; return { setMode: function () {} }; } };
  runtime.wasState = { officeScene: null };
  runtime.wasElements = { officeStage: runtimeElement(), officeTravel: runtimeElement() };
  runtime.wasEnsureOffice();
  var elements = runtime.wasElements;
  options.onTravel({ text: runtime.WasI18n.t("scene.fallback.webglUnavailable"), phase: "fallback", illustrative: false });
  assert.equal(runtime.wasElements.officeTravel.textContent, runtime.WasI18n.t("scene.fallback.webglUnavailable"));
  assert.doesNotMatch(runtime.wasElements.officeTravel.textContent, HANGUL);
  runtime.WasI18n.setLocale("ko");
  runtime.wasRenderOfficeTravel();
  assert.match(runtime.wasElements.officeTravel.textContent, HANGUL);
  assert.equal(runtime.wasElements.officeTravel.textContent, runtime.WasI18n.t("scene.fallback.webglUnavailable"));
  options.onTravel({ text: "a → b", phase: "outgoing", replay: false, illustrative: true });
  assert.equal(runtime.wasElements.officeTravel.textContent, "기록 기반 · 실제 통화 아님 · a → b");
  runtime.WasI18n.setLocale("en");
  runtime.wasState.replayStatus = null;
  runtime.wasElements = new Proxy(elements, { get: function (target, key)
  {
    if (!target[key]) target[key] = fakeElement();
    return target[key];
  } });
  elements.sidebarToggle = { querySelector: function () { return fakeElement(); } };
  runtime.wasState.flowPulses = [];
  runtime.wasState.reducedMotion = { matches: false };
  runtime.wasRefreshLocale();
  assert.equal(elements.officeTravel.textContent, "Record-based · not a real call", "a transient call description is not kept across a language change");
});

test("floor labels render the message tokens of the office model and rebuild when the language changes", function ()
{
  var runtime = frontendRuntime("en");
  addTestMessages(runtime);
  var actors = [node("one"), node("two")];
  var floor = { id: "first", name: runtime.WasI18n.token("test.floor"), nodeIds: ["one", "two"] };
  var office = { actors: actors, actorById: new Map(actors.map(function (actor) { return [actor.id, actor]; })), floors: [floor], floorById: new Map([[floor.id, floor]]), project: "alpha", stats: { matched: 2, context: 0, hidden: 0 } };
  runtime.WasOfficeModel = { buildOffice: function () { return office; } };
  runtime.wasReadFilters = filters;
  runtime.wasRenderViewScope = function () {};
  runtime.wasAutoReplayOffice = function () {};
  runtime.wasState = { model: runtime.wasBuildModel({ nodes: actors, edges: [] }), snapshot: {}, viewMode: "office", officeFloorId: "first", reducedMotion: { matches: false }, projectMessages: [],
    officeScene: { setOffice: function () {}, setPartners: function () {}, setMotion: function () {}, setVisible: function () {}, getState: function () { return { floorId: "first" }; } } };
  runtime.wasElements = {};
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeFloor", "officeDown", "officeUp", "officeSummary", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasElements.relationFilters.querySelectorAll = function () { return []; };
  runtime.wasUpdateOffice();
  assert.equal(runtime.wasElements.officeFloor.children[0].textContent, "1F · Team Alpha (2)");
  assert.equal(runtime.wasElements.officeSummary.textContent, "2 sessions · Filter matches 2 / Context 0 / Hidden 0 · Floors 1/1");
  runtime.WasI18n.setLocale("ko");
  runtime.wasUpdateOffice();
  assert.equal(runtime.wasElements.officeFloor.children[0].textContent, "1F · 알파 팀 (2)");
  assert.equal(runtime.wasElements.officeSummary.textContent, "2명 · 필터 일치 2 / 맥락 0 / 숨김 0 · 층 1/1");
});

test("a snapshot with message tokens is resolved in the current language and the raw copy is kept", function ()
{
  ["en", "ko"].forEach(function (locale)
  {
    var runtime = startPage(["en-US"]);
    addTestMessages(runtime);
    runtime.WasI18n.setLocale(locale);
    var snapshot = demoSnapshot(runtime);
    runtime.wasUpdateSnapshot(snapshot);
    var expected = locale === "en" ? ["Waiting on Ada", "Waiting on Bob"] : ["Ada 대기 중", "Bob 대기 중"];
    assert.equal(runtime.wasState.model.nodeMap.get("main").description, expected[0]);
    assert.equal(runtime.wasState.snapshot.diagnostics[0].message, expected[1]);
    assert.equal(runtime.wasState.rawSnapshot, snapshot, "the raw snapshot is stored untouched");
    assert.equal(snapshot.nodes[0].description.indexOf("⟦test.note"), 0);
    assert.ok(renderedStrings(runtime).some(function (text) { return text.indexOf(expected[1]) !== -1; }), "the diagnostics list shows the resolved text");
  });
});

test("switching the language re-renders the whole page from the stored snapshot and keeps the user's place", function ()
{
  var runtime = startPage(["en-US"]);
  addTestMessages(runtime);
  assert.equal(runtime.WasI18n.getLocale(), "en", "a non-Korean browser starts in English");
  assert.equal(runtime.elements["was-locale"].value, "en");
  assert.equal(runtime.document.documentElement.attributes.lang, "en");
  runtime.wasUpdateSnapshot(demoSnapshot(runtime));
  runtime.elements["was-project"].value = "alpha";
  runtime.elements["was-tree"].scrollTop = 123;
  runtime.wasSelectNode("main", false, false);
  runtime.wasState.expanded.add("main");
  runtime.wasUpdateView(false);
  var before = renderedStrings(runtime);
  assert.ok(before.length > 50, "the page produced text");
  before.forEach(function (text) { assert.doesNotMatch(text, HANGUL, "English output: " + text); });
  assert.equal(runtime.elements["was-project"].children[0].textContent, "All projects");
  assert.equal(runtime.elements["was-provider"].children[0].textContent, "All agents");
  assert.equal(runtime.elements["was-result-count"].textContent, "3 matches · 3 shown");
  assert.match(runtime.elements["was-activity-summary"].textContent, /^Activity scope: All · Hidden outside the scope: recent 0 \/ inactive · past 0 \/ time unknown 0 · Recent activity ≠ running now$/);
  assert.equal(runtime.elements["was-announcement"].textContent, "alpha-main selected");
  assert.equal(runtime.elements["was-stat-total-note"].textContent, "Recent activity 1 · All records 4");
  assert.ok(before.indexOf("Session info") !== -1 && before.indexOf("Working") !== -1);

  runtime.elements["was-locale"].value = "ko";
  runtime.elements["was-locale"].dispatch("change");
  assert.equal(runtime.WasI18n.getLocale(), "ko");
  assert.equal(runtime.storage.was_observatory_locale, "ko", "the choice is remembered");
  assert.equal(runtime.document.documentElement.attributes.lang, "ko");
  assert.equal(runtime.elements["was-project"].children[0].textContent, "전체 프로젝트");
  assert.equal(runtime.elements["was-provider"].children[0].textContent, "전체 에이전트");
  assert.equal(runtime.elements["was-project"].value, "alpha", "the filter selection survives");
  assert.equal(runtime.elements["was-tree"].scrollTop, 123, "the scroll position survives");
  assert.equal(runtime.wasState.selectedId, "main");
  assert.equal(runtime.wasState.expanded.has("main"), true);
  assert.equal(runtime.elements["was-result-count"].textContent, "일치 3개 · 표시 3개");
  assert.equal(runtime.elements["was-announcement"].textContent, "", "an announcement in the old language is cleared");
  assert.equal(runtime.elements["was-stat-total-note"].textContent, "최근 활동 1개 · 전체 기록 4개");
  assert.equal(runtime.wasState.model.nodeMap.get("main").description, "Ada 대기 중", "server tokens are rendered again from the raw snapshot");
  assert.equal(runtime.wasState.model.nodeMap.get("ghost").name, "미확인 대상 · ghost");
  var after = renderedStrings(runtime);
  assert.ok(after.indexOf("세션 정보") !== -1 && after.indexOf("작업 중") !== -1);
  assert.ok(after.some(function (text) { return text.indexOf("Ada 대기 중") !== -1; }));
  assert.equal(after.filter(function (text) { return /(?:^|[^a-z])(Session info|Working|Recent activity)(?:[^a-z]|$)/.test(text); }).length, 0, "no English wording is left");

  runtime.elements["was-locale"].value = "en";
  runtime.elements["was-locale"].dispatch("change");
  assert.equal(runtime.elements["was-result-count"].textContent, "3 matches · 3 shown");
  assert.equal(runtime.wasState.model.nodeMap.get("main").description, "Waiting on Ada");
  assert.equal(runtime.storage.was_observatory_locale, "en");
});

test("every renderer avoids Hangul in English and shows Korean wording in Korean", function ()
{
  var runtimes = ["en", "ko"].map(function (locale)
  {
    var runtime = startPage([locale === "ko" ? "ko-KR" : "en-US"]);
    addTestMessages(runtime);
    runtime.wasUpdateSnapshot(demoSnapshot(runtime));
    runtime.elements["was-project"].value = "";
    runtime.wasSelectNode("main", false, false);
    runtime.wasState.expanded.add("main");
    runtime.wasUpdateView(false);
    runtime.wasSelectConnection(runtime.wasState.graphEdges.find(function (pair) { return pair.deliveryCount > 0; }).id);
    runtime.wasState.snapshot.stats = { loading: true };
    runtime.wasState.loadError = runtime.WasI18n.token("app.error.snapshotFormat");
    runtime.wasRenderHealth();
    runtime.wasRenderDiagnostics();
    runtime.wasStartReplay();
    runtime.wasScheduleGraphAnimation();
    runtime.wasToggleNode("main");
    runtime.wasSelectNode("worker", false, false);
    runtime.wasCloseDetail();
    runtime.wasSelectNode("ghost", false, false);
    return runtime;
  });
  var english = renderedStrings(runtimes[0]);
  var korean = renderedStrings(runtimes[1]);
  english.forEach(function (text) { assert.doesNotMatch(text, HANGUL, "English output: " + text); });
  english.concat(korean).forEach(function (text) { assert.doesNotMatch(text, /\bapp\.[a-z]+\.[A-Za-z]+|⟦/, "an unresolved key or token leaked: " + text); });
  assert.ok(korean.some(function (text) { return HANGUL.test(text); }));
  assert.ok(english.some(function (text) { return text.indexOf("Could not load the snapshot. Invalid snapshot data format") !== -1; }));
  assert.ok(korean.some(function (text) { return text.indexOf("스냅샷을 불러오지 못했습니다. 스냅샷 데이터 형식 오류") !== -1; }));
  assert.ok(english.some(function (text) { return text === "UNKNOWN / Unresolved target"; }));
  assert.ok(korean.some(function (text) { return text === "UNKNOWN / 미확인 대상"; }));
  assert.ok(english.indexOf("Request") !== -1 && english.indexOf("Reply") !== -1, "the delivery feed names the message kinds");
  assert.ok(english.length > 100 && korean.length > 100);
});

test("the language select and the catalog cover everything app.js asks for", function ()
{
  var runtime = frontendRuntime("en");
  runtime.wasElements = {};
  runtime.wasBindLocale();
  runtime.wasElements = { locale: runtimeElement() };
  runtime.wasState = null;
  runtime.wasBindLocale();
  assert.equal(runtime.wasElements.locale.value, "en");
  runtime.wasRefreshLocale();
  var source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  var used = new Set();
  var pattern = /\bwasT\(\s*"([\w.-]+)"/g;
  var match;
  while ((match = pattern.exec(source)) !== null) used.add(match[1]);
  var english = catalog.catalogs.en;
  var korean = catalog.catalogs.ko;
  used.forEach(function (key)
  {
    assert.ok(Object.prototype.hasOwnProperty.call(english, key) && Object.prototype.hasOwnProperty.call(korean, key), "catalog key " + key);
  });
  var dynamic = { "app.status": ["running", "waiting", "idle", "completed", "interrupted", "unknown"], "app.type": ["management", "spawn", "dependency", "collaboration", "handoff"], "app.confidence": ["confirmed", "inferred", "unresolved"], "app.activity": ["recent", "inactive", "unconfirmed", "all"], "app.messageKind": ["request", "reply", "failureNotice", "progressNotice", "unknown", "record"] };
  Object.keys(dynamic).forEach(function (prefix)
  {
    dynamic[prefix].forEach(function (name) { assert.ok(Object.prototype.hasOwnProperty.call(english, prefix + "." + name) && Object.prototype.hasOwnProperty.call(korean, prefix + "." + name), prefix + "." + name); });
  });
  assert.equal(runtime.wasStatusName("made-up"), "made-up", "an unknown value is shown as it is");
  assert.equal(runtime.wasTypeName("future-type"), "future-type");
  assert.equal(runtime.wasActivityName("recent"), "Recent activity");
  assert.equal(runtime.wasConfidenceName("made-up"), "");
});

test("after a language change the stage rewrites its own text and receives freshly localized counterpart cards", function ()
{
  var runtime = partnerRuntimeIn("en");
  var calls = [];
  var cards = [];
  var edges = [edge("d1", "one", "two", { type: "collaboration", lastSeen: minutesAgo(5), message: { deliveryId: "d1", outcome: "none" } })];
  var elements = {};
  runtime.wasElements = new Proxy(elements, { get: function (target, key)
  {
    if (!target[key]) target[key] = fakeElement();
    return target[key];
  } });
  elements.sidebarToggle = { querySelector: function () { return fakeElement(); } };
  runtime.wasUpdateView = function () { calls.push("view"); };
  runtime.wasRenderHealth = function () { calls.push("health"); };
  runtime.wasRenderDiagnostics = function () { calls.push("diagnostics"); };
  Object.assign(runtime.wasState, { flowPulses: [], replayStatus: null, reducedMotion: { matches: false }, announcement: null });
  runtime.wasState.officeData.edges = edges;
  runtime.wasState.officeScene = { refreshText: function () { calls.push("refreshText"); }, setPartners: function (value) { calls.push("setPartners"); cards.push(value); } };
  runtime.wasRenderOfficePartners();
  assert.equal(cards[0].one[0].meta, "5 minutes ago · 1 unresolved");
  calls.length = 0;
  runtime.WasI18n.setLocale("ko");
  runtime.wasRefreshLocale();
  assert.deepEqual(calls, ["view", "health", "diagnostics", "refreshText", "setPartners"], "the stage text is refreshed, then the cards are handed over again");
  assert.equal(cards[1].one[0].meta, "5분 전 · 미해결 1");
  elements.replayFlow.textContent = "";
  runtime.wasState.replayStatus = { index: 1, total: 2, hidden: 0 };
  runtime.wasRefreshLocale();
  assert.equal(elements.replayFlow.textContent, "이력 재생 중지", "the replay button follows the replay state");
  assert.equal(elements.sceneStatus.textContent, "이력 재생 · 실시간 아님 · 1/2건");
  runtime.WasI18n.setLocale("en");
  runtime.wasRefreshLocale();
  assert.equal(elements.replayFlow.textContent, "Stop replay");
  assert.equal(elements.sceneStatus.textContent, "History replay · not live · 1/2");
});

test("the floor list shows the top floor first while the data and the up / down order stay from 1F upward", function ()
{
  var runtime = frontendRuntime("en");
  var actors = [node("one"), node("two"), node("three")];
  var floors = [
    { id: "f1", name: "Alpha", nodeIds: ["one"] },
    { id: "f2", name: "Beta", nodeIds: ["two"] },
    { id: "f3", name: "Gamma", nodeIds: ["three"] }
  ];
  var office = { actors: actors, actorById: new Map(actors.map(function (actor) { return [actor.id, actor]; })), floors: floors, floorById: new Map(floors.map(function (floor) { return [floor.id, floor]; })), project: "alpha", stats: { matched: 3, context: 0, hidden: 0 } };
  runtime.WasOfficeModel = { buildOffice: function () { return office; } };
  runtime.wasReadFilters = filters;
  runtime.wasRenderViewScope = function () {};
  runtime.wasAutoReplayOffice = function () {};
  runtime.wasState = { model: runtime.wasBuildModel({ nodes: actors, edges: [] }), snapshot: {}, viewMode: "office", officeFloorId: "f1", reducedMotion: { matches: false }, projectMessages: [],
    officeScene: { setOffice: function () {}, setPartners: function () {}, setMotion: function () {}, setVisible: function () {}, getState: function () { return { floorId: "f1" }; } } };
  runtime.wasElements = {};
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeFloor", "officeDown", "officeUp", "officeSummary", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasElements.relationFilters.querySelectorAll = function () { return []; };
  runtime.wasUpdateOffice();
  var options = runtime.wasElements.officeFloor.children;
  assert.deepEqual(options.map(function (option) { return option.textContent; }), ["3F · Gamma (1)", "2F · Beta (1)", "1F · Alpha (1)"]);
  assert.deepEqual(options.map(function (option) { return option.value; }), ["f3", "f2", "f1"]);
  assert.deepEqual(runtime.wasState.officeFloors.map(function (floor) { return floor.id; }), ["f1", "f2", "f3"], "the floor data keeps its order from 1F upward");
});
