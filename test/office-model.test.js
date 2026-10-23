"use strict";

var Test = require("node:test");
var Assert = require("node:assert/strict");
var Office = require("../public/office-model.js");
var I18nHelpers = require("./helpers/i18n");

function node(id, extra)
{
  return Object.assign({ id: id, name: id, project: "fixture", provider: "codex", kind: "session", status: "unknown", activity: { category: "recent" } }, extra);
}

function edge(from, to, type, extra)
{
  return Object.assign({ id: from + ":" + to, from: from, to: to, type: type }, extra);
}

function build(nodes, edges, options)
{
  return Office.buildOffice({ nodes: nodes, edges: edges }, Object.assign({ project: "fixture", activity: "all" }, options));
}

function ids(office)
{
  return office.actors.map(function (actor) { return actor.id; });
}

function topology()
{
  return {
    nodes: [node("master", { name: "ordinary title" }), node("coordinator"), node("director"), node("writer-a"), node("writer-b"), node("native-child", { kind: "agent" }), node("native-grandchild", { kind: "agent" })],
    edges: [edge("master", "coordinator", "management"), edge("master", "director", "management"), edge("director", "writer-a", "management"), edge("director", "writer-b", "management"), edge("writer-a", "native-child", "spawn"), edge("native-child", "native-grandchild", "spawn")]
  };
}

Test("management evidence groups managers on their own floors and native descendants inherit logical membership", function ()
{
  var source = topology();
  var office = build(source.nodes, source.edges);
  Assert.equal(office.floors.length, 2);
  Assert.equal(office.floors[0].managerId, "master");
  Assert.equal(office.floors[1].managerId, "director");
  Assert.equal(office.actorById.get("master").floorId, office.actorById.get("coordinator").floorId);
  Assert.notEqual(office.actorById.get("master").floorId, office.actorById.get("director").floorId);
  ["writer-a", "writer-b", "native-child", "native-grandchild"].forEach(function (id)
  {
    Assert.equal(office.actorById.get(id).floorId, office.actorById.get("director").floorId);
  });
  Assert.deepEqual(office.stats, { matched: 7, context: 0, hidden: 0, all: 7 });
});

Test("names alone create no hierarchy and independent sessions share a floor", function ()
{
  var office = build([node("a", { name: "master", role: "master" }), node("b", { name: "director" })], []);
  Assert.equal(office.floors.length, 1);
  Assert.equal(office.floors[0].managerId, null);
  Assert.match(office.floors[0].id, /:independent$/);
});

Test("native-only roots get stable floors and descendant placement chooses the nearest anchor", function ()
{
  var nodes = [node("root-a"), node("root-b"), node("middle"), node("shared"), node("leaf"), node("solo")];
  var edges = [edge("root-a", "middle", "spawn"), edge("middle", "shared", "spawn"), edge("root-b", "shared", "spawn"), edge("shared", "leaf", "spawn")];
  var office = build(nodes, edges);
  Assert.equal(office.floors.length, 3);
  Assert.equal(office.actorById.get("shared").floorId, office.actorById.get("root-b").floorId);
  Assert.equal(office.actorById.get("leaf").floorId, office.actorById.get("root-b").floorId);
  Assert.equal(office.actorById.get("middle").floorId, office.actorById.get("root-a").floorId);
  Assert.match(office.actorById.get("solo").floorId, /:independent$/);
});

Test("management cycles and shared members remain deterministic across source ordering", function ()
{
  var nodes = [node("a"), node("b"), node("shared"), node("child")];
  var edges = [edge("a", "b", "management"), edge("b", "a", "management"), edge("b", "shared", "management"), edge("a", "shared", "management"), edge("shared", "child", "spawn"), edge("child", "shared", "spawn")];
  var first = build(nodes, edges);
  var second = build(nodes.slice().reverse(), edges.slice().reverse());
  Assert.deepEqual(first.floors, second.floors);
  Assert.deepEqual(first.actors, second.actors);
  Assert.notEqual(first.actorById.get("a").floorId, first.actorById.get("b").floorId);
  Assert.equal(first.actorById.get("shared").floorId, first.actorById.get("a").floorId);
  Assert.equal(first.actorById.get("child").floorId, first.actorById.get("a").floorId);
});

Test("native cycles without a root retain every node under a deterministic source component", function ()
{
  var nodes = [node("a-leaf"), node("z-cycle"), node("y-cycle"), node("other-root"), node("other-child")];
  var edges = [edge("z-cycle", "y-cycle", "spawn"), edge("y-cycle", "z-cycle", "spawn"), edge("z-cycle", "a-leaf", "spawn"), edge("other-root", "other-child", "spawn")];
  var office = build(nodes, edges);
  Assert.equal(office.actors.length, 5);
  Assert.equal(office.floors.length, 2);
  Assert.equal(office.actorById.get("a-leaf").floorId, office.actorById.get("y-cycle").floorId);
  Assert.equal(office.actorById.get("z-cycle").floorId, office.actorById.get("y-cycle").floorId);
});

Test("twelve thousand deep native descendants are retained without recursion or caps", function ()
{
  var nodes = [];
  var edges = [];
  for (var index = 0; index < 12000; index += 1)
  {
    nodes.push(node("n" + index));
    if (index > 0)
    {
      edges.push(edge("n" + (index - 1), "n" + index, "spawn"));
    }
  }
  var office = build(nodes, edges);
  Assert.equal(office.actors.length, 12000);
  Assert.equal(office.floors.length, 1);
  Assert.equal(office.floors[0].nodeIds.length, 12000);
  Assert.equal(office.actorById.get("n11999").floorId, office.actorById.get("n0").floorId);
  var seats = new Set(office.actors.map(function (actor) { return actor.seatIndex; }));
  Assert.equal(seats.size, 12000);
});

Test("recent quiet team context excludes archived and completed native actors", function ()
{
  var nodes = [node("manager"), node("quiet", { activity: { category: "inactive" } }), node("archived", { archived: true }), node("native", { kind: "agent", status: "completed" })];
  var edges = [edge("manager", "quiet", "management"), edge("manager", "archived", "management"), edge("quiet", "native", "spawn")];
  var office = build(nodes, edges, { activity: "recent", showQuiet: true });
  Assert.deepEqual(ids(office), ["manager", "quiet"]);
  Assert.equal(office.actorById.get("quiet").context, true);
  Assert.equal(office.actorById.get("quiet").activity.category, "inactive");
  Assert.deepEqual(office.stats, { matched: 1, context: 1, hidden: 2, all: 4 });
  Assert.equal(office.floors[0].hiddenCount, 2);
  Assert.deepEqual(ids(build(nodes, edges, { activity: "recent", showQuiet: false })), ["manager"]);
});

Test("search retains necessary management and native ancestors without unrelated quiet teammates", function ()
{
  var source = topology();
  source.nodes.push(node("quiet", { activity: { category: "inactive" } }));
  source.edges.push(edge("master", "quiet", "management"));
  var office = build(source.nodes, source.edges, { query: "native-grandchild", activity: "recent" });
  Assert.deepEqual(ids(office), ["director", "master", "native-child", "native-grandchild", "writer-a"]);
  Assert.equal(office.actorById.get("native-grandchild").context, false);
  Assert.equal(office.actorById.get("master").context, true);
  Assert.deepEqual(office.stats, { matched: 1, context: 4, hidden: 3, all: 8 });
});

Test("provider, status, kind and activity filters preserve factual status and project boundaries", function ()
{
  var nodes = [node("queued", { provider: "claude", status: "queued", kind: "agent" }), node("old", { provider: "claude", status: "queued", kind: "agent", activity: { category: "inactive" } }), node("elsewhere", { project: "other" }), node("unknown", { activity: null, lastSeen: null })];
  var office = build(nodes, [], { provider: "claude", status: "queued", kind: "agent", activity: "recent" });
  Assert.deepEqual(ids(office), ["queued"]);
  Assert.equal(office.actors[0].status, "queued");
  Assert.equal(office.stats.all, 3);
  Assert.deepEqual(ids(build(nodes, [], { activity: "unconfirmed" })), ["unknown"]);
  Assert.deepEqual(ids(build(nodes, [], { activity: "inactive" })), ["old"]);
});

Test("floor toggling remaps display placement and retains stable home floor and avatars", function ()
{
  var source = topology();
  var grouped = build(source.nodes, source.edges);
  var merged = build(source.nodes, source.edges, { groupFloors: false });
  Assert.equal(merged.floors.length, 1);
  Assert.equal(merged.floorById.size, 1);
  Assert.equal(merged.floors[0].nodeIds.length, 7);
  grouped.actors.forEach(function (actor)
  {
    var other = merged.actorById.get(actor.id);
    Assert.equal(other.homeFloorId, actor.floorId);
    Assert.equal(other.floorId, merged.floors[0].id);
    Assert.equal(other.avatarIndex, actor.avatarIndex);
    Assert.ok(actor.avatarIndex >= 0 && actor.avatarIndex <= 7);
  });
  Assert.equal(new Set(merged.actors.map(function (actor) { return actor.seatIndex; })).size, 7);
  Assert.deepEqual(build(source.nodes.slice().reverse(), source.edges.slice().reverse()).actors.map(function (actor) { return actor.avatarIndex; }), grouped.actors.map(function (actor) { return actor.avatarIndex; }));
});

Test("empty snapshots and malformed or outside-project relationships do not fabricate actors", function ()
{
  Assert.deepEqual(Office.buildOffice({}, {}).stats, { matched: 0, context: 0, hidden: 0, all: 0 });
  var office = build([node("inside"), node("outside", { project: "other" }), null], [edge("inside", "outside", "management"), edge("inside", "missing", "spawn"), null]);
  Assert.deepEqual(ids(office), ["inside"]);
  Assert.equal(office.floors[0].managerId, null);
});

Test("floor navigation clamps at each endpoint", function ()
{
  var floors = [{ id: "a" }, { id: "b" }, { id: "c" }];
  Assert.equal(Office.nextFloor(floors, "b", 1), "c");
  Assert.equal(Office.nextFloor(floors, "c", 100), "c");
  Assert.equal(Office.nextFloor(floors, "a", -10), "a");
  Assert.equal(Office.nextFloor(floors, "unknown", 0), "a");
  Assert.equal(Office.nextFloor([], "a", 1), null);
});

Test("cross-floor phone calls keep sender and receiver on their original floors and seats", function ()
{
  var source = topology();
  var office = build(source.nodes, source.edges);
  var original = JSON.stringify(office.actors);
  var delivery = edge("master", "writer-a", "collaboration", { requestId: "thread", status: "queued", message: { deliveryId: "delivery-a" } });
  var call = Office.createCall(delivery, office, { startedAt: 1000, replay: true });
  Assert.equal(call.deliveryId, "delivery-a");
  Assert.equal(call.requestId, "thread");
  Assert.equal(call.from, "master");
  Assert.equal(call.to, "writer-a");
  Assert.equal(call.replay, true);
  Assert.equal(call.startedAt, 1000);
  Assert.equal(call.duration, 5000);
  Assert.notEqual(call.fromFloorId, call.toFloorId);
  Assert.equal(Office.callAt(call, 1000).phase, "outgoing");
  Assert.equal(Office.callAt(call, 2000).phase, "ringing");
  Assert.equal(Office.callAt(call, 3500).phase, "connected");
  Assert.equal(Office.callAt(call, 6000).phase, "done");
  for (var time = 1000; time <= 6500; time += 100)
  {
    var status = Office.callAt(call, time);
    Assert.equal(status.fromFloorId, office.actorById.get("master").floorId);
    Assert.equal(status.toFloorId, office.actorById.get("writer-a").floorId);
    Assert.equal(status.sameFloor, false);
    Assert.equal(Object.prototype.hasOwnProperty.call(status, "position"), false);
    Assert.equal(Object.prototype.hasOwnProperty.call(status, "visibleFloorId"), false);
    Assert.doesNotMatch(status.phase, /walk|travel|elevator|return|deliver/);
  }
  Assert.equal(JSON.stringify(office.actors), original);
});

Test("sender and receiver phone phases follow the same finite timing on every floor", function ()
{
  var office = build([node("a"), node("b")], []);
  var call = Office.createCall(edge("a", "b", "collaboration", { message: { deliveryId: "same" } }), office, { startedAt: 100 });
  Assert.equal(Office.callAt(call, 0).progress, 0);
  Assert.equal(Office.callAt(call, 1099).phase, "outgoing");
  Assert.equal(Office.callAt(call, 1100).phase, "ringing");
  Assert.equal(Office.callAt(call, 2599).phase, "ringing");
  Assert.equal(Office.callAt(call, 2600).phase, "connected");
  Assert.equal(Office.callAt(call, 5099).phase, "connected");
  Assert.equal(Office.callAt(call, 5100).phase, "done");
  Assert.deepEqual([Office.callAt(call, 100).senderPhase, Office.callAt(call, 100).receiverPhase], ["outgoing", "idle"]);
  Assert.deepEqual([Office.callAt(call, 1100).senderPhase, Office.callAt(call, 1100).receiverPhase], ["outgoing", "ringing"]);
  Assert.deepEqual([Office.callAt(call, 2600).senderPhase, Office.callAt(call, 2600).receiverPhase], ["connected", "connected"]);
  Assert.deepEqual([Office.callAt(call, 5100).senderPhase, Office.callAt(call, 5100).receiverPhase], ["done", "done"]);
  for (var time = -1000; time <= 10100; time += 100)
  {
    var status = Office.callAt(call, time);
    Assert.ok(Number.isFinite(status.progress) && Number.isFinite(status.overallProgress));
    Assert.ok(status.progress >= 0 && status.progress <= 1);
    Assert.ok(status.overallProgress >= 0 && status.overallProgress <= 1);
    Assert.equal(status.sameFloor, true);
  }
  Assert.equal(Office.callAt(call, Number.MAX_VALUE).progress, 1);
});

Test("delivery IDs distinguish replies from requests and absent endpoints or IDs prevent calls", function ()
{
  var office = build([node("a"), node("b")], []);
  var request = edge("a", "b", "collaboration", { requestId: "shared-thread", message: { deliveryId: "request" } });
  var reply = edge("b", "a", "collaboration", { requestId: "shared-thread", message: { deliveryId: "reply", parentDeliveryId: "request" } });
  Assert.notEqual(Office.createCall(request, office).deliveryId, Office.createCall(reply, office).deliveryId);
  Assert.equal(Office.createCall(edge("a", "missing", "collaboration", { message: { deliveryId: "missing" } }), office), null);
  Assert.equal(Office.createCall(edge("a", "b", "dependency", { requestId: "thread" }), office), null);
  Assert.equal(Office.createCall(null, office), null);
  Assert.equal(Office.createCall(request, null), null);
  Assert.equal(Office.callAt(null, 100), null);
});

Test("custom phone timing defaults invalid values and keeps progress finite", function ()
{
  var office = build([node("a"), node("b")], []);
  var delivery = edge("a", "b", "collaboration", { message: { deliveryId: "custom" } });
  var call = Office.createCall(delivery, office, { startedAt: 500, duration: 1000 });
  Assert.equal(Office.callAt(call, 700).phase, "ringing");
  Assert.equal(Office.callAt(call, 1000).phase, "connected");
  Assert.equal(Office.callAt(call, 1500).phase, "done");
  Assert.equal(Office.callAt(call, NaN).overallProgress, 0);
  [NaN, Infinity, 0, -1, "1000"].forEach(function (duration)
  {
    var invalid = Office.createCall(delivery, office, { startedAt: Infinity, duration: duration });
    Assert.equal(invalid.startedAt, 0);
    Assert.equal(invalid.duration, 5000);
  });
});

Test("legacy collaboration edge IDs preserve separate request and reply calls", function ()
{
  var office = build([node("a"), node("b")], []);
  var request = edge("a", "b", "collaboration", { id: "legacy-request", requestId: "shared-thread" });
  var reply = edge("b", "a", "collaboration", { id: "legacy-reply", requestId: "shared-thread" });
  Assert.equal(Office.createCall(request, office).deliveryId, "legacy-request");
  Assert.equal(Office.createCall(reply, office).deliveryId, "legacy-reply");
  Assert.notEqual(Office.createCall(request, office).deliveryId, Office.createCall(reply, office).deliveryId);
  Assert.equal(Office.createCall(edge("a", "b", "collaboration", { id: "legacy", message: { deliveryId: "actual-delivery" } }), office).deliveryId, "actual-delivery");
  Assert.equal(Office.createCall(edge("a", "b", "dependency", { requestId: "shared-thread" }), office), null);
  Assert.equal(Office.createCall(edge("a", "b", "handoff", { requestId: "shared-thread" }), office), null);
});

Test("phone phases contain metadata only and never claim recorded delivery completion", function ()
{
  var office = build([node("a"), node("b")], []);
  var delivery = edge("a", "b", "collaboration", { requestId: "thread", status: "queued", body: "PRIVATE_EDGE", message: { deliveryId: "private-test", body: "PRIVATE_BODY", transcript: "PRIVATE_TRANSCRIPT", outcome: "none" } });
  var original = JSON.stringify(delivery);
  var call = Office.createCall(delivery, office, { replay: true });
  var connected = Office.callAt(call, 2500);
  var done = Office.callAt(call, 5000);
  Assert.equal(call.observedStatus, "queued");
  Assert.equal(call.illustrative, true);
  Assert.equal(connected.illustrative, true);
  Assert.equal(done.illustrative, true);
  Assert.equal(done.replay, true);
  Assert.equal(delivery.status, "queued");
  Assert.equal(delivery.message.outcome, "none");
  Assert.doesNotMatch(JSON.stringify([call, connected, done]), /PRIVATE|confirmed|completed/);
  Assert.equal(JSON.stringify(delivery), original);
});

Test("resting uses inactivity or terminal status and never treats recent context as inactive", function ()
{
  var recentContext = { status: "unknown", context: true, activity: { category: "recent" } };
  Assert.equal(Office.isResting(recentContext), false);
  Assert.equal(Office.isResting({ status: "running", activity: { category: "inactive" } }), true);
  Assert.equal(Office.isResting({ status: "completed", activity: { category: "recent" } }), true);
  Assert.equal(Office.isResting({ status: "interrupted", activity: { category: "recent" } }), true);
  Assert.equal(Office.isResting({ status: "unknown", activity: { category: "unconfirmed" } }), false);
  Assert.equal(Office.isResting(null), false);
});

Test("recent observations remain separate from execution status while archived actors rest", function ()
{
  var office = build([node("unknown", { status: "unknown" }), node("idle", { status: "idle" }), node("old", { status: "running", activity: { category: "inactive" } }), node("archived", { archived: true })], []);
  Assert.equal(office.actorById.get("unknown").activity.category, "recent");
  Assert.equal(office.actorById.get("unknown").status, "unknown");
  Assert.equal(Office.isResting(office.actorById.get("unknown")), false);
  Assert.equal(Office.isResting(office.actorById.get("idle")), false);
  Assert.equal(Office.isResting(office.actorById.get("old")), true);
  Assert.equal(Office.isResting(office.actorById.get("archived")), true);
});

Test("output contains only display metadata and does not mutate source records", function ()
{
  var source = { nodes: [node("a", { role: { body: "PRIVATE_ROLE" }, description: "PRIVATE_DESCRIPTION", transcript: "PRIVATE_TRANSCRIPT", activity: { category: "recent", body: "PRIVATE_ACTIVITY" } })], edges: [] };
  var original = JSON.stringify(source);
  var office = Office.buildOffice(source, { project: "fixture", activity: "all" });
  Assert.doesNotMatch(JSON.stringify(office), /PRIVATE/);
  Assert.equal(JSON.stringify(source), original);
});

Test("built-in floor names are message tokens that each language renders, so the model stays deterministic", function ()
{
  var I18n = I18nHelpers.loadNodeI18n();
  var independent = build([node("a"), node("b")], []).floors[0];
  Assert.equal(independent.name, "\u27e6scene.floor.independent\u27e7");
  Assert.equal(I18n.resolve(independent.name, "en"), "Independent sessions");
  Assert.equal(I18n.resolve(independent.name, "ko"), "독립 세션");
  var all = Office.buildOffice({ nodes: [node("a"), node("b")], edges: [] }, { activity: "all", groupFloors: false });
  Assert.equal(all.floors.length, 1);
  Assert.equal(all.floors[0].name, "\u27e6scene.floor.all\u27e7");
  Assert.equal(I18n.resolve(all.floors[0].name, "en"), "Entire office");
  Assert.equal(I18n.resolve(all.floors[0].name, "ko"), "전체 사무실");
  var named = Office.buildOffice({ nodes: [node("a"), node("b")], edges: [] }, { project: "fixture", activity: "all", groupFloors: false });
  Assert.equal(named.floors[0].name, "fixture", "a project name stays as it is");
  var again = build([node("a"), node("b")], []).floors[0];
  Assert.equal(again.name, independent.name, "the same input always gives the same text");
});

Test("floor names taken from records cannot forge a message token", function ()
{
  var I18n = I18nHelpers.loadNodeI18n();
  var forged = "\u27e6scene.floor.independent\u27e7";
  var office = build([node("lead", { name: forged }), node("worker")], [edge("lead", "worker", "management")]);
  Assert.equal(office.floors[0].name, "[scene.floor.independent]");
  Assert.equal(I18n.resolve(office.floors[0].name, "en"), "[scene.floor.independent]");
  var project = Office.buildOffice({ nodes: [node("a", { project: forged })], edges: [] }, { project: forged, activity: "all", groupFloors: false });
  Assert.equal(I18n.resolve(project.floors[0].name, "en"), "[scene.floor.independent]");
});
