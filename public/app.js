/* AI Agents Visualizer. No external services or dependencies. */
"use strict";

var wasState = null;
var wasElements = null;
var wasGraphColors = null;
var wasCanvasFontFamily = "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", sans-serif";
var wasKnownStatuses = ["running", "waiting", "idle", "completed", "interrupted", "unknown"];
var wasKnownTypes = ["management", "dependency", "spawn", "collaboration", "handoff"];
var wasRouteRadius = 12;
/* Distance from one card to the next in the spawn hierarchy layout: the card plus twice the former gap. */
var wasNativeStep = { x: 322, y: 139 };

/* Looks a message up in the active language. Without the catalog (plain Node require) it returns the key and never throws. */
function wasT(key, params)
{
  if (typeof WasI18n === "undefined")
  {
    return key;
  }
  if (params && typeof params.count === "number" && typeof params.number === "undefined")
  {
    // {number} is the grouped display form of the plural count.
    params = Object.assign({ number: wasFormatNumber(params.count) }, params);
  }
  return WasI18n.t(key, params);
}

/* Returns the translation of prefix + "." + value when the catalog has it, otherwise an empty string so callers can fall back to the raw value. */
function wasKnownLabel(prefix, value)
{
  var key = prefix + "." + wasText(value);
  if (typeof WasI18n === "undefined" || !Object.prototype.hasOwnProperty.call(WasI18n.catalogs.en, key))
  {
    return "";
  }
  return WasI18n.t(key);
}

/* A message token keeps text in state that must follow a later language change; wasResolveText renders it for the current language. */
function wasToken(key, params)
{
  return typeof WasI18n === "undefined" ? key : WasI18n.token(key, params);
}

function wasLocale()
{
  return typeof WasI18n === "undefined" ? "" : WasI18n.getLocale();
}

function wasResolveText(text)
{
  return typeof WasI18n === "undefined" ? text : WasI18n.resolve(text);
}

function wasResolveSnapshot(snapshot)
{
  return typeof WasI18n === "undefined" ? snapshot : WasI18n.resolveDeep(snapshot);
}

function wasStatusName(status)
{
  return wasKnownLabel("app.status", status) || wasText(status);
}

function wasTypeName(type)
{
  return wasKnownLabel("app.type", type) || wasText(type);
}

function wasConfidenceName(confidence)
{
  return wasKnownLabel("app.confidence", confidence);
}

function wasActivityName(category)
{
  return wasKnownLabel("app.activity", category) || wasText(category);
}

function wasGetActivity(node, now)
{
  if (node.archived)
  {
    return { category: "inactive", reason: wasT("app.activity.reasonArchived"), windowMinutes: 120 };
  }
  var activity = node.activity;
  if (activity && (activity.category === "recent" || activity.category === "inactive" || activity.category === "unconfirmed"))
  {
    return activity;
  }
  var timestamp = new Date(node.lastSeen || "").getTime();
  var current = typeof now === "number" ? now : Date.now();
  if (node.kind === "agent" && (node.status === "completed" || node.status === "interrupted"))
  {
    return { category: "inactive", reason: wasT("app.activity.reasonTerminalAgent"), windowMinutes: 120 };
  }
  if (!Number.isFinite(timestamp))
  {
    return { category: "unconfirmed", reason: wasT("app.activity.reasonNoTimestamp"), windowMinutes: 120 };
  }
  if (current - timestamp > 120 * 60 * 1000)
  {
    return { category: "inactive", reason: wasT("app.activity.reasonOutsideWindow"), windowMinutes: 120 };
  }
  return { category: "recent", reason: wasT("app.activity.reasonRecent"), windowMinutes: 120 };
}

function wasGetEdgeHistory(edge, now)
{
  if (edge.type === "spawn" || edge.type === "management")
  {
    return false;
  }
  var status = wasText(edge.status).toLowerCase();
  var sourceKind = wasText(edge.source && edge.source.kind).toLowerCase();
  var evidenceKind = wasText(edge.evidence && edge.evidence.kind).toLowerCase();
  var documented = status.indexOf("documented") !== -1 || sourceKind.indexOf("document") !== -1 || evidenceKind.indexOf("document") !== -1 || sourceKind.indexOf("supplement") !== -1;
  if (documented && (edge.type === "dependency" || edge.type === "handoff"))
  {
    return true;
  }
  var timestamp = new Date(edge.lastSeen || edge.timestamp || "").getTime();
  var current = typeof now === "number" ? now : Date.now();
  return !Number.isFinite(timestamp) || current - timestamp > 120 * 60 * 1000;
}

function wasText(value)
{
  if (value === null || typeof value === "undefined")
  {
    return "";
  }
  if (typeof value === "object")
  {
    return JSON.stringify(value);
  }
  return String(value);
}

function wasMessageId(edge)
{
  if (edge.message && edge.message.deliveryId)
  {
    return wasText(edge.message.deliveryId);
  }
  // A documented dependency may refer to a request without being a delivery.
  // The edge ID keeps separate request/reply records distinct when legacy data has no delivery ID.
  return edge.type === "collaboration" ? wasText(edge.id) : "";
}

function wasUniqueMessages(edges)
{
  var messages = new Map();
  edges.forEach(function (edge)
  {
    var id = wasMessageId(edge);
    if (!id)
    {
      return;
    }
    var previous = messages.get(id);
    if (!previous || !previous.message && edge.message)
    {
      messages.set(id, edge);
    }
  });
  return messages;
}

function wasMessageSignature(edge)
{
  var message = edge.message || {};
  return JSON.stringify([edge.from, edge.to, edge.status, message.kind, message.acceptedAt, message.finishedAt, message.outcome, message.expired]);
}

function wasMessageResolved(edge)
{
  var message = edge.message || {};
  return !!(message.finishedAt || message.expired || message.outcome && message.outcome !== "none" || /completed|failed|cancelled|expired|reply-recorded|transcript-confirmed/.test(wasText(edge.status)));
}

function wasObserveMessages(previous, edges, observedAt, options)
{
  options = options || {};
  if (options.reset)
  {
    previous = null;
  }
  var state = previous || { baseline: false, signatures: new Map(), events: [], older: 0, sequence: 0 };
  var previousLength = state.events.length;
  var fresh = [];
  wasUniqueMessages(edges).forEach(function (edge)
  {
    var id = wasMessageId(edge);
    if (!id)
    {
      return;
    }
    var signature = wasMessageSignature(edge);
    var message = edge.message || {};
    var recordTime = Math.max.apply(null, [message.createdAt, message.acceptedAt, message.finishedAt, message.expired ? message.expiresAt : "", edge.lastSeen].map(function (value) { return Date.parse(value || "") || 0; }));
    var changed = state.signatures.has(id);
    if (state.baseline && !options.loading && state.signatures.get(id) !== signature && (changed && !recordTime || recordTime >= state.cutoff - 2000))
    {
      state.sequence += 1;
      fresh.push({ id: id, sequence: state.sequence, edge: edge, observedAt: observedAt, transition: state.signatures.has(id) });
    }
    state.signatures.set(id, signature);
  });
  if (!state.baseline && !options.loading)
  {
    state.baseline = true;
    state.cutoff = observedAt;
  }
  state.events = state.events.concat(fresh).slice(-200);
  state.older += Math.max(0, previousLength + fresh.length - 200);
  // Keep disappearance/reappearance deduplication bounded without replaying retained deliveries.
  if (state.signatures.size > 20000)
  {
    var current = new Set(edges.map(wasMessageId));
    state.signatures.forEach(function (value, id)
    {
      if (state.signatures.size > 20000 && !current.has(id))
      {
        state.signatures.delete(id);
      }
    });
  }
  return { state: state, fresh: fresh };
}

function wasSummarizeMessages(edges)
{
  var nodes = new Map();
  var deliveries = new Map();
  var bundles = new Map();
  wasUniqueMessages(edges).forEach(function (edge)
  {
    var id = wasMessageId(edge);
    if (!id || deliveries.has(id))
    {
      return;
    }
    deliveries.set(id, edge);
    [edge.from, edge.to].forEach(function (nodeId)
    {
      if (!nodes.has(nodeId))
      {
        nodes.set(nodeId, { sent: 0, received: 0, unresolved: 0 });
      }
    });
    nodes.get(edge.from).sent += 1;
    nodes.get(edge.to).received += 1;
    var unresolved = !wasMessageResolved(edge);
    if (unresolved)
    {
      nodes.get(edge.from).unresolved += 1;
    }
    var key = JSON.stringify([edge.from, edge.to]);
    if (!bundles.has(key))
    {
      bundles.set(key, { from: edge.from, to: edge.to, count: 0, unresolved: 0, edges: [] });
    }
    var bundle = bundles.get(key);
    bundle.count += 1;
    bundle.unresolved += Number(unresolved);
    bundle.edges.push(edge);
  });
  return { nodes: nodes, deliveries: deliveries, bundles: bundles };
}

function wasPairKey(from, to)
{
  return JSON.stringify([from, to].sort());
}

function wasBundleConnections(edges, edgeIssues)
{
  var pairs = new Map();
  var typeOrder = ["management", "spawn", "dependency", "collaboration", "handoff"];
  edges.forEach(function (edge)
  {
    var key = wasPairKey(edge.from, edge.to);
    if (!pairs.has(key))
    {
      var endpoints = [edge.from, edge.to].sort();
      pairs.set(key, { id: key, from: endpoints[0], to: endpoints[1], edges: [], types: [], conflicts: [], confidenceCounts: { confirmed: 0, inferred: 0, unresolved: 0 }, deliveryCount: 0, unresolved: 0, forward: { edges: [], messages: [], unresolved: 0 }, reverse: { edges: [], messages: [], unresolved: 0 } });
    }
    var pair = pairs.get(key);
    pair.edges.push(edge);
    (edge.from === pair.from ? pair.forward : pair.reverse).edges.push(edge);
    if (pair.types.indexOf(edge.type) === -1)
    {
      pair.types.push(edge.type);
    }
    var confidence = Object.prototype.hasOwnProperty.call(pair.confidenceCounts, edge.confidence) ? edge.confidence : "unresolved";
    pair.confidenceCounts[confidence] += 1;
    pair.conflicts = pair.conflicts.concat(edge.conflicts || []);
    if (edgeIssues && edgeIssues.has(edge.id))
    {
      pair.conflicts.push(edgeIssues.get(edge.id));
    }
  });
  pairs.forEach(function (pair)
  {
    pair.types.sort(function (first, second)
    {
      var firstIndex = typeOrder.indexOf(first);
      var secondIndex = typeOrder.indexOf(second);
      return (firstIndex === -1 ? 99 : firstIndex) - (secondIndex === -1 ? 99 : secondIndex);
    });
    pair.type = pair.types[0];
    pair.conflicts = Array.from(new Set(pair.conflicts));
    wasUniqueMessages(pair.edges).forEach(function (edge)
    {
      var direction = edge.from === pair.from ? pair.forward : pair.reverse;
      direction.messages.push(edge);
      direction.unresolved += Number(!wasMessageResolved(edge));
      pair.deliveryCount += 1;
      pair.unresolved += Number(!wasMessageResolved(edge));
    });
  });
  return Array.from(pairs.values());
}

function wasConnectionLabel(pair)
{
  var parts = [pair.types.map(function (type) { return type === "management" ? wasT("app.connection.typeManagement") : wasTypeName(type); }).join("·")];
  if (pair.deliveryCount)
  {
    parts.push(wasT("app.connection.deliveries", { count: pair.deliveryCount }));
  }
  if (pair.unresolved)
  {
    parts.push(wasT("app.connection.unresolved", { count: pair.unresolved }));
  }
  if (pair.confidenceCounts.inferred)
  {
    parts.push(wasT("app.connection.inferred", { count: pair.confidenceCounts.inferred }));
  }
  if (pair.confidenceCounts.unresolved)
  {
    parts.push(wasT("app.connection.unconfirmed", { count: pair.confidenceCounts.unresolved }));
  }
  if (pair.conflicts.length)
  {
    parts.push(wasT("app.connection.conflicts", { count: pair.conflicts.length }));
  }
  return parts.join(" · ");
}

function wasBuildObstacleIndex(positions)
{
  var index = { positions: positions, columns: new Map(), rows: new Map(), vertical: new Map(), horizontal: new Map() };
  positions.forEach(function (point, id)
  {
    var entry = { id: id, point: point };
    for (var x = Math.floor((point.x - 5) / 270); x <= Math.floor((point.x + point.width + 5) / 270); x += 1)
    {
      if (!index.columns.has(x))
      {
        index.columns.set(x, []);
      }
      index.columns.get(x).push(entry);
    }
    for (var y = Math.floor((point.y - 5) / 128); y <= Math.floor((point.y + point.height + 5) / 128); y += 1)
    {
      if (!index.rows.has(y))
      {
        index.rows.set(y, []);
      }
      index.rows.get(y).push(entry);
    }
  });
  return index;
}

function wasRouteIntervals(obstacles, coordinate, vertical)
{
  var cache = vertical ? obstacles.vertical : obstacles.horizontal;
  if (cache.has(coordinate))
  {
    return cache.get(coordinate);
  }
  var entries = (vertical ? obstacles.columns.get(Math.floor(coordinate / 270)) : obstacles.rows.get(Math.floor(coordinate / 128))) || [];
  var intervals = entries.filter(function (entry)
  {
    var point = entry.point;
    return vertical ? coordinate > point.x - 5 && coordinate < point.x + point.width + 5 : coordinate > point.y - 5 && coordinate < point.y + point.height + 5;
  }).map(function (entry)
  {
    return { id: entry.id, start: (vertical ? entry.point.y : entry.point.x) - 5, end: (vertical ? entry.point.y + entry.point.height : entry.point.x + entry.point.width) + 5 };
  });
  intervals.sort(function (first, second) { return first.start - second.start; });
  var maxEnd = -Infinity;
  intervals.forEach(function (interval)
  {
    maxEnd = Math.max(maxEnd, interval.end);
    interval.maxEnd = maxEnd;
  });
  cache.set(coordinate, intervals);
  return intervals;
}

function wasRouteCrossings(points, pair, obstacles)
{
  for (var segment = 1; segment < points.length; segment += 1)
  {
    var start = points[segment - 1];
    var end = points[segment];
    var endpoints = [obstacles.positions.get(pair.from), obstacles.positions.get(pair.to)];
    if (endpoints.some(function (point)
    {
      return Math.max(start.x, end.x) > point.x + .1 && Math.min(start.x, end.x) < point.x + point.width - .1 && Math.max(start.y, end.y) > point.y + .1 && Math.min(start.y, end.y) < point.y + point.height - .1;
    }))
    {
      return 10;
    }
    var vertical = start.x === end.x;
    var intervals = wasRouteIntervals(obstacles, vertical ? start.x : start.y, vertical);
    var min = vertical ? Math.min(start.y, end.y) : Math.min(start.x, end.x);
    var max = vertical ? Math.max(start.y, end.y) : Math.max(start.x, end.x);
    var low = 0;
    var high = intervals.length;
    while (low < high)
    {
      var middle = Math.floor((low + high) / 2);
      if (intervals[middle].maxEnd <= min)
      {
        low = middle + 1;
      }
      else
      {
        high = middle;
      }
    }
    for (var index = low; index < intervals.length && intervals[index].start < max; index += 1)
    {
      var interval = intervals[index];
      if (interval.id !== pair.from && interval.id !== pair.to && interval.end > min)
      {
        return 1;
      }
    }
  }
  return 0;
}

function wasRouteConnection(pair, positions, obstacles)
{
  var from = positions.get(pair.from);
  var to = positions.get(pair.to);
  if (!from || !to)
  {
    return null;
  }
  obstacles = obstacles || wasBuildObstacleIndex(positions);
  var fromX = from.x + from.width / 2;
  var fromY = from.y + from.height / 2;
  var toX = to.x + to.width / 2;
  var toY = to.y + to.height / 2;
  var candidates = [];
  if (pair.from === pair.to)
  {
    candidates.push([{ x: from.x + from.width, y: fromY - 14 }, { x: from.x + from.width + 24, y: fromY - 14 }, { x: from.x + from.width + 24, y: fromY + 14 }, { x: from.x + from.width, y: fromY + 14 }]);
  }
  else
  {
    if (from.x + from.width <= to.x || to.x + to.width <= from.x)
    {
      var right = fromX < toX;
      var startX = right ? from.x + from.width : from.x;
      var endX = right ? to.x : to.x + to.width;
      var middleX = (startX + endX) / 2;
      candidates.push([{ x: startX, y: fromY }, { x: middleX, y: fromY }, { x: middleX, y: toY }, { x: endX, y: toY }]);
    }
    if (from.y + from.height <= to.y || to.y + to.height <= from.y)
    {
      var below = fromY < toY;
      var startY = below ? from.y + from.height : from.y;
      var endY = below ? to.y : to.y + to.height;
      var middleY = (startY + endY) / 2;
      candidates.push([{ x: fromX, y: startY }, { x: fromX, y: middleY }, { x: toX, y: middleY }, { x: toX, y: endY }]);
    }
    // A team head with lanes to its right sends every line to them along one shared trunk.
    [[from, to, false], [to, from, true]].forEach(function (ends)
    {
      var head = ends[0];
      var member = ends[1];
      if (head.trunkX === undefined || member.x < head.trunkX)
      {
        return;
      }
      var headY = head.y + head.height / 2;
      var memberY = member.y + member.height / 2;
      var trunk = [{ x: head.x + head.width, y: headY }, { x: head.trunkX, y: headY }, { x: head.trunkX, y: memberY }, { x: member.x, y: memberY }];
      trunk.trunk = true;
      candidates.push(ends[2] ? trunk.reverse() : trunk);
    });
    [false, true].forEach(function (rightSide)
    {
      var lane = rightSide ? Math.max(from.x + from.width, to.x + to.width) + 18 : Math.min(from.x, to.x) - 18;
      candidates.push([{ x: rightSide ? from.x + from.width : from.x, y: fromY }, { x: lane, y: fromY }, { x: lane, y: toY }, { x: rightSide ? to.x + to.width : to.x, y: toY }]);
    });
    [false, true].forEach(function (bottomSide)
    {
      var lane = bottomSide ? Math.max(from.y + from.height, to.y + to.height) + 18 : Math.min(from.y, to.y) - 18;
      candidates.push([{ x: fromX, y: bottomSide ? from.y + from.height : from.y }, { x: fromX, y: lane }, { x: toX, y: lane }, { x: toX, y: bottomSide ? to.y + to.height : to.y }]);
    });
  }
  var best = null;
  candidates.forEach(function (candidate)
  {
    var points = candidate.filter(function (point, index)
    {
      return !index || point.x !== candidate[index - 1].x || point.y !== candidate[index - 1].y;
    });
    var length = 0;
    for (var index = 1; index < points.length; index += 1)
    {
      length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    }
    var score = length + wasRouteCrossings(points, pair, obstacles) * 100000 + points.length * 3 - (candidate.trunk ? 40 : 0);
    if (!best || score < best.score)
    {
      best = { points: points, length: length, score: score };
    }
  });
  best.label = wasPointOnRoute(best, .5);
  return best;
}

function wasPointOnRoute(route, progress)
{
  var remaining = route.length * Math.max(0, Math.min(1, progress));
  for (var index = 1; index < route.points.length; index += 1)
  {
    var start = route.points[index - 1];
    var end = route.points[index];
    var length = Math.hypot(end.x - start.x, end.y - start.y);
    if (remaining <= length || index === route.points.length - 1)
    {
      var fraction = length ? remaining / length : 0;
      return { x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction, angle: Math.atan2(end.y - start.y, end.x - start.x) };
    }
    remaining -= length;
  }
  return { x: route.points[0].x, y: route.points[0].y, angle: 0 };
}

function wasConnectionDirectionLabel(pair, route)
{
  if (!pair.deliveryCount)
  {
    return "";
  }
  if (pair.from === pair.to)
  {
    return wasT("app.connection.selfDeliveries", { count: pair.deliveryCount });
  }
  var start = route.points[0];
  var end = route.points[route.points.length - 1];
  var horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  var forward = horizontal ? end.x >= start.x ? "→" : "←" : end.y >= start.y ? "↓" : "↑";
  var reverse = { "→": "←", "←": "→", "↓": "↑", "↑": "↓" }[forward];
  return [pair.forward.messages.length ? forward + " " + pair.forward.messages.length : "", pair.reverse.messages.length ? reverse + " " + pair.reverse.messages.length : ""].filter(Boolean).join("  ·  ");
}

function wasPlaceConnectionLabel(route, width, height, obstacles, labels)
{
  var candidates = [];
  [.5, .4, .6, .25, .75].forEach(function (progress)
  {
    var anchor = wasPointOnRoute(route, progress);
    [0, -16, 16, -32, 32, -64, 64, -80, 80, -128, 128].forEach(function (offset)
    {
      candidates.push({ x: anchor.x, y: anchor.y + offset });
    });
    candidates.push({ x: anchor.x - width / 2 - 12, y: anchor.y });
    candidates.push({ x: anchor.x + width / 2 + 12, y: anchor.y });
  });
  candidates.sort(function (first, second)
  {
    return Math.hypot(first.x - route.label.x, first.y - route.label.y) - Math.hypot(second.x - route.label.x, second.y - route.label.y);
  });
  var chosen = candidates.find(function (candidate)
  {
    candidate.x = Math.max(width / 2 + 12, candidate.x);
    candidate.y = Math.max(height / 2 + 12, candidate.y);
    var left = candidate.x - width / 2;
    var right = candidate.x + width / 2;
    var top = candidate.y - height / 2;
    var bottom = candidate.y + height / 2;
    if ((labels || []).some(function (label)
    {
      return right > label.left - 4 && left < label.right + 4 && bottom > label.top - 4 && top < label.bottom + 4;
    }))
    {
      return false;
    }
    for (var row = Math.floor((top - 3) / 128); row <= Math.floor((bottom + 3) / 128); row += 1)
    {
      var entries = obstacles.rows.get(row) || [];
      for (var index = 0; index < entries.length; index += 1)
      {
        var point = entries[index].point;
        if (right > point.x - 3 && left < point.x + point.width + 3 && bottom > point.y - 3 && top < point.y + point.height + 3)
        {
          return false;
        }
      }
    }
    return true;
  });
  return chosen || { x: Math.max(width / 2 + 12, route.label.x), y: Math.max(height / 2 + 12, route.label.y) };
}

function wasBuildOperatingView(model, view, filters, expanded, showQuiet)
{
  var visible = new Set(view.rows.map(function (row) { return row.id; }));
  var management = model.edges.filter(function (edge)
  {
    if (edge.type !== "management")
    {
      return false;
    }
    return [edge.from, edge.to].every(function (id)
    {
      var node = model.nodeMap.get(id);
      return !node.archived && (!filters.project || wasText(node.project).toLowerCase() === wasText(filters.project).toLowerCase());
    });
  });
  var quiet = new Set();
  var team = new Set();
  var managerCounts = new Map();
  var allowContext = !filters.query && !filters.provider && !filters.status && !filters.kind && !filters.focusId && (filters.activity || "recent") === "recent";
  management.forEach(function (edge)
  {
    team.add(edge.from);
    team.add(edge.to);
    managerCounts.set(edge.from, (managerCounts.get(edge.from) || 0) + 1);
    if (allowContext)
    {
      [edge.from, edge.to].forEach(function (id)
      {
        if (!view.matched.has(id))
        {
          quiet.add(id);
          if (showQuiet)
          {
            visible.add(id);
          }
        }
      });
    }
  });
  // Search/filter matches retain their logical managers as context, just as native ancestors do.
  if (!filters.focusId)
  {
    var incoming = new Map();
    management.forEach(function (edge)
    {
      if (!incoming.has(edge.to))
      {
        incoming.set(edge.to, []);
      }
      incoming.get(edge.to).push(edge.from);
    });
    var ancestors = Array.from(visible);
    while (ancestors.length)
    {
      var ancestorId = ancestors.pop();
      (incoming.get(ancestorId) || []).forEach(function (id)
      {
        if (!visible.has(id))
        {
          visible.add(id);
          ancestors.push(id);
        }
      });
    }
  }
  // An archived record never returns via the logical-team context exception.
  if ((filters.activity || "recent") === "recent")
  {
    visible.forEach(function (id)
    {
      if (model.nodeMap.get(id).archived)
      {
        visible.delete(id);
      }
    });
  }
  var parent = new Map();
  function addParent(from, to)
  {
    if (!visible.has(from) || !visible.has(to) || from === to || parent.has(to))
    {
      return;
    }
    var ancestor = from;
    while (ancestor)
    {
      if (ancestor === to)
      {
        return;
      }
      ancestor = parent.get(ancestor);
    }
    parent.set(to, from);
  }
  management.slice().sort(function (first, second)
  {
    return (managerCounts.get(second.from) || 0) - (managerCounts.get(first.from) || 0) || first.id.localeCompare(second.id);
  }).forEach(function (edge)
  {
    addParent(edge.from, edge.to);
  });
  model.parent.forEach(function (from, to)
  {
    if (!team.has(to))
    {
      addParent(from, to);
    }
  });
  var children = new Map();
  visible.forEach(function (id) { children.set(id, []); });
  parent.forEach(function (from, to) { children.get(from).push(to); });
  function compareIds(first, second)
  {
    return (managerCounts.get(second) || 0) - (managerCounts.get(first) || 0) || model.nodeMap.get(first).name.localeCompare(model.nodeMap.get(second).name);
  }
  children.forEach(function (ids) { ids.sort(compareIds); });
  var roots = Array.from(visible).filter(function (id) { return !parent.has(id); }).sort(compareIds);
  var rows = [];
  var stack = roots.slice().reverse().map(function (id) { return { id: id, depth: 0 }; });
  while (stack.length)
  {
    var row = stack.pop();
    row.context = !view.matched.has(row.id);
    row.quiet = quiet.has(row.id);
    row.manager = managerCounts.has(row.id);
    row.managedCount = managerCounts.get(row.id) || 0;
    row.team = team.has(row.id);
    row.children = children.get(row.id);
    row.expanded = expanded.has(row.id) || view.forcedExpanded.has(row.id);
    rows.push(row);
    for (var index = row.children.length - 1; index >= 0; index -= 1)
    {
      stack.push({ id: row.children[index], depth: row.depth + 1 });
    }
  }
  return { rows: rows, roots: roots, quiet: quiet, team: team, parent: parent, management: management };
}

function wasCreateElement(tag, className, value)
{
  var element = document.createElement(tag);
  if (className)
  {
    element.className = className;
  }
  if (typeof value !== "undefined")
  {
    element.textContent = wasText(value);
  }
  return element;
}

function wasClearElement(element)
{
  while (element.firstChild)
  {
    element.removeChild(element.firstChild);
  }
}

function wasNormalizeSnapshot(snapshot)
{
  var nodes = [];
  var nodeMap = new Map();
  var edges = [];
  var edgeIds = new Set();
  var inputNodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  var inputEdges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  inputNodes.forEach(function (input)
  {
    if (!input || input.id === null || typeof input.id === "undefined")
    {
      return;
    }
    var node = Object.assign({}, input);
    node.id = wasText(node.id);
    if (nodeMap.has(node.id))
    {
      return;
    }
    node.name = wasText(node.name || node.sessionId || node.id);
    node.kind = node.kind || "session";
    node.provider = wasText(node.provider || "unknown");
    node.status = node.status || "unknown";
    node.sources = Array.isArray(node.sources) ? node.sources : [];
    node.conflicts = Array.isArray(node.conflicts) ? node.conflicts : [];
    nodes.push(node);
    nodeMap.set(node.id, node);
  });
  inputEdges.forEach(function (input, index)
  {
    if (!input || input.from === null || input.to === null || typeof input.from === "undefined" || typeof input.to === "undefined")
    {
      return;
    }
    var edge = Object.assign({}, input);
    edge.from = wasText(edge.from);
    edge.to = wasText(edge.to);
    edge.id = wasText(edge.id || "relation-" + index);
    if (edgeIds.has(edge.id))
    {
      edge.id += "-duplicate-" + index;
    }
    edgeIds.add(edge.id);
    edge.type = edge.type || "collaboration";
    edge.conflicts = Array.isArray(edge.conflicts) ? edge.conflicts : [];
    edges.push(edge);
    [edge.from, edge.to].forEach(function (id)
    {
      if (nodeMap.has(id))
      {
        return;
      }
      var node =
      {
        id: id,
        sessionId: id,
        name: wasT("app.node.unresolvedName", { id: id }),
        provider: "unknown",
        kind: "unresolved",
        status: "unknown",
        sources: edge.source ? [edge.source] : [],
        conflicts: [],
        description: wasT("app.node.unresolvedDescription")
      };
      nodes.push(node);
      nodeMap.set(id, node);
    });
  });
  return { nodes: nodes, nodeMap: nodeMap, edges: edges };
}

function wasBuildModel(snapshot)
{
  var normalized = wasNormalizeSnapshot(snapshot);
  var model =
  {
    nodes: normalized.nodes,
    nodeMap: normalized.nodeMap,
    edges: normalized.edges,
    children: new Map(),
    parent: new Map(),
    descendants: new Map(),
    incident: new Map(),
    edgeIssues: new Map(),
    nodeIssues: new Map(),
    activity: new Map(),
    roots: [],
    order: [],
    searchText: new Map()
  };
  var union = new Map();
  var unionRank = new Map();
  model.nodes.forEach(function (node)
  {
    model.children.set(node.id, []);
    model.incident.set(node.id, []);
    model.nodeIssues.set(node.id, []);
    model.activity.set(node.id, wasGetActivity(node));
    union.set(node.id, node.id);
    unionRank.set(node.id, 0);
    model.searchText.set(node.id, [node.id, node.name, node.sessionId, node.description, node.cwd, node.project, node.provider, node.account, node.model].map(wasText).join(" ").toLocaleLowerCase());
  });
  function findRoot(id)
  {
    var root = id;
    while (union.get(root) !== root)
    {
      root = union.get(root);
    }
    while (union.get(id) !== id)
    {
      var next = union.get(id);
      union.set(id, root);
      id = next;
    }
    return root;
  }
  function joinRoots(from, to)
  {
    var first = findRoot(from);
    var second = findRoot(to);
    if (first === second)
    {
      return false;
    }
    if (unionRank.get(first) < unionRank.get(second))
    {
      union.set(first, second);
    }
    else
    {
      union.set(second, first);
      if (unionRank.get(first) === unionRank.get(second))
      {
        unionRank.set(first, unionRank.get(first) + 1);
      }
    }
    return true;
  }
  function markIssue(edge, message)
  {
    model.edgeIssues.set(edge.id, message);
    model.nodeIssues.get(edge.from).push(message);
    if (edge.from !== edge.to)
    {
      model.nodeIssues.get(edge.to).push(message);
    }
  }
  var confidenceRank = { confirmed: 0, inferred: 1, unresolved: 2 };
  var hierarchyEdges = model.edges.filter(function (edge)
  {
    model.incident.get(edge.from).push(edge);
    if (edge.from !== edge.to)
    {
      model.incident.get(edge.to).push(edge);
    }
    return edge.type === "spawn";
  });
  hierarchyEdges.sort(function (a, b)
  {
    var rank = (confidenceRank[a.confidence] || 0) - (confidenceRank[b.confidence] || 0);
    return rank || a.id.localeCompare(b.id);
  });
  hierarchyEdges.forEach(function (edge)
  {
    if (edge.from === edge.to)
    {
      markIssue(edge, wasT("app.issue.selfParent"));
      return;
    }
    if (model.parent.has(edge.to))
    {
      if (model.parent.get(edge.to) !== edge.from)
      {
        markIssue(edge, wasT("app.issue.multipleParents"));
      }
      return;
    }
    if (findRoot(edge.from) === findRoot(edge.to))
    {
      markIssue(edge, wasT("app.issue.cycle"));
      return;
    }
    joinRoots(edge.from, edge.to);
    model.parent.set(edge.to, edge.from);
    model.children.get(edge.from).push(edge.to);
  });
  function compareIds(a, b)
  {
    var first = model.nodeMap.get(a);
    var second = model.nodeMap.get(b);
    var firstTime = new Date(first.lastSeen || 0).getTime() || 0;
    var secondTime = new Date(second.lastSeen || 0).getTime() || 0;
    return secondTime - firstTime || first.name.localeCompare(second.name) || a.localeCompare(b);
  }
  model.children.forEach(function (children)
  {
    children.sort(compareIds);
  });
  model.nodes.forEach(function (node)
  {
    if (!model.parent.has(node.id))
    {
      model.roots.push(node.id);
    }
  });
  model.roots.sort(compareIds);
  var stack = model.roots.slice().reverse();
  while (stack.length)
  {
    var id = stack.pop();
    model.order.push(id);
    var children = model.children.get(id);
    for (var index = children.length - 1; index >= 0; index -= 1)
    {
      stack.push(children[index]);
    }
  }
  for (var orderIndex = model.order.length - 1; orderIndex >= 0; orderIndex -= 1)
  {
    var orderId = model.order[orderIndex];
    var count = 0;
    model.children.get(orderId).forEach(function (child)
    {
      count += 1 + model.descendants.get(child);
    });
    model.descendants.set(orderId, count);
  }
  return model;
}

function wasGetBranch(model, id)
{
  var branch = new Set();
  var stack = [id];
  while (stack.length)
  {
    var current = stack.pop();
    if (branch.has(current) || !model.nodeMap.has(current))
    {
      continue;
    }
    branch.add(current);
    model.children.get(current).forEach(function (child)
    {
      stack.push(child);
    });
  }
  return branch;
}

// Status sort order: sessions that are doing something first, then the ones that need a look, then the finished ones.
var wasStatusRank = ["running", "waiting", "interrupted", "unknown", "idle", "completed"];
var wasSortKeys = ["recent", "status", "name"];
// The seat orders of the character stage; the first one, grouping by messages, is the default.
var wasOfficeOrders = ["group", "name", "status", "volume"];
// The direction a column starts with when it is chosen: newest, working and A first.
var wasSortFirstDirection = { recent: "desc", status: "asc", name: "asc" };
var wasDefaultSort = { key: "recent", direction: "desc" };

function wasParseSort(value)
{
  var parts = wasText(value).split(":");
  if (wasSortKeys.indexOf(parts[0]) === -1 || (parts[1] !== "asc" && parts[1] !== "desc"))
  {
    return null;
  }
  return { key: parts[0], direction: parts[1] };
}

function wasSortValue()
{
  var sort = wasState.sort || wasDefaultSort;
  return sort.key + ":" + sort.direction;
}

function wasNodeTime(node)
{
  return new Date(node.lastSeen || 0).getTime() || 0;
}

function wasSortComparator(model, sort)
{
  var sign = sort.direction === "desc" ? -1 : 1;
  return function (a, b)
  {
    var first = model.nodeMap.get(a);
    var second = model.nodeMap.get(b);
    var result;
    if (sort.key === "status")
    {
      result = wasStatusRank.indexOf(wasSafeStatus(first.status)) - wasStatusRank.indexOf(wasSafeStatus(second.status));
    }
    else if (sort.key === "name")
    {
      result = first.name.localeCompare(second.name, undefined, { numeric: true });
    }
    else
    {
      result = wasNodeTime(first) - wasNodeTime(second);
    }
    // Ties keep the default order (newest first, then name) whichever way the chosen column runs.
    return result * sign || wasNodeTime(second) - wasNodeTime(first) || first.name.localeCompare(second.name) || a.localeCompare(b);
  };
}

function wasBuildView(model, filters, expanded, focusId, sort)
{
  // The model already holds the default order, so only another choice needs sorting.
  var compare = sort && wasParseSort(sort.key + ":" + sort.direction) && !(sort.key === wasDefaultSort.key && sort.direction === wasDefaultSort.direction) ? wasSortComparator(model, sort) : null;
  var matched = new Set();
  var candidates = new Set();
  var included = new Set();
  var forcedExpanded = new Set();
  var rows = [];
  var rowIndex = new Map();
  var activityMode = filters.activity || "recent";
  var activityCounts = { recent: 0, inactive: 0, unconfirmed: 0 };
  var hiddenByActivity = { recent: 0, inactive: 0, unconfirmed: 0 };
  var contextActivity = { recent: 0, inactive: 0, unconfirmed: 0 };
  var hiddenActivityDescendants = new Map();
  var branch = focusId ? wasGetBranch(model, focusId) : null;
  var query = wasText(filters.query).trim().toLocaleLowerCase();
  var queryParts = query.split(/\s+/).filter(Boolean);
  var revealMatches = !!(query || filters.provider || filters.status || filters.kind);
  model.nodes.forEach(function (node)
  {
    if (branch && !branch.has(node.id))
    {
      return;
    }
    if (filters.project && wasText(node.project).toLocaleLowerCase() !== wasText(filters.project).toLocaleLowerCase())
    {
      return;
    }
    if ((filters.provider && node.provider !== filters.provider) || (filters.status && node.status !== filters.status) || (filters.kind && node.kind !== filters.kind))
    {
      return;
    }
    var text = model.searchText.get(node.id);
    if (!queryParts.every(function (part)
    {
      return text.indexOf(part) !== -1;
    }))
    {
      return;
    }
    candidates.add(node.id);
    var category = model.activity.get(node.id).category;
    activityCounts[category] += 1;
    if (activityMode !== "all" && activityMode !== category)
    {
      return;
    }
    matched.add(node.id);
    included.add(node.id);
  });
  matched.forEach(function (id)
  {
    var ancestor = model.parent.get(id);
    while (ancestor && !included.has(ancestor))
    {
      if (branch && !branch.has(ancestor))
      {
        break;
      }
      included.add(ancestor);
      if (revealMatches)
      {
        forcedExpanded.add(ancestor);
      }
      ancestor = model.parent.get(ancestor);
    }
  });
  if (revealMatches)
  {
    included.forEach(function (id)
    {
      var parent = model.parent.get(id);
      if (parent && included.has(parent))
      {
        forcedExpanded.add(parent);
      }
    });
  }
  included.forEach(function (id)
  {
    if (!matched.has(id))
    {
      var category = model.activity.get(id).category;
      contextActivity[category] += 1;
      if (activityMode !== "all" && category !== activityMode)
      {
        forcedExpanded.add(id);
      }
    }
  });
  candidates.forEach(function (id)
  {
    if (!included.has(id))
    {
      hiddenByActivity[model.activity.get(id).category] += 1;
    }
  });
  for (var activityIndex = model.order.length - 1; activityIndex >= 0; activityIndex -= 1)
  {
    var activityId = model.order[activityIndex];
    var hiddenCount = 0;
    model.children.get(activityId).forEach(function (child)
    {
      hiddenCount += hiddenActivityDescendants.get(child) || 0;
      if (candidates.has(child) && !included.has(child))
      {
        hiddenCount += 1;
      }
    });
    hiddenActivityDescendants.set(activityId, hiddenCount);
  }
  var roots = focusId && included.has(focusId) ? [focusId] : model.roots.filter(function (id)
  {
    return included.has(id);
  });
  if (compare)
  {
    roots.sort(compare);
  }
  var stack = [];
  for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex -= 1)
  {
    stack.push({ id: roots[rootIndex], depth: 0, position: rootIndex + 1, size: roots.length });
  }
  while (stack.length)
  {
    var item = stack.pop();
    var children = model.children.get(item.id).filter(function (id)
    {
      return included.has(id);
    });
    if (compare)
    {
      children.sort(compare);
    }
    item.children = children;
    item.expanded = (expanded.has(item.id) || forcedExpanded.has(item.id)) && children.length > 0;
    item.context = !matched.has(item.id);
    rowIndex.set(item.id, rows.length);
    rows.push(item);
    if (item.expanded)
    {
      for (var index = children.length - 1; index >= 0; index -= 1)
      {
        stack.push({ id: children[index], depth: item.depth + 1, position: index + 1, size: children.length });
      }
    }
  }
  return { matched: matched, included: included, forcedExpanded: forcedExpanded, rows: rows, rowIndex: rowIndex, roots: roots, activityMode: activityMode, activityCounts: activityCounts, hiddenByActivity: hiddenByActivity, contextActivity: contextActivity, hiddenActivityDescendants: hiddenActivityDescendants };
}

function wasFormatNumber(value)
{
  return typeof WasI18n === "undefined" ? Number(value || 0).toLocaleString("en-US") : WasI18n.formatNumber(value);
}

function wasFormatBytes(value)
{
  var number = Number(value) || 0;
  if (number < 1024)
  {
    return wasFormatNumber(number) + " B";
  }
  if (number < 1024 * 1024)
  {
    return (number / 1024).toFixed(1) + " KB";
  }
  return (number / (1024 * 1024)).toFixed(1) + " MB";
}

function wasRelativeTime(value)
{
  var time = new Date(value).getTime();
  if (!Number.isFinite(time))
  {
    return wasT("app.common.noRecord");
  }
  var seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60)
  {
    return wasT("app.time.justNow");
  }
  if (seconds < 3600)
  {
    return wasT("app.time.minutesAgo", { count: Math.floor(seconds / 60) });
  }
  if (seconds < 86400)
  {
    return wasT("app.time.hoursAgo", { count: Math.floor(seconds / 3600) });
  }
  return wasT("app.time.daysAgo", { count: Math.floor(seconds / 86400) });
}

function wasDateTime(value)
{
  var date = new Date(value);
  if (!Number.isFinite(date.getTime()))
  {
    return wasT("app.common.noRecord");
  }
  return typeof WasI18n === "undefined" ? date.toLocaleString("en-US", { hour12: false }) : WasI18n.formatDateTime(date);
}

function wasReadFilters()
{
  return {
    query: wasElements.search.value,
    project: wasElements.project.value,
    provider: wasElements.provider.value,
    activity: wasElements.activity.value,
    status: wasElements.status.value,
    kind: wasElements.kind.value
  };
}

function wasSavePreferences()
{
  if (wasState.presentation)
  {
    return;
  }
  try
  {
    sessionStorage.setItem("was_observatory_preferences", JSON.stringify({ filters: wasReadFilters(), view: wasState.viewMode, edgeScope: wasElements.edgeScope.value, graphLayout: wasElements.graphLayout.value, showQuiet: wasElements.showQuiet.checked, officeFloorId: wasState.officeFloorId, officeGrouped: wasElements.officeGrouped.checked, officeOrder: wasElements.officeOrder.value, officeQuiet: wasElements.officeQuiet.checked, sort: wasSortValue() }));
  }
  catch (error)
  {
    // Browsers may disable local storage for local/private sessions.
  }
}

function wasRestorePreferences()
{
  try
  {
    var preference = JSON.parse(sessionStorage.getItem("was_observatory_preferences") || "null");
    if (!preference)
    {
      return;
    }
    var filters = preference.filters || {};
    ["query", "project", "provider", "activity", "status", "kind"].forEach(function (name)
    {
      if (typeof filters[name] === "string")
      {
        wasState.savedFilters[name] = filters[name];
      }
    });
    wasElements.search.value = filters.query || "";
    wasElements.status.value = filters.status || "";
    wasElements.kind.value = filters.kind || "";
    wasElements.activity.value = ["recent", "inactive", "unconfirmed", "all"].indexOf(filters.activity) !== -1 ? filters.activity : "recent";
    wasElements.edgeScope.value = preference.edgeScope === "selected" ? "selected" : "all";
    wasState.viewMode = ["spatial", "office3d"].indexOf(preference.view) !== -1 ? "office" : ["graph", "office"].indexOf(preference.view) !== -1 ? preference.view : "tree";
    wasElements.graphLayout.value = preference.graphLayout === "native" ? "native" : "operating";
    wasElements.showQuiet.checked = preference.showQuiet !== false;
    wasState.officeFloorId = typeof preference.officeFloorId === "string" ? preference.officeFloorId : null;
    wasElements.officeGrouped.checked = preference.officeGrouped !== false;
    wasElements.officeOrder.value = wasOfficeOrders.indexOf(preference.officeOrder) !== -1 ? preference.officeOrder : "group";
    wasElements.officeQuiet.checked = preference.officeQuiet !== false;
    wasState.sort = wasParseSort(preference.sort) || wasState.sort;
  }
  catch (error)
  {
    // A malformed preference must not prevent loading live data.
  }
}

function wasUpdateOptions(element, values, allLabel, pendingValue)
{
  var previous = typeof pendingValue === "string" ? pendingValue : element.value;
  var unique = new Set(values.filter(Boolean));
  if (previous)
  {
    unique.add(previous);
  }
  wasClearElement(element);
  var option = wasCreateElement("option", "", allLabel);
  option.value = "";
  element.appendChild(option);
  Array.from(unique).sort(function (a, b)
  {
    return a.localeCompare(b);
  }).forEach(function (value)
  {
    var item = wasCreateElement("option", "", value);
    item.value = value;
    element.appendChild(item);
  });
  element.value = previous;
}

function wasRefreshFilterOptions()
{
  wasUpdateOptions(wasElements.project, wasState.model.nodes.map(function (node)
  {
    return wasText(node.project);
  }), wasT("app.filter.allProjects"), wasState.savedFilters.project);
  wasUpdateOptions(wasElements.provider, wasState.model.nodes.map(function (node)
  {
    return node.provider;
  }), wasT("app.filter.allProviders"), wasState.savedFilters.provider);
}

function wasUpdateSnapshot(snapshot)
{
  if (wasState.snapshot && snapshot.version === wasState.snapshot.version && !wasState.loadError)
  {
    wasState.lastSuccess = Date.now();
    wasRenderHealth();
    return;
  }
  var resetMessages = !!(wasState.snapshot && Number(snapshot.version) < Number(wasState.snapshot.version));
  // The raw snapshot may carry message tokens; the model and every page text use its rendering in the current language.
  wasState.rawSnapshot = snapshot;
  wasState.snapshot = wasResolveSnapshot(snapshot);
  wasState.model = wasBuildModel(wasState.snapshot);
  var observation = wasObserveMessages(wasState.messageState, wasState.model.edges, Date.now(), { loading: !!(snapshot.stats && snapshot.stats.loading), reset: resetMessages });
  wasState.messageState = observation.state;
  wasState.messageSummary = wasSummarizeMessages(wasState.model.edges);
  if (observation.fresh.length && !document.hidden && !wasState.reducedMotion.matches)
  {
    wasState.flowPulses = wasState.flowPulses.concat(observation.fresh.slice(-24).map(function (entry)
    {
      return { edge: entry.edge, startedAt: Date.now(), replay: false };
    })).slice(-24);
  }
  wasRefreshFilterOptions();
  wasState.savedFilters = {};
  if (wasState.selectedId && !wasState.model.nodeMap.has(wasState.selectedId))
  {
    wasState.selectedId = null;
  }
  if (wasState.focusId && !wasState.model.nodeMap.has(wasState.focusId))
  {
    wasState.focusId = null;
  }
  wasState.lastSuccess = Date.now();
  wasState.loadError = null;
  wasUpdateView(false);
  if (wasState.viewMode === "office" && wasState.officeScene && observation.fresh.length)
  {
    wasState.officeScene.observe(wasOfficeDeliveryEdges(observation.fresh.map(function (entry) { return entry.edge; })), { replay: false, observedAt: Date.now() });
  }
  wasRenderHealth();
  wasRenderDiagnostics();
}

function wasUpdateView(resetScroll)
{
  if (!wasState.model)
  {
    return;
  }
  var filters = wasReadFilters();
  wasState.view = wasBuildView(wasState.model, filters, wasState.expanded, wasState.focusId, wasState.sort);
  if (resetScroll)
  {
    wasElements.tree.scrollTop = 0;
  }
  if (!wasState.view.rowIndex.has(wasState.activeId))
  {
    wasState.activeId = wasState.view.rows.length ? wasState.view.rows[0].id : null;
  }
  wasElements.projectLabel.textContent = filters.project || wasT("app.project.all");
  var counts = { running: 0, waiting: 0, attention: 0 };
  wasState.view.matched.forEach(function (id)
  {
    var node = wasState.model.nodeMap.get(id);
    if (node.status === "running")
    {
      counts.running += 1;
    }
    if (node.status === "waiting")
    {
      counts.waiting += 1;
    }
    if (node.kind === "unresolved" || node.status === "unknown" || node.conflicts.length || wasState.model.nodeIssues.get(id).length)
    {
      counts.attention += 1;
    }
  });
  wasElements.statTotal.textContent = wasFormatNumber(wasState.view.matched.size);
  var matchedRecent = 0;
  wasState.view.matched.forEach(function (id)
  {
    if (wasState.model.activity.get(id).category === "recent")
    {
      matchedRecent += 1;
    }
  });
  wasElements.statTotalNote.textContent = wasT("app.stat.totalNote", { recent: wasFormatNumber(matchedRecent), total: wasFormatNumber(wasState.model.nodes.length) });
  wasElements.statTotalNote.title = wasT("app.stat.totalNoteTitle");
  wasElements.statRunning.textContent = wasFormatNumber(counts.running);
  wasElements.statWaiting.textContent = wasFormatNumber(counts.waiting);
  wasElements.statAttention.textContent = wasFormatNumber(counts.attention);
  wasRenderViewScope();
  var excluded = wasState.view.hiddenByActivity;
  var contextPast = wasState.view.contextActivity.inactive + wasState.view.contextActivity.unconfirmed;
  var scopeParts = [wasT("app.scope.summary", { scope: wasKnownLabel("app.activity", filters.activity) || wasT("app.activity.recent"), recent: wasFormatNumber(excluded.recent), inactive: wasFormatNumber(excluded.inactive), unconfirmed: wasFormatNumber(excluded.unconfirmed) })];
  if (contextPast)
  {
    scopeParts.push(wasT("app.scope.contextParents", { count: contextPast }));
  }
  scopeParts.push(wasT("app.scope.disclaimer"));
  wasElements.activitySummary.textContent = scopeParts.join(" · ");
  wasElements.clearFocus.hidden = !wasState.focusId;
  if (wasState.focusId)
  {
    wasElements.clearFocus.textContent = wasT("app.focus.clear", { name: wasState.model.nodeMap.get(wasState.focusId).name });
  }
  wasElements.focusBranch.disabled = !wasState.selectedId;
  wasElements.empty.hidden = wasState.view.rows.length > 0;
  wasElements.emptyTitle.textContent = wasState.model.nodes.length ? wasT("app.empty.noMatchTitle") : wasT("app.empty.noSessionsTitle");
  wasElements.emptyText.textContent = wasState.model.nodes.length ? wasT("app.empty.noMatchText") : wasT("app.empty.noSessionsText");
  wasElements.treeSpacer.style.height = (wasState.view.rows.length * wasState.rowHeight) + "px";
  wasRenderTree();
  wasBuildGraph();
  wasRenderMessageFeed();
  if (wasState.viewMode === "office")
  {
    wasUpdateOffice();
  }
  wasRenderDetails();
  wasRenderOverview();
  wasSavePreferences();
}

function wasRenderViewScope()
{
  if (!wasState.view) return;
  if (wasState.viewMode === "office" && wasState.officeData)
  {
    var office = wasState.officeData;
    wasElements.resultCount.textContent = wasT("app.scope.shownSessions", { count: office.actors.length }) + " · " + wasT("app.scope.floorCount", { count: wasState.officeFloors.length });
    wasElements.searchContext.textContent = office.stats.context ? wasT("app.scope.relationContext", { count: office.stats.context }) : "";
    return;
  }
  var hidden = wasState.view.included.size - wasState.view.rows.length;
  var scopeCounts = [wasT("app.scope.matched", { count: wasState.view.matched.size }), wasT("app.scope.shownRows", { count: wasState.view.rows.length })];
  if (hidden)
  {
    scopeCounts.push(wasT("app.scope.collapsedRows", { count: hidden }));
  }
  wasElements.resultCount.textContent = scopeCounts.join(" · ");
  var contextCount = wasState.view.included.size - wasState.view.matched.size;
  wasElements.searchContext.textContent = contextCount ? wasT("app.scope.ancestorContext", { count: contextCount }) : "";
}

function wasEnsureOffice()
{
  if (wasState.officeScene || typeof WasOfficeScene === "undefined" || typeof WasOfficeModel === "undefined")
  {
    return !!wasState.officeScene;
  }
  wasState.officeScene = WasOfficeScene.create({
    container: wasElements.officeStage,
    onSelect: function (id, info)
    {
      var detailOpen = !wasState.presentation || document.body.classList.contains("was-presentation-detail-open");
      if (info && info.again && wasState.selectedId === id && detailOpen)
      {
        wasCloseDetail();
        return;
      }
      wasSelectNode(id, false, false);
      if (wasState.presentation)
      {
        document.body.classList.add("was-presentation-detail-open");
        wasElements.presentationDetail.setAttribute("aria-expanded", "true");
      }
    },
    onDeselect: function ()
    {
      if (wasState.selectedId || wasState.selectedPairId)
      {
        wasCloseDetail();
      }
    },
    onFloorChange: function (id)
    {
      wasState.officeFloorId = id;
      wasRenderOfficeFloor();
    },
    onTravel: function (info)
    {
      if (info && info.text)
      {
        wasSetOfficeTravel("scene", info);
      }
    }
  });
  wasState.officeSceneSignature = null;
  wasState.officePartnersSignature = null;
  wasState.officeScene.setMode("2d");
  return true;
}

/* The line under the stage follows the last travel state, so it can be rendered again when the language changes. */
function wasSetOfficeTravel(kind, info)
{
  wasState.officeTravel = { kind: kind, info: info || null, noticeKey: kind === "scene" && info && !info.illustrative ? wasFindNoticeKey(info.text) : "" };
  wasRenderOfficeTravel();
}

/* A stage notice (graphics failure) arrives already localized; its catalog key is remembered so the line can follow a language change. */
function wasFindNoticeKey(text)
{
  if (typeof WasI18n === "undefined")
  {
    return "";
  }
  var catalog = WasI18n.catalogs[WasI18n.getLocale()] || {};
  return Object.keys(catalog).filter(function (key) { return key.indexOf("scene.fallback.") === 0 && catalog[key] === text; })[0] || "";
}

/* The line under the stage only speaks when there is something to say: a skipped animation, a call in progress or a graphics notice. */
function wasRenderOfficeTravel()
{
  var travel = wasState.officeTravel || { kind: "note", info: null };
  var text = "";
  if (travel.kind === "reduced")
  {
    text = wasT("app.travel.reducedMotion");
  }
  else if (travel.kind === "scene" && travel.info)
  {
    text = !travel.info.illustrative ? (travel.noticeKey ? wasT(travel.noticeKey) : travel.info.text) : travel.info.phase === "done" ? "" : travel.info.text;
  }
  wasElements.officeTravel.textContent = text;
  wasElements.officeTravel.classList.toggle("was-travel-idle", !text);
}

function wasResizeOfficeAfterLayout(fit)
{
  if (!wasState.officeScene) return;
  if (wasState.officeResizeFrame !== null) cancelAnimationFrame(wasState.officeResizeFrame);
  var scene = wasState.officeScene;
  var presentation = wasState.presentation;
  wasState.officeResizeFrame = requestAnimationFrame(function ()
  {
    wasState.officeResizeFrame = requestAnimationFrame(function ()
    {
      wasState.officeResizeFrame = null;
      if (wasState.officeScene !== scene || wasState.viewMode !== "office" || wasState.presentation !== presentation || document.hidden) return;
      scene.resize();
      if (fit) scene.fit();
    });
  });
}

function wasDestroyOffice()
{
  if (wasState.officeResizeFrame !== null) cancelAnimationFrame(wasState.officeResizeFrame);
  wasState.officeResizeFrame = null;
  wasStopReplay();
  if (wasState.officeScene) wasState.officeScene.destroy();
  wasState.officeScene = null;
}

function wasUpdateOffice()
{
  if (!wasState.model || !wasEnsureOffice())
  {
    return;
  }
  var filters = wasReadFilters();
  var nodes = wasState.model.nodes;
  var edges = wasState.model.edges;
  if (wasState.focusId)
  {
    var branch = wasGetBranch(wasState.model, wasState.focusId);
    nodes = nodes.filter(function (node) { return branch.has(node.id); });
    edges = edges.filter(function (edge) { return branch.has(edge.from) && branch.has(edge.to); });
  }
  wasState.officeData = WasOfficeModel.buildOffice({ nodes: nodes, edges: edges }, Object.assign({}, filters, {
    groupFloors: wasElements.officeGrouped.checked,
    order: wasElements.officeOrder.value,
    showQuiet: wasElements.officeQuiet.checked,
    selectedId: wasState.selectedId
  }));
  wasState.officeData.edges = wasOfficeDeliveryEdges(edges);
  wasState.officeFloors = wasState.officeData.floors.filter(function (floor) { return floor.nodeIds.length > 0; });
  if (!wasState.officeFloors.some(function (floor) { return floor.id === wasState.officeFloorId; }))
  {
    wasState.officeFloorId = wasState.officeFloors.length ? wasState.officeFloors[0].id : null;
  }
  // Floor names may be message tokens; the key includes the language so the select is rebuilt when it changes.
  var floorOptionsKey = JSON.stringify([wasLocale(), wasState.officeFloors.map(function (floor) { return [floor.id, floor.name, floor.nodeIds.length]; })]);
  if (wasState.officeFloorOptionsKey !== floorOptionsKey)
  {
    wasState.officeFloorOptionsKey = floorOptionsKey;
    wasClearElement(wasElements.officeFloor);
    // Listed from the top floor down, like the floors of a building. The data order, and with it the up and
    // down buttons, still runs from 1F upward.
    for (var floorIndex = wasState.officeFloors.length - 1; floorIndex >= 0; floorIndex--)
    {
      var floor = wasState.officeFloors[floorIndex];
      var option = wasCreateElement("option", "", (floorIndex + 1) + "F · " + wasResolveText(floor.name) + " (" + floor.nodeIds.length + ")");
      option.value = floor.id;
      wasElements.officeFloor.appendChild(option);
    }
  }
  var sceneData = Object.assign({}, wasState.officeData, {
    floors: wasState.officeFloors,
    floorById: new Map(wasState.officeFloors.map(function (floor) { return [floor.id, floor]; }))
  });
  var sceneSignature = JSON.stringify({ project: sceneData.project, floors: sceneData.floors, actors: sceneData.actors, edges: sceneData.edges });
  if (wasState.officeSceneSignature !== sceneSignature)
  {
    wasState.officeSceneSignature = sceneSignature;
    wasState.officeScene.setOffice(sceneData);
  }
  if (wasState.officeFloorId && wasState.officeScene.getState().floorId !== wasState.officeFloorId)
  {
    wasState.officeScene.setFloor(wasState.officeFloorId, { animate: false });
  }
  wasState.officeScene.setVisible(wasState.viewMode === "office" && !document.hidden);
  wasState.officeScene.setMotion(!wasState.reducedMotion.matches && !document.hidden);
  wasRenderOfficeFloor();
  wasElements.empty.hidden = wasState.officeData.actors.length > 0;
  wasRenderOfficePartners();
  wasRenderViewScope();
  wasAutoReplayOffice();
}

function wasOfficeDeliveryEdges(edges)
{
  if (!wasState.officeData) return [];
  var enabled = new Set();
  wasElements.relationFilters.querySelectorAll("input:checked").forEach(function (input) { enabled.add(input.value); });
  return (edges || []).filter(function (edge)
  {
    return !!wasMessageId(edge) && wasState.officeData.actorById.has(edge.from) && wasState.officeData.actorById.has(edge.to) && enabled.has(edge.type) &&
      (wasElements.activity.value !== "recent" || !wasGetEdgeHistory(edge));
  });
}

function wasOfficeMessageTime(edge)
{
  var message = edge.message || {};
  return Date.parse(edge.lastSeen || message.finishedAt || message.acceptedAt || message.createdAt || "") || 0;
}

/* For every actor: the sessions it exchanged recorded messages with, most recent first, as the card data shown beside its nameplate. */
function wasOfficePartnerMap()
{
  var pairs = new Map();
  wasUniqueMessages(wasState.officeData.edges || []).forEach(function (edge)
  {
    if (edge.from === edge.to)
    {
      return;
    }
    [[edge.from, edge.to], [edge.to, edge.from]].forEach(function (side)
    {
      if (!pairs.has(side[0]))
      {
        pairs.set(side[0], new Map());
      }
      var partners = pairs.get(side[0]);
      if (!partners.has(side[1]))
      {
        partners.set(side[1], { id: side[1], unresolved: 0, lastTime: 0 });
      }
      var partner = partners.get(side[1]);
      partner.unresolved += Number(!wasMessageResolved(edge));
      partner.lastTime = Math.max(partner.lastTime, wasOfficeMessageTime(edge));
    });
  });
  var cards = {};
  pairs.forEach(function (partners, id)
  {
    cards[id] = Array.from(partners.values()).sort(function (first, second)
    {
      return second.lastTime - first.lastTime || wasState.model.nodeMap.get(first.id).name.localeCompare(wasState.model.nodeMap.get(second.id).name);
    }).map(function (partner)
    {
      var node = wasState.model.nodeMap.get(partner.id);
      var meta = [partner.lastTime ? wasRelativeTime(partner.lastTime) : wasT("app.partner.timeUnknown")];
      if (partner.unresolved)
      {
        meta.push(wasT("app.partner.unresolved", { count: partner.unresolved }));
      }
      return { id: partner.id, name: node.name, status: wasSafeStatus(node.status), meta: meta.join(" · "), lastTime: partner.lastTime };
    });
  });
  return cards;
}

/* Hands the stage the counterpart cards; they are drawn to the right of each character's nameplate. */
function wasRenderOfficePartners()
{
  if (wasState.viewMode !== "office" || !wasState.officeData || !wasState.officeScene)
  {
    return;
  }
  var cards = wasOfficePartnerMap();
  var signature = JSON.stringify(cards);
  if (wasState.officePartnersSignature === signature)
  {
    return;
  }
  wasState.officePartnersSignature = signature;
  wasState.officeScene.setPartners(cards);
}

function wasRenderOfficeFloor()
{
  if (!wasState.officeData)
  {
    return;
  }
  var index = wasState.officeFloors.findIndex(function (floor) { return floor.id === wasState.officeFloorId; });
  wasElements.officeFloor.value = wasState.officeFloorId || "";
  wasElements.officeDown.disabled = index <= 0;
  wasElements.officeUp.disabled = index < 0 || index >= wasState.officeFloors.length - 1;
  wasElements.officeFloor.disabled = !wasState.officeFloors.length;
  var floor = wasState.officeData.floorById.get(wasState.officeFloorId);
  var stats = wasState.officeData.stats;
  wasElements.officeSummary.textContent = wasT("app.office.summary", { count: floor ? floor.nodeIds.length : 0, matched: stats.matched, context: stats.context, hidden: stats.hidden, floors: wasState.officeFloors.length, floorsTotal: wasState.officeData.floors.length });
}

function wasChooseOfficeFloor(id, animate)
{
  if (!wasState.officeScene || !wasState.officeData.floorById.has(id))
  {
    return;
  }
  wasState.officeFloorId = id;
  wasState.officeScene.setFloor(id, { animate: animate !== false });
  wasRenderOfficeFloor();
  wasSavePreferences();
}

function wasProviderSymbol(node)
{
  if (node.kind === "unresolved")
  {
    return "?";
  }
  if (node.provider.toLowerCase().indexOf("codex") !== -1)
  {
    return "C";
  }
  if (node.provider.toLowerCase().indexOf("claude") !== -1)
  {
    return "✳";
  }
  return node.provider.slice(0, 1).toUpperCase() || "·";
}

function wasProviderClass(node)
{
  var name = String(node.provider || "").toLowerCase();
  return (name.indexOf("codex") !== -1 ? " was-provider-codex" : "") + (name.indexOf("claude") !== -1 ? " was-provider-claude" : "") + (node.kind === "unresolved" ? " was-provider-unresolved" : "");
}

function wasRenderTree()
{
  // Only the visible view is rendered; wasSetView renders the list when the user switches to it.
  if (!wasState.view || wasState.viewMode !== "tree")
  {
    return;
  }
  var rows = wasState.view.rows;
  var start = Math.max(0, Math.floor(wasElements.tree.scrollTop / wasState.rowHeight) - 8);
  var end = Math.min(rows.length, Math.ceil((wasElements.tree.scrollTop + (wasElements.tree.clientHeight || 500)) / wasState.rowHeight) + 8);
  var fragment = document.createDocumentFragment();
  for (var index = start; index < end; index += 1)
  {
    var item = rows[index];
    var node = wasState.model.nodeMap.get(item.id);
    var activity = wasState.model.activity.get(item.id);
    var pastContext = item.context && activity.category !== "recent";
    var row = wasCreateElement("div", "was-tree-row" + (item.id === wasState.selectedId ? " was-selected" : "") + (item.context ? " was-context" : "") + (pastContext ? " was-past-context" : ""));
    row.id = "was-row-" + index;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", item.depth + 1);
    row.setAttribute("aria-posinset", item.position);
    row.setAttribute("aria-setsize", item.size);
    row.setAttribute("aria-selected", item.id === wasState.selectedId ? "true" : "false");
    row.setAttribute("data-was-node-id", item.id);
    row.setAttribute("aria-label", [node.name, wasStatusName(node.status), pastContext ? wasT("app.tree.activityContext", { activity: wasActivityName(activity.category) }) : wasActivityName(activity.category), wasT("app.tree.descendantCount", { count: wasState.model.descendants.get(item.id) })].join(", "));
    if (item.children.length)
    {
      row.setAttribute("aria-expanded", item.expanded ? "true" : "false");
    }
    row.style.transform = "translateY(" + (index * wasState.rowHeight) + "px)";
    var nodeCell = wasCreateElement("div", "was-tree-node");
    nodeCell.style.paddingLeft = (Math.min(item.depth, 12) * 15) + "px";
    var expander = wasCreateElement("button", "was-tree-expander" + (item.expanded ? " was-expanded" : ""), item.expanded ? "▾" : "▸");
    expander.type = "button";
    expander.tabIndex = -1;
    expander.disabled = !item.children.length;
    expander.setAttribute("data-was-action", "toggle");
    expander.setAttribute("aria-label", item.expanded ? wasT("app.tree.collapseChildren") : wasT("app.tree.expandChildren"));
    nodeCell.appendChild(expander);
    var provider = wasCreateElement("span", "was-provider-icon" + wasProviderClass(node), wasProviderSymbol(node));
    provider.setAttribute("aria-hidden", "true");
    nodeCell.appendChild(provider);
    var content = wasCreateElement("div", "was-row-content");
    var title = wasCreateElement("div", "was-row-title");
    var name = wasCreateElement("span", "was-row-name", node.name);
    name.title = node.name;
    title.appendChild(name);
    if (activity.category !== "recent")
    {
      var activityBadge = wasCreateElement("span", "was-activity-badge" + (activity.category === "unconfirmed" ? " was-unconfirmed" : ""), wasActivityBadgeText(activity.category, item.context));
      activityBadge.title = activity.reason;
      title.appendChild(activityBadge);
    }
    var descendants = wasState.model.descendants.get(item.id);
    if (descendants)
    {
      var badge = wasCreateElement("span", "was-row-count", wasFormatNumber(descendants));
      badge.title = wasT("app.tree.descendantTotal", { count: descendants });
      title.appendChild(badge);
    }
    if (item.depth > 12)
    {
      title.appendChild(wasCreateElement("span", "was-depth", wasT("app.tree.depth", { depth: item.depth })));
    }
    if (node.conflicts.length || wasState.model.nodeIssues.get(item.id).length)
    {
      var warning = wasCreateElement("span", "was-conflict-mark", "⚠");
      warning.title = wasT("app.tree.conflictTitle");
      title.appendChild(warning);
    }
    content.appendChild(title);
    var hiddenActivity = wasState.view.hiddenActivityDescendants.get(item.id) || 0;
    var subtitle = (hiddenActivity ? wasT("app.tree.hiddenByScope", { count: hiddenActivity }) + " · " : "") + wasText(node.description || node.statusEvidence || node.cwd || node.sessionId || node.provider);
    var description = wasCreateElement("div", "was-row-description", subtitle);
    description.title = subtitle;
    content.appendChild(description);
    nodeCell.appendChild(content);
    row.appendChild(nodeCell);
    var status = wasCreateElement("div", "was-row-status");
    status.appendChild(wasCreateElement("i", "was-status-dot was-status-" + wasSafeStatus(node.status)));
    status.appendChild(wasCreateElement("span", "", wasStatusName(node.status)));
    row.appendChild(status);
    var time = wasCreateElement("div", "was-row-time", wasRelativeTime(node.lastSeen));
    time.title = wasDateTime(node.lastSeen);
    row.appendChild(time);
    fragment.appendChild(row);
  }
  wasClearElement(wasElements.treeRows);
  wasElements.treeRows.appendChild(fragment);
  var activeIndex = wasState.view.rowIndex.get(wasState.activeId);
  if (typeof activeIndex === "number" && activeIndex >= start && activeIndex < end)
  {
    wasElements.tree.setAttribute("aria-activedescendant", "was-row-" + activeIndex);
  }
  else
  {
    wasElements.tree.removeAttribute("aria-activedescendant");
  }
}

function wasActivityBadgeText(category, context)
{
  if (category === "inactive")
  {
    return context ? wasT("app.tree.badgePastContext") : wasT("app.tree.badgePast");
  }
  return context ? wasT("app.tree.badgeUnknownContext") : wasT("app.tree.badgeUnknown");
}

function wasSafeStatus(status)
{
  return wasKnownStatuses.indexOf(status) !== -1 ? status : "unknown";
}

/* Routes depend on a selection only through the "selected node" connection scope; otherwise a redraw is enough. */
function wasRefreshGraphSelection(hadPair)
{
  if (wasElements.edgeScope.value === "selected")
  {
    wasUpdateGraphEdges();
  }
  else if (hadPair)
  {
    wasRenderConnectionList();
  }
  wasRequestGraphDraw();
}

function wasSelectNode(id, reveal, moveCamera)
{
  var hadPair = !!wasState.selectedPairId;
  wasState.selectedPairId = null;
  if (!wasState.model || !wasState.model.nodeMap.has(id))
  {
    return;
  }
  var changed = wasState.selectedId !== id;
  wasState.selectedId = id;
  wasState.activeId = id;
  wasState.detailLimit = 20;
  if (changed)
  {
    wasElements.detail.scrollTop = 0;
    wasState.detailRelationType = "";
  }
  if (reveal)
  {
    wasStopReplay();
    var parent = wasState.model.parent.get(id);
    while (parent)
    {
      wasState.expanded.add(parent);
      parent = wasState.model.parent.get(parent);
    }
    if (!wasState.view.included.has(id))
    {
      wasElements.search.value = "";
      wasElements.project.value = "";
      wasElements.provider.value = "";
      wasElements.activity.value = "all";
      wasElements.status.value = "";
      wasElements.kind.value = "";
      wasState.focusId = null;
    }
    wasUpdateView(false);
  }
  else
  {
    wasRenderTree();
    wasRenderDetails();
    wasElements.focusBranch.disabled = false;
    wasRefreshGraphSelection(hadPair);
  }
  if (reveal)
  {
    wasScrollToNode(id);
  }
  if (moveCamera)
  {
    wasCenterNode(id);
  }
  wasElements.announcement.textContent = wasT("app.announce.selected", { name: wasState.model.nodeMap.get(id).name });
  if (wasState.viewMode === "office" && wasState.officeScene && wasState.officeData.actorById.has(id))
  {
    wasState.officeScene.select(id, { focus: !!moveCamera });
    wasRenderOfficeFloor();
  }
}

/* Clicking an already selected session closes its detail: the side panel returns to its empty state and the wide-view overlay hides. */
function wasCloseDetail()
{
  var hadPair = !!wasState.selectedPairId;
  wasState.selectedPairId = null;
  wasState.selectedId = null;
  wasElements.focusBranch.disabled = true;
  document.body.classList.remove("was-presentation-detail-open");
  wasElements.presentationDetail.setAttribute("aria-expanded", "false");
  if (wasState.officeScene)
  {
    wasState.officeScene.select(null);
  }
  wasRenderTree();
  wasRenderDetails();
  wasRefreshGraphSelection(hadPair);
  wasElements.announcement.textContent = wasT("app.announce.detailClosed");
}

function wasScrollToNode(id)
{
  var index = wasState.view.rowIndex.get(id);
  if (typeof index !== "number")
  {
    return;
  }
  var top = index * wasState.rowHeight;
  if (top < wasElements.tree.scrollTop)
  {
    wasElements.tree.scrollTop = top;
  }
  else if (top + wasState.rowHeight > wasElements.tree.scrollTop + wasElements.tree.clientHeight)
  {
    wasElements.tree.scrollTop = top + wasState.rowHeight - wasElements.tree.clientHeight;
  }
  wasRenderTree();
}

function wasToggleNode(id)
{
  if (wasState.expanded.has(id))
  {
    wasState.expanded.delete(id);
  }
  else
  {
    wasState.expanded.add(id);
  }
  if (wasState.view.forcedExpanded.has(id))
  {
    wasElements.announcement.textContent = wasT("app.announce.forcedExpanded");
  }
  wasUpdateView(false);
}

function wasAppendDetailField(list, label, value)
{
  list.appendChild(wasCreateElement("dt", "", label));
  list.appendChild(wasCreateElement("dd", "", value || wasT("app.common.noRecord")));
}

function wasDetailSection(title)
{
  var section = wasCreateElement("section", "was-detail-section");
  section.appendChild(wasCreateElement("h3", "", title));
  return section;
}

function wasSourceText(source)
{
  if (!source)
  {
    return wasT("app.source.none");
  }
  if (typeof source === "string")
  {
    return source;
  }
  return [source.kind, source.path, source.detail].map(wasText).filter(Boolean).join("\n");
}

function wasAdditionalSources(edge)
{
  var seen = new Set([wasSourceText(edge.source), wasSourceText(edge.evidence)]);
  return (Array.isArray(edge.sources) ? edge.sources : []).filter(function (source)
  {
    var text = wasSourceText(source);
    if (seen.has(text))
    {
      return false;
    }
    seen.add(text);
    return true;
  });
}

function wasRenderConnectionList()
{
  wasClearElement(wasElements.connectionList);
  wasElements.connectionSummary.textContent = wasT("app.connection.summary", { count: wasState.graphEdges.length });
  wasState.graphEdges.forEach(function (pair)
  {
    var from = wasState.model.nodeMap.get(pair.from);
    var to = wasState.model.nodeMap.get(pair.to);
    var button = wasCreateElement("button", "was-connection-item", from.name + " ↔ " + to.name);
    button.type = "button";
    button.setAttribute("data-was-pair-id", pair.id);
    button.setAttribute("aria-pressed", pair.id === wasState.selectedPairId ? "true" : "false");
    button.appendChild(wasCreateElement("span", "", wasConnectionLabel(pair)));
    wasElements.connectionList.appendChild(button);
  });
}

function wasSelectConnection(id)
{
  if (!wasState.graphRoutes.has(id))
  {
    return;
  }
  wasState.selectedPairId = id;
  wasState.detailLimit = 20;
  wasElements.detail.scrollTop = 0;
  wasRenderDetails();
  wasRenderConnectionList();
  if (wasState.presentation)
  {
    document.body.classList.add("was-presentation-detail-open");
    wasElements.presentationDetail.setAttribute("aria-expanded", "true");
  }
  wasRequestGraphDraw();
  wasElements.announcement.textContent = wasT("app.announce.connectionSelected");
}

/* An X in the panel's top-right corner closes the detail from any view; it stays in reach while the panel scrolls. */
function wasCreateDetailClose()
{
  var button = wasCreateElement("button", "was-detail-close", "");
  button.type = "button";
  button.setAttribute("data-was-action", "close-detail");
  button.setAttribute("aria-label", wasT("app.detail.close"));
  button.title = wasT("app.detail.close");
  return button;
}

function wasRenderConnectionDetails(pair)
{
  pair = pair || wasState.graphEdges.find(function (entry) { return entry.id === wasState.selectedPairId; });
  if (!pair)
  {
    wasState.selectedPairId = null;
    wasRenderDetails();
    return;
  }
  var scrollTop = wasElements.detail.scrollTop;
  wasClearElement(wasElements.detail);
  wasElements.detail.appendChild(wasCreateDetailClose());
  wasElements.detail.appendChild(wasCreateElement("div", "was-detail-eyebrow", wasT("app.connection.eyebrow", { count: pair.edges.length })));
  var from = wasState.model.nodeMap.get(pair.from);
  var to = wasState.model.nodeMap.get(pair.to);
  wasElements.detail.appendChild(wasCreateElement("h2", "", from.name + " ↔ " + to.name));
  wasElements.detail.appendChild(wasCreateElement("p", "was-evidence", wasConnectionLabel(pair)));
  [[pair.forward, from, to], [pair.reverse, to, from]].forEach(function (entry)
  {
    var direction = entry[0];
    if (!direction.edges.length)
    {
      return;
    }
    var section = wasDetailSection(entry[1].name + " → " + entry[2].name);
    var requestCount = direction.messages.filter(function (edge) { return edge.message && edge.message.kind === "request"; }).length;
    var replyCount = direction.messages.filter(function (edge) { return edge.message && edge.message.kind === "reply"; }).length;
    section.appendChild(wasCreateElement("p", "was-evidence", wasT("app.connection.directionSummary", { deliveries: direction.messages.length, requests: requestCount, replies: replyCount, others: direction.messages.length - requestCount - replyCount, unresolved: direction.unresolved, closed: direction.messages.length - direction.unresolved, relations: direction.edges.length })));
    wasElements.detail.appendChild(section);
  });
  var confidence = pair.confidenceCounts;
  wasElements.detail.appendChild(wasCreateElement("p", "was-evidence", wasT("app.connection.confidenceSummary", { confirmed: confidence.confirmed, inferred: confidence.inferred, unresolved: confidence.unresolved })));
  if (pair.conflicts.length)
  {
    wasElements.detail.appendChild(wasCreateElement("p", "was-conflict", wasT("app.connection.conflictsHeading") + "\n" + pair.conflicts.map(wasText).join("\n")));
  }
  var records = wasDetailSection(wasT("app.connection.records", { shown: Math.min(wasState.detailLimit, pair.edges.length), total: pair.edges.length }));
  pair.edges.slice(0, wasState.detailLimit).forEach(function (edge)
  {
    var card = wasCreateElement("article", "was-relation-card was-type-" + edge.type);
    card.appendChild(wasCreateElement("div", "was-relation-top", wasTypeName(edge.type) + " · " + (wasConfidenceName(edge.confidence) || wasT("app.confidence.unresolved"))));
    card.appendChild(wasCreateElement("p", "was-evidence", wasState.model.nodeMap.get(edge.from).name + " → " + wasState.model.nodeMap.get(edge.to).name));
    var provenance = [wasT("app.relation.id", { id: edge.id }), wasT("app.relation.status", { status: edge.status || wasT("app.common.noRecord") })];
    if (edge.lastSeen)
    {
      provenance.push(wasT("app.relation.observed", { time: wasDateTime(edge.lastSeen) }));
    }
    if (edge.requestId)
    {
      provenance.push(wasT("app.relation.request", { id: edge.requestId }));
    }
    card.appendChild(wasCreateElement("p", "was-relation-provenance", provenance.join("\n")));
    if (wasMessageId(edge))
    {
      var message = edge.message || {};
      var delivery = [wasMessageKind(edge) + " · " + (wasMessageResolved(edge) ? wasT("app.delivery.closedRecord") : wasT("app.delivery.unresolved")), wasT("app.delivery.id", { id: wasMessageId(edge) }), wasT("app.delivery.outcome", { outcome: message.outcome || "none" })];
      if (message.parentDeliveryId)
      {
        delivery.push(wasT("app.delivery.parentRequest", { id: message.parentDeliveryId }));
      }
      if (message.returnDeliveryId)
      {
        delivery.push(wasT("app.delivery.returnDelivery", { id: message.returnDeliveryId }));
      }
      card.appendChild(wasCreateElement("p", "was-relation-provenance", delivery.join("\n")));
    }
    card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.collection") + "\n" + wasSourceText(edge.source)));
    var additionalSources = wasAdditionalSources(edge);
    if (additionalSources.length)
    {
      card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.additional") + "\n" + additionalSources.map(wasSourceText).join("\n\n")));
    }
    if (edge.evidence)
    {
      card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.evidence") + "\n" + wasSourceText(edge.evidence)));
    }
    records.appendChild(card);
  });
  if (pair.edges.length > wasState.detailLimit)
  {
    var more = wasCreateElement("button", "was-button was-button-subtle", wasT("app.more.next20", { count: pair.edges.length - wasState.detailLimit }));
    more.type = "button";
    more.setAttribute("data-was-action", "more-relations");
    records.appendChild(more);
  }
  wasElements.detail.appendChild(records);
  [from, to].forEach(function (node)
  {
    var button = wasCreateElement("button", "was-button was-button-subtle", wasT("app.connection.sessionDetails", { name: node.name }));
    button.type = "button";
    button.setAttribute("data-was-target-id", node.id);
    wasElements.detail.appendChild(button);
  });
  wasElements.detail.scrollTop = scrollTop;
}

function wasRenderDetails()
{
  if (wasState.selectedPairId)
  {
    wasRenderConnectionDetails();
    return;
  }
  var node = wasState.model.nodeMap.get(wasState.selectedId);
  if (!node)
  {
    if (wasElements.detail.firstChild !== wasState.detailPlaceholder)
    {
      wasClearElement(wasElements.detail);
      wasElements.detail.appendChild(wasState.detailPlaceholder);
    }
    return;
  }
  var scrollTop = wasElements.detail.scrollTop;
  wasClearElement(wasElements.detail);
  wasElements.detail.appendChild(wasCreateDetailClose());
  var eyebrow = wasCreateElement("div", "was-detail-eyebrow" + wasProviderClass(node), node.provider.toUpperCase() + " / " + (node.kind === "agent" ? wasT("app.kind.agent") : node.kind === "unresolved" ? wasT("app.kind.unresolved") : wasT("app.kind.session")));
  wasElements.detail.appendChild(eyebrow);
  var status = wasCreateElement("div", "was-detail-status");
  status.appendChild(wasCreateElement("i", "was-status-dot was-status-" + wasSafeStatus(node.status)));
  status.appendChild(wasCreateElement("span", "", wasStatusName(node.status)));
  wasElements.detail.appendChild(status);
  wasElements.detail.appendChild(wasCreateElement("h2", "", node.name));
  wasElements.detail.appendChild(wasCreateElement("div", "was-detail-id", node.sessionId || node.id));
  if (!wasState.view.rowIndex.has(node.id))
  {
    var hiddenNote = wasCreateElement("p", "was-evidence", wasT("app.detail.hiddenNote"));
    wasElements.detail.appendChild(hiddenNote);
    var revealButton = wasCreateElement("button", "was-button was-button-subtle", wasT("app.detail.reveal"));
    revealButton.type = "button";
    revealButton.setAttribute("data-was-action", "reveal-selection");
    revealButton.title = wasT("app.detail.revealTitle");
    wasElements.detail.appendChild(revealButton);
  }
  wasElements.detail.appendChild(wasCreateElement("p", "was-detail-description", node.description || wasT("app.detail.noDescription")));
  var activity = wasState.model.activity.get(node.id);
  wasElements.detail.appendChild(wasCreateElement("div", "was-detail-activity was-" + activity.category, wasActivityName(activity.category) + " · " + wasText(activity.reason)));
  var allEdges = wasState.model.incident.get(node.id).slice();
  var recentWaits = 0;
  var historicalRelations = 0;
  var outgoingAgents = 0;
  allEdges.forEach(function (edge)
  {
    if (wasGetEdgeHistory(edge))
    {
      historicalRelations += 1;
    }
    else if (edge.type === "dependency" && edge.from === node.id)
    {
      recentWaits += 1;
    }
    if (edge.type === "spawn" && edge.from === node.id)
    {
      outgoingAgents += 1;
    }
  });
  var waitSummary = wasDetailSection(wasT("app.detail.waitSection"));
  waitSummary.appendChild(wasCreateElement("p", "was-wait-summary", wasT("app.detail.waitCounts", { waits: wasFormatNumber(recentWaits), spawned: wasFormatNumber(outgoingAgents) }) + "\n" + wasT("app.detail.historyKept", { count: historicalRelations })));
  wasElements.detail.appendChild(waitSummary);
  var info = wasDetailSection(wasT("app.detail.infoSection"));
  var list = wasCreateElement("dl", "was-detail-dl");
  wasAppendDetailField(list, wasT("app.detail.project"), node.project);
  if (Array.isArray(node.nameHistory) && node.nameHistory.length > 1)
  {
    wasAppendDetailField(list, wasT("app.detail.renamed"), node.nameHistory.map(wasText).join(" → ") + "\n" + wasT("app.detail.renameNote"));
  }
  if (Array.isArray(node.aliases) && node.aliases.length)
  {
    wasAppendDetailField(list, wasT("app.detail.aliases"), node.aliases.map(wasText).join(", "));
  }
  wasAppendDetailField(list, wasT("app.detail.role"), node.role);
  wasAppendDetailField(list, wasT("app.detail.managedMembers"), wasT("app.detail.managedMembersValue", { count: allEdges.filter(function (edge) { return edge.type === "management" && edge.from === node.id; }).length }));
  wasAppendDetailField(list, wasT("app.detail.cwd"), node.cwd);
  wasAppendDetailField(list, wasT("app.detail.account"), node.account);
  wasAppendDetailField(list, wasT("app.detail.model"), node.model);
  wasAppendDetailField(list, wasT("app.detail.effort"), node.effort);
  wasAppendDetailField(list, wasT("app.detail.lastObserved"), wasDateTime(node.lastSeen));
  wasAppendDetailField(list, wasT("app.detail.descendants"), wasT("app.detail.descendantsValue", { count: wasState.model.descendants.get(node.id) }));
  info.appendChild(list);
  if (node.statusEvidence)
  {
    info.appendChild(wasCreateElement("p", "was-evidence", wasT("app.detail.statusEvidence", { evidence: wasText(node.statusEvidence) })));
  }
  wasElements.detail.appendChild(info);
  var conflicts = node.conflicts.concat(wasState.model.nodeIssues.get(node.id));
  if (conflicts.length)
  {
    var warning = wasDetailSection(wasT("app.detail.conflictSection", { count: conflicts.length }));
    Array.from(new Set(conflicts.map(wasText))).forEach(function (conflict)
    {
      warning.appendChild(wasCreateElement("p", "was-conflict", conflict));
    });
    wasElements.detail.appendChild(warning);
  }
  allEdges.sort(function (first, second)
  {
    var historyOrder = Number(wasGetEdgeHistory(first)) - Number(wasGetEdgeHistory(second));
    var waitOrder = Number(second.type === "dependency") - Number(first.type === "dependency");
    var firstTime = new Date(first.lastSeen || "").getTime() || 0;
    var secondTime = new Date(second.lastSeen || "").getTime() || 0;
    return historyOrder || waitOrder || secondTime - firstTime || first.id.localeCompare(second.id);
  });
  var edges = allEdges.filter(function (edge)
  {
    return !wasState.detailRelationType || edge.type === wasState.detailRelationType;
  });
  var relations = wasDetailSection(wasT("app.detail.relationSection", { shown: wasFormatNumber(edges.length), total: wasFormatNumber(allEdges.length) }));
  var filterLabel = wasCreateElement("label", "was-detail-relation-filter", wasT("app.detail.filterLabel"));
  var relationFilter = wasCreateElement("select", "");
  relationFilter.setAttribute("data-was-action", "detail-relation-type");
  relationFilter.setAttribute("aria-label", wasT("app.detail.filterAria"));
  ["", "management", "dependency", "spawn", "collaboration", "handoff"].forEach(function (type)
  {
    var option = wasCreateElement("option", "", type ? wasTypeName(type) : wasT("app.detail.allTypes"));
    option.value = type;
    relationFilter.appendChild(option);
  });
  relationFilter.value = wasState.detailRelationType;
  filterLabel.appendChild(relationFilter);
  relations.appendChild(filterLabel);
  if (!edges.length)
  {
    relations.appendChild(wasCreateElement("p", "was-evidence", wasT("app.detail.noRelations")));
  }
  edges.slice(0, wasState.detailLimit).forEach(function (edge)
  {
    var outgoing = edge.from === node.id;
    var targetId = outgoing ? edge.to : edge.from;
    var target = wasState.model.nodeMap.get(targetId);
    var card = wasCreateElement("div", "was-relation-card was-type-" + (wasKnownTypes.indexOf(edge.type) !== -1 ? edge.type : "collaboration"));
    var top = wasCreateElement("div", "was-relation-top");
    top.appendChild(wasCreateElement("span", "", outgoing ? wasT("app.relation.outgoing", { type: wasTypeName(edge.type) }) : wasT("app.relation.incoming", { type: wasTypeName(edge.type) })));
    top.appendChild(wasCreateElement("span", "was-confidence", wasConfidenceName(edge.confidence) || wasT("app.relation.confidenceUnspecified")));
    card.appendChild(top);
    var targetButton = wasCreateElement("button", "was-relation-target", target.name);
    targetButton.type = "button";
    targetButton.setAttribute("data-was-target-id", targetId);
    targetButton.title = wasT("app.relation.targetTitle");
    card.appendChild(targetButton);
    if (wasGetEdgeHistory(edge))
    {
      card.appendChild(wasCreateElement("div", "was-relation-provenance", wasT("app.relation.historyNote")));
    }
    if (edge.lastSeen)
    {
      card.appendChild(wasCreateElement("div", "was-relation-provenance", wasT("app.relation.relationObserved", { time: wasDateTime(edge.lastSeen) })));
    }
    if (edge.status || edge.requestId)
    {
      card.appendChild(wasCreateElement("div", "was-relation-provenance", [edge.status, edge.requestId ? wasT("app.relation.request", { id: edge.requestId }) : ""].filter(Boolean).join(" · ")));
    }
    card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.collection") + "\n" + wasSourceText(edge.source)));
    if (edge.message)
    {
      var metadata = [wasT("app.delivery.metadata", { kind: wasMessageKind(edge) }), wasT("app.delivery.idShort", { id: wasMessageId(edge) }), wasT("app.delivery.outcome", { outcome: wasText(edge.message.outcome || "none") })];
      if (edge.message.parentDeliveryId)
      {
        metadata.push(wasT("app.delivery.parentRequest", { id: edge.message.parentDeliveryId }));
      }
      if (edge.message.returnDeliveryId)
      {
        metadata.push(wasT("app.delivery.returnDelivery", { id: edge.message.returnDeliveryId }));
      }
      card.appendChild(wasCreateElement("p", "was-relation-provenance", metadata.join("\n")));
    }
    var additionalSources = wasAdditionalSources(edge);
    if (additionalSources.length)
    {
      card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.additional") + "\n" + additionalSources.map(wasSourceText).join("\n\n")));
    }
    if (edge.evidence)
    {
      card.appendChild(wasCreateElement("p", "was-relation-provenance", wasT("app.source.evidence") + "\n" + wasSourceText(edge.evidence)));
    }
    var issues = edge.conflicts.slice();
    if (wasState.model.edgeIssues.has(edge.id))
    {
      issues.push(wasState.model.edgeIssues.get(edge.id));
    }
    issues.forEach(function (issue)
    {
      card.appendChild(wasCreateElement("p", "was-conflict", wasText(issue)));
    });
    relations.appendChild(card);
  });
  if (edges.length > wasState.detailLimit)
  {
    var more = wasCreateElement("button", "was-button was-button-subtle", wasT("app.more.next20", { count: edges.length - wasState.detailLimit }));
    more.type = "button";
    more.setAttribute("data-was-action", "more-relations");
    relations.appendChild(more);
  }
  wasElements.detail.appendChild(relations);
  var sources = wasDetailSection(wasT("app.detail.sourcesSection", { count: node.sources.length }));
  if (!node.sources.length)
  {
    sources.appendChild(wasCreateElement("p", "was-evidence", wasT("app.detail.noSources")));
  }
  node.sources.forEach(function (source)
  {
    sources.appendChild(wasCreateElement("div", "was-source", wasSourceText(source)));
  });
  wasElements.detail.appendChild(sources);
  wasElements.detail.scrollTop = scrollTop;
}

/* Columns of a member grid: close to square on screen, never wider than six cards. */
function wasGridColumns(count)
{
  return count ? Math.min(count, 6, Math.max(1, Math.ceil(Math.sqrt(count * .9)))) : 0;
}

/* A row heads a team when at least one of its children is on the graph. */
function wasHasMembers(row, byId)
{
  return (row.children || []).some(function (id) { return byId.has(id); });
}

/*
 * Team layout of the operating graph. A manager heads a lane (a labelled panel) that holds its plain members in a grid
 * below the manager card. A member that manages others becomes the head of a lane of its own, to the right of its
 * manager's lane, so reading left to right follows the chain of management. Sessions without a team share one panel.
 * rows come in pre-order, so walking them backwards sizes every subtree before its parent and forwards places them.
 */
function wasBuildTeamLayout(rows)
{
  var card = { width: 238, height: 100 };
  var gap = { x: 48, y: 48 };
  var pad = 28;
  var head = 22;
  var corridor = 128;
  var bandGap = 72;
  var treeGap = 128;
  var byId = new Map();
  rows.forEach(function (row) { byId.set(row.id, row); });
  var plan = new Map();
  for (var index = rows.length - 1; index >= 0; index -= 1)
  {
    var row = rows[index];
    var members = (row.children || []).filter(function (id) { return byId.has(id); });
    if (!members.length)
    {
      continue;
    }
    var leaves = members.filter(function (id) { return !wasHasMembers(byId.get(id), byId); });
    var branches = members.filter(function (id) { return wasHasMembers(byId.get(id), byId); });
    // A lane without lanes to its right lets its head join the grid; otherwise the head keeps a row to itself for the trunk.
    var inline = !branches.length;
    var cells = leaves.length + (inline ? 1 : 0);
    var cols = wasGridColumns(cells);
    var gridRows = cols ? Math.ceil(cells / cols) : 0;
    var laneWidth = pad * 2 + Math.max(card.width, cols * card.width + Math.max(0, cols - 1) * gap.x);
    var laneHeight = pad * 2 + head + (inline ? 0 : card.height + (gridRows ? gap.y : 0)) + (gridRows ? gridRows * card.height + (gridRows - 1) * gap.y : 0);
    var bandHeight = Math.max(0, branches.length - 1) * bandGap;
    var bandWidth = 0;
    branches.forEach(function (id)
    {
      bandHeight += plan.get(id).height;
      bandWidth = Math.max(bandWidth, plan.get(id).width);
    });
    plan.set(row.id, { members: members, leaves: leaves, branches: branches, inline: inline, cols: cols, laneWidth: laneWidth, laneHeight: laneHeight, bandHeight: bandHeight, width: laneWidth + (branches.length ? corridor + bandWidth : 0), height: Math.max(laneHeight, bandHeight) });
  }
  var positions = new Map();
  var lanes = [];
  var origins = new Map();
  var solo = [];
  var top = 40;
  rows.forEach(function (row)
  {
    var info = plan.get(row.id);
    if (!row.depth)
    {
      if (!info)
      {
        solo.push(row);
        return;
      }
      origins.set(row.id, { x: 40, y: top });
      top += info.height + treeGap;
    }
    if (!info)
    {
      return;
    }
    var origin = origins.get(row.id);
    if (!origin)
    {
      return;
    }
    var lane = { id: row.id, ids: [row.id].concat(info.members), x: origin.x, y: origin.y + (info.height - info.laneHeight) / 2, width: info.laneWidth, height: info.laneHeight, count: info.members.length, solo: false };
    lanes.push(lane);
    var headPoint = { x: lane.x + pad, y: lane.y + pad + head, width: card.width, height: card.height, row: row, lane: lane };
    if (info.branches.length)
    {
      headPoint.trunkX = lane.x + lane.width + corridor / 2;
    }
    positions.set(row.id, headPoint);
    var gridTop = lane.y + pad + head + (info.inline ? 0 : card.height + gap.y);
    info.leaves.forEach(function (id, index)
    {
      var slot = index + (info.inline ? 1 : 0);
      positions.set(id, { x: lane.x + pad + slot % info.cols * (card.width + gap.x), y: gridTop + Math.floor(slot / info.cols) * (card.height + gap.y), width: card.width, height: card.height, row: byId.get(id), leafOf: row.id });
    });
    var bandTop = origin.y + (info.height - info.bandHeight) / 2;
    info.branches.forEach(function (id)
    {
      origins.set(id, { x: lane.x + lane.width + corridor, y: bandTop });
      bandTop += plan.get(id).height + bandGap;
    });
  });
  if (solo.length)
  {
    var soloCols = wasGridColumns(solo.length);
    var panel = solo.length > 1;
    var inset = panel ? pad : 0;
    var soloTop = top + (panel ? head + pad : 0);
    solo.forEach(function (row, slot)
    {
      positions.set(row.id, { x: 40 + inset + slot % soloCols * (card.width + gap.x), y: soloTop + Math.floor(slot / soloCols) * (card.height + gap.y), width: card.width, height: card.height, row: row });
    });
    if (panel)
    {
      lanes.push({ id: "", ids: solo.map(function (row) { return row.id; }), x: 40, y: top, width: pad * 2 + soloCols * card.width + (soloCols - 1) * gap.x, height: pad * 2 + head + Math.ceil(solo.length / soloCols) * card.height + (Math.ceil(solo.length / soloCols) - 1) * gap.y, count: solo.length, solo: true });
    }
  }
  return { positions: positions, lanes: lanes };
}

/* A management or spawn line between a team head and a member in its own lane adds nothing the lane does not already say. */
function wasIsContainedPair(pair, positions)
{
  var from = positions.get(pair.from);
  var to = positions.get(pair.to);
  if (!from || !to || pair.conflicts.length || pair.deliveryCount || (from.leafOf !== pair.to && to.leafOf !== pair.from))
  {
    return false;
  }
  return pair.types.every(function (type) { return type === "management" || type === "spawn"; });
}

/* Lanes sit under everything else: a soft panel per team with its caption. */
function wasDrawLanes(context, viewport, camera, focus, detail)
{
  var unit = 1 / Math.max(.5, camera.scale);
  context.lineWidth = unit;
  wasState.graphLanes.forEach(function (lane)
  {
    if (lane.x > viewport.right || lane.x + lane.width < viewport.left || lane.y > viewport.bottom || lane.y + lane.height < viewport.top)
    {
      return;
    }
    var involved = !focus || lane.ids.some(function (id) { return focus.ids.has(id); });
    context.globalAlpha = involved ? 1 : .45;
    context.fillStyle = wasGraphColors.lane;
    context.strokeStyle = wasGraphColors.laneStroke;
    wasCanvasRoundRect(context, lane.x, lane.y, lane.width, lane.height, 18);
    context.fill();
    context.stroke();
    if (detail !== "block" && camera.scale >= .4)
    {
      context.font = "600 11px " + wasCanvasFontFamily;
      context.fillStyle = wasGraphColors.muted;
      context.fillText(wasT(lane.solo ? "app.lane.solo" : "app.lane.team", { count: lane.count }), lane.x + 16, lane.y + 24);
    }
  });
  context.globalAlpha = 1;
}

function wasBuildGraph()
{
  // Layout and routing are the costly part of the graph: a hidden graph only remembers that it is out of date.
  if (wasState.viewMode !== "graph")
  {
    wasState.graphStale = true;
    return;
  }
  var positions = new Map();
  var maxX = 0;
  var maxY = 0;
  var operating = wasElements.graphLayout.value === "operating";
  wasState.operatingView = wasBuildOperatingView(wasState.model, wasState.view, Object.assign(wasReadFilters(), { focusId: wasState.focusId }), wasState.expanded, wasElements.showQuiet.checked);
  wasState.graphRows = operating ? wasState.operatingView.rows : wasState.view.rows;
  wasElements.quietCount.textContent = wasFormatNumber(wasState.operatingView.quiet.size);
  wasState.graphLanes = [];
  if (operating)
  {
    var layout = wasBuildTeamLayout(wasState.graphRows);
    positions = layout.positions;
    wasState.graphLanes = layout.lanes;
  }
  else
  {
    wasState.graphRows.forEach(function (row, index)
    {
      positions.set(row.id, { x: 38 + row.depth * wasNativeStep.x, y: 38 + index * wasNativeStep.y, width: 228, height: 77, row: row });
    });
  }
  positions.forEach(function (point)
  {
    maxX = Math.max(maxX, point.x + point.width);
    maxY = Math.max(maxY, point.y + point.height);
  });
  wasState.graphLanes.forEach(function (lane)
  {
    maxX = Math.max(maxX, lane.x + lane.width);
    maxY = Math.max(maxY, lane.y + lane.height);
  });
  wasState.graphPositions = positions;
  wasState.graphBounds = { width: maxX + 54, height: maxY + 64 };
  wasElements.empty.hidden = wasState.viewMode === "graph" ? wasState.graphRows.length > 0 : wasState.view.rows.length > 0;
  wasUpdateGraphEdges();
  wasState.graphStale = false;
  if (!wasState.graphInitialized && wasState.view.rows.length && wasState.viewMode === "graph")
  {
    wasFitGraph();
    wasState.graphInitialized = true;
  }
  wasRequestGraphDraw();
}

function wasUpdateGraphEdges()
{
  if (!wasState.model || !wasState.graphPositions)
  {
    return;
  }
  if (wasState.viewMode !== "graph")
  {
    wasState.graphStale = true;
    return;
  }
  var selectedPairId = wasState.selectedPairId;
  var enabled = new Set();
  wasElements.relationFilters.querySelectorAll("input:checked").forEach(function (input)
  {
    enabled.add(input.value);
  });
  var positions = wasState.graphPositions;
  var included = wasElements.graphLayout.value === "operating" ? new Set(positions.keys()) : wasState.view.included;
  var counts = { history: 0, nodeFilter: 0, collapsed: 0, type: 0, scope: 0, visible: 0 };
  wasState.graphEdges = wasState.model.edges.filter(function (edge)
  {
    if (wasElements.activity.value === "recent" && wasGetEdgeHistory(edge))
    {
      counts.history += 1;
      return false;
    }
    if (!included.has(edge.from) || !included.has(edge.to))
    {
      counts.nodeFilter += 1; return false;
    }
    if (!positions.has(edge.from) || !positions.has(edge.to))
    {
      counts.collapsed += 1; return false;
    }
    if (!enabled.has(edge.type))
    {
      counts.type += 1; return false;
    }
    if (wasElements.edgeScope.value === "selected" && edge.type !== "spawn" && edge.type !== "management" && edge.from !== wasState.selectedId && edge.to !== wasState.selectedId)
    {
      counts.scope += 1; return false;
    }
    counts.visible += 1;
    return true;
  });
  wasState.graphEdges = wasBundleConnections(wasState.graphEdges, wasState.model.edgeIssues);
  wasState.graphEdges.forEach(function (pair)
  {
    pair.contained = wasIsContainedPair(pair, positions);
  });
  var obstacles = wasBuildObstacleIndex(positions);
  // A lane's caption is no place for a label, but lines may still cross it.
  var captions = new Map(positions);
  wasState.graphLanes.forEach(function (lane, index)
  {
    captions.set("lane:" + index, { x: lane.x, y: lane.y, width: Math.min(lane.width, 210), height: 28 });
  });
  var labelObstacles = wasBuildObstacleIndex(captions);
  wasState.graphObstacles = obstacles;
  wasState.graphRoutes = new Map();
  wasState.graphDeliveries = new Map();
  var context = wasElements.canvas.getContext("2d");
  var labels = [];
  var maxX = 0;
  var maxY = 0;
  positions.forEach(function (point)
  {
    maxX = Math.max(maxX, point.x + point.width);
    maxY = Math.max(maxY, point.y + point.height);
  });
  if (context)
  {
    context.save();
    context.font = "500 11px " + wasCanvasFontFamily;
  }
  wasState.graphEdges.forEach(function (pair)
  {
    var route = wasRouteConnection(pair, positions, obstacles);
    var label = wasConnectionLabel(pair);
    var direction = wasConnectionDirectionLabel(pair, route);
    label += direction ? "  |  " + direction : "";
    var labelWidth = (context ? context.measureText(label).width : label.length * 7) + 22;
    var placement = wasPlaceConnectionLabel(route, labelWidth, 22, labelObstacles, labels);
    route.badge = { text: label, x: placement.x, y: placement.y, width: labelWidth, height: 22 };
    if (!pair.contained)
    {
      // A line the lane already says is drawn only while it is in focus, so its label claims no room.
      labels.push({ left: placement.x - labelWidth / 2, right: placement.x + labelWidth / 2, top: placement.y - 11, bottom: placement.y + 11 });
      maxX = Math.max(maxX, placement.x + labelWidth / 2);
      maxY = Math.max(maxY, placement.y + 11);
    }
    wasState.graphRoutes.set(pair.id, route);
    pair.forward.messages.concat(pair.reverse.messages).forEach(function (edge)
    {
      wasState.graphDeliveries.set(wasMessageId(edge), pair);
    });
  });
  if (context)
  {
    context.restore();
  }
  wasState.graphBounds = { width: maxX + 54, height: maxY + 64 };
  if (wasState.selectedPairId && !wasState.graphRoutes.has(wasState.selectedPairId))
  {
    wasState.selectedPairId = null;
  }
  wasRenderConnectionList();
  var omitted = [];
  if (counts.history)
  {
    omitted.push(wasT("app.graph.omitHistory", { number: wasFormatNumber(counts.history) }));
  }
  if (counts.nodeFilter)
  {
    omitted.push(wasT("app.graph.omitNodeFilter", { number: wasFormatNumber(counts.nodeFilter) }));
  }
  if (counts.collapsed)
  {
    omitted.push(wasT("app.graph.omitCollapsed", { number: wasFormatNumber(counts.collapsed) }));
  }
  if (counts.type)
  {
    omitted.push(wasT("app.graph.omitType", { number: wasFormatNumber(counts.type) }));
  }
  if (counts.scope)
  {
    omitted.push(wasT("app.graph.omitScope", { number: wasFormatNumber(counts.scope) }));
  }
  var inLanes = wasState.graphEdges.filter(function (pair) { return pair.contained; }).length;
  if (inLanes)
  {
    omitted.push(wasT("app.graph.omitLanes", { number: wasFormatNumber(inLanes) }));
  }
  wasElements.graphCount.textContent = wasT("app.graph.count", { visible: wasFormatNumber(counts.visible), total: wasFormatNumber(wasState.model.edges.length), connections: wasFormatNumber(wasState.graphEdges.length) });
  wasElements.graphCount.title = omitted.length ? wasT("app.graph.hiddenRelations", { list: omitted.join(" · ") }) : wasT("app.graph.allShown");
  wasElements.graphCount.setAttribute("aria-label", wasElements.graphCount.textContent + (omitted.length ? ". " + wasT("app.graph.hiddenAria", { list: omitted.join(" · ") }) : ""));
  wasElements.graphOmissions.textContent = omitted.length ? wasT("app.graph.omissions", { list: omitted.join(" · ") }) : wasT("app.graph.noOmissions");
  if (selectedPairId)
  {
    wasRenderDetails();
  }
}

function wasResizeGraph()
{
  var rect = wasElements.canvasWrap.getBoundingClientRect();
  if (!rect.width || !rect.height)
  {
    return;
  }
  var ratio = window.devicePixelRatio || 1;
  wasElements.canvas.width = Math.round(rect.width * ratio);
  wasElements.canvas.height = Math.round(rect.height * ratio);
  wasState.canvasWidth = rect.width;
  wasState.canvasHeight = rect.height;
  wasState.pixelRatio = ratio;
  wasRequestGraphDraw();
}

function wasRequestGraphDraw()
{
  if (wasState.drawFrame || wasState.viewMode !== "graph" || document.hidden)
  {
    return;
  }
  wasState.drawFrame = requestAnimationFrame(function ()
  {
    wasState.drawFrame = null;
    wasDrawGraph();
  });
}

/* The route as the canvas draws it, with its rounded corners sampled into points and a running distance, for beams to follow. */
function wasRouteCurve(route)
{
  if (route.curve)
  {
    return route.curve;
  }
  var points = route.points;
  var out = [{ x: points[0].x, y: points[0].y, d: 0 }];
  var length = 0;
  var push = function (x, y)
  {
    var last = out[out.length - 1];
    length += Math.hypot(x - last.x, y - last.y);
    out.push({ x: x, y: y, d: length });
  };
  for (var index = 1; index < points.length - 1; index += 1)
  {
    var previous = points[index - 1];
    var corner = points[index];
    var next = points[index + 1];
    var before = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    var after = Math.hypot(next.x - corner.x, next.y - corner.y);
    var radius = Math.min(wasRouteRadius, before / 2, after / 2);
    var startX = before ? corner.x - (corner.x - previous.x) / before * radius : corner.x;
    var startY = before ? corner.y - (corner.y - previous.y) / before * radius : corner.y;
    var endX = after ? corner.x + (next.x - corner.x) / after * radius : corner.x;
    var endY = after ? corner.y + (next.y - corner.y) / after * radius : corner.y;
    push(startX, startY);
    for (var step = 1; step < 6; step += 1)
    {
      var t = step / 6;
      push((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * corner.x + t * t * endX, (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * corner.y + t * t * endY);
    }
    push(endX, endY);
  }
  push(points[points.length - 1].x, points[points.length - 1].y);
  route.curve = { points: out, length: length };
  return route.curve;
}

/* The points of the drawn route between two distances (either order), including the ones in between. */
function wasCurveSlice(curve, first, second)
{
  var from = Math.max(0, Math.min(curve.length, Math.min(first, second)));
  var to = Math.max(0, Math.min(curve.length, Math.max(first, second)));
  var at = function (distance)
  {
    for (var index = 1; index < curve.points.length; index += 1)
    {
      var end = curve.points[index];
      if (distance <= end.d || index === curve.points.length - 1)
      {
        var start = curve.points[index - 1];
        var fraction = end.d > start.d ? Math.max(0, Math.min(1, (distance - start.d) / (end.d - start.d))) : 0;
        return { x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction };
      }
    }
    return { x: curve.points[0].x, y: curve.points[0].y };
  };
  var slice = [at(from)];
  curve.points.forEach(function (point)
  {
    if (point.d > from && point.d < to)
    {
      slice.push({ x: point.x, y: point.y });
    }
  });
  slice.push(at(to));
  return slice;
}

/* How far the head of a connection's one beam has travelled at a moment, or null while it rests before the next run. */
function wasLaserHead(length, seconds, seed, still)
{
  if (still)
  {
    return length * .72;
  }
  var head = (seconds * 300 + seed) % (length + 84 + 160);
  return head < length + 84 ? head : null;
}

/* Each connection keeps its own beam color, handed out in the order connections are first seen. */
function wasLaserColor(id)
{
  if (!wasState.laserColors.has(id))
  {
    wasState.laserColors.set(id, wasGraphColors["laser" + (wasState.laserColors.size % 8 + 1)]);
  }
  return wasState.laserColors.get(id);
}

function wasStrokeCurve(context, points)
{
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (var index = 1; index < points.length; index += 1)
  {
    context.lineTo(points[index].x, points[index].y);
  }
  context.stroke();
}

/*
 * A beam is a stretch of the line itself that glows brighter, in the color of its connection and exactly as wide as the line:
 * it brightens from its tail to its head. head is the distance travelled; reverse runs it from the end of the route to the start.
 */
function wasDrawLaser(context, curve, head, reverse, color, width, alpha)
{
  var beam = 84;
  var tail = Math.max(0, head - beam);
  var front = Math.min(head, curve.length);
  if (front <= tail || alpha <= 0)
  {
    return;
  }
  var steps = 10;
  var path = function (distance) { return reverse ? curve.length - distance : distance; };
  context.lineCap = "butt";
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.lineWidth = width;
  for (var step = 0; step < steps; step += 1)
  {
    context.globalAlpha = alpha * Math.pow((step + 1) / steps, 1.5);
    wasStrokeCurve(context, wasCurveSlice(curve, path(tail + (front - tail) * step / steps), path(tail + (front - tail) * (step + 1) / steps)));
  }
}

/* The beam of every connection that still carries an unresolved delivery, drawn after all lines so none is covered. */
function wasDrawFlows(context, entries, camera, now)
{
  var unit = 1 / Math.max(.45, camera.scale);
  context.globalCompositeOperation = "lighter";
  entries.forEach(function (entry)
  {
    if (!entry.style.flowing || entry.muted)
    {
      return;
    }
    var curve = wasRouteCurve(entry.route);
    var head = wasLaserHead(curve.length, now / 1000, wasRouteSeed(entry.pair.id), wasState.reducedMotion.matches);
    if (head !== null)
    {
      wasDrawLaser(context, curve, head, !entry.style.forward, wasLaserColor(entry.pair.id), [1.2, 1.5, 1.9, 2.4][entry.level] * unit, entry.level ? .9 : .2);
    }
  });
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
}

/* A stable offset in [0, 220) for an id, so beams of different connections do not run in step. */
function wasRouteSeed(id)
{
  var hash = 0;
  for (var index = 0; index < id.length; index += 1)
  {
    hash = (hash * 31 + id.charCodeAt(index)) % 2203;
  }
  return hash % 220;
}

function wasDrawObservationPulses(context)
{
  var now = Date.now();
  wasState.flowPulses = wasState.flowPulses.filter(function (pulse)
  {
    return now - pulse.startedAt < 1600;
  });
  if (wasState.reducedMotion.matches)
  {
    return;
  }
  var unit = 1 / Math.max(.5, wasState.camera.scale);
  wasState.flowPulses.forEach(function (pulse)
  {
    var pair = wasState.graphDeliveries.get(wasMessageId(pulse.edge));
    var route = pair && wasState.graphRoutes.get(pair.id);
    if (!route)
    {
      return;
    }
    var progress = (now - pulse.startedAt) / 1600;
    var curve = wasRouteCurve(route);
    var color = wasLaserColor(pair.id);
    context.globalCompositeOperation = "lighter";
    wasDrawLaser(context, curve, progress * (curve.length + 84), pulse.edge.from !== pair.from, color, 2.4 * unit, pulse.replay ? .6 : 1);
    context.globalCompositeOperation = "source-over";
    [pulse.edge.from, pulse.edge.to].forEach(function (id)
    {
      var point = wasState.graphPositions.get(id);
      if (!point)
      {
        return;
      }
      var spread = 3 + progress * 13;
      context.globalAlpha = (1 - progress) * .8;
      context.strokeStyle = color;
      context.lineWidth = 2 / Math.max(.4, wasState.camera.scale);
      wasCanvasRoundRect(context, point.x - spread, point.y - spread, point.width + spread * 2, point.height + spread * 2, 12);
      context.stroke();
    });
  });
  context.globalAlpha = 1;
}

function wasRenderGraphStatus()
{
  var replaying = wasState.flowPulses.some(function (pulse) { return pulse.replay; });
  var observing = wasState.flowPulses.length;
  var replay = wasState.replayStatus;
  var text = replay ? wasReplayStatusText(replay) : replaying ? wasT("app.graphStatus.replaying") : observing ? wasT("app.graphStatus.observing") : wasT("app.graphStatus.quiet");
  if (wasElements.sceneStatus.textContent !== text)
  {
    wasElements.sceneStatus.textContent = text;
  }
}

function wasReplayStatusText(replay)
{
  var parts = [wasT("app.graphStatus.replayProgress", { index: replay.index, total: replay.total })];
  if (replay.hidden)
  {
    parts.push(wasT("app.graphStatus.replayOffscreen", { count: replay.hidden }));
  }
  if (wasState.reducedMotion.matches)
  {
    parts.push(wasT("app.graphStatus.reducedMotion"));
  }
  return parts.join(" · ");
}

function wasScheduleGraphAnimation()
{
  clearTimeout(wasState.animationTimer);
  wasState.animationTimer = null;
  var observing = wasState.flowPulses.length;
  wasRenderGraphStatus();
  if (document.hidden || wasState.reducedMotion.matches || wasState.viewMode !== "graph")
  {
    return;
  }
  // graphLive is set by the last draw: the redraw period in ms that what is on screen needs, 0 when nothing moves.
  if (observing || wasState.graphLive)
  {
    wasState.animationTimer = setTimeout(wasRequestGraphDraw, observing ? 50 : wasState.graphLive);
  }
}

function wasMessageKind(edge)
{
  var kinds = { request: "request", reply: "reply", "failure-notice": "failureNotice", "progress-notice": "progressNotice", unknown: "unknown" };
  var kind = Object.prototype.hasOwnProperty.call(kinds, edge.message && edge.message.kind) ? kinds[edge.message.kind] : "";
  return wasKnownLabel("app.messageKind", kind) || wasT("app.messageKind.record");
}

function wasRenderMessageFeed()
{
  if (!wasState.messageSummary)
  {
    return;
  }
  var project = wasElements.project.value.toLowerCase();
  var edges = Array.from(wasState.messageSummary.deliveries.values()).filter(function (edge)
  {
    return !project || [edge.from, edge.to].some(function (id)
    {
      return wasText(wasState.model.nodeMap.get(id).project).toLowerCase() === project;
    });
  });
  edges.sort(function (first, second)
  {
    var firstMessage = first.message || {};
    var secondMessage = second.message || {};
    return (Date.parse(second.lastSeen || secondMessage.finishedAt || secondMessage.acceptedAt || secondMessage.createdAt || "") || 0) - (Date.parse(first.lastSeen || firstMessage.finishedAt || firstMessage.acceptedAt || firstMessage.createdAt || "") || 0) || wasMessageId(first).localeCompare(wasMessageId(second));
  });
  var unresolved = edges.filter(function (edge) { return !wasMessageResolved(edge); }).length;
  var eventCount = wasState.messageState.events.length;
  wasState.projectMessages = edges;
  wasElements.messageSummary.textContent = wasT("app.feed.summary", { deliveries: wasFormatNumber(edges.length), unresolved: wasFormatNumber(unresolved), observed: wasFormatNumber(eventCount + wasState.messageState.older) }) + (wasState.messageState.older ? " " + wasT("app.feed.summaryOlder", { older: wasFormatNumber(wasState.messageState.older) }) : "") + " · " + wasT("app.feed.summaryNote");
  wasElements.messageMore.hidden = edges.length <= wasState.messageLimit;
  wasElements.messageMore.textContent = wasT("app.feed.more", { count: Math.max(0, edges.length - wasState.messageLimit) });
  wasElements.replayFlow.disabled = !edges.length;
  wasElements.presentationFlow.textContent = wasT("app.feed.presentationFlow", { count: edges.length });
  wasClearElement(wasElements.messageFeed);
  if (!edges.length)
  {
    wasElements.messageFeed.appendChild(wasCreateElement("p", "was-message-empty", wasT("app.feed.empty")));
  }
  edges.slice(0, wasState.messageLimit).forEach(function (edge)
  {
    var message = edge.message || {};
    var item = wasCreateElement("details", "was-message-item");
    item.setAttribute("data-was-delivery-id", wasMessageId(edge));
    var summary = wasCreateElement("summary", "");
    var route = wasCreateElement("span", "was-message-route", wasState.model.nodeMap.get(edge.from).name + " → " + wasState.model.nodeMap.get(edge.to).name);
    route.title = route.textContent;
    summary.appendChild(route);
    summary.appendChild(wasCreateElement("span", "was-message-kind", wasMessageKind(edge)));
    summary.appendChild(wasCreateElement("span", "was-message-state" + (wasMessageResolved(edge) ? " was-resolved" : ""), wasText(edge.status || wasT("app.common.statusUnknown"))));
    var timestamp = edge.lastSeen || message.finishedAt || message.acceptedAt || message.createdAt;
    var time = wasCreateElement("time", "", wasRelativeTime(timestamp));
    time.title = wasDateTime(timestamp);
    if (timestamp)
    {
      time.dateTime = timestamp;
    }
    summary.appendChild(time);
    item.appendChild(summary);
    var metadata = wasCreateElement("div", "was-message-metadata");
    var lines = [wasT("app.feed.requestId", { id: wasMessageId(edge) }), wasT("app.feed.outcome", { outcome: wasText(message.outcome || "none") }) + (message.expired ? " · " + wasT("app.feed.expired") : ""), wasT("app.feed.observedAt", { time: wasDateTime(timestamp) })];
    if (message.parentDeliveryId)
    {
      lines.push(wasT("app.feed.parentRequest", { id: message.parentDeliveryId }));
    }
    if (message.returnDeliveryId)
    {
      lines.push(wasT("app.feed.returnDelivery", { id: message.returnDeliveryId }));
    }
    metadata.appendChild(wasCreateElement("p", "", lines.join("\n")));
    metadata.appendChild(wasCreateElement("p", "", wasT("app.feed.source", { confidence: wasConfidenceName(edge.confidence) || edge.confidence || wasT("app.common.unspecified") }) + "\n" + wasSourceText(edge.source) + (edge.evidence ? "\n" + wasSourceText(edge.evidence) : "")));
    [edge.from, edge.to].forEach(function (id, index)
    {
      var button = wasCreateElement("button", "was-button was-button-subtle", index ? wasT("app.feed.receiverDetails") : wasT("app.feed.senderDetails"));
      button.type = "button";
      button.setAttribute("data-was-message-node", id);
      metadata.appendChild(button);
    });
    item.appendChild(metadata);
    wasElements.messageFeed.appendChild(item);
  });
}

function wasRenderOverview()
{
  if (wasState.viewMode === "office" && wasState.officeData)
  {
    wasElements.overviewTitle.textContent = wasT("app.overview.stageTitle", { project: wasElements.project.value || wasT("app.filter.allProjects") });
    wasElements.overviewSummary.textContent = wasT("app.overview.stageSummary", { sessions: wasFormatNumber(wasState.officeData.actors.length), floors: wasState.officeFloors.length, running: wasElements.statRunning.textContent });
    return;
  }
  var quiet = wasState.viewMode === "office" && wasState.officeData ? wasState.officeData.stats.context : wasState.operatingView ? wasState.operatingView.quiet.size : 0;
  var project = wasElements.project.value || wasT("app.filter.allProjects");
  wasElements.overviewTitle.textContent = wasState.viewMode === "office" ? wasT("app.overview.officeTitle", { project: project }) : wasT("app.overview.relationsTitle", { project: project });
  wasElements.overviewSummary.textContent = wasT("app.overview.summary", { matched: wasFormatNumber(wasState.view.matched.size), running: wasElements.statRunning.textContent, quiet: quiet, nodes: wasFormatNumber(wasState.model.nodes.length) });
}

function wasStopReplay()
{
  var hadOfficeReplay = wasState.viewMode === "office" && !!wasState.replayStatus;
  if (wasState.officeScene && wasState.officeScene.stopReplay) wasState.officeScene.stopReplay();
  clearTimeout(wasState.replayTimer);
  wasState.replayTimer = null;
  wasState.replayStatus = null;
  wasState.replayQueue = [];
  wasState.flowPulses = wasState.flowPulses.filter(function (pulse) { return !pulse.replay; });
  wasElements.replayFlow.textContent = wasT("app.replay.start");
  if (hadOfficeReplay) wasSetOfficeTravel("note");
  wasElements.messageFeed.querySelectorAll(".was-replay-highlight").forEach(function (item)
  {
    item.classList.remove("was-replay-highlight");
  });
  wasRequestGraphDraw();
}

function wasReplayNext()
{
  if (!wasState.replayStatus || document.hidden)
  {
    wasStopReplay();
    return;
  }
  var edge = wasState.replayQueue.shift();
  if (edge && wasState.viewMode === "office" && !wasOfficeDeliveryEdges([edge]).length)
  {
    wasStopReplay();
    wasSetOfficeTravel("note");
    return;
  }
  if (!edge)
  {
    wasState.replayTimer = setTimeout(wasStopReplay, wasState.viewMode === "office" ? 4000 : 1800);
    return;
  }
  wasState.replayStatus.index += 1;
  wasElements.messageFeed.querySelectorAll("[data-was-delivery-id]").forEach(function (item)
  {
    item.classList.toggle("was-replay-highlight", item.getAttribute("data-was-delivery-id") === wasMessageId(edge));
  });
  if (!wasState.reducedMotion.matches)
  {
    wasState.flowPulses.push({ edge: edge, startedAt: Date.now(), replay: true });
  }
  if (wasState.viewMode === "office" && wasState.officeScene)
  {
    wasState.officeScene.observe([edge], { replay: true, observedAt: Date.now() });
  }
  wasRequestGraphDraw();
  wasState.replayTimer = setTimeout(wasReplayNext, wasState.viewMode === "office" ? 1200 : 900);
}

/* The character stage plays its call illustration without a button: the latest deliveries inside the two-hour window, oldest first, once per opening. */
function wasAutoReplayOffice()
{
  if (!wasState.officeAutoReplay || !wasState.officeScene || wasState.replayStatus || document.hidden || wasState.snapshot && wasState.snapshot.stats && wasState.snapshot.stats.loading)
  {
    return;
  }
  wasState.officeAutoReplay = false;
  wasStartReplay({ auto: true });
}

function wasStartReplay(options)
{
  var auto = !!options && options.auto === true;
  if (wasState.replayStatus)
  {
    if (!auto) wasStopReplay();
    return;
  }
  var candidates = wasState.projectMessages || [];
  if (wasState.viewMode === "office" && wasState.officeData)
  {
    candidates = wasOfficeDeliveryEdges(candidates);
  }
  if (auto)
  {
    candidates = candidates.filter(function (edge) { return !wasGetEdgeHistory(edge); }).slice(0, 12);
  }
  var edges = (wasState.viewMode === "office" ? candidates.slice() : candidates.slice(0, 12)).reverse();
  if (!edges.length)
  {
    return;
  }
  if (wasState.viewMode !== "office")
  {
    wasSetView("graph");
  }
  if (wasState.presentation)
  {
    if (wasState.viewMode !== "office")
    {
      document.body.classList.add("was-presentation-flow-open");
      wasElements.presentationFlow.setAttribute("aria-expanded", "true");
    }
  }
  var hidden = wasState.viewMode === "office" ? 0 : edges.filter(function (edge)
  {
    return !wasState.graphDeliveries.has(wasMessageId(edge));
  }).length;
  wasState.replayQueue = edges;
  wasState.replayStatus = { total: edges.length, index: 0, hidden: hidden };
  wasElements.replayFlow.textContent = wasT("app.replay.stop");
  if (!auto) wasElements.announcement.textContent = wasT("app.announce.replayStarted", { count: edges.length });
  if (wasState.reducedMotion.matches)
  {
    wasState.replayStatus.index = edges.length;
    wasState.replayQueue = [];
    if (wasState.viewMode === "office") wasSetOfficeTravel("reduced");
    wasRequestGraphDraw();
    return;
  }
  wasReplayNext();
}

function wasRenderSidebarLabel()
{
  wasElements.sidebarToggle.querySelector("span").textContent = wasState.sidebarCollapsed ? wasT("app.sidebar.expand") : wasT("app.sidebar.collapse");
}

function wasSetSidebar(collapsed, persist)
{
  wasState.sidebarCollapsed = collapsed;
  document.body.classList.toggle("was-sidebar-collapsed", collapsed);
  wasElements.sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  wasRenderSidebarLabel();
  wasElements.sidebar.inert = collapsed;
  wasElements.sidebar.setAttribute("aria-hidden", collapsed ? "true" : "false");
  if (persist)
  {
    try
    {
      localStorage.setItem("was_observatory_sidebar_collapsed", collapsed ? "1" : "0");
    }
    catch (error)
    {
      // A browser storage restriction does not affect the current layout.
    }
  }
  wasResizeGraph();
}

function wasRenderDetailToggleLabel()
{
  wasElements.detailToggle.querySelector("span").textContent = wasState.detailCollapsed ? wasT("app.detail.expandPanel") : wasT("app.detail.collapsePanel");
}

function wasSetDetail(collapsed, persist)
{
  wasState.detailCollapsed = collapsed;
  document.body.classList.toggle("was-detail-collapsed", collapsed);
  wasElements.detailToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  wasRenderDetailToggleLabel();
  if (persist)
  {
    try
    {
      localStorage.setItem("was_observatory_detail_collapsed", collapsed ? "1" : "0");
    }
    catch (error)
    {
      // A browser storage restriction does not affect the current layout.
    }
  }
  wasResizeGraph();
}

function wasSortLabel(sort)
{
  var labels =
  {
    "recent:desc": wasT("page.sort.recentDesc"),
    "recent:asc": wasT("page.sort.recentAsc"),
    "status:asc": wasT("page.sort.statusAsc"),
    "status:desc": wasT("page.sort.statusDesc"),
    "name:asc": wasT("page.sort.nameAsc"),
    "name:desc": wasT("page.sort.nameDesc")
  };
  return labels[sort.key + ":" + sort.direction];
}

function wasRenderSort()
{
  var sort = wasState.sort || wasDefaultSort;
  wasElements.treeSort.value = wasSortValue();
  wasElements.treeColumns.querySelectorAll("[data-was-sort]").forEach(function (button)
  {
    var active = button.getAttribute("data-was-sort") === sort.key;
    button.setAttribute("data-was-sort-state", active ? sort.direction : "none");
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function wasApplySort(sort)
{
  if (!sort)
  {
    return;
  }
  wasState.sort = sort;
  wasRenderSort();
  wasUpdateView(true);
  if (wasState.selectedId)
  {
    wasScrollToNode(wasState.selectedId);
  }
  wasElements.announcement.textContent = wasT("app.announce.sorted", { order: wasSortLabel(sort) });
}

function wasEnterPresentation()
{
  if (wasState.presentation)
  {
    wasExitPresentation();
    return;
  }
  wasState.presentation = { filters: wasReadFilters(), viewMode: wasState.viewMode, layout: wasElements.graphLayout.value, showQuiet: wasElements.showQuiet.checked, edgeScope: wasElements.edgeScope.value, sidebar: wasState.sidebarCollapsed, focusId: wasState.focusId, selectedId: wasState.selectedId, selectedPairId: wasState.selectedPairId, detailScroll: wasElements.detail.scrollTop, detailLimit: wasState.detailLimit, detailRelationType: wasState.detailRelationType, treeScroll: wasElements.tree.scrollTop, expanded: new Set(wasState.expanded), camera: Object.assign({}, wasState.camera), officeFloorId: wasState.officeFloorId, officeGrouped: wasElements.officeGrouped.checked, officeOrder: wasElements.officeOrder.value, officeQuiet: wasElements.officeQuiet.checked };
  if (wasState.viewMode !== "office")
  {
    wasStopReplay();
    ["search", "provider", "status", "kind"].forEach(function (key) { wasElements[key].value = ""; });
    wasElements.activity.value = "recent";
    wasElements.graphLayout.value = "operating";
    wasState.focusId = null;
  }
  wasSetSidebar(true, false);
  document.body.classList.add("was-presenting");
  wasElements.presentation.setAttribute("aria-pressed", "true");
  wasElements.presentationDetail.setAttribute("aria-expanded", "false");
  wasElements.presentationFlow.setAttribute("aria-expanded", "false");
  wasUpdateView(false);
  wasSetView(wasState.presentation.viewMode === "office" ? "office" : "graph");
  if (wasState.viewMode === "office" && wasState.officeScene)
  {
    wasResizeOfficeAfterLayout(true);
  }
  else wasFitGraph();
  wasElements.presentationExit.focus();
  wasElements.announcement.textContent = wasT("app.announce.presentation");
}

function wasExitPresentation()
{
  if (!wasState.presentation)
  {
    return;
  }
  var previous = wasState.presentation;
  wasState.presentation = null;
  document.body.classList.remove("was-presenting", "was-presentation-detail-open", "was-presentation-flow-open");
  wasStopReplay();
  wasElements.presentation.setAttribute("aria-pressed", "false");
  Object.keys(previous.filters).forEach(function (key)
  {
    wasElements[key === "query" ? "search" : key].value = previous.filters[key];
  });
  wasElements.graphLayout.value = previous.layout;
  wasElements.showQuiet.checked = previous.showQuiet;
  wasElements.edgeScope.value = previous.edgeScope;
  wasState.officeFloorId = previous.officeFloorId;
  wasElements.officeGrouped.checked = previous.officeGrouped;
  wasElements.officeOrder.value = previous.officeOrder;
  wasElements.officeQuiet.checked = previous.officeQuiet;
  if (wasState.officeScene) wasState.officeScene.setMode("2d");
  wasState.focusId = previous.focusId;
  wasState.selectedId = previous.selectedId;
  wasState.selectedPairId = previous.selectedPairId;
  wasState.expanded = previous.expanded;
  wasState.detailLimit = previous.detailLimit;
  wasState.detailRelationType = previous.detailRelationType;
  wasState.viewMode = previous.viewMode;
  wasSetSidebar(previous.sidebar, false);
  wasUpdateView(false);
  wasSetView(previous.viewMode);
  wasState.camera = previous.camera;
  wasElements.detail.scrollTop = previous.detailScroll;
  wasElements.tree.scrollTop = previous.treeScroll;
  wasRequestGraphDraw();
  wasElements.presentation.focus();
}

function wasReadGraphPalette()
{
  // Canvas colors follow the CSS theme tokens; the fallbacks mirror styles.css.
  var tokens =
  {
    management: ["--was-management", "#f0a35e"],
    spawn: ["--was-spawn", "#5cc8b8"],
    dependency: ["--was-dependency", "#f5c451"],
    collaboration: ["--was-collaboration", "#a78bfa"],
    handoff: ["--was-handoff", "#67b7f7"],
    running: ["--was-running", "#4fd18b"],
    waiting: ["--was-waiting", "#f5c451"],
    idle: ["--was-idle", "#9aa6b5"],
    completed: ["--was-completed", "#6fa8ff"],
    interrupted: ["--was-interrupted", "#e98bb5"],
    unknown: ["--was-unknown", "#8b93a1"],
    canvasBg: ["--was-canvas-bg", "#0f1216"],
    canvasGrid: ["--was-canvas-grid", "#242a33"],
    node: ["--was-node", "#1b2027"],
    nodeTop: ["--was-node-top", "#252c36"],
    nodeHover: ["--was-node-hover", "#46505e"],
    minimapBg: ["--was-minimap-bg", "#12161b"],
    laser1: ["--was-laser-1", "#22d3ee"],
    laser2: ["--was-laser-2", "#a3e635"],
    laser3: ["--was-laser-3", "#f472b6"],
    laser4: ["--was-laser-4", "#fbbf24"],
    laser5: ["--was-laser-5", "#818cf8"],
    laser6: ["--was-laser-6", "#fb7185"],
    laser7: ["--was-laser-7", "#34d399"],
    laser8: ["--was-laser-8", "#fb923c"],
    lane: ["--was-lane", "#141920"],
    laneStroke: ["--was-lane-stroke", "#2a313b"],
    nodeContext: ["--was-node-context", "#171b21"],
    nodePast: ["--was-node-past", "#131619"],
    nodeSelected: ["--was-node-selected", "#2a2119"],
    nodeStroke: ["--was-node-stroke", "#353d49"],
    accent: ["--was-accent", "#f0a35e"],
    edgeMuted: ["--was-edge-muted", "#4d5562"],
    labelBg: ["--was-label-bg", "#161a20"],
    labelStroke: ["--was-label-stroke", "#323a46"],
    labelText: ["--was-label-text", "#c4cad3"],
    conflict: ["--was-conflict", "#f2777a"],
    conflictFill: ["--was-conflict-fill", "#2b1a1c"],
    conflictText: ["--was-conflict-text", "#ffb4b1"],
    text: ["--was-text", "#eceef1"],
    text2: ["--was-text-2", "#b6bdc8"],
    muted: ["--was-muted", "#8a93a0"],
    dim: ["--was-dim", "#5f6875"],
    claude: ["--was-claude", "#e5895f"],
    codex: ["--was-codex", "#7ea6ff"],
    pulseLive: ["--was-pulse-live", "#5cc8b8"],
    pulseReplay: ["--was-pulse-replay", "#f5c451"],
    teal: ["--was-teal", "#5cc8b8"]
  };
  var style = typeof getComputedStyle === "function" && typeof document !== "undefined" && document.documentElement ? getComputedStyle(document.documentElement) : null;
  var palette = {};
  Object.keys(tokens).forEach(function (key)
  {
    var value = style ? style.getPropertyValue(tokens[key][0]).trim() : "";
    palette[key] = value || tokens[key][1];
  });
  return palette;
}

function wasCanvasProviderColor(provider)
{
  var name = String(provider || "").toLowerCase();
  if (name.indexOf("claude") !== -1)
  {
    return wasGraphColors.claude;
  }
  if (name.indexOf("codex") !== -1)
  {
    return wasGraphColors.codex;
  }
  return wasGraphColors.text2;
}

function wasCanvasSegments(context, segments, x, y, maxWidth)
{
  // Draws colored text runs on one line and truncates the run that reaches the width limit.
  var cursor = x;
  var limit = x + maxWidth;
  for (var index = 0; index < segments.length; index += 1)
  {
    var text = segments[index].text;
    if (!text)
    {
      continue;
    }
    var room = limit - cursor;
    if (room <= 8)
    {
      return;
    }
    var fitted = wasCanvasText(context, text, room);
    context.fillStyle = segments[index].color;
    context.fillText(fitted, cursor, y);
    if (fitted !== text)
    {
      return;
    }
    cursor += context.measureText(fitted).width;
  }
}

function wasCanvasRoundRect(context, x, y, width, height, radius)
{
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function wasCanvasText(context, value, maxWidth)
{
  var text = wasText(value);
  if (context.measureText(text).width <= maxWidth)
  {
    return text;
  }
  var start = 0;
  var end = text.length;
  while (start < end)
  {
    var middle = Math.ceil((start + end) / 2);
    if (context.measureText(text.slice(0, middle) + "…").width <= maxWidth)
    {
      start = middle;
    }
    else
    {
      end = middle - 1;
    }
  }
  return text.slice(0, start) + "…";
}

/* Level of detail of the graph: tinted blocks, names only, then the full card. */
function wasGraphDetail(scale)
{
  return scale < .3 ? "block" : scale < .55 ? "name" : "full";
}

function wasRamp(value, low, high)
{
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

/* Rounds the corners of an orthogonal route; the route points themselves stay untouched. */
function wasDrawRoute(context, route)
{
  var points = route.points;
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (var index = 1; index < points.length - 1; index += 1)
  {
    var previous = points[index - 1];
    var corner = points[index];
    var next = points[index + 1];
    var radius = Math.min(wasRouteRadius, Math.hypot(corner.x - previous.x, corner.y - previous.y) / 2, Math.hypot(next.x - corner.x, next.y - corner.y) / 2);
    context.arcTo(corner.x, corner.y, next.x, next.y, radius);
  }
  context.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  context.stroke();
}

function wasDrawRouteArrow(context, route, reverse, scale)
{
  var point = wasPointOnRoute(route, reverse ? 0 : 1);
  var angle = point.angle + (reverse ? Math.PI : 0);
  var size = 8 / Math.max(.6, scale);
  var cos = Math.cos(angle);
  var sin = Math.sin(angle);
  context.beginPath();
  context.moveTo(point.x, point.y);
  context.lineTo(point.x - size * cos + size * .5 * sin, point.y - size * sin - size * .5 * cos);
  context.lineTo(point.x - size * .7 * cos, point.y - size * .7 * sin);
  context.lineTo(point.x - size * cos - size * .5 * sin, point.y - size * sin + size * .5 * cos);
  context.closePath();
  context.fill();
}

/* The point of a route that is closest to (x, y); a label uses it to draw its leader line. */
function wasRouteAnchor(route, x, y)
{
  var best = { x: route.points[0].x, y: route.points[0].y, distance: Infinity };
  for (var index = 1; index < route.points.length; index += 1)
  {
    var start = route.points[index - 1];
    var end = route.points[index];
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = dx * dx + dy * dy;
    var fraction = length ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / length)) : 0;
    var px = start.x + dx * fraction;
    var py = start.y + dy * fraction;
    var distance = Math.hypot(x - px, y - py);
    if (distance < best.distance)
    {
      best = { x: px, y: py, distance: distance };
    }
  }
  return best;
}

/* Lines are always solid; the weakest evidence of a pair is only named here, and counted in the label. */
function wasConnectionStyle(pair)
{
  var evidence = pair.confidenceCounts.unresolved ? "unresolved" : pair.confidenceCounts.inferred ? "inferred" : "confirmed";
  return {
    evidence: evidence,
    flowing: pair.unresolved > 0,
    forward: pair.forward.unresolved >= pair.reverse.unresolved
  };
}

function wasGraphNeighbors(edges, id)
{
  var ids = new Set([id]);
  edges.forEach(function (pair)
  {
    if (pair.from === id)
    {
      ids.add(pair.to);
    }
    else if (pair.to === id)
    {
      ids.add(pair.from);
    }
  });
  return ids;
}

/* What stays sharp while a node or connection is selected (or only hovered, which dims less); everything else is veiled. */
function wasGraphFocus()
{
  var selectedId = wasState.graphPositions.has(wasState.selectedId) ? wasState.selectedId : "";
  var selected = !!(wasState.selectedPairId || selectedId);
  var pairId = wasState.selectedPairId || (selected ? "" : wasState.hoverPairId);
  var anchor = pairId ? "" : selectedId || wasState.hoverId;
  if (!pairId && !(anchor && wasState.graphPositions.has(anchor)))
  {
    return null;
  }
  var ids = new Set();
  if (pairId)
  {
    var pair = wasState.graphEdges.find(function (entry) { return entry.id === pairId; });
    if (!pair)
    {
      return null;
    }
    ids.add(pair.from);
    ids.add(pair.to);
  }
  else
  {
    ids = wasGraphNeighbors(wasState.graphEdges, anchor);
  }
  return { ids: ids, pairId: pairId, anchor: anchor, soft: !selected };
}

function wasStrokeConnection(context, entry, camera, now)
{
  var pair = entry.pair;
  var style = entry.style;
  var unit = 1 / Math.max(.45, camera.scale);
  var alpha = [.1, entry.muted ? .4 : .8, 1, 1][entry.level];
  context.globalAlpha = alpha;
  context.strokeStyle = entry.color;
  context.fillStyle = entry.color;
  context.lineWidth = [1.2, 1.5, 1.9, 2.4][entry.level] * unit;
  context.lineCap = "butt";
  if (entry.level === 3)
  {
    context.shadowColor = entry.color;
    context.shadowBlur = 10 * wasState.pixelRatio;
  }
  wasDrawRoute(context, entry.route);
  context.shadowBlur = 0;
  context.shadowColor = "transparent";
  context.globalAlpha = alpha;
  if (pair.forward.edges.length)
  {
    wasDrawRouteArrow(context, entry.route, false, camera.scale);
  }
  if (pair.reverse.edges.length)
  {
    wasDrawRouteArrow(context, entry.route, true, camera.scale);
  }
}

function wasDrawConnectionLabel(context, entry, camera)
{
  var pair = entry.pair;
  var badge = entry.route.badge;
  var unit = 1 / Math.max(.45, camera.scale);
  var left = badge.x - badge.width / 2;
  var top = badge.y - badge.height / 2;
  var alpha = [.12, entry.muted ? .62 : .96, 1, 1][entry.level];
  var anchor = wasRouteAnchor(entry.route, badge.x, badge.y);
  var edgeX = Math.max(left, Math.min(left + badge.width, anchor.x));
  var edgeY = Math.max(top, Math.min(top + badge.height, anchor.y));
  if (Math.hypot(anchor.x - edgeX, anchor.y - edgeY) > 5)
  {
    context.globalAlpha = alpha * .7;
    context.strokeStyle = entry.color;
    context.lineWidth = unit;
    context.beginPath();
    context.moveTo(anchor.x, anchor.y);
    context.lineTo(edgeX, edgeY);
    context.stroke();
  }
  context.globalAlpha = alpha;
  context.font = "500 11px " + wasCanvasFontFamily;
  context.fillStyle = pair.conflicts.length ? wasGraphColors.conflictFill : wasGraphColors.labelBg;
  context.strokeStyle = pair.conflicts.length ? wasGraphColors.conflict : entry.level === 3 ? entry.color : wasGraphColors.labelStroke;
  context.lineWidth = (entry.level === 3 || pair.conflicts.length ? 1.2 : .8) * unit;
  wasCanvasRoundRect(context, left, top, badge.width, badge.height, badge.height / 2);
  context.fill();
  context.stroke();
  var step = (badge.height - 10) / pair.types.length;
  pair.types.forEach(function (type, index)
  {
    context.fillStyle = entry.muted ? wasGraphColors.edgeMuted : wasGraphColors[type] || wasGraphColors.muted;
    context.fillRect(left + 7, top + 5 + step * index, 3, step);
  });
  context.fillStyle = pair.conflicts.length ? wasGraphColors.conflictText : entry.level === 3 ? wasGraphColors.text : wasGraphColors.labelText;
  context.textAlign = "center";
  context.fillText(badge.text, badge.x + 2, badge.y + 4);
  context.textAlign = "left";
  if (entry.level)
  {
    wasState.graphLabelHits.push({ id: pair.id, left: left, top: top, right: left + badge.width, bottom: top + badge.height });
  }
}

/* Zoomed out, only a connection in focus or in conflict keeps a mark: a dot on its line with one colored slice per relation type. */
function wasDrawConnectionDot(context, entry, camera)
{
  var pair = entry.pair;
  var unit = 1 / camera.scale;
  var radius = 4 * unit;
  var center = entry.route.label;
  var tau = Math.PI * 2;
  context.globalAlpha = [.3, entry.muted ? .6 : .95, 1, 1][entry.level];
  pair.types.forEach(function (type, index)
  {
    context.fillStyle = entry.muted ? wasGraphColors.edgeMuted : wasGraphColors[type] || wasGraphColors.muted;
    context.beginPath();
    context.moveTo(center.x, center.y);
    context.arc(center.x, center.y, radius, tau * index / pair.types.length - Math.PI / 2, tau * (index + 1) / pair.types.length - Math.PI / 2);
    context.closePath();
    context.fill();
  });
  context.strokeStyle = pair.conflicts.length ? wasGraphColors.conflict : wasGraphColors.canvasBg;
  context.lineWidth = 1.4 * unit;
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, tau);
  context.stroke();
  wasState.graphLabelHits.push({ id: pair.id, left: center.x - radius * 1.4, top: center.y - radius * 1.4, right: center.x + radius * 1.4, bottom: center.y + radius * 1.4 });
}

function wasDrawConnections(context, viewport, camera, focus, now, detail)
{
  wasState.graphLabelHits = [];
  var visible = [];
  context.lineJoin = "round";
  wasState.graphEdges.forEach(function (pair)
  {
    var route = wasState.graphRoutes.get(pair.id);
    if (!route || route.points.every(function (point) { return point.x < viewport.left; }) || route.points.every(function (point) { return point.x > viewport.right; }) || route.points.every(function (point) { return point.y < viewport.top; }) || route.points.every(function (point) { return point.y > viewport.bottom; }))
    {
      return;
    }
    var focused = !focus || (focus.pairId ? pair.id === focus.pairId : pair.from === focus.anchor || pair.to === focus.anchor);
    if (pair.contained && !(focus && focused))
    {
      return;
    }
    var muted = wasState.model.activity.get(pair.from).category !== "recent" && wasState.model.activity.get(pair.to).category !== "recent";
    // A messaging line has a color of its own, the one its beam travels in; any other line takes the color of its relation type.
    var color = pair.conflicts.length ? wasGraphColors.conflict : muted ? wasGraphColors.edgeMuted : pair.deliveryCount ? wasLaserColor(pair.id) : (wasGraphColors[pair.type] || wasGraphColors.muted);
    // level: 0 veiled, 1 normal, 2 hover focus, 3 selected
    var level = !focus ? 1 : !focused ? 0 : focus.soft ? 2 : 3;
    visible.push({ pair: pair, route: route, muted: muted, color: color, style: wasConnectionStyle(pair), level: level });
  });
  visible.sort(function (first, second) { return first.level - second.level; });
  visible.forEach(function (entry)
  {
    wasStrokeConnection(context, entry, camera, now);
  });
  if (detail !== "block")
  {
    wasDrawFlows(context, visible, camera, now);
  }
  visible.forEach(function (entry)
  {
    if (detail === "full")
    {
      wasDrawConnectionLabel(context, entry, camera);
    }
    else if (detail === "name" && (entry.level >= 2 || entry.pair.conflicts.length))
    {
      wasDrawConnectionDot(context, entry, camera);
    }
  });
  context.globalAlpha = 1;
  return visible;
}

/* Ports sit where a line meets a card; an end that carries an arrowhead needs no port. */
function wasDrawPorts(context, entries, camera)
{
  var unit = 1 / Math.max(.45, camera.scale);
  entries.forEach(function (entry)
  {
    var points = entry.route.points;
    var ends = [{ point: points[0], arrow: entry.pair.reverse.edges.length > 0 }, { point: points[points.length - 1], arrow: entry.pair.forward.edges.length > 0 }];
    context.globalAlpha = [.3, entry.muted ? .5 : .95, 1, 1][entry.level];
    context.fillStyle = wasGraphColors.canvasBg;
    context.strokeStyle = entry.color;
    context.lineWidth = 1.5 * unit;
    ends.forEach(function (end)
    {
      if (end.arrow)
      {
        return;
      }
      context.beginPath();
      context.arc(end.point.x, end.point.y, 3.2 * unit, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    });
  });
  context.globalAlpha = 1;
}

/* The muted run of text after the provider name on a graph card: role, team, origin, activity scope. */
function wasCardTagText(row, node, activity)
{
  var text = "";
  if (row.manager)
  {
    text = " · " + wasT("app.card.manages", { count: row.managedCount });
  }
  else if (node.role)
  {
    text = " · " + node.role;
  }
  else if (row.team)
  {
    text = " · " + wasT("app.card.teamMember");
  }
  else if (node.kind === "agent")
  {
    text = " · " + wasT("app.card.originalAgent");
  }
  if (node.kind === "unresolved")
  {
    text += " · " + wasT("app.card.unresolved");
  }
  if (activity.category !== "recent")
  {
    text += " · " + (row.quiet ? wasT("app.card.quietContext") : wasActivityName(activity.category));
  }
  return text;
}

/* Status glyphs differ in shape, not only in color: spinner, clock, check, alert, bar ring, dotted ring. */
function wasDrawStatusIcon(context, status, x, y, radius, color, spin)
{
  var tau = Math.PI * 2;
  context.lineWidth = 1.7;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.fillStyle = color;
  if (status === "completed" || status === "interrupted")
  {
    context.globalAlpha = .2;
    context.beginPath();
    context.arc(x, y, radius, 0, tau);
    context.fill();
  }
  context.globalAlpha = status === "running" ? .3 : 1;
  context.beginPath();
  context.arc(x, y, radius, 0, tau);
  context.stroke();
  context.globalAlpha = 1;
  context.beginPath();
  if (status === "running")
  {
    context.arc(x, y, radius, spin, spin + Math.PI * 1.15);
  }
  else if (status === "completed")
  {
    context.moveTo(x - radius * .42, y + radius * .02);
    context.lineTo(x - radius * .1, y + radius * .36);
    context.lineTo(x + radius * .46, y - radius * .3);
  }
  else if (status === "waiting")
  {
    context.moveTo(x, y - radius * .5);
    context.lineTo(x, y);
    context.lineTo(x + radius * .38, y + radius * .22);
  }
  else if (status === "interrupted")
  {
    context.moveTo(x, y - radius * .5);
    context.lineTo(x, y + radius * .1);
    context.moveTo(x, y + radius * .44);
    context.lineTo(x, y + radius * .46);
  }
  else if (status === "idle")
  {
    context.moveTo(x - radius * .3, y);
    context.lineTo(x + radius * .3, y);
  }
  else
  {
    // unknown: a ring with a dot
    context.moveTo(x, y);
    context.lineTo(x, y + .01);
  }
  context.stroke();
}

/* One gradient per card height, defined in card space so every card can reuse it. */
function wasCardGradient(context, height)
{
  var key = height + wasGraphColors.nodeTop + wasGraphColors.node;
  if (!wasState.cardGradients.has(key))
  {
    var gradient = null;
    try
    {
      gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, wasGraphColors.nodeTop);
      gradient.addColorStop(1, wasGraphColors.node);
    }
    catch (error)
    {
      gradient = null;
    }
    wasState.cardGradients.set(key, gradient);
  }
  return wasState.cardGradients.get(key);
}

function wasDrawCardShell(context, card, camera, detail, running, now)
{
  var point = card.point;
  var unit = 1 / Math.max(.5, camera.scale);
  if (card.selected)
  {
    context.globalAlpha = .22;
    context.strokeStyle = wasGraphColors.accent;
    context.lineWidth = 5 * unit;
    wasCanvasRoundRect(context, point.x - 2, point.y - 2, point.width + 4, point.height + 4, 14);
    context.stroke();
  }
  if (running)
  {
    context.strokeStyle = wasGraphColors.running;
    context.globalAlpha = wasState.reducedMotion.matches ? .2 : .12 + .12 * (1 + Math.sin(now / 1100));
    context.lineWidth = 2 * unit;
    wasCanvasRoundRect(context, point.x - 4, point.y - 4, point.width + 8, point.height + 8, 16);
    context.stroke();
  }
  context.globalAlpha = 1;
  var plain = !card.selected && !card.past && !card.row.context;
  var base = card.selected ? wasGraphColors.nodeSelected : card.past ? wasGraphColors.nodePast : card.row.context ? wasGraphColors.nodeContext : wasGraphColors.node;
  var gradient = plain && detail !== "block" ? wasCardGradient(context, point.height) : null;
  if (gradient)
  {
    context.save();
    context.translate(point.x, point.y);
    context.fillStyle = gradient;
    wasCanvasRoundRect(context, 0, 0, point.width, point.height, 12);
    context.fill();
    context.restore();
  }
  else
  {
    context.fillStyle = base;
    wasCanvasRoundRect(context, point.x, point.y, point.width, point.height, 12);
    context.fill();
  }
  if (detail === "block")
  {
    context.globalAlpha = card.past ? .1 : .28;
    context.fillStyle = card.statusColor;
    context.fill();
    context.globalAlpha = 1;
  }
  context.strokeStyle = card.selected ? wasGraphColors.accent : card.conflict ? wasGraphColors.conflict : card.hovered ? wasGraphColors.nodeHover : wasGraphColors.nodeStroke;
  context.lineWidth = (card.selected ? 1.6 : card.hovered ? 1.3 : 1) * unit;
  context.stroke();
  if (card.manager)
  {
    context.fillStyle = wasGraphColors.management;
    wasCanvasRoundRect(context, point.x + 16, point.y - 1.25, 36, 2.5, 1.25);
    context.fill();
  }
  context.fillStyle = card.past ? wasGraphColors.edgeMuted : wasCanvasProviderColor(card.node.provider);
  wasCanvasRoundRect(context, point.x - 1.5, point.y + 18, 3, point.height - 36, 1.5);
  context.fill();
}

/* The share of the messages a session sent that are already resolved; the unresolved share shows in the waiting color. */
function wasDrawCardQueue(context, card, y)
{
  var point = card.point;
  var queue = wasState.messageSummary.nodes.get(card.row.id) || { sent: 0, received: 0, unresolved: 0 };
  wasCanvasSegments(context, [
    { text: wasT("app.card.queueCounts", { sent: queue.sent, received: queue.received }) + "  · ", color: wasGraphColors.muted },
    { text: wasT("app.card.queueUnresolved", { unresolved: queue.unresolved }), color: queue.unresolved ? wasGraphColors.waiting : wasGraphColors.muted }
  ], point.x + 14, y, point.width - 28);
  var total = queue.sent;
  var width = point.width - 28;
  var waiting = Math.min(total, queue.unresolved);
  context.fillStyle = wasGraphColors.nodeStroke;
  context.globalAlpha = .7;
  wasCanvasRoundRect(context, point.x + 14, y + 8, width, 3.5, 1.75);
  context.fill();
  context.globalAlpha = 1;
  if (total)
  {
    context.fillStyle = wasGraphColors.teal;
    wasCanvasRoundRect(context, point.x + 14, y + 8, Math.max(3.5, width * (total - waiting) / total), 3.5, 1.75);
    context.fill();
    if (waiting)
    {
      context.fillStyle = wasGraphColors.waiting;
      wasCanvasRoundRect(context, point.x + 14 + width * (total - waiting) / total, y + 8, Math.max(3.5, width * waiting / total), 3.5, 1.75);
      context.fill();
    }
  }
}

function wasDrawCardText(context, card, camera, operating, running, now)
{
  var point = card.point;
  var node = card.node;
  var row = card.row;
  var detail = wasRamp(camera.scale, .5, .7);
  var size = Math.min(24, Math.max(13.5, 10.8 / camera.scale));
  var spin = running && !wasState.reducedMotion.matches ? now / 900 % 1 * Math.PI * 2 - Math.PI / 2 : -Math.PI / 2;
  wasDrawStatusIcon(context, node.status, point.x + point.width - 20, point.y + 20, 8, card.statusColor, spin);
  if (detail > .02)
  {
    context.globalAlpha = detail;
    context.font = "600 11px " + wasCanvasFontFamily;
    wasCanvasSegments(context, [
      { text: node.provider.toUpperCase(), color: card.past ? wasGraphColors.muted : wasCanvasProviderColor(node.provider) },
      { text: wasCardTagText(row, node, card.activity), color: wasGraphColors.muted },
      { text: card.conflict ? " · " + wasT("app.card.conflict") : "", color: wasGraphColors.conflictText }
    ], point.x + 14, point.y + 20, point.width - 52);
    context.font = "11px " + wasCanvasFontFamily;
    var hiddenActivity = wasState.view.hiddenActivityDescendants.get(row.id) || 0;
    var activityText = hiddenActivity ? wasT("app.card.hiddenByScope", { count: hiddenActivity }) : node.description || node.statusEvidence || wasRelativeTime(node.lastSeen);
    wasCanvasSegments(context, [
      { text: wasStatusName(node.status), color: card.past ? wasGraphColors.muted : wasGraphColors[node.status] || wasGraphColors.text2 },
      { text: " · " + wasText(activityText), color: wasGraphColors.muted }
    ], point.x + 14, point.y + 61, wasState.model.descendants.get(row.id) ? 156 : 198);
    if (wasState.model.descendants.get(row.id))
    {
      context.fillStyle = wasGraphColors.text2;
      context.textAlign = "right";
      context.fillText((row.expanded ? "▾ " : "▸ ") + wasFormatNumber(wasState.model.descendants.get(row.id)), point.x + point.width - 13, point.y + 61);
      context.textAlign = "left";
    }
    if (operating)
    {
      wasDrawCardQueue(context, card, point.y + 81);
    }
    context.globalAlpha = 1;
  }
  // The name grows as the card shrinks and settles in the middle once the detail rows have faded.
  context.font = "600 " + size + "px " + wasCanvasFontFamily;
  context.fillStyle = row.context ? wasGraphColors.text2 : wasGraphColors.text;
  context.fillText(wasCanvasText(context, node.name, point.width - 28), point.x + 14, point.y + 41 + (1 - detail) * (point.height / 2 + size * .35 - 41));
}

/* A far-away team head keeps a readable name on its block. */
function wasDrawBlockTitle(context, card, camera)
{
  var point = card.point;
  var size = Math.min(56, 11 / camera.scale);
  context.font = "700 " + size + "px " + wasCanvasFontFamily;
  context.fillStyle = wasGraphColors.text;
  context.textAlign = "center";
  context.fillText(wasCanvasText(context, card.node.name, point.width - 16), point.x + point.width / 2, point.y + point.height / 2 + size * .35);
  context.textAlign = "left";
}

function wasDrawCard(context, card, camera, detail, operating, now)
{
  var running = card.node.status === "running" && card.activity.category === "recent" && !card.node.archived;
  card.statusColor = card.past ? wasGraphColors.edgeMuted : wasGraphColors[card.node.status] || wasGraphColors.unknown;
  wasDrawCardShell(context, card, camera, detail, running && !card.veil, now);
  if (detail !== "block")
  {
    wasDrawCardText(context, card, camera, operating, running, now);
  }
  else if (card.manager)
  {
    wasDrawBlockTitle(context, card, camera);
  }
  if (card.veil)
  {
    context.globalAlpha = card.veil;
    context.fillStyle = wasGraphColors.canvasBg;
    wasCanvasRoundRect(context, card.point.x, card.point.y, card.point.width, card.point.height, 12);
    context.fill();
    context.globalAlpha = 1;
  }
  return running;
}

/* The dots belong to the world: they follow the pan and the zoom, and thin out by halves before they crowd. */
function wasDrawGraphGrid(context, camera, width, height)
{
  var scale = Math.max(1e-6, camera.scale);
  var step = 28;
  while (step * scale < 24)
  {
    step *= 2;
  }
  while (step * scale > 48)
  {
    step /= 2;
  }
  var spacing = step * scale;
  var gridX = ((camera.x % spacing) + spacing) % spacing;
  var gridY = ((camera.y % spacing) + spacing) % spacing;
  var size = spacing > 30 ? 1.6 : 1.2;
  context.fillStyle = wasGraphColors.canvasGrid;
  for (var x = gridX; x < width; x += spacing)
  {
    for (var y = gridY; y < height; y += spacing)
    {
      context.fillRect(x, y, size, size);
    }
  }
}

/* The overview appears only while part of the graph lies outside the view. Coordinates are canvas pixels. */
function wasMinimapLayout(bounds, camera, canvasWidth, canvasHeight, count)
{
  if (!bounds || count < 8 || canvasWidth < 700 || canvasHeight < 300)
  {
    return null;
  }
  var inside = camera.x >= -2 && camera.y >= -2 && camera.x + bounds.width * camera.scale <= canvasWidth + 2 && camera.y + bounds.height * camera.scale <= canvasHeight + 2;
  if (inside)
  {
    return null;
  }
  var scale = Math.min(220 / bounds.width, 130 / bounds.height);
  var width = Math.max(56, bounds.width * scale);
  var height = Math.max(36, bounds.height * scale);
  return { x: canvasWidth - width - 12, y: canvasHeight - height - 60, width: width, height: height, scale: scale };
}

function wasMinimapContains(x, y)
{
  var layout = wasState.minimap;
  return !!layout && x >= layout.x - 4 && x <= layout.x + layout.width + 4 && y >= layout.y - 4 && y <= layout.y + layout.height + 4;
}

/* Centers the view on the world point under a minimap pixel. */
function wasPanToMinimap(clientX, clientY)
{
  var layout = wasState.minimap;
  if (!layout)
  {
    return;
  }
  var rect = wasElements.canvas.getBoundingClientRect();
  var x = (clientX - rect.left - layout.x) / layout.scale;
  var y = (clientY - rect.top - layout.y) / layout.scale;
  wasState.camera.x = wasState.canvasWidth / 2 - x * wasState.camera.scale;
  wasState.camera.y = wasState.canvasHeight / 2 - y * wasState.camera.scale;
  wasRequestGraphDraw();
}

function wasDrawMinimap(context, camera, width, height)
{
  var layout = wasMinimapLayout(wasState.graphBounds, camera, width, height, wasState.graphPositions.size);
  wasState.minimap = layout;
  if (!layout)
  {
    return;
  }
  context.globalAlpha = .94;
  context.fillStyle = wasGraphColors.minimapBg;
  context.strokeStyle = wasGraphColors.nodeStroke;
  context.lineWidth = 1;
  wasCanvasRoundRect(context, layout.x, layout.y, layout.width, layout.height, 8);
  context.fill();
  context.stroke();
  context.globalAlpha = 1;
  context.save();
  wasCanvasRoundRect(context, layout.x, layout.y, layout.width, layout.height, 8);
  context.clip();
  context.fillStyle = wasGraphColors.laneStroke;
  context.globalAlpha = .5;
  wasState.graphLanes.forEach(function (lane)
  {
    context.fillRect(layout.x + lane.x * layout.scale, layout.y + lane.y * layout.scale, lane.width * layout.scale, lane.height * layout.scale);
  });
  context.globalAlpha = 1;
  wasState.graphPositions.forEach(function (point, id)
  {
    var node = wasState.model.nodeMap.get(id);
    var past = wasState.model.activity.get(id).category !== "recent";
    context.fillStyle = id === wasState.selectedId ? wasGraphColors.accent : past ? wasGraphColors.edgeMuted : wasGraphColors[node.status] || wasGraphColors.unknown;
    context.fillRect(layout.x + point.x * layout.scale, layout.y + point.y * layout.scale, Math.max(2, point.width * layout.scale), Math.max(1.6, point.height * layout.scale));
  });
  var left = layout.x - camera.x / camera.scale * layout.scale;
  var top = layout.y - camera.y / camera.scale * layout.scale;
  context.fillStyle = wasGraphColors.accent;
  context.globalAlpha = .1;
  context.fillRect(left, top, width / camera.scale * layout.scale, height / camera.scale * layout.scale);
  context.globalAlpha = 1;
  context.strokeStyle = wasGraphColors.accent;
  context.lineWidth = 1.2;
  context.strokeRect(left, top, width / camera.scale * layout.scale, height / camera.scale * layout.scale);
  context.restore();
}

function wasDrawGraph()
{
  if (!wasState.view || wasState.viewMode !== "graph" || !wasState.canvasWidth || !wasState.canvasHeight)
  {
    return;
  }
  var context = wasElements.canvas.getContext("2d");
  if (!context)
  {
    return;
  }
  var ratio = wasState.pixelRatio;
  var camera = wasState.camera;
  var width = wasState.canvasWidth;
  var height = wasState.canvasHeight;
  var now = Date.now();
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = wasGraphColors.canvasBg;
  context.fillRect(0, 0, width, height);
  if (wasElements.showGrid.checked)
  {
    wasDrawGraphGrid(context, camera, width, height);
  }
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);
  var viewport = { left: -camera.x / camera.scale, top: -camera.y / camera.scale, right: (width - camera.x) / camera.scale, bottom: (height - camera.y) / camera.scale };
  var focus = wasGraphFocus();
  var detail = wasGraphDetail(camera.scale);
  wasDrawLanes(context, viewport, camera, focus, detail);
  var connections = wasDrawConnections(context, viewport, camera, focus, now, detail);
  // How often the graph must redraw to stay alive: beams need a smooth frame rate, a spinning ring only a slow one.
  var live = detail !== "block" && connections.some(function (entry) { return entry.style.flowing && !entry.muted; }) ? 50 : 0;
  var operating = wasElements.graphLayout.value === "operating";
  var startRow = operating ? 0 : Math.max(0, Math.floor((viewport.top - 115) / wasNativeStep.y));
  var endRow = operating ? wasState.graphRows.length : Math.min(wasState.graphRows.length, Math.ceil((viewport.bottom + 77) / wasNativeStep.y));
  for (var index = startRow; index < endRow; index += 1)
  {
    var row = wasState.graphRows[index];
    var point = wasState.graphPositions.get(row.id);
    if (point.x > viewport.right || point.x + point.width < viewport.left || point.y > viewport.bottom || point.y + point.height < viewport.top)
    {
      continue;
    }
    var node = wasState.model.nodeMap.get(row.id);
    var activity = wasState.model.activity.get(row.id);
    var card =
    {
      row: row,
      point: point,
      node: node,
      activity: activity,
      selected: row.id === wasState.selectedId,
      hovered: row.id === wasState.hoverId,
      conflict: !!(node.conflicts.length || wasState.model.nodeIssues.get(row.id).length),
      past: !!row.context && activity.category !== "recent",
      manager: operating && !!row.manager,
      veil: focus && !focus.ids.has(row.id) ? (focus.soft ? .38 : .64) : 0
    };
    if (wasDrawCard(context, card, camera, detail, operating, now) && !card.veil)
    {
      live = live || 100;
    }
  }
  if (detail !== "block")
  {
    wasDrawPorts(context, connections, camera);
  }
  wasDrawObservationPulses(context);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  wasDrawMinimap(context, camera, width, height);
  wasElements.zoomLabel.textContent = Math.round(camera.scale * 1000) / 10 + "%";
  wasState.graphLive = live;
  wasScheduleGraphAnimation();
}

function wasFitGraph()
{
  if (wasState.viewMode !== "graph")
  {
    // The layout of a hidden graph is out of date; it is fitted when the graph is shown.
    wasState.graphInitialized = false;
    return;
  }
  if (!wasState.graphBounds || !wasState.graphPositions.size)
  {
    return;
  }
  wasResizeGraph();
  var width = wasState.canvasWidth || 600;
  var height = wasState.canvasHeight || 450;
  var bounds = wasState.graphBounds;
  var scale = Math.min(1, (width - 55) / Math.max(1, bounds.width), (height - 55) / Math.max(1, bounds.height));
  wasState.camera = { x: (width - bounds.width * scale) / 2, y: (height - bounds.height * scale) / 2, scale: Math.max(Number.EPSILON, scale) };
  wasRequestGraphDraw();
}

function wasCenterNode(id)
{
  if (wasState.viewMode !== "graph" || !wasState.graphPositions)
  {
    wasState.pendingCenterId = id;
    return;
  }
  var point = wasState.graphPositions.get(id);
  if (!point)
  {
    return;
  }
  var scale = Math.max(.6, wasState.camera.scale);
  wasState.camera = { x: wasState.canvasWidth / 2 - (point.x + point.width / 2) * scale, y: wasState.canvasHeight / 2 - (point.y + point.height / 2) * scale, scale: scale };
  wasRequestGraphDraw();
}

function wasZoomGraph(factor, x, y)
{
  var camera = wasState.camera;
  var next = Math.min(4, Math.max(Number.EPSILON, camera.scale * factor));
  camera.x = x - (x - camera.x) * next / camera.scale;
  camera.y = y - (y - camera.y) * next / camera.scale;
  camera.scale = next;
  wasRequestGraphDraw();
}

function wasHitGraph(clientX, clientY)
{
  var rect = wasElements.canvas.getBoundingClientRect();
  var x = (clientX - rect.left - wasState.camera.x) / wasState.camera.scale;
  var y = (clientY - rect.top - wasState.camera.y) / wasState.camera.scale;
  if (wasElements.graphLayout.value === "operating")
  {
    var found = null;
    wasState.graphPositions.forEach(function (point, id)
    {
      if (x >= point.x && x <= point.x + point.width && y >= point.y && y <= point.y + point.height)
      {
        found = id;
      }
    });
    return found;
  }
  var index = Math.floor((y - 38) / wasNativeStep.y);
  if (index < 0 || index >= wasState.view.rows.length)
  {
    return null;
  }
  var row = wasState.view.rows[index];
  var point = wasState.graphPositions.get(row.id);
  return x >= point.x && x <= point.x + point.width && y >= point.y && y <= point.y + point.height ? row.id : null;
}

/* A pointer the browser no longer tracks makes setPointerCapture throw; dragging then simply goes without it. */
function wasCapturePointer(event)
{
  try
  {
    wasElements.canvas.setPointerCapture(event.pointerId);
  }
  catch (error)
  {
    return;
  }
}

/* The connection whose label or dot lies under the pointer; the last one drawn wins. */
function wasHitLabel(clientX, clientY)
{
  var rect = wasElements.canvas.getBoundingClientRect();
  var x = (clientX - rect.left - wasState.camera.x) / wasState.camera.scale;
  var y = (clientY - rect.top - wasState.camera.y) / wasState.camera.scale;
  var hit = wasState.graphLabelHits.slice().reverse().find(function (label)
  {
    return x >= label.left && x <= label.right && y >= label.top && y <= label.bottom;
  });
  return hit ? hit.id : "";
}

function wasUpdateHover(clientX, clientY)
{
  if (!wasState.view)
  {
    return;
  }
  var rect = wasElements.canvas.getBoundingClientRect();
  var overMap = wasMinimapContains(clientX - rect.left, clientY - rect.top);
  var id = overMap ? null : wasHitGraph(clientX, clientY);
  var pairId = overMap || id ? "" : wasHitLabel(clientX, clientY);
  wasElements.canvas.classList.toggle("was-hovering", !!(id || pairId || overMap));
  if (id !== wasState.hoverId || pairId !== wasState.hoverPairId)
  {
    wasState.hoverId = id;
    wasState.hoverPairId = pairId;
    wasRequestGraphDraw();
  }
}

function wasSetView(mode)
{
  if (mode !== wasState.viewMode && wasState.replayStatus) wasStopReplay();
  if (mode !== wasState.viewMode)
  {
    wasState.selectedPairId = null;
    wasState.hoverId = null;
    wasState.hoverPairId = "";
    wasState.minimapDrag = false;
  }
  clearTimeout(wasState.animationTimer);
  if (mode === "office" && wasState.viewMode !== "office") wasState.officeAutoReplay = true;
  wasState.viewMode = mode;
  wasElements.treeView.hidden = mode !== "tree";
  wasElements.graphView.hidden = mode !== "graph";
  wasElements.officeView.hidden = mode !== "office";
  document.body.classList.toggle("was-office-mode", mode === "office");
  wasElements.viewTree.classList.toggle("was-active", mode === "tree");
  wasElements.viewGraph.classList.toggle("was-active", mode === "graph");
  wasElements.viewOffice.classList.toggle("was-active", mode === "office");
  wasElements.viewTree.setAttribute("aria-pressed", mode === "tree" ? "true" : "false");
  wasElements.viewGraph.setAttribute("aria-pressed", mode === "graph" ? "true" : "false");
  wasElements.viewOffice.setAttribute("aria-pressed", mode === "office" ? "true" : "false");
  if (wasState.officeScene) wasState.officeScene.setVisible(mode === "office" && !document.hidden);
  if (wasState.view)
  {
    wasElements.empty.hidden = mode === "graph" ? wasState.graphRows.length > 0 : wasState.view.rows.length > 0;
  }
  if (mode === "graph")
  {
    if (wasState.graphStale && wasState.model && wasState.view)
    {
      wasBuildGraph();
    }
    wasResizeGraph();
    if (!wasState.graphInitialized && wasState.model)
    {
      wasFitGraph();
      wasState.graphInitialized = true;
    }
    if (wasState.pendingCenterId)
    {
      // A selection made while the graph was hidden asked to be centered; only the current one still matters.
      var pending = wasState.pendingCenterId;
      wasState.pendingCenterId = "";
      if (pending === wasState.selectedId)
      {
        wasCenterNode(pending);
      }
    }
    wasRequestGraphDraw();
  }
  else if (mode === "office")
  {
    wasUpdateOffice();
    if (wasState.officeScene) wasState.officeScene.resize();
  }
  else
  {
    wasRenderTree();
    if (wasState.selectedId)
    {
      wasScrollToNode(wasState.selectedId);
    }
  }
  if (wasState.model)
  {
    wasRenderViewScope();
    wasRenderDetails();
    wasRenderOverview();
  }
  wasSavePreferences();
}

function wasRenderHealth()
{
  var partial = !!(wasState.snapshot && wasState.snapshot.stats && wasState.snapshot.stats.loading);
  var connected = wasState.connected && !wasState.loadError;
  wasElements.liveBadge.classList.toggle("was-live", connected && !partial);
  wasElements.liveBadge.textContent = wasState.loadError ? wasT("app.health.badgeCheck") : partial ? wasT("app.health.badgePartial") : connected ? wasT("app.health.badgeLive") : wasT("app.health.badgeAuto");
  wasElements.updated.textContent = wasState.snapshot ? wasT("app.health.observed", { time: wasDateTime(wasState.snapshot.generatedAt || wasState.lastSuccess) }) : wasT("app.health.loading");
  var notice = [];
  if (wasState.loadError)
  {
    if (wasState.snapshot)
    {
      notice.push(wasT("app.health.lastData"));
    }
    notice.push(wasT("app.health.loadFailed", { error: wasResolveText(wasState.loadError) }));
  }
  if (partial)
  {
    notice.push(wasT("app.health.partial"));
  }
  var diagnostics = wasState.snapshot && Array.isArray(wasState.snapshot.diagnostics) ? wasState.snapshot.diagnostics : [];
  var warningCount = diagnostics.filter(function (item)
  {
    return item.level === "error" || item.level === "warning" || item.level === "warn";
  }).length;
  if (warningCount)
  {
    notice.push(wasT("app.health.warnings", { count: warningCount }));
  }
  wasElements.notice.hidden = !notice.length;
  wasElements.notice.textContent = notice.join(" ");
  if (!wasState.snapshot && wasState.loadError)
  {
    wasElements.resultCount.textContent = wasT("app.health.waitingSnapshot");
    wasElements.empty.hidden = false;
    wasElements.emptyTitle.textContent = wasT("app.health.serverUnreachable");
    wasElements.emptyText.textContent = wasT("app.health.serverHint");
  }
}

function wasRenderDiagnostics()
{
  var snapshot = wasState.snapshot;
  if (!snapshot)
  {
    return;
  }
  wasClearElement(wasElements.diagnostics);
  wasElements.diagnostics.appendChild(wasCreateElement("h2", "", wasT("app.diagnostics.title")));
  wasElements.diagnostics.appendChild(wasCreateElement("p", "", wasT("app.diagnostics.overview", { version: wasText(snapshot.version), generated: wasDateTime(snapshot.generatedAt), nodes: wasFormatNumber(wasState.model.nodes.length), relations: wasFormatNumber(wasState.model.edges.length) })));
  var statuses = snapshot.sourceStatus;
  if (Array.isArray(statuses))
  {
    statuses.forEach(function (source)
    {
      var summary = [];
      var sourceName = source.provider || source.name || source.kind || source.path;
      if (sourceName)
      {
        summary.push(wasText(sourceName));
      }
      if (typeof source.files !== "undefined")
      {
        summary.push(wasT("app.diagnostics.files", { count: source.files }));
      }
      if (typeof source.fileCount !== "undefined")
      {
        summary.push(wasT("app.diagnostics.files", { count: source.fileCount }));
      }
      if (typeof source.filesScanned !== "undefined")
      {
        summary.push(wasT("app.diagnostics.filesScanned", { count: source.filesScanned }));
      }
      if (typeof source.bytesRead !== "undefined")
      {
        summary.push(wasT("app.diagnostics.bytesRead", { size: wasFormatBytes(source.bytesRead) }));
      }
      if (typeof source.skippedHistoryBytes !== "undefined")
      {
        summary.push(wasT("app.diagnostics.skippedHistory", { size: wasFormatBytes(source.skippedHistoryBytes) }));
      }
      if (source.lastScanAt)
      {
        summary.push(wasT("app.diagnostics.lastScan", { time: wasDateTime(source.lastScanAt) }));
      }
      if (source.status)
      {
        summary.push(wasText(source.status));
      }
      wasElements.diagnostics.appendChild(wasCreateElement("p", "", summary.length ? summary.join(" · ") : wasSourceText(source)));
    });
  }
  else if (statuses && typeof statuses === "object")
  {
    Object.keys(statuses).forEach(function (key)
    {
      wasElements.diagnostics.appendChild(wasCreateElement("p", "", key + " · " + wasText(statuses[key])));
    });
  }
  var diagnostics = Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
  if (!diagnostics.length)
  {
    wasElements.diagnostics.appendChild(wasCreateElement("p", "", wasT("app.diagnostics.none")));
  }
  if (diagnostics.length)
  {
    wasElements.diagnostics.appendChild(wasCreateElement("p", "", wasT("app.diagnostics.reported", { count: diagnostics.length, shown: wasFormatNumber(Math.min(diagnostics.length, wasState.diagnosticsLimit)) })));
  }
  diagnostics.slice(0, wasState.diagnosticsLimit).forEach(function (diagnostic)
  {
    var row = wasCreateElement("p", "");
    row.appendChild(wasCreateElement("strong", "was-level-" + wasText(diagnostic.level).toLowerCase().replace(/[^a-z]/g, ""), "[" + wasText(diagnostic.level) + "] " + wasText(diagnostic.code) + " "));
    row.appendChild(document.createTextNode(wasText(diagnostic.message)));
    if (diagnostic.source)
    {
      row.appendChild(document.createTextNode(" · " + wasSourceText(diagnostic.source)));
    }
    wasElements.diagnostics.appendChild(row);
  });
  if (diagnostics.length > wasState.diagnosticsLimit)
  {
    var more = wasCreateElement("button", "was-button was-button-subtle", wasT("app.more.next50", { count: diagnostics.length - wasState.diagnosticsLimit }));
    more.type = "button";
    more.setAttribute("data-was-action", "more-diagnostics");
    wasElements.diagnostics.appendChild(more);
  }
}

function ajax_wasLoadSnapshot()
{
  if (wasState.fetching)
  {
    wasState.fetchAgain = true;
    return;
  }
  wasState.fetching = true;
  wasElements.refresh.disabled = true;
  fetch("/api/snapshot", { cache: "no-store", headers: { Accept: "application/json" } }).then(function (response)
  {
    if (!response.ok)
    {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  }).then(function (snapshot)
  {
    if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges))
    {
      throw new Error(wasToken("app.error.snapshotFormat"));
    }
    wasUpdateSnapshot(snapshot);
  }).catch(function (error)
  {
    wasState.loadError = error.message;
    wasRenderHealth();
  }).finally(function ()
  {
    wasState.fetching = false;
    wasElements.refresh.disabled = false;
    if (wasState.fetchAgain)
    {
      wasState.fetchAgain = false;
      wasScheduleSnapshot();
    }
  });
}

function wasScheduleSnapshot()
{
  clearTimeout(wasState.fetchTimer);
  wasState.fetchTimer = setTimeout(ajax_wasLoadSnapshot, 180);
}

function wasConnectEvents()
{
  if (typeof EventSource === "undefined")
  {
    wasRenderHealth();
    return;
  }
  wasState.events = new EventSource("/api/events");
  wasState.events.addEventListener("open", function ()
  {
    wasState.connected = true;
    wasRenderHealth();
    wasScheduleSnapshot();
  });
  wasState.events.addEventListener("update", function (event)
  {
    try
    {
      var update = JSON.parse(event.data);
      if (!wasState.snapshot || update.version !== wasState.snapshot.version)
      {
        wasScheduleSnapshot();
      }
    }
    catch (error)
    {
      wasScheduleSnapshot();
    }
  });
  wasState.events.addEventListener("error", function ()
  {
    wasState.connected = false;
    wasRenderHealth();
  });
}

function didChangeWasFilter()
{
  wasStopReplay();
  clearTimeout(wasState.filterTimer);
  wasState.filterTimer = setTimeout(function ()
  {
    wasState.graphInitialized = false;
    wasUpdateView(true);
  }, 130);
}

function wasResetFilters(allProjects)
{
  wasStopReplay();
  wasElements.search.value = "";
  wasElements.project.value = "";
  wasElements.provider.value = "";
  wasElements.activity.value = allProjects ? "all" : "recent";
  wasElements.status.value = "";
  wasElements.kind.value = "";
  wasState.focusId = null;
  wasState.graphInitialized = false;
  wasUpdateView(true);
}

function didKeydownWasTree(event)
{
  if (!wasState.view || !wasState.view.rows.length)
  {
    return;
  }
  var rows = wasState.view.rows;
  var index = wasState.view.rowIndex.get(wasState.activeId);
  if (typeof index !== "number")
  {
    index = 0;
  }
  var item = rows[index];
  var next = index;
  if (event.key === "ArrowDown")
  {
    next = Math.min(rows.length - 1, index + 1);
  }
  else if (event.key === "ArrowUp")
  {
    next = Math.max(0, index - 1);
  }
  else if (event.key === "Home")
  {
    next = 0;
  }
  else if (event.key === "End")
  {
    next = rows.length - 1;
  }
  else if (event.key === "PageDown")
  {
    next = Math.min(rows.length - 1, index + Math.floor(wasElements.tree.clientHeight / wasState.rowHeight));
  }
  else if (event.key === "PageUp")
  {
    next = Math.max(0, index - Math.floor(wasElements.tree.clientHeight / wasState.rowHeight));
  }
  else if (event.key === "ArrowRight")
  {
    if (item.children.length && !item.expanded)
    {
      wasToggleNode(item.id);
    }
    else if (item.expanded)
    {
      next = Math.min(rows.length - 1, index + 1);
    }
  }
  else if (event.key === "ArrowLeft")
  {
    if (item.expanded)
    {
      wasToggleNode(item.id);
    }
    else
    {
      var parentIndex = wasState.view.rowIndex.get(wasState.model.parent.get(item.id));
      if (typeof parentIndex === "number")
      {
        next = parentIndex;
      }
    }
  }
  else if (event.key === "Enter")
  {
    wasSelectNode(item.id, false, false);
  }
  else if (event.key === " ")
  {
    wasToggleNode(item.id);
  }
  else
  {
    return;
  }
  event.preventDefault();
  if (rows[next])
  {
    wasState.activeId = rows[next].id;
    wasSelectNode(wasState.activeId, false, false);
    wasScrollToNode(wasState.activeId);
  }
}

function wasBindOfficeEvents()
{
  wasElements.viewOffice.addEventListener("click", function () { wasSetView("office"); });
  wasElements.officeGrouped.addEventListener("change", function ()
  {
    wasStopReplay();
    wasState.officeFloorId = null;
    wasUpdateOffice();
    if (wasState.officeScene) wasState.officeScene.fit();
    wasSavePreferences();
  });
  wasElements.officeOrder.addEventListener("change", function () { wasStopReplay(); wasUpdateOffice(); wasSavePreferences(); });
  wasElements.officeQuiet.addEventListener("change", function () { wasStopReplay(); wasUpdateOffice(); wasSavePreferences(); });
  wasElements.officeFloor.addEventListener("change", function () { wasChooseOfficeFloor(wasElements.officeFloor.value, true); });
  wasElements.officeDown.addEventListener("click", function ()
  {
    if (wasState.officeData) wasChooseOfficeFloor(WasOfficeModel.nextFloor(wasState.officeFloors, wasState.officeFloorId, -1), true);
  });
  wasElements.officeUp.addEventListener("click", function ()
  {
    if (wasState.officeData) wasChooseOfficeFloor(WasOfficeModel.nextFloor(wasState.officeFloors, wasState.officeFloorId, 1), true);
  });
  wasElements.officeLeft.addEventListener("click", function () { if (wasState.officeScene) wasState.officeScene.pan(-0.7); });
  wasElements.officeRight.addEventListener("click", function () { if (wasState.officeScene) wasState.officeScene.pan(0.7); });
  wasElements.officeZoomIn.addEventListener("click", function () { if (wasState.officeScene) wasState.officeScene.zoom(1.2); });
  wasElements.officeZoomOut.addEventListener("click", function () { if (wasState.officeScene) wasState.officeScene.zoom(1 / 1.2); });
  window.addEventListener("pagehide", wasDestroyOffice);
  window.addEventListener("pageshow", function ()
  {
    if (wasState.viewMode === "office" && !wasState.officeScene) wasUpdateOffice();
  });
}

function wasBindEvents()
{
  wasBindOfficeEvents();
  wasElements.showGrid.addEventListener("change", function ()
  {
    try
    {
      localStorage.setItem("was_observatory_show_grid", wasElements.showGrid.checked ? "1" : "0");
    }
    catch (error)
    {
      // Keep the toggle usable when browser storage is unavailable.
    }
    wasRequestGraphDraw();
  });
  wasElements.sidebarToggle.addEventListener("click", function ()
  {
    wasSetSidebar(!wasState.sidebarCollapsed, true);
  });
  wasElements.detailToggle.addEventListener("click", function ()
  {
    wasSetDetail(!wasState.detailCollapsed, true);
  });
  wasElements.treeSort.addEventListener("change", function ()
  {
    wasApplySort(wasParseSort(wasElements.treeSort.value));
  });
  wasElements.treeColumns.addEventListener("click", function (event)
  {
    var button = event.target.closest("[data-was-sort]");
    if (!button)
    {
      return;
    }
    var key = button.getAttribute("data-was-sort");
    var current = wasState.sort || wasDefaultSort;
    wasApplySort({ key: key, direction: current.key === key ? (current.direction === "asc" ? "desc" : "asc") : wasSortFirstDirection[key] });
  });
  wasElements.graphLayout.addEventListener("change", function ()
  {
    wasBuildGraph();
    wasRenderOverview();
    wasFitGraph();
    wasSavePreferences();
  });
  wasElements.showQuiet.addEventListener("change", function ()
  {
    wasBuildGraph();
    wasFitGraph();
    wasSavePreferences();
  });
  wasElements.presentation.addEventListener("click", wasEnterPresentation);
  wasElements.presentationExit.addEventListener("click", wasExitPresentation);
  wasElements.presentationDetail.addEventListener("click", function ()
  {
    var open = document.body.classList.toggle("was-presentation-detail-open");
    wasElements.presentationDetail.setAttribute("aria-expanded", open ? "true" : "false");
  });
  wasElements.presentationFlow.addEventListener("click", function ()
  {
    var open = document.body.classList.toggle("was-presentation-flow-open");
    wasElements.presentationFlow.setAttribute("aria-expanded", open ? "true" : "false");
  });
  wasElements.messageMore.addEventListener("click", function ()
  {
    wasState.messageLimit += 30;
    wasRenderMessageFeed();
  });
  wasElements.messageFeed.addEventListener("click", function (event)
  {
    var button = event.target.closest("[data-was-message-node]");
    if (button)
    {
      wasSelectNode(button.getAttribute("data-was-message-node"), false, true);
      if (wasState.presentation)
      {
        document.body.classList.add("was-presentation-detail-open");
        wasElements.presentationDetail.setAttribute("aria-expanded", "true");
      }
    }
  });
  wasElements.replayFlow.addEventListener("click", wasStartReplay);
  wasElements.connectionList.addEventListener("click", function (event)
  {
    var button = event.target.closest("[data-was-pair-id]");
    if (button)
    {
      wasSelectConnection(button.getAttribute("data-was-pair-id"));
    }
  });
  [wasElements.search, wasElements.project, wasElements.provider, wasElements.activity, wasElements.status, wasElements.kind].forEach(function (element)
  {
    element.addEventListener(element === wasElements.search ? "input" : "change", didChangeWasFilter);
  });
  wasElements.clearFilters.addEventListener("click", function ()
  {
    wasResetFilters(false);
  });
  wasElements.emptyReset.addEventListener("click", function ()
  {
    wasResetFilters(true);
  });
  wasElements.refresh.addEventListener("click", ajax_wasLoadSnapshot);
  wasElements.viewTree.addEventListener("click", function ()
  {
    wasSetView("tree");
  });
  wasElements.viewGraph.addEventListener("click", function ()
  {
    wasSetView("graph");
  });
  wasElements.collapseAll.addEventListener("click", function ()
  {
    wasState.expanded.clear();
    wasUpdateView(false);
    if (wasState.view.forcedExpanded.size)
    {
      wasElements.announcement.textContent = wasT("app.announce.collapseBlocked");
    }
    wasFitGraph();
  });
  wasElements.expandAll.addEventListener("click", function ()
  {
    if (!wasState.model)
    {
      return;
    }
    wasState.model.children.forEach(function (children, id)
    {
      if (children.length)
      {
        wasState.expanded.add(id);
      }
    });
    wasUpdateView(false);
    wasFitGraph();
  });
  wasElements.focusBranch.addEventListener("click", function ()
  {
    wasStopReplay();
    wasState.focusId = wasState.selectedId;
    wasState.expanded.add(wasState.focusId);
    wasUpdateView(true);
    wasFitGraph();
  });
  wasElements.clearFocus.addEventListener("click", function ()
  {
    wasStopReplay();
    wasState.focusId = null;
    wasUpdateView(true);
    wasFitGraph();
  });
  wasElements.resetView.addEventListener("click", function ()
  {
    wasStopReplay();
    wasState.focusId = null;
    wasState.expanded.clear();
    wasUpdateView(true);
    if (wasState.viewMode === "office" && wasState.officeScene) wasState.officeScene.fit();
    else wasFitGraph();
  });
  wasElements.tree.addEventListener("scroll", wasRenderTree, { passive: true });
  wasElements.tree.addEventListener("keydown", didKeydownWasTree);
  wasElements.treeRows.addEventListener("click", function (event)
  {
    var row = event.target.closest("[data-was-node-id]");
    if (!row)
    {
      return;
    }
    var id = row.getAttribute("data-was-node-id");
    if (event.target.closest("[data-was-action='toggle']"))
    {
      wasToggleNode(id);
    }
    else
    {
      wasSelectNode(id, false, false);
    }
    wasState.activeId = id;
    wasElements.tree.focus({ preventScroll: true });
    wasRenderTree();
  });
  wasElements.detail.addEventListener("click", function (event)
  {
    var target = event.target.closest("[data-was-target-id]");
    if (target)
    {
      wasSelectNode(target.getAttribute("data-was-target-id"), true, true);
      wasElements.detail.scrollTop = 0;
    }
    else if (event.target.closest("[data-was-action='close-detail']"))
    {
      wasCloseDetail();
    }
    else if (event.target.closest("[data-was-action='more-relations']"))
    {
      wasState.detailLimit += 20;
      wasRenderDetails();
    }
    else if (event.target.closest("[data-was-action='reveal-selection']"))
    {
      wasSelectNode(wasState.selectedId, true, true);
    }
  });
  wasElements.detail.addEventListener("change", function (event)
  {
    if (event.target.getAttribute("data-was-action") === "detail-relation-type")
    {
      wasState.detailRelationType = event.target.value;
      wasState.detailLimit = 20;
      wasRenderDetails();
      var filter = wasElements.detail.querySelector("[data-was-action='detail-relation-type']");
      if (filter)
      {
        filter.focus({ preventScroll: true });
      }
    }
  });
  wasElements.relationFilters.addEventListener("change", function ()
  {
    wasUpdateGraphEdges();
    wasRequestGraphDraw();
    if (wasState.viewMode === "office")
    {
      wasStopReplay();
      wasUpdateOffice();
      wasRenderDetails();
      wasRenderOverview();
    }
  });
  wasElements.edgeScope.addEventListener("change", function ()
  {
    wasUpdateGraphEdges();
    wasRequestGraphDraw();
    wasSavePreferences();
  });
  wasElements.zoomIn.addEventListener("click", function ()
  {
    wasZoomGraph(1.25, wasState.canvasWidth / 2, wasState.canvasHeight / 2);
  });
  wasElements.zoomOut.addEventListener("click", function ()
  {
    wasZoomGraph(.8, wasState.canvasWidth / 2, wasState.canvasHeight / 2);
  });
  wasElements.fitGraph.addEventListener("click", wasFitGraph);
  wasElements.canvas.addEventListener("wheel", function (event)
  {
    event.preventDefault();
    var rect = wasElements.canvas.getBoundingClientRect();
    wasZoomGraph(Math.exp(-event.deltaY * .0014), event.clientX - rect.left, event.clientY - rect.top);
    wasUpdateHover(event.clientX, event.clientY);
  }, { passive: false });
  wasElements.canvas.addEventListener("pointerdown", function (event)
  {
    if (event.button !== 0)
    {
      return;
    }
    var rect = wasElements.canvas.getBoundingClientRect();
    if (wasMinimapContains(event.clientX - rect.left, event.clientY - rect.top))
    {
      wasCapturePointer(event);
      wasState.minimapDrag = true;
      wasPanToMinimap(event.clientX, event.clientY);
      return;
    }
    wasCapturePointer(event);
    wasState.drag = { x: event.clientX, y: event.clientY, originX: wasState.camera.x, originY: wasState.camera.y, moved: false, pointerId: event.pointerId };
    wasElements.canvas.classList.add("was-dragging");
  });
  wasElements.canvas.addEventListener("pointermove", function (event)
  {
    if (wasState.minimapDrag && !(event.buttons & 1))
    {
      wasState.minimapDrag = false;
    }
    if (wasState.minimapDrag)
    {
      wasPanToMinimap(event.clientX, event.clientY);
      return;
    }
    if (!wasState.drag)
    {
      wasUpdateHover(event.clientX, event.clientY);
      return;
    }
    var dx = event.clientX - wasState.drag.x;
    var dy = event.clientY - wasState.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4)
    {
      wasState.drag.moved = true;
    }
    if (wasState.drag.moved)
    {
      wasState.camera.x = wasState.drag.originX + dx;
      wasState.camera.y = wasState.drag.originY + dy;
      wasRequestGraphDraw();
    }
  });
  wasElements.canvas.addEventListener("pointerup", function (event)
  {
    if (wasState.minimapDrag)
    {
      wasState.minimapDrag = false;
      return;
    }
    if (!wasState.drag)
    {
      return;
    }
    var moved = wasState.drag.moved;
    wasState.drag = null;
    wasElements.canvas.classList.remove("was-dragging");
    if (moved)
    {
      wasUpdateHover(event.clientX, event.clientY);
    }
    if (!moved && wasState.view)
    {
      var id = wasHitGraph(event.clientX, event.clientY);
      if (id)
      {
        wasSelectNode(id, false, false);
      }
      else
      {
        var pairId = wasHitLabel(event.clientX, event.clientY);
        if (pairId)
        {
          wasSelectConnection(pairId);
        }
        else if (wasState.selectedId || wasState.selectedPairId)
        {
          // A click on empty canvas lets go of the selection.
          wasCloseDetail();
        }
      }
    }
  });
  wasElements.canvas.addEventListener("pointercancel", function ()
  {
    wasState.drag = null;
    wasState.minimapDrag = false;
    wasElements.canvas.classList.remove("was-dragging");
  });
  wasElements.canvas.addEventListener("pointerleave", function ()
  {
    wasElements.canvas.classList.remove("was-hovering");
    if (wasState.hoverId || wasState.hoverPairId)
    {
      wasState.hoverId = null;
      wasState.hoverPairId = "";
      wasRequestGraphDraw();
    }
  });
  wasElements.canvas.addEventListener("dblclick", function (event)
  {
    var rect = wasElements.canvas.getBoundingClientRect();
    if (wasMinimapContains(event.clientX - rect.left, event.clientY - rect.top))
    {
      return;
    }
    var id = wasHitGraph(event.clientX, event.clientY);
    if (id)
    {
      wasToggleNode(id);
    }
  });
  wasElements.canvas.addEventListener("keydown", function (event)
  {
    if ((event.key.toLowerCase() === "n" || event.key.toLowerCase() === "p") && !event.ctrlKey && !event.metaKey && wasState.graphRows.length)
    {
      var selectedIndex = wasState.graphRows.findIndex(function (row) { return row.id === wasState.selectedId; });
      var direction = event.key.toLowerCase() === "n" ? 1 : -1;
      var nextIndex = (selectedIndex + direction + wasState.graphRows.length) % wasState.graphRows.length;
      wasSelectNode(wasState.graphRows[nextIndex].id, false, true);
    }
    else if (event.key === "Enter" && wasState.selectedId)
    {
      wasToggleNode(wasState.selectedId);
    }
    else if (event.key === "+" || event.key === "=")
    {
      wasZoomGraph(1.25, wasState.canvasWidth / 2, wasState.canvasHeight / 2);
    }
    else if (event.key === "-")
    {
      wasZoomGraph(.8, wasState.canvasWidth / 2, wasState.canvasHeight / 2);
    }
    else if (event.key === "0")
    {
      wasFitGraph();
    }
    else if (event.key === "Escape" && (wasState.selectedId || wasState.selectedPairId))
    {
      event.stopPropagation();
      wasCloseDetail();
    }
    else if (event.key === "ArrowLeft")
    {
      wasState.camera.x += 50;
    }
    else if (event.key === "ArrowRight")
    {
      wasState.camera.x -= 50;
    }
    else if (event.key === "ArrowUp")
    {
      wasState.camera.y += 50;
    }
    else if (event.key === "ArrowDown")
    {
      wasState.camera.y -= 50;
    }
    else { return; }
    event.preventDefault();
    wasRequestGraphDraw();
  });
  wasElements.diagnosticsToggle.addEventListener("click", function ()
  {
    wasElements.diagnostics.hidden = !wasElements.diagnostics.hidden;
    wasElements.diagnosticsToggle.setAttribute("aria-expanded", wasElements.diagnostics.hidden ? "false" : "true");
  });
  wasElements.diagnostics.addEventListener("click", function (event)
  {
    if (event.target.closest("[data-was-action='more-diagnostics']"))
    {
      wasState.diagnosticsLimit += 50;
      wasRenderDiagnostics();
    }
  });
  document.addEventListener("keydown", function (event)
  {
    if (event.key === "Escape" && wasState.presentation)
    {
      event.preventDefault();
      wasExitPresentation();
      return;
    }
    if (event.altKey && event.key.toLowerCase() === "b")
    {
      event.preventDefault();
      wasSetSidebar(!wasState.sidebarCollapsed, true);
      wasElements.sidebarToggle.focus();
    }
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
    {
      event.preventDefault();
      wasSetSidebar(false, true);
      wasElements.search.focus();
    }
    if (event.key === "Escape" && document.activeElement === wasElements.search)
    {
      wasElements.search.value = "";
      didChangeWasFilter();
      wasElements.tree.focus();
    }
  });
  if (typeof ResizeObserver !== "undefined")
  {
    wasState.resizeObserver = new ResizeObserver(function ()
    {
      wasResizeGraph();
      wasRenderTree();
      if (wasState.officeScene && wasState.viewMode === "office") wasState.officeScene.resize();
      if (wasState.presentation && wasState.viewMode === "graph")
      {
        wasFitGraph();
      }
    });
    wasState.resizeObserver.observe(wasElements.canvasWrap);
    wasState.resizeObserver.observe(wasElements.tree);
    wasState.resizeObserver.observe(wasElements.officeStage);
  }
  window.addEventListener("resize", function ()
  {
    wasResizeGraph();
    wasRenderTree();
    if (wasState.officeScene && wasState.viewMode === "office") wasState.officeScene.resize();
    if (wasState.presentation && wasState.viewMode === "graph")
    {
      wasFitGraph();
    }
  });
  document.addEventListener("visibilitychange", function ()
  {
    wasStopReplay();
    clearTimeout(wasState.animationTimer);
    wasState.flowPulses = [];
    if (wasState.officeScene)
    {
      wasState.officeScene.setVisible(!document.hidden && wasState.viewMode === "office");
      wasState.officeScene.setMotion(!document.hidden && !wasState.reducedMotion.matches);
    }
    if (!document.hidden)
    {
      wasScheduleSnapshot();
      wasRequestGraphDraw();
    }
  });
  if (wasState.reducedMotion.addEventListener)
  {
    wasState.reducedMotion.addEventListener("change", function ()
    {
      wasStopReplay();
      clearTimeout(wasState.animationTimer);
      wasState.flowPulses = [];
      if (wasState.officeScene) wasState.officeScene.setMotion(!wasState.reducedMotion.matches && !document.hidden);
      wasRequestGraphDraw();
    });
  }
}

/* Renders every text this script owns again for the current language and keeps selection, filters, collapsed branches and scroll positions. */
function wasRefreshLocale()
{
  if (!wasState)
  {
    return;
  }
  if (wasState.rawSnapshot)
  {
    // The model holds localized text (relation issues, unresolved targets, server messages), so it is rebuilt from the raw snapshot.
    wasState.snapshot = wasResolveSnapshot(wasState.rawSnapshot);
    wasState.model = wasBuildModel(wasState.snapshot);
    wasState.messageSummary = wasSummarizeMessages(wasState.model.edges);
    wasRefreshFilterOptions();
  }
  wasElements.announcement.textContent = "";
  if (wasState.officeTravel && wasState.officeTravel.kind === "scene" && wasState.officeTravel.info && wasState.officeTravel.info.illustrative)
  {
    wasState.officeTravel = null;
  }
  wasRenderSidebarLabel();
  wasRenderDetailToggleLabel();
  wasElements.replayFlow.textContent = wasState.replayStatus ? wasT("app.replay.stop") : wasT("app.replay.start");
  wasRenderOfficeTravel();
  wasRenderGraphStatus();
  wasUpdateView(false);
  wasRenderHealth();
  wasRenderDiagnostics();
  if (wasState.officeScene && typeof wasState.officeScene.refreshText === "function")
  {
    wasState.officeScene.refreshText();
    // The counterpart cards carry localized text of their own, so they are handed over again.
    wasState.officePartnersSignature = null;
    wasRenderOfficePartners();
  }
}

function wasChangeLocale(value)
{
  if (typeof WasI18n === "undefined")
  {
    return;
  }
  var locale = WasI18n.normalizeLocale(value);
  if (!locale)
  {
    return;
  }
  WasI18n.persistLocale(locale);
  WasI18n.setLocale(locale);
  WasI18n.applyDom(document);
  if (wasState && wasState.detailPlaceholder)
  {
    // The placeholder is detached from the document while a session is selected, so applyDom(document) does not reach it.
    WasI18n.applyDom(wasState.detailPlaceholder);
  }
  wasRefreshLocale();
}

function wasBindLocale()
{
  if (typeof WasI18n === "undefined" || !wasElements.locale)
  {
    return;
  }
  wasElements.locale.value = WasI18n.getLocale();
  wasElements.locale.addEventListener("change", function ()
  {
    wasChangeLocale(wasElements.locale.value);
  });
}

function wasInitialize()
{
  if (typeof WasI18n !== "undefined")
  {
    WasI18n.setLocale(WasI18n.detectBrowserLocale());
    WasI18n.applyDom(document);
  }
  wasGraphColors = wasReadGraphPalette();
  wasState =
  {
    snapshot: null,
    rawSnapshot: null,
    officeTravel: null,
    model: null,
    view: null,
    expanded: new Set(),
    selectedId: null,
    selectedPairId: null,
    activeId: null,
    focusId: null,
    viewMode: "tree",
    rowHeight: 54,
    savedFilters: {},
    detailLimit: 20,
    detailRelationType: "",
    diagnosticsLimit: 50,
    detailPlaceholder: null,
    graphPositions: null,
    graphRows: [],
    operatingView: null,
    officeScene: null,
    officeSceneSignature: null,
    officePartnersSignature: null,
    officeAutoReplay: true,
    officeFloorOptionsKey: null,
    officeData: null,
    officeFloors: [],
    officeFloorId: null,
    officeResizeFrame: null,
    messageState: null,
    messageSummary: null,
    messageLimit: 20,
    projectMessages: [],
    replayTimer: null,
    replayStatus: null,
    replayQueue: [],
    flowPulses: [],
    animationTimer: null,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)"),
    sidebarCollapsed: false,
    detailCollapsed: false,
    sort: { key: wasDefaultSort.key, direction: wasDefaultSort.direction },
    presentation: null,
    graphEdges: [],
    graphRoutes: new Map(),
    graphObstacles: new Map(),
    graphDeliveries: new Map(),
    graphLabelHits: [],
    graphLive: 0,
    laserColors: new Map(),
    graphStale: true,
    pendingCenterId: "",
    graphLanes: [],
    cardGradients: new Map(),
    hoverId: null,
    hoverPairId: "",
    minimap: null,
    minimapDrag: false,
    graphBounds: null,
    camera: { x: 0, y: 0, scale: 1 },
    canvasWidth: 0,
    canvasHeight: 0,
    pixelRatio: 1,
    graphInitialized: false,
    drawFrame: null,
    drag: null,
    resizeObserver: null,
    fetching: false,
    fetchAgain: false,
    fetchTimer: null,
    filterTimer: null,
    connected: false,
    events: null,
    lastSuccess: null,
    loadError: null
  };
  wasElements = {};
  var ids = ["search", "project", "provider", "activity", "activity-summary", "status", "kind", "relation-filters", "clear-filters", "refresh", "live-badge", "updated", "project-label", "stat-total", "stat-total-note", "stat-running", "stat-waiting", "stat-attention", "notice", "view-tree", "view-graph", "collapse-all", "expand-all", "focus-branch", "reset-view", "result-count", "clear-focus", "search-context", "tree-view", "tree", "tree-spacer", "tree-rows", "graph-view", "edge-scope", "graph-count", "canvas-wrap", "graph", "zoom-out", "zoom-label", "zoom-in", "fit-graph", "empty", "empty-title", "empty-text", "empty-reset", "detail", "diagnostics-toggle", "diagnostics", "announcement"];
  ids.forEach(function (id)
  {
    var key = id.replace(/-([a-z])/g, function (match, letter)
    {
      return letter.toUpperCase();
    });
    wasElements[key] = document.getElementById("was-" + id);
  });
  ["sidebar", "sidebar-toggle", "detail-toggle", "tree-sort", "tree-columns", "graph-layout", "show-quiet", "show-grid", "quiet-count", "scene-status", "presentation", "presentation-exit", "presentation-detail", "presentation-flow", "overview-title", "overview-summary", "message-summary", "message-feed", "message-more", "replay-flow", "connection-list", "connection-summary", "view-office", "office-view", "office-grouped", "office-order", "office-quiet", "office-floor", "office-up", "office-down", "office-stage", "office-summary", "office-travel", "office-left", "office-right", "office-zoom-in", "office-zoom-out", "locale"].forEach(function (id)
  {
    var key = id.replace(/-([a-z])/g, function (match, letter) { return letter.toUpperCase(); });
    wasElements[key] = document.getElementById("was-" + id);
  });
  wasElements.canvas = wasElements.graph;
  wasState.detailPlaceholder = wasElements.detail.firstChild;
  while (wasState.detailPlaceholder && wasState.detailPlaceholder.nodeType !== 1)
  {
    wasState.detailPlaceholder = wasState.detailPlaceholder.nextSibling;
  }
  wasElements.graphOmissions = wasCreateElement("div", "was-graph-omissions");
  wasElements.graphOmissions.setAttribute("role", "status");
  wasElements.graphView.insertBefore(wasElements.graphOmissions, wasElements.canvasWrap);
  wasRestorePreferences();
  wasRenderSort();
  try
  {
    wasElements.showGrid.checked = localStorage.getItem("was_observatory_show_grid") !== "0";
    wasSetSidebar(localStorage.getItem("was_observatory_sidebar_collapsed") === "1", false);
    wasSetDetail(localStorage.getItem("was_observatory_detail_collapsed") === "1", false);
  }
  catch (error)
  {
    wasSetSidebar(false, false);
    wasSetDetail(false, false);
  }
  wasBindEvents();
  wasBindLocale();
  wasSetView(wasState.viewMode);
  ajax_wasLoadSnapshot();
  wasConnectEvents();
  setInterval(function ()
  {
    if (!document.hidden)
    {
      wasRenderOfficePartners();
      wasScheduleSnapshot();
    }
  }, 30000);
}

if (typeof module !== "undefined" && module.exports)
{
  module.exports = { wasBuildModel: wasBuildModel, wasBuildView: wasBuildView, wasParseSort: wasParseSort, wasGetBranch: wasGetBranch, wasNormalizeSnapshot: wasNormalizeSnapshot, wasGetActivity: wasGetActivity, wasGetEdgeHistory: wasGetEdgeHistory, wasBuildOperatingView: wasBuildOperatingView, wasObserveMessages: wasObserveMessages, wasSummarizeMessages: wasSummarizeMessages, wasMessageResolved: wasMessageResolved, wasBundleConnections: wasBundleConnections, wasRouteConnection: wasRouteConnection, wasPointOnRoute: wasPointOnRoute, wasConnectionLabel: wasConnectionLabel, wasConnectionDirectionLabel: wasConnectionDirectionLabel, wasGraphDetail: wasGraphDetail, wasRamp: wasRamp, wasConnectionStyle: wasConnectionStyle, wasGraphNeighbors: wasGraphNeighbors, wasRouteAnchor: wasRouteAnchor, wasMinimapLayout: wasMinimapLayout, wasBuildTeamLayout: wasBuildTeamLayout, wasIsContainedPair: wasIsContainedPair, wasGridColumns: wasGridColumns, wasRouteCurve: wasRouteCurve, wasCurveSlice: wasCurveSlice, wasLaserHead: wasLaserHead, wasRouteSeed: wasRouteSeed };
}

if (typeof document !== "undefined")
{
  if (document.readyState === "loading")
  {
    document.addEventListener("DOMContentLoaded", wasInitialize);
  }
  else
  {
    wasInitialize();
  }
}
