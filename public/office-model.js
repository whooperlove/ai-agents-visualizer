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

/* Status order of the "status" seat order: working first, then what needs a look, then what is done. The words match the stage's own reading of a status. */
var WAS_OFFICE_STATUS_ORDER = ["running", "waiting", "error", "interrupted", "unknown", "idle", "completed"];

function wasOfficeStatusKey(status)
{
  var value = wasOfficeText(status).toLowerCase();
  return /^(running|active|working)$/.test(value) ? "running" : /^(waiting|blocked|needs-input)$/.test(value) ? "waiting" : /^(failed|error)$/.test(value) ? "error"
    : value === "interrupted" ? "interrupted" : /^(idle|ready)$/.test(value) ? "idle" : /^(completed|done|stopped)$/.test(value) ? "completed" : "unknown";
}

/* The id a recorded message goes by; a documented relation that is not a delivery has none. */
function wasOfficeMessageId(edge)
{
  var deliveryId = wasOfficeText(edge && edge.message && edge.message.deliveryId);
  return deliveryId || (edge && edge.type === "collaboration" ? wasOfficeText(edge.id) : "");
}

/* Recorded messages between two different sessions, counted once per message id: the whole traffic of each session and the
   traffic of each pair. Age and relation filters do not matter here, so seats do not shuffle as messages scroll out of the recent window. */
function wasOfficeMessageVolumes(rawEdges, nodes)
{
  var seen = new Set();
  var totals = new Map();
  var pairs = new Map();
  rawEdges.forEach(function (edge)
  {
    var id = wasOfficeMessageId(edge);
    var from = wasOfficeText(edge && edge.from);
    var to = wasOfficeText(edge && edge.to);
    if (!id || seen.has(id) || from === to || !nodes.has(from) || !nodes.has(to))
    {
      return;
    }
    seen.add(id);
    [[from, to], [to, from]].forEach(function (side)
    {
      totals.set(side[0], (totals.get(side[0]) || 0) + 1);
      if (!pairs.has(side[0]))
      {
        pairs.set(side[0], new Map());
      }
      pairs.get(side[0]).set(side[1], (pairs.get(side[0]).get(side[1]) || 0) + 1);
    });
  });
  return { totals: totals, pairs: pairs };
}

/* Largest connected group of talkers a floor puts in order; a bigger one stays together but keeps its default order inside, rather than slowing every refresh. */
var WAS_OFFICE_GROUP_LIMIT = 1500;
/* Cost evaluations of the seat search per floor, so a crowded floor cannot stall a refresh. */
var WAS_OFFICE_SEARCH_BUDGET = 1500000;

/* Seats of one talking group in a row: the sum of message count times seat distance over every pair, which the search lowers
   by moving one session at a time to the seat where it costs least. Everything is deterministic: ties go to the lower seat. */
function wasOfficeArrangeGroup(group, links, fixedFirst, budget)
{
  var members = new Set(group);
  var weights = new Map();
  group.forEach(function (id)
  {
    var row = [];
    (links.get(id) || new Map()).forEach(function (count, other) { if (members.has(other)) { row.push([other, count]); } });
    weights.set(id, row);
  });
  var rank = new Map(group.map(function (id, index) { return [id, index]; }));
  var order = [group[0]];
  var placed = new Set(order);
  var pull = new Map();
  function reach(id)
  {
    weights.get(id).forEach(function (entry)
    {
      if (!placed.has(entry[0]))
      {
        pull.set(entry[0], (pull.get(entry[0]) || 0) + entry[1]);
      }
    });
  }
  reach(group[0]);
  while (order.length < group.length)
  {
    var best = null;
    pull.forEach(function (amount, id)
    {
      if (best === null || amount > pull.get(best) || amount === pull.get(best) && rank.get(id) < rank.get(best))
      {
        best = id;
      }
    });
    pull.delete(best);
    order.push(best);
    placed.add(best);
    reach(best);
  }
  var pairsOf = [];
  group.forEach(function (id)
  {
    weights.get(id).forEach(function (entry)
    {
      if (rank.get(id) < rank.get(entry[0]))
      {
        pairsOf.push([id, entry[0], entry[1]]);
      }
    });
  });
  function cost(arrangement)
  {
    var seat = new Map(arrangement.map(function (id, index) { return [id, index]; }));
    var total = 0;
    pairsOf.forEach(function (pair) { total += pair[2] * Math.abs(seat.get(pair[0]) - seat.get(pair[1])); });
    return total;
  }
  var current = cost(order);
  var lowest = fixedFirst ? 1 : 0;
  var improved = true;
  while (improved && budget.left > 0)
  {
    improved = false;
    for (var from = lowest; from < order.length && budget.left > 0; from += 1)
    {
      var bestSeat = from;
      var bestCost = current;
      for (var to = lowest; to < order.length && budget.left > 0; to += 1)
      {
        if (to === from)
        {
          continue;
        }
        var trial = order.slice();
        trial.splice(to, 0, trial.splice(from, 1)[0]);
        budget.left -= pairsOf.length + order.length;
        var trialCost = cost(trial);
        if (trialCost < bestCost)
        {
          bestCost = trialCost;
          bestSeat = to;
        }
      }
      if (bestSeat !== from)
      {
        order.splice(bestSeat, 0, order.splice(from, 1)[0]);
        current = bestCost;
        improved = true;
      }
    }
  }
  return order;
}

/* Sessions that message each other sit side by side. Talking groups come out as runs, each starting where its earliest member
   stood, and sessions that talk to nobody on the floor keep their place. fixedFirst keeps the manager or tree root at the head. */
function wasOfficeGroupSeats(ids, links, fixedFirst)
{
  var onFloor = new Set(ids);
  var talking = new Map();
  ids.forEach(function (id)
  {
    var partners = [];
    (links.get(id) || new Map()).forEach(function (count, other) { if (onFloor.has(other)) { partners.push(other); } });
    if (partners.length)
    {
      talking.set(id, partners);
    }
  });
  if (!talking.size)
  {
    return ids;
  }
  var position = new Map(ids.map(function (value, index) { return [value, index]; }));
  var groupOf = new Map();
  var groups = [];
  ids.forEach(function (id)
  {
    if (!talking.has(id) || groupOf.has(id))
    {
      return;
    }
    var group = [];
    var pending = [id];
    groupOf.set(id, group);
    while (pending.length)
    {
      var member = pending.pop();
      group.push(member);
      talking.get(member).forEach(function (other)
      {
        if (!groupOf.has(other))
        {
          groupOf.set(other, group);
          pending.push(other);
        }
      });
    }
    group.sort(function (first, second) { return position.get(first) - position.get(second); });
    groups.push(group);
  });
  var budget = { left: WAS_OFFICE_SEARCH_BUDGET };
  var arranged = new Map();
  groups.forEach(function (group)
  {
    arranged.set(group[0], group.length <= WAS_OFFICE_GROUP_LIMIT ? wasOfficeArrangeGroup(group, links, fixedFirst && group[0] === ids[0], budget) : group);
  });
  var result = [];
  ids.forEach(function (id)
  {
    if (!groupOf.has(id))
    {
      result.push(id);
    }
    else if (arranged.has(id))
    {
      arranged.get(id).forEach(function (member) { result.push(member); });
    }
  });
  return result;
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
  /* The viewer may pick another seat order. "group" keeps the arrangement above and gathers those who message each other; the
     others sort by name, by status (those that need a look first) or by how many messages a session has sent and received,
     and then no one is pinned to the head of the floor. */
  var seatOrder = ["group", "name", "status", "volume"].indexOf(options.order) !== -1 ? options.order : "group";
  var volumes = wasOfficeMessageVolumes(Array.isArray(snapshot.edges) ? snapshot.edges : [], nodes);
  function sortSeats(seatIds)
  {
    var base = new Map(seatIds.map(function (id, index) { return [id, index]; }));
    return seatIds.slice().sort(function (first, second)
    {
      var result = seatOrder === "name" ? actorById.get(first).name.localeCompare(actorById.get(second).name, undefined, { numeric: true })
        : seatOrder === "status" ? WAS_OFFICE_STATUS_ORDER.indexOf(wasOfficeStatusKey(actorById.get(first).status)) - WAS_OFFICE_STATUS_ORDER.indexOf(wasOfficeStatusKey(actorById.get(second).status))
        : (volumes.totals.get(second) || 0) - (volumes.totals.get(first) || 0);
      return result || base.get(first) - base.get(second);
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
    if (seatOrder === "group")
    {
      /* Sessions that talk a lot sit side by side, within one floor. The stage seats working sessions at their desks and resting
         ones on the sofas further right, so each of the two groups is arranged on its own; the head of a group stays with the
         manager or tree root. */
      var anchor = floor.managerId !== null || floor.id.indexOf(treePrefix) === 0 ? floor.nodeIds[0] : null;
      var working = floor.nodeIds.filter(function (id) { return !wasOfficeIsResting(actorById.get(id)); });
      var resting = floor.nodeIds.filter(function (id) { return wasOfficeIsResting(actorById.get(id)); });
      floor.nodeIds = wasOfficeGroupSeats(working, volumes.pairs, working[0] === anchor).concat(wasOfficeGroupSeats(resting, volumes.pairs, resting[0] === anchor));
    }
    else
    {
      floor.nodeIds = sortSeats(floor.nodeIds);
    }
    floor.nodeIds.forEach(function (id, index) { actorById.get(id).seatIndex = index; });
  });
  if (options.groupFloors === false && ids.length)
  {
    var merged = { id: prefix + "all", name: wasOfficeFloorName(project) || wasOfficeMessage("scene.floor.all"), managerId: null, nodeIds: [], hiddenCount: ids.length - actors.length };
    var arranged = [];
    floors.forEach(function (floor) { floor.nodeIds.forEach(function (id) { arranged.push(id); }); });
    (seatOrder === "group" ? arranged : sortSeats(arranged)).forEach(function (id, index)
    {
      actorById.get(id).floorId = merged.id;
      actorById.get(id).seatIndex = index;
      merged.nodeIds.push(id);
    });
    floors = [merged];
    floorById = new Map([[merged.id, merged]]);
  }
  return { floors: floors, actors: actors, actorById: actorById, floorById: floorById, stats: { matched: matched.size, context: included.size - matched.size, hidden: ids.length - included.size, all: ids.length }, project: project, order: seatOrder };
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
  var deliveryId = wasOfficeMessageId(edge);
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
