/* Shared metadata-only office layout and phone animation model. */
"use strict";

function wasOfficeText(value)
{
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/* A message token in the form WasI18n.token builds, so the viewer renders the floor name in its own language (WasI18n.resolve). */
function wasOfficeMessage(key)
{
  return "\u27e6" + key + "\u27e7";
}

/* Names that come from observed records must not be able to forge a message token. */
function wasOfficeFloorName(value)
{
  return wasOfficeText(value).replace(/\u27e6/g, "[").replace(/\u27e7/g, "]");
}

function wasOfficeCompare(first, second)
{
  return first < second ? -1 : first > second ? 1 : 0;
}

function wasOfficeActivity(node, now)
{
  var supplied = node.activity || {};
  var category = supplied.category;
  var reason = wasOfficeText(supplied.reason);
  if (node.archived || node.kind === "agent" && (node.status === "completed" || node.status === "interrupted"))
  {
    category = "inactive";
  }
  else if (category !== "recent" && category !== "inactive" && category !== "unconfirmed")
  {
    var timestamp = Date.parse(node.lastSeen || "");
    category = !Number.isFinite(timestamp) ? "unconfirmed" : now - timestamp > 120 * 60 * 1000 ? "inactive" : "recent";
  }
  return { category: category, reason: reason, windowMinutes: Number.isFinite(supplied.windowMinutes) ? supplied.windowMinutes : 120 };
}

function wasOfficeAvatar(id)
{
  var hash = 2166136261;
  for (var index = 0; index < id.length; index += 1)
  {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 8;
}

function wasOfficeAddLink(adjacency, from, to)
{
  if (!adjacency.has(from))
  {
    adjacency.set(from, []);
  }
  adjacency.get(from).push(to);
}

/* Iterative strongly connected components keep native cycles finite at any depth. */
function wasOfficeNativeRoots(ids, children, parents)
{
  var included = new Set(ids);
  var visited = new Set();
  var finished = [];
  ids.forEach(function (id)
  {
    if (visited.has(id))
    {
      return;
    }
    visited.add(id);
    var stack = [{ id: id, index: 0 }];
    while (stack.length)
    {
      var frame = stack[stack.length - 1];
      var next = children.get(frame.id) || [];
      if (frame.index < next.length)
      {
        var child = next[frame.index];
        frame.index += 1;
        if (included.has(child) && !visited.has(child))
        {
          visited.add(child);
          stack.push({ id: child, index: 0 });
        }
      }
      else
      {
        finished.push(frame.id);
        stack.pop();
      }
    }
  });
  var componentById = new Map();
  var components = [];
  for (var finishIndex = finished.length - 1; finishIndex >= 0; finishIndex -= 1)
  {
    var finishId = finished[finishIndex];
    if (componentById.has(finishId))
    {
      continue;
    }
    var component = { id: finishId, incoming: false };
    var componentIndex = components.length;
    components.push(component);
    var pending = [finishId];
    componentById.set(finishId, componentIndex);
    while (pending.length)
    {
      var current = pending.pop();
      if (wasOfficeCompare(current, component.id) < 0)
      {
        component.id = current;
      }
      (parents.get(current) || []).forEach(function (parentId)
      {
        if (included.has(parentId) && !componentById.has(parentId))
        {
          componentById.set(parentId, componentIndex);
          pending.push(parentId);
        }
      });
    }
  }
  ids.forEach(function (id)
  {
    (children.get(id) || []).forEach(function (child)
    {
      if (included.has(child) && componentById.get(child) !== componentById.get(id))
      {
        components[componentById.get(child)].incoming = true;
      }
    });
  });
  return components.filter(function (component) { return !component.incoming; }).map(function (component) { return component.id; }).sort(wasOfficeCompare);
}

function wasOfficePropagate(seeds, children, assignment)
{
  var queue = seeds.slice().sort(function (first, second) { return wasOfficeCompare(first.anchor, second.anchor); });
  var reached = new Map();
  queue.forEach(function (seed) { reached.set(seed.id, seed); });
  for (var index = 0; index < queue.length; index += 1)
  {
    var entry = queue[index];
    (children.get(entry.id) || []).forEach(function (child)
    {
      if (assignment.has(child))
      {
        return;
      }
      var previous = reached.get(child);
      var distance = entry.distance + 1;
      if (!previous || distance < previous.distance || distance === previous.distance && wasOfficeCompare(entry.anchor, previous.anchor) < 0)
      {
        var next = { id: child, anchor: entry.anchor, floorId: entry.floorId, distance: distance };
        reached.set(child, next);
        queue.push(next);
      }
    });
  }
  reached.forEach(function (entry, id)
  {
    if (!assignment.has(id))
    {
      assignment.set(id, entry.floorId);
    }
  });
}

function wasOfficeManagerOrder(managers, management)
{
  var indegree = new Map();
  var children = new Map();
  managers.forEach(function (id) { indegree.set(id, 0); });
  management.forEach(function (edge)
  {
    if (managers.has(edge.to) && edge.from !== edge.to)
    {
      indegree.set(edge.to, indegree.get(edge.to) + 1);
      wasOfficeAddLink(children, edge.from, edge.to);
    }
  });
  var ready = Array.from(managers).filter(function (id) { return !indegree.get(id); }).sort(wasOfficeCompare);
  var ordered = [];
  for (var index = 0; index < ready.length; index += 1)
  {
    var id = ready[index];
    ordered.push(id);
    (children.get(id) || []).sort(wasOfficeCompare).forEach(function (child)
    {
      indegree.set(child, indegree.get(child) - 1);
      if (!indegree.get(child))
      {
        ready.push(child);
      }
    });
  }
  var added = new Set(ordered);
  return ordered.concat(Array.from(managers).filter(function (id) { return !added.has(id); }).sort(wasOfficeCompare));
}

function wasOfficeBuildOffice(snapshot, options)
{
  snapshot = snapshot || {};
  options = options || {};
  var project = wasOfficeText(options.project);
  var projectKey = project.toLocaleLowerCase();
  var prefix = "office:" + encodeURIComponent(projectKey || "all") + ":";
  var nodes = new Map();
  (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).forEach(function (node)
  {
    if (!node || node.id === null || typeof node.id === "undefined" || projectKey && wasOfficeText(node.project).toLocaleLowerCase() !== projectKey)
    {
      return;
    }
    var id = wasOfficeText(node.id);
    if (id && !nodes.has(id))
    {
      nodes.set(id, node);
    }
  });
  var ids = Array.from(nodes.keys()).sort(wasOfficeCompare);
  var edges = (Array.isArray(snapshot.edges) ? snapshot.edges : []).filter(function (edge)
  {
    return edge && nodes.has(wasOfficeText(edge.from)) && nodes.has(wasOfficeText(edge.to));
  }).map(function (edge)
  {
    return { from: wasOfficeText(edge.from), to: wasOfficeText(edge.to), type: edge.type };
  }).sort(function (first, second)
  {
    return wasOfficeCompare(first.from, second.from) || wasOfficeCompare(first.to, second.to) || wasOfficeCompare(first.type, second.type);
  });
  var management = edges.filter(function (edge) { return edge.type === "management"; });
  var managers = new Set();
  var managedParents = new Map();
  var nativeParents = new Map();
  var nativeChildren = new Map();
  management.forEach(function (edge)
  {
    managers.add(edge.from);
    wasOfficeAddLink(managedParents, edge.to, edge.from);
  });
  edges.forEach(function (edge)
  {
    if (edge.type === "spawn")
    {
      wasOfficeAddLink(nativeChildren, edge.from, edge.to);
      wasOfficeAddLink(nativeParents, edge.to, edge.from);
    }
  });
  var homeFloor = new Map();
  var floorById = new Map();
  var floors = [];
  function addFloor(id, name, managerId)
  {
    if (!floorById.has(id))
    {
      var floor = { id: id, name: name, managerId: managerId, nodeIds: [], hiddenCount: 0 };
      floors.push(floor);
      floorById.set(id, floor);
    }
    return id;
  }
  wasOfficeManagerOrder(managers, management).forEach(function (id)
  {
    homeFloor.set(id, addFloor(prefix + "manager:" + encodeURIComponent(id), wasOfficeFloorName(nodes.get(id).name) || wasOfficeFloorName(id), id));
  });
  ids.forEach(function (id)
  {
    if (!homeFloor.has(id) && managedParents.has(id))
    {
      homeFloor.set(id, homeFloor.get(managedParents.get(id)[0]));
    }
  });
  wasOfficePropagate(Array.from(homeFloor.keys()).map(function (id)
  {
    return { id: id, anchor: id, floorId: homeFloor.get(id), distance: 0 };
  }), nativeChildren, homeFloor);
  var remaining = ids.filter(function (id) { return !homeFloor.has(id); });
  var roots = wasOfficeNativeRoots(remaining, nativeChildren, nativeParents);
  var seeds = roots.map(function (id)
  {
    var hasNativeRelation = (nativeChildren.get(id) || []).length || (nativeParents.get(id) || []).length;
    var floorId = hasNativeRelation ? addFloor(prefix + "native:" + encodeURIComponent(id), wasOfficeFloorName(nodes.get(id).name) || wasOfficeFloorName(id), null) : addFloor(prefix + "independent", wasOfficeMessage("scene.floor.independent"), null);
    homeFloor.set(id, floorId);
    return { id: id, anchor: id, floorId: floorId, distance: 0 };
  });
  wasOfficePropagate(seeds, nativeChildren, homeFloor);
  var activityMode = options.activity || "recent";
  var now = Number.isFinite(options.now) ? options.now : Date.now();
  var activities = new Map();
  var matched = new Set();
  var included = new Set();
  var query = wasOfficeText(options.query).trim().toLocaleLowerCase();
  var queryParts = query.split(/\s+/).filter(Boolean);
  var hasSpecificFilter = !!(query || options.provider || options.status || options.kind);
  ids.forEach(function (id)
  {
    var node = nodes.get(id);
    var activity = wasOfficeActivity(node, now);
    activities.set(id, activity);
    var text = [id, node.name, node.sessionId, node.description, node.cwd, node.project, node.provider, node.account, node.model, node.role].map(wasOfficeText).join(" ").toLocaleLowerCase();
    if (options.provider && node.provider !== options.provider || options.status && node.status !== options.status || options.kind && node.kind !== options.kind || !queryParts.every(function (part) { return text.indexOf(part) !== -1; }))
    {
      return;
    }
    if (activityMode === "all" || activityMode === activity.category)
    {
      matched.add(id);
      included.add(id);
    }
  });
  if (activityMode === "recent" && options.showQuiet !== false && !hasSpecificFilter)
  {
    management.forEach(function (edge)
    {
      [edge.from, edge.to].forEach(function (id)
      {
        if (!nodes.get(id).archived)
        {
          included.add(id);
        }
      });
    });
  }
  var contextQueue = Array.from(included);
  for (var contextIndex = 0; contextIndex < contextQueue.length; contextIndex += 1)
  {
    var contextId = contextQueue[contextIndex];
    (managedParents.get(contextId) || []).concat(nativeParents.get(contextId) || []).forEach(function (parentId)
    {
      if (!included.has(parentId) && !(activityMode === "recent" && nodes.get(parentId).archived))
      {
        included.add(parentId);
        contextQueue.push(parentId);
      }
    });
  }
  /* A tree of spawned sessions earns a floor of its own only while at least two of its sessions are on show; a lone one
     belongs with the other independent sessions. Floors then run teams first, trees next and the independent floor last,
     whatever the order of the session ids was. */
  var treePrefix = prefix + "native:";
  var independentId = prefix + "independent";
  var visibleInFloor = new Map();
  ids.forEach(function (id)
  {
    if (included.has(id))
    {
      visibleInFloor.set(homeFloor.get(id), (visibleInFloor.get(homeFloor.get(id)) || 0) + 1);
    }
  });
  var loneTrees = new Set(floors.filter(function (floor) { return floor.id.indexOf(treePrefix) === 0 && (visibleInFloor.get(floor.id) || 0) < 2; }).map(function (floor) { return floor.id; }));
  if (loneTrees.size)
  {
    addFloor(independentId, wasOfficeMessage("scene.floor.independent"), null);
    ids.forEach(function (id)
    {
      if (loneTrees.has(homeFloor.get(id)))
      {
        homeFloor.set(id, independentId);
      }
    });
    floors = floors.filter(function (floor) { return !loneTrees.has(floor.id); });
    loneTrees.forEach(function (floorId) { floorById.delete(floorId); });
  }
  function floorRank(floor)
  {
    return floor.id === independentId ? 2 : floor.id.indexOf(treePrefix) === 0 ? 1 : 0;
  }
  floors = floors.map(function (floor, index) { return { floor: floor, index: index }; }).sort(function (first, second)
  {
    return floorRank(first.floor) - floorRank(second.floor) || first.index - second.index;
  }).map(function (entry) { return entry.floor; });
  var actors = [];
  var actorById = new Map();
  ids.forEach(function (id)
  {
    var floor = floorById.get(homeFloor.get(id));
    if (!included.has(id))
    {
      floor.hiddenCount += 1;
      return;
    }
    var node = nodes.get(id);
    var actor =
    {
      id: id,
      name: wasOfficeText(node.name || node.sessionId) || id,
      provider: wasOfficeText(node.provider) || "unknown",
      status: wasOfficeText(node.status) || "unknown",
      role: wasOfficeText(node.role),
      floorId: floor.id,
      homeFloorId: floor.id,
      avatarIndex: wasOfficeAvatar(id),
      seatIndex: floor.nodeIds.length,
      activity: activities.get(id),
      context: !matched.has(id)
    };
    floor.nodeIds.push(id);
    actors.push(actor);
    actorById.set(id, actor);
  });
  /* Seats group what belongs together: a team's manager first, a tree's root before its descendants level by level, then
     sessions of one project side by side, then by name. */
  var depth = new Map();
  var queue = [];
  actors.forEach(function (actor)
  {
    var home = homeFloor.get(actor.id);
    var inFloor = (nativeParents.get(actor.id) || []).filter(function (parentId) { return included.has(parentId) && homeFloor.get(parentId) === home; });
    if (home.indexOf(treePrefix) === 0 && !inFloor.length)
    {
      depth.set(actor.id, 0);
      queue.push(actor.id);
    }
  });
  for (var head = 0; head < queue.length; head += 1)
  {
    var parentId = queue[head];
    (nativeChildren.get(parentId) || []).forEach(function (childId)
    {
      if (included.has(childId) && homeFloor.get(childId) === homeFloor.get(parentId) && !depth.has(childId))
      {
        depth.set(childId, depth.get(parentId) + 1);
        queue.push(childId);
      }
    });
  }
  floors.forEach(function (floor)
  {
    var keys = new Map();
    floor.nodeIds.forEach(function (id)
    {
      keys.set(id, [floor.managerId === id ? 0 : 1, depth.get(id) || 0, wasOfficeText(nodes.get(id).project).toLocaleLowerCase(), actorById.get(id).name.toLocaleLowerCase()]);
    });
    floor.nodeIds.sort(function (first, second)
    {
      var one = keys.get(first);
      var two = keys.get(second);
      return one[0] - two[0] || one[1] - two[1] || wasOfficeCompare(one[2], two[2]) || wasOfficeCompare(one[3], two[3]) || wasOfficeCompare(first, second);
    });
    floor.nodeIds.forEach(function (id, index) { actorById.get(id).seatIndex = index; });
  });
  if (options.groupFloors === false && ids.length)
  {
    var merged = { id: prefix + "all", name: wasOfficeFloorName(project) || wasOfficeMessage("scene.floor.all"), managerId: null, nodeIds: [], hiddenCount: ids.length - actors.length };
    var arranged = [];
    floors.forEach(function (floor) { floor.nodeIds.forEach(function (id) { arranged.push(actorById.get(id)); }); });
    arranged.forEach(function (actor, index)
    {
      actor.floorId = merged.id;
      actor.seatIndex = index;
      merged.nodeIds.push(actor.id);
    });
    floors = [merged];
    floorById = new Map([[merged.id, merged]]);
  }
  return { floors: floors, actors: actors, actorById: actorById, floorById: floorById, stats: { matched: matched.size, context: included.size - matched.size, hidden: ids.length - included.size, all: ids.length }, project: project };
}

function wasOfficeNextFloor(floors, currentId, delta)
{
  if (!floors || !floors.length)
  {
    return null;
  }
  var index = floors.findIndex(function (floor) { return floor.id === currentId; });
  if (index < 0)
  {
    index = 0;
  }
  var step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return floors[Math.max(0, Math.min(floors.length - 1, index + step))].id;
}

function wasOfficeIsResting(actor)
{
  return !!(actor && (actor.status === "completed" || actor.status === "interrupted" || actor.activity && actor.activity.category === "inactive"));
}

function wasOfficeCreateCall(edge, office, options)
{
  options = options || {};
  var deliveryId = wasOfficeText(edge && edge.message && edge.message.deliveryId) || (edge && edge.type === "collaboration" ? wasOfficeText(edge.id) : "");
  if (!deliveryId || !office || !office.actorById)
  {
    return null;
  }
  var from = office.actorById.get(wasOfficeText(edge.from));
  var to = office.actorById.get(wasOfficeText(edge.to));
  if (!from || !to)
  {
    return null;
  }
  var call =
  {
    deliveryId: deliveryId,
    requestId: wasOfficeText(edge.requestId),
    from: from.id,
    to: to.id,
    fromFloorId: from.floorId,
    toFloorId: to.floorId,
    startedAt: Number.isFinite(options.startedAt) ? options.startedAt : 0,
    duration: Number.isFinite(options.duration) && options.duration > 0 ? Math.max(1, options.duration) : 5000,
    replay: !!options.replay,
    observedStatus: wasOfficeText(edge.status),
    illustrative: true
  };
  return call;
}

/* Phone phases illustrate a recorded delivery; they do not prove acceptance or completion. */
function wasOfficeCallAt(call, now)
{
  if (!call || !call.deliveryId)
  {
    return null;
  }
  var startedAt = Number.isFinite(call.startedAt) ? call.startedAt : 0;
  var duration = Number.isFinite(call.duration) && call.duration > 0 ? call.duration : 5000;
  var elapsed = Math.max(0, (Number.isFinite(now) ? now : startedAt) - startedAt);
  var overallProgress = Math.min(1, elapsed / duration);
  var phase = overallProgress < 0.2 ? "outgoing" : overallProgress < 0.5 ? "ringing" : overallProgress < 1 ? "connected" : "done";
  var progress = phase === "outgoing" ? overallProgress / 0.2 : phase === "ringing" ? (overallProgress - 0.2) / 0.3 : phase === "connected" ? (overallProgress - 0.5) / 0.5 : 1;
  var result =
  {
    phase: phase,
    progress: Math.max(0, Math.min(1, progress)),
    overallProgress: overallProgress,
    from: call.from,
    to: call.to,
    fromFloorId: call.fromFloorId,
    toFloorId: call.toFloorId,
    sameFloor: call.fromFloorId === call.toFloorId,
    senderPhase: phase === "ringing" ? "outgoing" : phase,
    receiverPhase: phase === "outgoing" ? "idle" : phase,
    replay: !!call.replay,
    illustrative: true
  };
  return result;
}

function wasOfficeCreateJourney(edge, office, now, options)
{
  var deliveryId = wasOfficeText(edge && edge.message && edge.message.deliveryId);
  if (!deliveryId || !office || !office.actorById)
  {
    return null;
  }
  var from = office.actorById.get(wasOfficeText(edge.from));
  var to = office.actorById.get(wasOfficeText(edge.to));
  if (!from || !to)
  {
    return null;
  }
  var fromIndex = office.floors.findIndex(function (floor) { return floor.id === from.floorId; });
  var toIndex = office.floors.findIndex(function (floor) { return floor.id === to.floorId; });
  return { deliveryId: deliveryId, from: from.id, to: to.id, fromFloorId: from.floorId, toFloorId: to.floorId, startTime: Number.isFinite(now) ? now : 0, replay: !!(options && options.replay), direction: toIndex >= fromIndex ? "elevator-up" : "elevator-down", duration: 8000 };
}

function wasOfficeJourneyAt(journey, now)
{
  var elapsed = Math.max(0, (Number.isFinite(now) ? now : journey.startTime) - journey.startTime);
  var sameFloor = journey.fromFloorId === journey.toFloorId;
  var result = { phase: "done", progress: 1, fromFloorId: journey.fromFloorId, toFloorId: journey.toFloorId, visibleFloorId: journey.fromFloorId, overallProgress: Math.min(1, elapsed / 8000), sameFloor: sameFloor };
  if (elapsed >= 8000)
  {
    return result;
  }
  if (sameFloor)
  {
    result.phase = elapsed < 1600 ? "walk-to-elevator" : elapsed < 3200 ? "deliver" : "return";
    result.progress = elapsed < 1600 ? elapsed / 1600 : elapsed < 3200 ? (elapsed - 1600) / 1600 : (elapsed - 3200) / 4800;
    if (result.phase === "return")
    {
      result.returnStage = "walk-to-seat";
      result.returnProgress = result.progress;
    }
    return result;
  }
  if (elapsed < 1200)
  {
    result.phase = "walk-to-elevator";
    result.progress = elapsed / 1200;
  }
  else if (elapsed < 2600)
  {
    result.phase = journey.direction;
    result.progress = (elapsed - 1200) / 1400;
    result.visibleFloorId = result.progress < 0.5 ? journey.fromFloorId : journey.toFloorId;
  }
  else if (elapsed < 4000)
  {
    result.phase = "deliver";
    result.progress = (elapsed - 2600) / 1400;
    result.visibleFloorId = journey.toFloorId;
  }
  else
  {
    var returning = elapsed - 4000;
    result.phase = "return";
    result.progress = returning / 4000;
    result.returnStage = returning < 1200 ? "walk-to-elevator" : returning < 2600 ? "elevator" : "walk-to-seat";
    result.returnProgress = returning < 1200 ? returning / 1200 : returning < 2600 ? (returning - 1200) / 1400 : (returning - 2600) / 1400;
    result.visibleFloorId = returning < 1900 ? journey.toFloorId : journey.fromFloorId;
  }
  return result;
}

var WasOfficeModel =
{
  buildOffice: wasOfficeBuildOffice,
  nextFloor: wasOfficeNextFloor,
  isResting: wasOfficeIsResting,
  createCall: wasOfficeCreateCall,
  callAt: wasOfficeCallAt,
  createJourney: wasOfficeCreateJourney,
  journeyAt: wasOfficeJourneyAt
};

if (typeof module !== "undefined" && module.exports)
{
  module.exports = WasOfficeModel;
}
