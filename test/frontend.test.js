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
  var classes = new Set();
  return {
    value: value || "", checked: true, textContent: "", scrollTop: 0, children: [],
    classList: { add: function (name) { classes.add(name); }, remove: function (name) { classes.delete(name); }, contains: function (name) { return classes.has(name); },
      toggle: function (name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); } },
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
    ["search", "status", "kind", "activity", "edgeScope", "graphLayout", "showQuiet", "officeGrouped", "officeOrder", "officeQuiet"].forEach(function (key)
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
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeOrder", "officeFloor", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
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

test("the seat order of the character stage reaches the office model, survives a reload and falls back to the default", function ()
{
  [["volume", "volume"], ["name", "name"], ["status", "status"], ["bogus", "group"], [undefined, "group"]].forEach(function (pair)
  {
    var runtime = frontendRuntime();
    runtime.sessionStorage = { getItem: function () { return JSON.stringify({ view: "office", officeOrder: pair[0], filters: { project: "alpha", activity: "all" } }); } };
    runtime.wasState = { savedFilters: {} };
    runtime.wasElements = {};
    ["search", "status", "kind", "activity", "edgeScope", "graphLayout", "showQuiet", "officeGrouped", "officeOrder", "officeQuiet"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
    runtime.wasRestorePreferences();
    assert.equal(runtime.wasElements.officeOrder.value, pair[1]);
  });
  var runtime = frontendRuntime();
  var seen = [];
  var actors = [node("one"), node("two")];
  var floor = { id: "first", name: "팀", nodeIds: ["one", "two"] };
  var office = { actors: actors, actorById: new Map(actors.map(function (actor) { return [actor.id, actor]; })), floors: [floor], floorById: new Map([[floor.id, floor]]), project: "alpha", stats: { matched: 2, context: 0, hidden: 0 } };
  runtime.WasOfficeModel = { buildOffice: function (snapshot, options) { seen.push(options.order); return office; } };
  runtime.wasReadFilters = filters;
  runtime.wasRenderOfficeFloor = function () {};
  runtime.wasRenderViewScope = function () {};
  runtime.wasState = {
    model: frontend.wasBuildModel({ nodes: actors, edges: [] }), snapshot: {}, viewMode: "office", officeFloorId: "first", reducedMotion: { matches: false },
    officeScene: { setOffice: function () {}, setPartners: function () {}, setMotion: function () {}, setVisible: function () {}, getState: function () { return { floorId: "first" }; } }
  };
  runtime.wasElements = {};
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeOrder", "officeFloor", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasElements.activity.value = "all";
  runtime.wasElements.relationFilters.querySelectorAll = function () { return []; };
  runtime.wasElements.officeOrder.value = "volume";
  runtime.wasUpdateOffice();
  runtime.wasElements.officeOrder.value = "name";
  runtime.wasUpdateOffice();
  assert.deepEqual(seen, ["volume", "name"]);
  var html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.deepEqual(Array.from(html.match(/<select id="was-office-order"[\s\S]*?<\/select>/)[0].matchAll(/<option value="(\w+)"/g)).map(function (match) { return match[1]; }), ["group", "name", "status", "volume"]);
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
    assert.equal(runtime.wasElements.officeTravel.textContent, "", "a stopped replay leaves the line empty");
    assert.equal(runtime.wasElements.officeTravel.classList.contains("was-travel-idle"), true, "an empty line is marked empty");
  });
});

test("character controls pan and zoom through the existing office scene API", function ()
{
  var runtime = frontendRuntime();
  var calls = [];
  runtime.window = { addEventListener: function () {} };
  runtime.wasState = { officeScene: { pan: function (value) { calls.push(["pan", value]); }, zoom: function (value) { calls.push(["zoom", value]); }, fit: function () { calls.push(["fit"]); } } };
  runtime.wasElements = {};
  ["viewOffice", "officeGrouped", "officeOrder", "officeQuiet", "officeFloor", "officeDown", "officeUp", "officeLeft", "officeRight", "officeZoomIn", "officeZoomOut"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
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
  assert.equal(runtime.wasElements.officeTravel.textContent, "a → b");
  assert.equal(runtime.wasElements.officeTravel.classList.contains("was-travel-idle"), false, "a call in progress shows its line");
  options.onTravel({ text: "a → b", phase: "done", replay: true, illustrative: true });
  assert.equal(runtime.wasElements.officeTravel.textContent, "", "a finished movement empties the line");
  assert.equal(runtime.wasElements.officeTravel.classList.contains("was-travel-idle"), true);
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

function teamRows(spec)
{
  // spec: { id: [children...] } in pre-order; the first key is the only root unless a key is listed in roots.
  var ids = Object.keys(spec);
  var parent = new Map();
  ids.forEach(function (id) { spec[id].forEach(function (child) { parent.set(child, id); }); });
  var depth = function (id) { return parent.has(id) ? depth(parent.get(id)) + 1 : 0; };
  return ids.map(function (id) { return { id: id, depth: depth(id), children: spec[id] }; });
}

test("the team layout puts a manager's members in a lane beside the manager's own lane chain", function ()
{
  var rows = teamRows({
    master: ["lead", "a", "b", "c", "d", "e"], lead: ["w1", "w2"], w1: [], w2: [], a: [], b: [], c: [], d: [], e: [],
    loner1: [], loner2: [], loner3: []
  });
  var layout = frontend.wasBuildTeamLayout(rows);
  assert.equal(layout.positions.size, rows.length, "every row gets a card");
  var at = function (id) { return layout.positions.get(id); };
  var overlaps = function (first, second) { return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height; };
  var cards = Array.from(layout.positions.values());
  cards.forEach(function (first, index)
  {
    cards.slice(index + 1).forEach(function (second) { assert.equal(overlaps(first, second), false, first.row.id + " overlaps " + second.row.id); });
  });
  var masterLane = layout.lanes.find(function (lane) { return lane.id === "master"; });
  var leadLane = layout.lanes.find(function (lane) { return lane.id === "lead"; });
  assert.equal(masterLane.count, 6);
  ["a", "b", "c", "d", "e"].forEach(function (id)
  {
    var card = at(id);
    assert.equal(card.leafOf, "master");
    assert.ok(card.x >= masterLane.x && card.x + card.width <= masterLane.x + masterLane.width && card.y >= masterLane.y && card.y + card.height <= masterLane.y + masterLane.height, id + " sits inside the lane of its manager");
    assert.ok(card.y > at("master").y + at("master").height, "members sit below a head that has lanes to its right");
  });
  assert.ok(leadLane.x >= masterLane.x + masterLane.width + 40, "the lane of a member that manages others lies to the right");
  assert.equal(at("master").trunkX > masterLane.x + masterLane.width && at("master").trunkX < leadLane.x, true, "the shared trunk runs in the corridor between the two lanes");
  assert.equal(at("lead").trunkX, undefined, "a head without lanes to its right has no trunk");
  assert.ok(at("w1").x >= leadLane.x && at("w1").y > leadLane.y, "plain members of the lead stay in its lane");
  var solo = layout.lanes.find(function (lane) { return lane.solo; });
  assert.equal(solo.count, 3, "sessions without a team share one panel");
  assert.ok(solo.y > masterLane.y + masterLane.height, "the panel of sessions without a team lies below the teams");
  ["loner1", "loner2", "loner3"].forEach(function (id) { assert.equal(at(id).leafOf, undefined); });
});

test("cards keep twice the former space between them, in the team layout and in the spawn hierarchy", function ()
{
  var layout = frontend.wasBuildTeamLayout(teamRows({ master: ["lead", "a", "b", "c", "d"], lead: ["w1", "w2"], w1: [], w2: [], a: [], b: [], c: [], d: [] }));
  var at = function (id) { return layout.positions.get(id); };
  assert.equal(at("b").x - (at("a").x + at("a").width), 48, "side by side in a lane: 48");
  assert.equal(at("c").y - (at("a").y + at("a").height), 48, "one row below the other: 48");
  var masterLane = layout.lanes.find(function (lane) { return lane.id === "master"; });
  var leadLane = layout.lanes.find(function (lane) { return lane.id === "lead"; });
  assert.equal(leadLane.x - (masterLane.x + masterLane.width), 128, "between a lane and the lane to its right: 128");
  assert.equal(at("a").x - masterLane.x, 28, "the lane panel keeps matching room around its cards");
  var stacked = frontend.wasBuildTeamLayout(teamRows({ boss1: ["x1", "y1"], x1: [], y1: [], boss2: ["x2", "y2"], x2: [], y2: [] }));
  var first = stacked.lanes.find(function (lane) { return lane.id === "boss1"; });
  var second = stacked.lanes.find(function (lane) { return lane.id === "boss2"; });
  assert.equal(second.y - (first.y + first.height), 128, "between two separate teams: 128");

  var runtime = startPage(["ko"]);
  addTestMessages(runtime);
  runtime.elements["was-graph-layout"].value = "native";
  runtime.wasUpdateSnapshot(demoSnapshot(runtime));
  runtime.wasState.expanded.add("main");
  runtime.wasUpdateView(false);
  runtime.wasSetView("graph");
  var cards = Array.from(runtime.wasState.graphPositions.values()).sort(function (first, second) { return first.y - second.y; });
  assert.ok(cards.length >= 3);
  assert.equal(cards[1].y - (cards[0].y + cards[0].height), 62, "rows of the spawn hierarchy: twice the former 31");
  var deeper = cards.find(function (card) { return card.row.depth === 1; });
  assert.equal(deeper.x - (cards[0].x + cards[0].width), 94, "one level deeper: twice the former 47");
  var hit = runtime.wasState.graphPositions.get(cards[2].row.id);
  var rect = { left: 0, top: 0, width: 900, height: 520 };
  runtime.elements["was-graph"].getBoundingClientRect = function () { return rect; };
  runtime.wasState.camera = { x: 0, y: 0, scale: 1 };
  assert.equal(runtime.wasHitGraph(hit.x + 10, hit.y + 10), cards[2].row.id, "a click lands on the card it points at");
  assert.equal(runtime.wasHitGraph(hit.x + 10, hit.y - 20), null, "the gap between two cards is empty");
});

test("a head without lanes to its right joins its member grid, and a lone session gets no panel", function ()
{
  var layout = frontend.wasBuildTeamLayout(teamRows({ boss: ["x", "y"], x: [], y: [], single: [] }));
  assert.equal(layout.lanes.length, 1, "one lane for the team and none for a single stray session");
  var head = layout.positions.get("boss");
  var second = layout.positions.get("x");
  assert.equal(head.y, second.y, "the head shares its first row with the first member");
  assert.ok(second.x > head.x);
  assert.equal(layout.positions.get("single").leafOf, undefined);
  assert.deepEqual([1, 2, 3, 4, 6, 7, 12, 14, 60, 400].map(frontend.wasGridColumns), [1, 2, 2, 2, 3, 3, 4, 4, 6, 6]);
  assert.equal(frontend.wasGridColumns(0), 0);
});

test("lines between a head and the members of its own lane stay hidden unless they carry more than the lane says", function ()
{
  var layout = frontend.wasBuildTeamLayout(teamRows({ boss: ["x", "y", "z"], x: [], y: [], z: [] }));
  var pairs = frontend.wasBundleConnections([
    edge("m1", "boss", "x", { type: "management" }), edge("s1", "boss", "x"), edge("m2", "boss", "y", { type: "management" }),
    edge("c1", "boss", "y", { type: "collaboration", message: { deliveryId: "d1" } }), edge("m3", "boss", "z", { type: "management", conflicts: ["two managers"] }),
    edge("peer", "x", "y", { type: "collaboration", message: { deliveryId: "d2" } })
  ]);
  var contained = function (id) { return frontend.wasIsContainedPair(pairs.find(function (pair) { return pair.id === id; }), layout.positions); };
  assert.equal(contained(JSON.stringify(["boss", "x"].sort())), true, "management and spawn alone are the lane's own business");
  assert.equal(contained(JSON.stringify(["boss", "y"].sort())), false, "a delivery between them is worth a line");
  assert.equal(contained(JSON.stringify(["boss", "z"].sort())), false, "a conflict is never hidden");
  assert.equal(contained(JSON.stringify(["x", "y"].sort())), false, "a line between two members is not the lane's business");
});

test("a team head routes to a lane on its right along the shared trunk", function ()
{
  var layout = frontend.wasBuildTeamLayout(teamRows({ master: ["lead", "other", "b", "c"], lead: ["w1", "w2"], other: ["w3"], w1: [], w2: [], w3: [], b: [], c: [] }));
  var master = layout.positions.get("master");
  ["lead", "other"].forEach(function (id)
  {
    var member = layout.positions.get(id);
    var forward = frontend.wasRouteConnection({ from: "master", to: id }, layout.positions);
    assert.equal(forward.points[0].x, master.x + master.width);
    assert.ok(forward.points.some(function (point) { return point.x === master.trunkX; }), id + " is reached through the trunk");
    assert.equal(forward.points[forward.points.length - 1].x, member.x);
    var backward = frontend.wasRouteConnection({ from: id, to: "master" }, layout.positions);
    assert.equal(backward.points[0].x, member.x, "a route always starts at pair.from");
    assert.equal(backward.points[backward.points.length - 1].x, master.x + master.width);
  });
  var plain = new Map([["a", { x: 0, y: 0, width: 100, height: 50 }], ["b", { x: 200, y: 100, width: 100, height: 50 }]]);
  assert.equal(frontend.wasRouteConnection({ from: "a", to: "b" }, plain).points.length, 4, "positions without a trunk route as before");
});

test("a beam follows the drawn route: rounded corners keep its length close to the polyline and a slice runs between two distances", function ()
{
  var route = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }] };
  var curve = frontend.wasRouteCurve(route);
  assert.equal(route.curve, curve, "the curve is kept on its route");
  assert.equal(frontend.wasRouteCurve(route), curve);
  assert.ok(curve.length < 300 && curve.length > 280, "cutting the corners shortens the path a little");
  assert.deepEqual([curve.points[0].x, curve.points[0].y], [0, 0]);
  var last = curve.points[curve.points.length - 1];
  assert.deepEqual([last.x, last.y], [200, 100]);
  var slice = frontend.wasCurveSlice(curve, 0, 50);
  assert.deepEqual([slice[0].x, slice[0].y, slice[slice.length - 1].x, slice[slice.length - 1].y].map(function (value) { return Math.round(value * 1e6) / 1e6; }), [0, 0, 50, 0]);
  var swapped = frontend.wasCurveSlice(curve, 50, 0);
  assert.deepEqual(swapped.map(function (point) { return [point.x, point.y]; }), slice.map(function (point) { return [point.x, point.y]; }), "either order gives the same points");
  var around = frontend.wasCurveSlice(curve, 80, 160);
  assert.ok(around.length > 3, "a slice across a corner keeps the points of the corner");
  var all = frontend.wasCurveSlice(curve, -10, 9999);
  assert.deepEqual([all[0].x, all[all.length - 1].x], [0, 200], "distances are clamped to the route");
  var straight = frontend.wasRouteCurve({ points: [{ x: 0, y: 0 }, { x: 0, y: 40 }] });
  assert.equal(straight.length, 40);
});

test("a connection has one beam that runs from its start to past its end, rests, and stands still for reduced motion", function ()
{
  assert.equal(frontend.wasLaserHead(500, 3, 10, true), 360);
  var length = 500;
  var heads = [];
  for (var tenth = 0; tenth < 200; tenth += 1) heads.push(frontend.wasLaserHead(length, tenth / 10, 0, false));
  var running = heads.filter(function (head) { return head !== null; });
  assert.ok(running.length > 0 && running.length < heads.length, "the beam runs and then rests");
  assert.ok(running.every(function (head) { return head >= 0 && head < length + 84; }), "a beam is gone once its tail has left the route");
  assert.ok(Math.abs(frontend.wasLaserHead(length, .1, 0, false) - frontend.wasLaserHead(length, 0, 0, false) - 30) < 1e-9, "the head moves 300 distance units per second");
  for (var n = 0; n < 50; n += 1)
  {
    var seed = frontend.wasRouteSeed("pair-" + n);
    assert.ok(seed >= 0 && seed < 220);
  }
  assert.equal(frontend.wasRouteSeed("same"), frontend.wasRouteSeed("same"));
  assert.notEqual(frontend.wasRouteSeed("a"), frontend.wasRouteSeed("b"));
});

test("each connection gets its own beam color, in the order it is first seen, and keeps it", function ()
{
  var runtime = startPage(["ko"]);
  var colors = [];
  for (var index = 0; index < 8; index += 1) colors.push(runtime.wasLaserColor("pair-" + index));
  assert.equal(new Set(colors).size, 8, "eight connections get eight different colors");
  assert.ok(colors.every(function (color) { return /^#[0-9a-f]{6}$/i.test(color); }));
  assert.equal(runtime.wasLaserColor("pair-3"), colors[3], "a connection keeps its color");
  assert.equal(runtime.wasLaserColor("pair-8"), colors[0], "the ninth connection starts the palette again");
  assert.equal(runtime.wasLaserColor("pair-9"), colors[1]);
});

test("a hidden graph is neither centered nor fitted on stale numbers: the next visit does it", function ()
{
  var runtime = startPage(["ko"]);
  addTestMessages(runtime);
  runtime.wasUpdateSnapshot(demoSnapshot(runtime));
  assert.equal(runtime.wasState.graphPositions, null);
  runtime.wasCenterNode("main");
  assert.equal(runtime.wasState.pendingCenterId, "main", "the request is remembered instead of throwing");
  runtime.wasState.graphInitialized = true;
  var camera = runtime.wasState.camera;
  runtime.wasFitGraph();
  assert.equal(runtime.wasState.camera, camera, "the camera of a hidden graph is left alone");
  assert.equal(runtime.wasState.graphInitialized, false, "the graph asks to be fitted when it is shown");

  runtime.wasState.canvasWidth = 900;
  runtime.wasState.canvasHeight = 520;
  runtime.wasState.selectedId = "main";
  runtime.wasSetView("graph");
  assert.equal(runtime.wasState.pendingCenterId, "");
  var point = runtime.wasState.graphPositions.get("main");
  var scale = runtime.wasState.camera.scale;
  assert.ok(Math.abs(runtime.wasState.camera.x - (450 - (point.x + point.width / 2) * scale)) < 1e-6, "a selection made while hidden is centered when the graph appears");

  runtime.wasSetView("tree");
  runtime.wasCenterNode("quiet");
  runtime.wasState.selectedId = "main";
  runtime.wasSetView("graph");
  assert.equal(runtime.wasState.pendingCenterId, "", "the request is dropped once handled");
  var quiet = runtime.wasState.graphPositions.get("quiet");
  var camera2 = runtime.wasState.camera;
  var offX = Math.abs(camera2.x - (450 - (quiet.x + quiet.width / 2) * camera2.scale));
  var offY = Math.abs(camera2.y - (260 - (quiet.y + quiet.height / 2) * camera2.scale));
  assert.ok(offX > 1 || offY > 1, "a request for a session that is no longer the selected one is not honored");
});

test("graph detail follows the zoom in three steps and the ramp stays between 0 and 1", function ()
{
  assert.equal(frontend.wasGraphDetail(.1), "block");
  assert.equal(frontend.wasGraphDetail(.299), "block");
  assert.equal(frontend.wasGraphDetail(.3), "name");
  assert.equal(frontend.wasGraphDetail(.549), "name");
  assert.equal(frontend.wasGraphDetail(.55), "full");
  assert.equal(frontend.wasGraphDetail(4), "full");
  assert.equal(frontend.wasRamp(.4, .5, .7), 0);
  assert.equal(frontend.wasRamp(.6, .5, .7), .5);
  assert.equal(frontend.wasRamp(.9, .5, .7), 1);
});

test("a connection line names the weakest evidence of its pair and flows while a delivery is unresolved, but is never dashed", function ()
{
  var style = function (edges) { return frontend.wasConnectionStyle(frontend.wasBundleConnections(edges)[0]); };
  var confirmed = style([edge("a", "a", "b")]);
  assert.equal(confirmed.evidence, "confirmed");
  assert.equal(confirmed.flowing, false);
  assert.equal(style([edge("a", "a", "b"), edge("b", "a", "b", { confidence: "inferred" })]).evidence, "inferred");
  assert.equal(style([edge("a", "a", "b", { confidence: "inferred" })]).evidence, "inferred");
  assert.equal("dash" in confirmed, false, "no line is ever patterned");
  var unconfirmed = style([edge("a", "a", "b", { confidence: "inferred" }), edge("b", "a", "b", { confidence: "unresolved" })]);
  assert.equal(unconfirmed.evidence, "unresolved");
  var mixed = style([edge("a", "a", "b", { type: "management" }), edge("b", "a", "b", { type: "spawn", confidence: "unresolved" })]);
  assert.equal(mixed.evidence, "unresolved", "several relation types still make one line with one pattern");
  var flowing = style([edge("a", "a", "b", { type: "collaboration", status: "queued", message: { deliveryId: "d1" } })]);
  assert.equal(flowing.flowing, true);
  assert.equal(flowing.forward, true);
  var backward = style([edge("a", "b", "a", { type: "collaboration", status: "queued", message: { deliveryId: "d1" } })]);
  assert.equal(backward.flowing, true);
  assert.equal(backward.forward, false, "the dots travel from b toward a, against the sorted pair order");
  var resolved = style([edge("a", "a", "b", { type: "collaboration", status: "reply-recorded", message: { deliveryId: "d1", finishedAt: "2026-01-01T00:00:00Z" } })]);
  assert.equal(resolved.flowing, false);
});

test("the focus of a selection is the selected session and its neighbours", function ()
{
  var pairs = frontend.wasBundleConnections([edge("a", "a", "b"), edge("b", "c", "a"), edge("c", "b", "d"), edge("d", "e", "f")]);
  assert.deepEqual(Array.from(frontend.wasGraphNeighbors(pairs, "a")).sort(), ["a", "b", "c"]);
  assert.deepEqual(Array.from(frontend.wasGraphNeighbors(pairs, "d")), ["d", "b"]);
  assert.deepEqual(Array.from(frontend.wasGraphNeighbors(pairs, "lonely")), ["lonely"]);
});

test("a label finds the nearest point of its route for the leader line", function ()
{
  var route = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] };
  var above = frontend.wasRouteAnchor(route, 50, 30);
  assert.deepEqual([above.x, above.y, above.distance], [50, 0, 30]);
  var beside = frontend.wasRouteAnchor(route, 130, 60);
  assert.deepEqual([beside.x, beside.y, beside.distance], [100, 60, 30]);
  var beyond = frontend.wasRouteAnchor(route, -20, -15);
  assert.deepEqual([beyond.x, beyond.y], [0, 0]);
  assert.equal(frontend.wasRouteAnchor(route, 100, 50).distance, 0);
});

test("the minimap appears only for a large graph that does not fit the view, and stays inside the canvas", function ()
{
  var bounds = { width: 4000, height: 1200 };
  var fitting = { x: 20, y: 20, scale: .2 };
  assert.equal(frontend.wasMinimapLayout(bounds, fitting, 1000, 600, 40), null, "everything is already in view");
  var zoomed = { x: -800, y: 0, scale: 1 };
  assert.equal(frontend.wasMinimapLayout(bounds, zoomed, 1000, 600, 7), null, "too few sessions to need an overview");
  assert.equal(frontend.wasMinimapLayout(bounds, zoomed, 400, 600, 40), null, "a narrow canvas has no room for it");
  var layout = frontend.wasMinimapLayout(bounds, zoomed, 1000, 600, 40);
  assert.ok(layout.x >= 0 && layout.y >= 0 && layout.x + layout.width <= 1000 && layout.y + layout.height <= 600);
  assert.ok(layout.width <= 221 && layout.height <= 131);
  assert.ok(Math.abs(layout.width / layout.height - bounds.width / bounds.height) < .2, "the overview keeps the graph's proportions");
});

function recordingContext()
{
  var calls = [];
  var values = {};
  var methods = /^(arc|arcTo|beginPath|clearRect|clip|closePath|fill|fillRect|lineTo|moveTo|quadraticCurveTo|restore|save|scale|setLineDash|setTransform|stroke|strokeRect|translate)$/;
  return new Proxy({}, {
    get: function (target, name)
    {
      if (name === "calls") return calls;
      if (name === "measureText") return function (text) { return { width: String(text).length * 6 }; };
      if (name === "createLinearGradient") return function () { return { addColorStop: function () {} }; };
      if (name === "fillText") return function (text) { calls.push(["fillText", String(text)]); };
      if (typeof name === "string" && methods.test(name)) return function () { calls.push([name]); };
      return values[name];
    },
    set: function (target, name, value) { values[name] = value; return true; }
  });
}

function drawnTexts(context)
{
  return context.calls.filter(function (call) { return call[0] === "fillText"; }).map(function (call) { return call[1]; });
}

test("only the visible view is built: a hidden graph or list stays out of date until it is shown", function ()
{
  var runtime = startPage(["ko"]);
  addTestMessages(runtime);
  assert.equal(runtime.wasState.viewMode, "tree");
  runtime.wasUpdateSnapshot(demoSnapshot(runtime));
  assert.equal(runtime.wasState.graphPositions, null, "no layout is made while the list is the view");
  assert.equal(runtime.wasState.graphStale, true);
  assert.ok(runtime.elements["was-tree-rows"].children.length > 0, "the list renders its rows");

  runtime.wasSetView("graph");
  var built = runtime.wasState.graphPositions;
  assert.ok(built && built.size === 3 && runtime.wasState.graphEdges.length > 0, "switching to the graph builds it");
  assert.equal(runtime.wasState.graphStale, false);

  var rows = runtime.elements["was-tree-rows"];
  rows.children = [];
  runtime.wasUpdateView(false);
  assert.equal(runtime.wasState.graphStale, false, "a visible graph is rebuilt at once");
  assert.notEqual(runtime.wasState.graphPositions, built);
  assert.equal(rows.children.length, 0, "the hidden list renders nothing");

  runtime.wasSetView("tree");
  assert.ok(rows.children.length > 0, "switching back renders the list");
  var kept = runtime.wasState.graphPositions;
  runtime.wasUpdateView(false);
  runtime.wasSelectNode("main", false, false);
  runtime.wasState.camera = { x: 0, y: 0, scale: 1 };
  assert.equal(runtime.wasState.graphPositions, kept, "no layout or routing runs for a hidden graph");
  assert.equal(runtime.wasState.graphStale, true);

  runtime.wasSetView("graph");
  assert.notEqual(runtime.wasState.graphPositions, kept, "the next visit rebuilds it from the current data");
  assert.equal(runtime.wasState.graphStale, false);
});

test("the graph draws at every zoom step with a selection, a hover and a selected connection without throwing", function ()
{
  var runtime = startPage(["ko"]);
  addTestMessages(runtime);
  runtime.wasUpdateSnapshot(demoSnapshot(runtime));
  runtime.wasSetView("graph");
  var context = recordingContext();
  runtime.elements["was-graph"].getContext = function () { return context; };
  runtime.wasState.canvasWidth = 900;
  runtime.wasState.canvasHeight = 520;
  runtime.wasState.pixelRatio = 2;
  runtime.wasState.viewMode = "graph";
  var draw = function (scale, setup)
  {
    context.calls.length = 0;
    runtime.wasState.camera = { x: 10, y: 10, scale: scale };
    runtime.wasState.selectedId = null;
    runtime.wasState.selectedPairId = null;
    runtime.wasState.hoverId = null;
    runtime.wasState.hoverPairId = "";
    if (setup) setup();
    runtime.wasDrawGraph();
    return drawnTexts(context);
  };
  var full = draw(1);
  assert.ok(full.indexOf("alpha-main") !== -1 && full.indexOf("alpha-quiet") !== -1, "names are drawn on the full cards");
  assert.ok(full.some(function (text) { return text.indexOf("미해결") !== -1; }), "the delivery queue row is drawn");
  var names = draw(.4);
  assert.ok(names.indexOf("alpha-quiet") !== -1, "names stay at a middle zoom");
  assert.equal(names.some(function (text) { return text.indexOf("미해결") !== -1; }), false, "the detail rows have faded");
  var far = draw(.15);
  assert.equal(far.indexOf("alpha-quiet"), -1, "a plain block carries no text");
  assert.equal(runtime.wasState.graphLabelHits.length, 0, "no label or dot can be hit while only blocks are drawn");
  draw(1, function () { runtime.wasSelectNode("main", false, false); });
  assert.ok(runtime.wasGraphFocus().ids.has("quiet") && runtime.wasGraphFocus().ids.has("ghost"));
  assert.equal(runtime.wasGraphFocus().soft, false);
  draw(1, function () { runtime.wasState.hoverId = "quiet"; });
  assert.equal(runtime.wasGraphFocus().soft, true, "a hover alone dims less");
  draw(.45, function () { runtime.wasState.hoverId = "quiet"; });
  var pair = runtime.wasState.graphEdges.find(function (entry) { return entry.deliveryCount > 0; });
  draw(1, function () { runtime.wasSelectConnection(pair.id); });
  var focus = runtime.wasGraphFocus();
  assert.deepEqual(Array.from(focus.ids).sort(), [pair.from, pair.to].sort());
  runtime.wasState.selectedPairId = null;
  runtime.wasState.selectedId = null;
  runtime.wasState.hoverId = "not-in-the-graph";
  assert.equal(runtime.wasGraphFocus(), null, "a node that is not drawn dims nothing");
  assert.ok(context.calls.length > 0);
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
  ["wasRenderTree", "wasRenderDetails", "wasUpdateGraphEdges", "wasRefreshGraphSelection", "wasRequestGraphDraw", "wasRenderOfficeFloor"].forEach(function (name)
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

function wideViewRuntime(viewMode)
{
  var runtime = frontendRuntime();
  var calls = [];
  var classes = new Set();
  runtime.document = { hidden: false, body: { classList: { add: function (name) { classes.add(name); }, remove: function (name) { classes.delete(name); }, contains: function (name) { return classes.has(name); } } } };
  runtime.wasState = { presentation: null, viewMode: viewMode, sidebarCollapsed: false, focusId: "focus", selectedId: null, selectedPairId: null, detailLimit: 20, detailRelationType: "", expanded: new Set(), camera: {}, officeFloorId: null, officeScene: null };
  runtime.wasElements = {};
  ["search", "provider", "status", "kind", "activity", "graphLayout", "showQuiet", "edgeScope", "officeGrouped", "officeOrder", "officeQuiet", "detail", "tree", "presentation", "presentationDetail", "presentationFlow", "announcement"].forEach(function (key)
  {
    runtime.wasElements[key] = runtimeElement();
  });
  runtime.wasElements.search.value = "alpha";
  runtime.wasElements.activity.value = "all";
  runtime.wasElements.graphLayout.value = "native";
  runtime.wasElements.presentation.focus = function () {};
  runtime.wasElements.presentationExit = Object.assign(runtimeElement(), { focus: function () {} });
  runtime.wasReadFilters = function () { return { query: runtime.wasElements.search.value }; };
  runtime.wasSetView = function (mode) { calls.push("view:" + mode); runtime.wasState.viewMode = mode; };
  ["wasStopReplay", "wasSetSidebar", "wasUpdateView", "wasFitGraph", "wasResizeOfficeAfterLayout"].forEach(function (name)
  {
    runtime[name] = function () { calls.push(name); };
  });
  return { runtime: runtime, calls: calls, classes: classes };
}

test("wide view enlarges the view that is open instead of switching to the relation graph", function ()
{
  var tree = wideViewRuntime("tree");
  tree.runtime.wasEnterPresentation();
  assert.deepEqual(tree.calls.filter(function (call) { return call.indexOf("view:") === 0; }), ["view:tree"]);
  assert.equal(tree.runtime.wasState.viewMode, "tree");
  assert.ok(tree.classes.has("was-presenting"));
  // The list the user was reading stays as it was; only the graph overview starts from a clean, recent scope.
  assert.equal(tree.runtime.wasElements.search.value, "alpha");
  assert.equal(tree.runtime.wasElements.activity.value, "all");
  assert.equal(tree.runtime.wasElements.graphLayout.value, "native");
  assert.equal(tree.runtime.wasState.focusId, "focus");
  assert.equal(tree.calls.includes("wasFitGraph"), false);
  assert.equal(tree.calls.includes("wasStopReplay"), false);

  var graph = wideViewRuntime("graph");
  graph.runtime.wasEnterPresentation();
  assert.deepEqual(graph.calls.filter(function (call) { return call.indexOf("view:") === 0; }), ["view:graph"]);
  assert.equal(graph.runtime.wasElements.search.value, "");
  assert.equal(graph.runtime.wasElements.activity.value, "recent");
  assert.equal(graph.runtime.wasElements.graphLayout.value, "operating");
  assert.equal(graph.runtime.wasState.focusId, null);
  assert.ok(graph.calls.includes("wasFitGraph"));

  tree.runtime.wasExitPresentation();
  assert.equal(tree.runtime.wasState.viewMode, "tree");
  assert.equal(tree.classes.has("was-presenting"), false);
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
  var detailSpan = fakeElement("span");
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
        if (id === "was-detail-toggle") elements[id].querySelector = function () { return detailSpan; };
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
  assert.equal(plain.t("app.travel.reducedMotion"), "app.travel.reducedMotion", "without a catalog the key comes back and nothing throws");
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
  assert.equal(english.wasElements.officeTravel.textContent, "");
  english.wasSetOfficeTravel("reduced");
  assert.equal(english.wasElements.officeTravel.textContent, "The call animation was skipped because of the reduced-motion setting.");
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
  assert.equal(runtime.wasElements.officeTravel.textContent, "a → b");
  runtime.WasI18n.setLocale("en");
  runtime.wasState.replayStatus = null;
  runtime.wasElements = new Proxy(elements, { get: function (target, key)
  {
    if (!target[key]) target[key] = fakeElement();
    return target[key];
  } });
  elements.sidebarToggle = { querySelector: function () { return fakeElement(); } };
  elements.detailToggle = { querySelector: function () { return fakeElement(); } };
  runtime.wasState.flowPulses = [];
  runtime.wasState.reducedMotion = { matches: false };
  runtime.wasRefreshLocale();
  assert.equal(elements.officeTravel.textContent, "", "a transient call description is not kept across a language change");
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
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeOrder", "officeFloor", "officeDown", "officeUp", "officeSummary", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
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
    runtime.wasSetView("graph");
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
  elements.detailToggle = { querySelector: function () { return fakeElement(); } };
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
  ["relationFilters", "activity", "officeQuiet", "officeGrouped", "officeOrder", "officeFloor", "officeDown", "officeUp", "officeSummary", "empty"].forEach(function (key) { runtime.wasElements[key] = runtimeElement(); });
  runtime.wasElements.relationFilters.querySelectorAll = function () { return []; };
  runtime.wasUpdateOffice();
  var options = runtime.wasElements.officeFloor.children;
  assert.deepEqual(options.map(function (option) { return option.textContent; }), ["3F · Gamma (1)", "2F · Beta (1)", "1F · Alpha (1)"]);
  assert.deepEqual(options.map(function (option) { return option.value; }), ["f3", "f2", "f1"]);
  assert.deepEqual(runtime.wasState.officeFloors.map(function (floor) { return floor.id; }), ["f1", "f2", "f3"], "the floor data keeps its order from 1F upward");
});

test("the detail panel toggle collapses and restores the panel, keeps its label and remembers the choice", function ()
{
  var runtime = startPage(["ko"]);
  var toggle = runtime.elements["was-detail-toggle"];
  var label = toggle.querySelector("span");
  var bodyClasses = {};
  runtime.document.body.classList.toggle = function (name, force) { bodyClasses[name] = force; };
  assert.equal(runtime.wasState.detailCollapsed, false, "the panel starts open");
  assert.equal(label.textContent, "상세 접기");
  assert.equal(toggle.attributes["aria-expanded"], "true");

  toggle.dispatch("click");
  assert.equal(runtime.wasState.detailCollapsed, true);
  assert.equal(bodyClasses["was-detail-collapsed"], true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(label.textContent, "상세 펼치기");
  assert.equal(runtime.storage.was_observatory_detail_collapsed, "1", "the choice is stored for the next visit");

  runtime.WasI18n.setLocale("en");
  runtime.wasRefreshLocale();
  assert.equal(label.textContent, "Expand details", "the label follows the language while the panel is collapsed");

  toggle.dispatch("click");
  assert.equal(runtime.wasState.detailCollapsed, false);
  assert.equal(bodyClasses["was-detail-collapsed"], false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(label.textContent, "Collapse details");
  assert.equal(runtime.storage.was_observatory_detail_collapsed, "0");
});

test("a stored detail panel choice is restored when the page starts and storage failures are tolerated", function ()
{
  var collapsed = pageRuntime(["ko"]);
  collapsed.storage.was_observatory_detail_collapsed = "1";
  collapsed.wasInitialize();
  assert.equal(collapsed.wasState.detailCollapsed, true);
  assert.equal(collapsed.elements["was-detail-toggle"].attributes["aria-expanded"], "false");

  var blocked = pageRuntime(["ko"]);
  blocked.localStorage = { getItem: function () { throw new Error("blocked"); }, setItem: function () { throw new Error("blocked"); } };
  blocked.wasInitialize();
  assert.equal(blocked.wasState.detailCollapsed, false, "without storage the panel stays open");
  blocked.elements["was-detail-toggle"].dispatch("click");
  assert.equal(blocked.wasState.detailCollapsed, true, "a failed save does not stop the toggle");
});

function sortText(runtime)
{
  return runtime.wasState.sort.key + ":" + runtime.wasState.sort.direction;
}

function sortedIds(model, sort, expanded, extra)
{
  return frontend.wasBuildView(model, filters(extra), expanded || new Set(), null, sort).rows.map(function (row) { return row.id; });
}

test("sorting by status orders siblings by the status rank and breaks ties by the newest observation", function ()
{
  var nodes = [
    node("idle-one", { status: "idle", lastSeen: minutesAgo(10) }),
    node("working-old", { status: "running", lastSeen: minutesAgo(40) }),
    node("waiting-one", { status: "waiting", lastSeen: minutesAgo(5) }),
    node("unknown-one", { status: "unknown", lastSeen: minutesAgo(1) }),
    node("completed-one", { status: "completed", lastSeen: minutesAgo(2) }),
    node("stopped-one", { status: "interrupted", lastSeen: minutesAgo(3) }),
    node("working-new", { status: "running", lastSeen: minutesAgo(20) })
  ];
  var model = frontend.wasBuildModel({ nodes: nodes, edges: [] });
  assert.deepEqual(sortedIds(model, { key: "status", direction: "asc" }), ["working-new", "working-old", "waiting-one", "stopped-one", "unknown-one", "idle-one", "completed-one"]);
  assert.deepEqual(sortedIds(model, { key: "status", direction: "desc" }), ["completed-one", "idle-one", "unknown-one", "stopped-one", "waiting-one", "working-new", "working-old"], "the status order reverses while ties still show the newest first");
});

test("sorting reorders the children under each parent and keeps the position numbers of the rows consistent", function ()
{
  var nodes = [
    node("parent", { status: "running", lastSeen: minutesAgo(1) }),
    node("child-idle", { status: "idle", lastSeen: minutesAgo(2) }),
    node("child-working", { status: "running", lastSeen: minutesAgo(30) }),
    node("child-waiting", { status: "waiting", lastSeen: minutesAgo(20) })
  ];
  var edges = ["child-idle", "child-working", "child-waiting"].map(function (id) { return edge("e-" + id, "parent", id); });
  var model = frontend.wasBuildModel({ nodes: nodes, edges: edges });
  var view = frontend.wasBuildView(model, filters(), new Set(["parent"]), null, { key: "status", direction: "asc" });
  assert.deepEqual(view.rows.map(function (row) { return row.id; }), ["parent", "child-working", "child-waiting", "child-idle"]);
  assert.deepEqual(view.rows.slice(1).map(function (row) { return row.position + "/" + row.size; }), ["1/3", "2/3", "3/3"]);
  assert.deepEqual(view.rows[0].children, ["child-working", "child-waiting", "child-idle"]);
});

test("sorting by name is natural and sorting by last observed can run oldest first", function ()
{
  var nodes = [
    node("dev10", { lastSeen: minutesAgo(5) }),
    node("dev2", { lastSeen: minutesAgo(50) }),
    node("Alpha", { lastSeen: minutesAgo(20) })
  ];
  var model = frontend.wasBuildModel({ nodes: nodes, edges: [] });
  assert.deepEqual(sortedIds(model, { key: "name", direction: "asc" }), ["Alpha", "dev2", "dev10"], "numbers inside names compare as numbers");
  assert.deepEqual(sortedIds(model, { key: "name", direction: "desc" }), ["dev10", "dev2", "Alpha"]);
  assert.deepEqual(sortedIds(model, { key: "recent", direction: "desc" }), ["dev10", "Alpha", "dev2"]);
  assert.deepEqual(sortedIds(model, { key: "recent", direction: "asc" }), ["dev2", "Alpha", "dev10"]);
});

test("the default sort and an unusable sort leave the model order untouched", function ()
{
  var nodes = [node("a", { lastSeen: minutesAgo(30) }), node("b", { lastSeen: minutesAgo(3) }), node("c", { lastSeen: minutesAgo(12) })];
  var model = frontend.wasBuildModel({ nodes: nodes, edges: [] });
  var plain = sortedIds(model, undefined);
  assert.deepEqual(plain, ["b", "c", "a"], "newest first is the model order");
  assert.deepEqual(sortedIds(model, { key: "recent", direction: "desc" }), plain);
  assert.deepEqual(sortedIds(model, { key: "nonsense", direction: "asc" }), plain);
  assert.deepEqual(sortedIds(model, { key: "status", direction: "sideways" }), plain);
  assert.deepEqual(frontend.wasParseSort("status:desc"), { key: "status", direction: "desc" });
  assert.equal(frontend.wasParseSort("status"), null);
  assert.equal(frontend.wasParseSort(undefined), null);
});

test("the sort select and the column headers share one choice that is announced, shown and remembered", function ()
{
  var runtime = pageRuntime(["ko"]);
  var buttons = ["name", "status", "recent"].map(function (key)
  {
    var button = fakeElement("button");
    button.attributes["data-was-sort"] = key;
    return button;
  });
  runtime.wasInitialize();
  var select = runtime.elements["was-tree-sort"];
  var columns = runtime.elements["was-tree-columns"];
  columns.querySelectorAll = function () { return buttons; };
  var clicked = null;
  columns.closest = function () { return clicked; };
  assert.equal(sortText(runtime), "recent:desc", "the list starts newest first");

  select.value = "status:asc";
  select.dispatch("change");
  assert.equal(sortText(runtime), "status:asc");
  assert.equal(buttons[1].attributes["data-was-sort-state"], "asc");
  assert.equal(buttons[0].attributes["data-was-sort-state"], "none");
  assert.equal(buttons[2].attributes["aria-pressed"], "false");
  assert.equal(runtime.elements["was-announcement"].textContent, "정렬 기준: 상태 · 작업 중 먼저");

  clicked = buttons[1];
  columns.dispatch("click");
  assert.equal(select.value, "status:desc", "a second click on the same column reverses it");
  clicked = buttons[0];
  columns.dispatch("click");
  assert.equal(select.value, "name:asc", "another column starts with its own first direction");
  clicked = buttons[2];
  columns.dispatch("click");
  assert.equal(select.value, "recent:desc");

  select.value = "garbage";
  select.dispatch("change");
  assert.equal(sortText(runtime), "recent:desc", "an unknown value is ignored");
});

test("a remembered sort is restored when the page starts and is part of the saved preferences", function ()
{
  var saved = pageRuntime(["ko"]);
  saved.sessionStorage = { getItem: function () { return JSON.stringify({ sort: "name:desc", view: "tree" }); }, setItem: function () {} };
  saved.wasInitialize();
  assert.equal(sortText(saved), "name:desc");
  assert.equal(saved.elements["was-tree-sort"].value, "name:desc");

  var garbled = pageRuntime(["ko"]);
  garbled.sessionStorage = { getItem: function () { return JSON.stringify({ sort: "name" }); }, setItem: function () {} };
  garbled.wasInitialize();
  assert.equal(sortText(garbled), "recent:desc", "a malformed value keeps the default");

  var writes = [];
  var live = pageRuntime(["ko"]);
  live.sessionStorage = { getItem: function () { return null; }, setItem: function (key, value) { writes.push(JSON.parse(value)); } };
  live.wasInitialize();
  live.wasState.sort = { key: "status", direction: "desc" };
  live.wasSavePreferences();
  assert.equal(writes[writes.length - 1].sort, "status:desc");
});

test("the status line under the stage keeps its height when it is empty, so a call starting or ending never resizes the stage", function ()
{
  var css = fs.readFileSync(require.resolve("../public/styles.css"), "utf8");
  var hidden = css.slice(css.indexOf(".was-office-travel.was-travel-idle"));
  hidden = hidden.slice(0, hidden.indexOf("}"));
  assert.match(hidden, /visibility: hidden;/);
  assert.doesNotMatch(hidden, /display: none/, "removing the line from the layout would resize the stage and redraw the canvas");
  assert.match(fs.readFileSync(require.resolve("../public/index.html"), "utf8"), /id="was-office-travel" class="was-office-travel was-travel-idle"/, "the line starts empty");
  var line = css.slice(css.indexOf(".was-office-travel\n{"));
  line = line.slice(0, line.indexOf("}"));
  assert.match(line, /min-height: calc\(1\.55em \+ 17px\);/, "an empty line is as tall as a line with text");
});
