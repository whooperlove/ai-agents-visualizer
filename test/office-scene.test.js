var Assert = require('node:assert/strict');
var Fs = require('node:fs');
var Path = require('node:path');
var Test = require('node:test');
var Vm = require('node:vm');
var OfficeModel = require('../public/office-model');
var Renderer = require('../public/office-scene');
var Model = require('../public/character-model');
var I18nHelpers = require('./helpers/i18n');

function actor(id, changes)
{
  return Object.assign({ id: id, name: 'codex-project-' + id, provider: 'codex', status: 'idle', floorId: 'first',
    seatIndex: 0, role: 'member', activity: { category: 'recent' }, context: false }, changes || {});
}

function officeWithActors(actors, edges)
{
  var floors = [{ id: 'first', name: 'Work team', managerId: 'a' }, { id: 'second', name: 'Other team', managerId: 'b' }];
  return { actors: actors, floors: floors, actorById: new Map(actors.map(function (item) { return [item.id, item]; })),
    floorById: new Map(floors.map(function (floor) { return [floor.id, floor]; })), edges: edges || [] };
}

function makeOffice()
{
  return officeWithActors([actor('a', { role: 'manager', seatIndex: 4 }), actor('c', { seatIndex: 0 }),
    actor('d', { name: 'codex-project-an-entire-long-session-name-that-must-remain-completely-visible-without-ellipsis', seatIndex: 1 }),
    actor('b', { floorId: 'second', provider: 'claude', status: 'waiting', role: 'manager' })]);
}

function delivery(id, from, to, changes)
{
  return Object.assign({ id: 'edge-' + id, from: from || 'a', to: to || 'c', type: 'collaboration', status: 'queued',
    message: { deliveryId: id, outcome: 'none' } }, changes || {});
}

function createBrowserHarness(settings)
{
  settings = settings || {};
  var pending = new Map();
  var timers = new Map();
  var frameId = 0;
  var listenerCount = 0;
  var backingWrites = 0;
  var currentTime = 100000;
  var viewport = { width: settings.width || 1000, height: settings.height || 600 };
  var graphics = [];
  var constants = new Map();
  var methods = new Map();
  var explicit = {
    getShaderParameter: function () { return settings.shaderFails ? false : true; },
    getShaderInfoLog: function () { return ''; },
    getProgramParameter: function () { return true; },
    getUniformLocation: function (_, name) { return name; },
    getParameter: function () { return 4096; },
    checkFramebufferStatus: function () { return settings.framebufferIncomplete ? -1 : gl.FRAMEBUFFER_COMPLETE; }
  };
  /* Records every WebGL call; constants are stable numbers and create* calls return fresh handles. */
  var gl = new Proxy({}, { get: function (target, name)
  {
    if (typeof name !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(name))
    {
      if (!constants.has(name)) constants.set(name, constants.size + 1);
      return constants.get(name);
    }
    if (!methods.has(name))
    {
      methods.set(name, function ()
      {
        graphics.push({ method: name, arguments: Array.from(arguments) });
        if (explicit[name]) return explicit[name].apply(null, arguments);
        if (/^create/.test(name)) return {};
        return undefined;
      });
    }
    return methods.get(name);
  } });
  function eventTarget(target)
  {
    target.events = new Map();
    target.addEventListener = function (name, callback)
    {
      if (!target.events.has(name)) target.events.set(name, new Set());
      target.events.get(name).add(callback);
      listenerCount += 1;
    };
    target.removeEventListener = function (name, callback)
    {
      if (target.events.has(name) && target.events.get(name).delete(callback)) listenerCount -= 1;
    };
    target.dispatch = function (name, extra)
    {
      var event = Object.assign({ type: name, target: target, preventDefault: function () {}, stopPropagation: function () {} }, extra || {});
      Array.from(target.events.get(name) || []).forEach(function (callback) { callback(event); });
    };
    return target;
  }
  function element(tag)
  {
    var classes = new Set();
    var result = eventTarget({ tagName: tag.toUpperCase(), style: {}, attributes: {}, children: [], hidden: false, textContent: '',
      classList: { add: function (value) { classes.add(value); }, remove: function (value) { classes.delete(value); },
        contains: function (value) { return classes.has(value); }, toggle: function (value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
      appendChild: function (child) { result.children.push(child); child.parentElement = result; child.parentNode = result; },
      insertBefore: function (child, before)
      {
        if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
        var position = before ? result.children.indexOf(before) : -1;
        if (position < 0) result.children.push(child); else result.children.splice(position, 0, child);
        child.parentElement = result;
        child.parentNode = result;
      },
      setAttribute: function (name, value) { result.attributes[name] = value; },
      getAttribute: function (name) { return result.attributes[name]; },
      getBoundingClientRect: function () { return { width: viewport.width, height: viewport.height, top: 0, left: 0 }; },
      remove: function ()
      {
        if (result.parentElement) result.parentElement.children.splice(result.parentElement.children.indexOf(result), 1);
      } });
    if (tag === 'canvas')
    {
      var width = 300;
      var height = 150;
      Object.defineProperty(result, 'width', { get: function () { return width; }, set: function (value) { width = value; backingWrites += 1; } });
      Object.defineProperty(result, 'height', { get: function () { return height; }, set: function (value) { height = value; backingWrites += 1; } });
      result.getContext = function (kind)
      {
        if (kind === 'webgl') return settings.webgl === false ? null : gl;
        if (kind === '2d') return { measureText: function (value) { return { width: String(value).length * 7 }; } };
        return null;
      };
    }
    if (tag === 'button' && settings.naturalLabelWidth)
    {
      Object.defineProperty(result, 'offsetWidth', { get: function ()
      {
        return result.style.width === 'max-content' ? settings.naturalLabelWidth(result) : parseFloat(result.style.width) || 0;
      } });
    }
    return result;
  }
  var document = eventTarget({ hidden: false, createElement: element });
  var media = eventTarget({ matches: !!settings.reduced });
  var sandbox = eventTarget({ Map: Map, Set: Set, Math: Math, Number: Number, Float32Array: Float32Array,
    Date: { now: function () { return currentTime; } }, document: document, WasOfficeModel: OfficeModel, devicePixelRatio: 2,
    setTimeout: function (callback) { frameId += 1; timers.set(frameId, callback); return frameId; },
    clearTimeout: function (id) { timers.delete(id); },
    requestAnimationFrame: function (callback) { frameId += 1; pending.set(frameId, callback); return frameId; },
    cancelAnimationFrame: function (id) { pending.delete(id); }, matchMedia: function () { return media; } });
  sandbox.window = sandbox;
  if (settings.i18n === false) Vm.createContext(sandbox);
  else I18nHelpers.loadBrowserI18n(sandbox, settings.locale || 'ko');
  ['character-model.js', 'office-scene.js'].forEach(function (name)
  {
    Vm.runInContext(Fs.readFileSync(Path.join(__dirname, '../public/' + name), 'utf8'), sandbox);
  });
  var container = element('section');
  return { renderer: sandbox.WasOfficeScene, container: container, pending: pending, viewport: viewport, document: document, media: media,
    graphics: graphics, backingWrites: function () { return backingWrites; }, listenerCount: function () { return listenerCount; },
    setLocale: function (locale) { sandbox.WasI18n.setLocale(locale); },
    advanceTime: function (amount) { currentTime += amount; },
    runTimers: function ()
    {
      var entries = Array.from(timers.entries());
      entries.forEach(function (entry) { timers.delete(entry[0]); entry[1](); });
    },
    flush: function ()
    {
      var entries = Array.from(pending.entries());
      entries.forEach(function (entry) { pending.delete(entry[0]); entry[1](currentTime); });
    } };
}

function find(root, className)
{
  if (root.className === className) return root;
  var index;
  for (index = 0; index < root.children.length; index += 1)
  {
    var result = find(root.children[index], className);
    if (result) return result;
  }
  return null;
}

Test('horizontal stage retains every actor, puts the manager first and reserves the complete name width', function ()
{
  var office = makeOffice();
  var layout = Renderer.layoutFloor(office, 'first', null, { pixelsPerUnit: 80, measure: function (name) { return name.length * 7; } });
  Assert.equal(layout.order[0], 'a');
  Assert.equal(layout.actors.length, 3);
  Assert.equal(layout.seats.has('b'), false);
  var fullName = office.actorById.get('d').name;
  Assert.ok(layout.seats.get('d').width * 80 >= fullName.length * 7 + 60);
  var actors = Array.from({ length: 2500 }, function (_, index) { return actor('session-' + index, { seatIndex: index }); });
  var all = Renderer.layoutFloor(officeWithActors(actors), 'first');
  Assert.equal(all.seats.size, 2500);
  Assert.equal(new Set(Array.from(all.seats.values()).map(function (seat) { return seat.x; })).size, 2500);
});

Test('orthographic front camera has no quarter-view horizontal skew or perspective shrink', function ()
{
  var matrix = Renderer.stageMatrix(0, 1, 1200, 600);
  var origin = Renderer.project({ x: 0, y: 0, z: 0 }, matrix, 1200, 600);
  var right = Renderer.project({ x: 1, y: 0, z: 0 }, matrix, 1200, 600);
  var depth = Renderer.project({ x: 1, y: 0, z: 10 }, matrix, 1200, 600);
  var elevated = Renderer.project({ x: 0, y: 1, z: 0 }, matrix, 1200, 600);
  Assert.equal(right.x, depth.x);
  Assert.equal(right.x - origin.x, 100);
  Assert.ok(elevated.y < origin.y);
  Assert.notEqual(depth.y, origin.y);
});

function count(browser, method)
{
  return browser.graphics.filter(function (call) { return call.method === method; }).length;
}

Test('WebGL shares one indexed mesh across characters, furniture and frames, and idle frames stop', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  browser.flush();
  Assert.equal(scene.getState().renderer, 'webgl-characters');
  Assert.equal(scene.getState().shadows, true);
  Assert.ok(count(browser, 'drawElements') > 50);
  Assert.equal(count(browser, 'createBuffer'), 2);
  Assert.equal(scene.getState().bufferCount, 2);
  Assert.equal(browser.pending.size, 0);
  var crowd = officeWithActors(Array.from({ length: 30 }, function (_, index) { return actor('crowd-' + index, { seatIndex: index, status: index % 3 ? 'idle' : 'waiting' }); }));
  scene.setOffice(crowd);
  browser.flush();
  scene.pan(1);
  browser.flush();
  Assert.equal(count(browser, 'createBuffer'), 2);
  Assert.equal(count(browser, 'createTexture'), 1);
  Assert.equal(browser.pending.size, 0);
  Assert.equal(scene.getState().yaw, 0);
  Assert.equal(scene.getState().fixedCamera, true);
  Assert.equal(scene.setMode('2d'), '2d');
  scene.destroy();
  Assert.equal(count(browser, 'deleteBuffer'), 2);
  Assert.equal(count(browser, 'deleteProgram'), 2);
  Assert.equal(count(browser, 'deleteTexture'), 1);
  Assert.equal(count(browser, 'deleteFramebuffer'), 1);
  Assert.equal(count(browser, 'deleteRenderbuffer'), 1);
  Assert.equal(browser.listenerCount(), 0);
  Assert.equal(browser.container.children.length, 0);
});

Test('an incomplete shadow target keeps drawing the characters without shadows', function ()
{
  var browser = createBrowserHarness({ framebufferIncomplete: true });
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  browser.flush();
  Assert.equal(scene.getState().renderer, 'webgl-characters');
  Assert.equal(scene.getState().shadows, false);
  Assert.ok(count(browser, 'drawElements') > 50);
  Assert.equal(browser.graphics.some(function (call) { return call.method === 'bindFramebuffer' && call.arguments[1] && call.arguments[1] !== null; }), true);
  scene.destroy();
});

Test('a shader that fails to compile is disclosed and releases partial graphics', function ()
{
  var browser = createBrowserHarness({ shaderFails: true });
  var warn = console.warn;
  console.warn = function () {};
  var scene = browser.renderer.create({ container: browser.container });
  console.warn = warn;
  scene.setOffice(makeOffice());
  browser.flush();
  Assert.equal(scene.getState().webglAvailable, false);
  Assert.ok(find(browser.container, 'was-office-webgl-notice').textContent.includes('WebGL'));
  Assert.equal(count(browser, 'drawElements'), 0);
  scene.destroy();
});

Test('full names, provider and activity stay present at narrow height and minimum zoom', function ()
{
  var browser = createBrowserHarness({ width: 816, height: 332 });
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  scene.setOffice(office);
  scene.select('d', { focus: true });
  scene.zoom(0.1);
  browser.flush();
  var layer = find(browser.container, 'was-office-labels');
  var label = layer.children.find(function (entry) { return entry.attributes['data-was-actor-id'] === 'd'; });
  Assert.equal(label.hidden, false);
  Assert.equal(find(label, 'was-office-actor-name').textContent, office.actorById.get('d').name);
  Assert.equal(find(label, 'was-office-actor-provider').textContent, 'Codex');
  Assert.equal(find(label, 'was-office-actor-activity').textContent, '최근');
  Assert.ok(parseFloat(label.style.width) >= office.actorById.get('d').name.length * 7);
  Assert.equal(scene.getState().zoom, 0.7);
  scene.destroy();
});

Test('same-size resize and repeated snapshots preserve backing buffers and label identity', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  scene.setOffice(office);
  browser.flush();
  var layer = find(browser.container, 'was-office-labels');
  var label = layer.children[0];
  var writes = browser.backingWrites();
  scene.resize(); scene.resize();
  Assert.equal(browser.backingWrites(), writes);
  Assert.equal(browser.pending.size, 0);
  scene.setOffice(office);
  browser.flush();
  Assert.equal(layer.children[0], label);
  Assert.equal(browser.backingWrites(), writes);
  scene.destroy();
});

Test('initial delivery baseline and duplicates do not create calls, fresh deliveries and explicit replay do', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  var old = delivery('old');
  office.edges.push(old);
  scene.setOffice(office);
  browser.flush();
  Assert.equal(scene.observe([old]), 0);
  Assert.equal(scene.getState().calls, 0);
  var fresh = delivery('fresh');
  office.edges.push(fresh);
  scene.setOffice(office);
  Assert.equal(scene.observe([fresh]), 1);
  Assert.equal(scene.observe([fresh]), 0);
  Assert.equal(scene.observe([old], { replay: true }), 1);
  Assert.equal(scene.getState().calls, 2);
  scene.stopReplay();
  Assert.equal(scene.getState().calls, 1);
  scene.destroy();
});

Test('same-floor and cross-floor phone phases do not move or reassign either actor', function ()
{
  var browser = createBrowserHarness();
  var notices = [];
  var scene = browser.renderer.create({ container: browser.container, onTravel: function (notice) { notices.push(notice); } });
  var office = makeOffice();
  scene.setOffice(office);
  browser.flush();
  var initial = JSON.stringify(scene.getState().positions);
  var assignments = JSON.stringify(office.actors);
  var same = delivery('same');
  var cross = delivery('cross', 'a', 'b');
  office.edges.push(same, cross);
  scene.setOffice(office);
  Assert.equal(scene.observe([same, cross]), 2);
  browser.flush();
  Assert.equal(JSON.stringify(scene.getState().positions), initial);
  browser.advanceTime(1200); browser.flush();
  Assert.equal(JSON.stringify(scene.getState().positions), initial);
  browser.advanceTime(1600); browser.flush();
  Assert.equal(JSON.stringify(scene.getState().positions), initial);
  Assert.equal(scene.getState().floorId, 'first');
  browser.advanceTime(3000); browser.flush();
  Assert.equal(scene.getState().calls, 0);
  Assert.equal(JSON.stringify(office.actors), assignments);
  Assert.ok(notices.some(function (notice) { return notice.phase === 'ringing' && notice.illustrative === true; }));
  Assert.ok(notices.some(function (notice) { return notice.phase === 'connected' && /^codex-project-a → codex-project-(c|b)$/.test(notice.text); }), 'the stage reports only who calls whom');
  Assert.ok(notices.every(function (notice) { return !/연출|실제 수신|illustrat|real call/i.test(notice.text); }), 'the wording lives in one bottom note, not in every notice');
  Assert.equal(find(browser.container, 'was-office-call-notice'), null, 'no top-right notice');
  scene.destroy();
});

Test('only explicit inactivity sends an actor to a sofa, while recent context keeps its workstation', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  office.actorById.get('c').context = true;
  scene.setOffice(office);
  browser.flush();
  var current = scene.getState().positions.find(function (entry) { return entry.id === 'c'; });
  Assert.equal(current.seated, false);
  Assert.equal(current.zone, 'work');
  var changed = officeWithActors(office.actors.map(function (entry)
  {
    return entry.id === 'c' ? Object.assign({}, entry, { activity: { category: 'inactive' } }) : entry;
  }));
  scene.setOffice(changed);
  browser.flush();
  Assert.equal(scene.getState().positions.find(function (entry) { return entry.id === 'c'; }).x, current.x);
  browser.advanceTime(1200); browser.flush();
  var resting = scene.getState().positions.find(function (entry) { return entry.id === 'c'; });
  Assert.equal(resting.seated, true);
  Assert.equal(resting.zone, 'rest');
  Assert.notEqual(resting.x, current.x);
  scene.destroy();
});

Test('rendering virtualizes offscreen characters without dropping thousands of actor records', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var actors = Array.from({ length: 1500 }, function (_, index) { return actor('session-' + index, { seatIndex: index }); });
  scene.setOffice(officeWithActors(actors));
  browser.flush();
  Assert.equal(scene.getState().actorCount, 1500);
  Assert.ok(scene.getState().visibleActorCount < 10);
  Assert.equal(scene.getState().zoom, 1);
  scene.select('session-1499', { focus: true });
  browser.flush();
  Assert.ok(scene.getState().visibleActorIds.includes('session-1499'));
  scene.fit();
  Assert.equal(scene.getState().zoom, 1);
  scene.destroy();
});

Test('wheel and dragging pan horizontally while zoom stays an explicit action', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  browser.flush();
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  var initial = scene.getState().cameraX;
  canvas.dispatch('wheel', { deltaX: 0, deltaY: 300 });
  Assert.ok(scene.getState().cameraX > initial);
  Assert.equal(scene.getState().zoom, 1);
  var moved = scene.getState().cameraX;
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 500, clientY: 350, button: 0 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 300, clientY: 360 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 360 });
  Assert.ok(scene.getState().cameraX >= moved);
  Assert.equal(scene.getState().yaw, 0);
  scene.zoom(1.2);
  Assert.equal(scene.getState().zoom, 1.2);
  scene.destroy();
});

Test('a tap on empty stage releases the selection and tells the host, but a drag or a tap with nothing selected does not', function ()
{
  var browser = createBrowserHarness();
  var released = 0;
  var scene = browser.renderer.create({ container: browser.container, onDeselect: function () { released += 1; } });
  scene.setOffice(makeOffice());
  browser.flush();
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  function tap(x, y)
  {
    canvas.dispatch('pointerdown', { pointerId: 1, clientX: x, clientY: y, button: 0 });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y });
  }
  tap(2, 2);
  Assert.equal(released, 0, 'nothing was selected, so there is nothing to release');
  scene.select('a');
  Assert.equal(scene.getState().selectedId, 'a');
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 500, clientY: 350, button: 0 });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 300, clientY: 360 });
  canvas.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 360 });
  Assert.equal(scene.getState().selectedId, 'a', 'dragging the stage keeps the selection');
  Assert.equal(released, 0);
  tap(2, 2);
  Assert.equal(scene.getState().selectedId, null, 'a tap on empty stage releases the selection');
  Assert.equal(released, 1, 'the host is told once');
  tap(2, 2);
  Assert.equal(released, 1, 'a second tap has nothing left to release');
  scene.destroy();
});

Test('a name tag is as wide as its measured wider row, and the name estimate stands in when nothing can be measured', function ()
{
  function plateWidth(plate) { return find(plate, 'was-office-actor-name').textContent.length * 8 + 60; }
  var measured = createBrowserHarness({ naturalLabelWidth: plateWidth });
  var scene = measured.renderer.create({ container: measured.container });
  scene.setOffice(makeOffice());
  measured.flush();
  var short = labelFor(measured, 'c');
  var long = labelFor(measured, 'd');
  Assert.equal(short.style.width, plateWidth(short) + 'px', 'the plate takes the width the layout reports');
  Assert.equal(long.style.width, plateWidth(long) + 'px', 'a long name is not cut to a cap');
  Assert.ok(parseFloat(long.style.width) > parseFloat(short.style.width));
  scene.destroy();
  var plain = createBrowserHarness();
  var fallback = plain.renderer.create({ container: plain.container });
  fallback.setOffice(makeOffice());
  plain.flush();
  Assert.equal(labelFor(plain, 'c').style.width, Math.max(156, 'codex-project-c'.length * 7 + 46) + 'px', 'without layout the estimate from the name is used');
  fallback.destroy();
});

Test('shift and wheel switch floors one at a time and the stage names the current floor', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  browser.flush();
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  var number = find(browser.container, 'was-office-floor-number');
  var position = find(browser.container, 'was-office-floor-position');
  Assert.equal(scene.getState().floorId, 'first');
  Assert.equal(number.textContent, '1F');
  Assert.equal(find(browser.container, 'was-office-floor-name').textContent, 'Work team');
  Assert.equal(position.textContent, '1 / 2층');
  canvas.dispatch('wheel', { deltaX: 0, deltaY: 100, shiftKey: true });
  Assert.equal(scene.getState().floorId, 'first', 'the lowest floor has nothing below it');
  var cameraX = scene.getState().cameraX;
  canvas.dispatch('wheel', { deltaX: 0, deltaY: -100, shiftKey: true });
  browser.flush();
  Assert.equal(scene.getState().floorId, 'second');
  Assert.equal(number.textContent, '2F');
  Assert.equal(find(browser.container, 'was-office-floor-name').textContent, 'Other team');
  Assert.equal(position.textContent, '2 / 2층');
  canvas.dispatch('wheel', { deltaX: 0, deltaY: 100, shiftKey: true });
  Assert.equal(scene.getState().floorId, 'second', 'a wheel gesture that is still coasting must not skip floors');
  browser.advanceTime(700);
  canvas.dispatch('wheel', { deltaX: 100, deltaY: 0, shiftKey: true });
  browser.flush();
  Assert.equal(scene.getState().floorId, 'first', 'macOS reports Shift+wheel on the horizontal axis');
  Assert.equal(number.textContent, '1F');
  Assert.ok(Number.isFinite(cameraX));
  browser.advanceTime(700);
  canvas.dispatch('wheel', { deltaX: 0, deltaY: -10, shiftKey: true });
  Assert.equal(scene.getState().floorId, 'first', 'small trackpad movements accumulate before a floor changes');
  canvas.dispatch('wheel', { deltaX: 0, deltaY: -10, shiftKey: true });
  canvas.dispatch('wheel', { deltaX: 0, deltaY: -30, shiftKey: true });
  Assert.equal(scene.getState().floorId, 'second');
  scene.destroy();
});

var PARTNER_NOW = 100000 + 3600000;

function partnerCard(id, name, minutesAgo, extra)
{
  return Object.assign({ id: id, name: name, status: 'running', meta: minutesAgo + ' min ago', lastTime: PARTNER_NOW - minutesAgo * 60000 }, extra || {});
}

function partnerBrowser()
{
  var browser = createBrowserHarness({ width: 1400 });
  browser.advanceTime(3600000);
  return browser;
}

function stackFor(browser, actorId)
{
  return find(browser.container, 'was-office-partner-layer').children.find(function (stack) { return stack.attributes['aria-label'].indexOf('codex-project-' + actorId + '와') === 0; });
}

function labelFor(browser, actorId)
{
  return find(browser.container, 'was-office-labels').children.find(function (label) { return label.attributes['data-was-actor-id'] === actorId; });
}

function cardNames(stack)
{
  return stack.children.filter(function (item) { return !item.classList.contains('was-office-partner-leaving'); }).map(function (item) { return item.children[0].children[0].children[1].textContent; });
}

Test('every character shows its counterpart cards to the right of its nameplate, newest first, with the whole name', function ()
{
  var browser = partnerBrowser();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  var longName = 'claude-alpha-a-very-long-session-name-that-must-stay-completely-readable-without-any-ellipsis';
  scene.setPartners({
    a: [partnerCard('c', longName, 20, { meta: '20 min ago · unresolved 3' }), partnerCard('d', 'codex-alpha-recent', 2), partnerCard('b', 'claude-alpha-old', 45)],
    c: [partnerCard('a', 'claude-alpha-master', 3)]
  });
  browser.flush();
  Assert.equal(find(browser.container, 'was-office-partner-layer').children.length, 2, 'one stack per character that has partners');
  var master = stackFor(browser, 'a');
  Assert.deepEqual(cardNames(master), ['codex-alpha-recent', longName], 'newest on top; the 45 minute old card is past its lifetime');
  Assert.equal(master.attributes['aria-label'], 'codex-project-a와 최근 통신한 세션 2개');
  var label = labelFor(browser, 'a');
  Assert.equal(parseInt(master.style.left, 10), parseInt(label.style.left, 10) + parseInt(label.style.width, 10) + 8, 'right beside the nameplate');
  Assert.equal(parseInt(master.style.top, 10), parseInt(label.style.top, 10), 'starting at the nameplate height');
  Assert.ok(parseInt(master.style.width, 10) >= 112 && parseInt(master.style.width, 10) <= 180);
  var card = master.children[1].children[0];
  Assert.equal(card.attributes['data-was-partner-id'], 'c');
  Assert.equal(card.children.length, 2, 'only the name line and one meta line: no provider tag, no sent/received counts');
  Assert.equal(card.children[0].children[1].textContent, longName);
  Assert.equal(card.children[1].textContent, '20 min ago · unresolved 3');
  Assert.equal(card.attributes['data-was-provider'], undefined);
  Assert.equal(card.attributes['data-was-status'], 'running');
  scene.destroy();
});

Test('new cards enter at the top and cards fade from the bottom until their lifetime is over', function ()
{
  var browser = partnerBrowser();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-first', 10), partnerCard('d', 'claude-alpha-second', 12)] });
  browser.flush();
  var stack = stackFor(browser, 'a');
  Assert.deepEqual(cardNames(stack), ['claude-alpha-first', 'claude-alpha-second']);
  Assert.equal(stack.children[0].classList.contains('was-office-partner-new'), false, 'the first population does not animate');
  Assert.equal(stack.children[0].style.opacity, '1');
  scene.setPartners({ a: [partnerCard('b', 'claude-alpha-newest', 0), partnerCard('c', 'claude-alpha-first', 10), partnerCard('d', 'claude-alpha-second', 12)] });
  browser.flush();
  Assert.deepEqual(cardNames(stack), ['claude-alpha-newest', 'claude-alpha-first', 'claude-alpha-second']);
  Assert.ok(stack.children[0].classList.contains('was-office-partner-new'), 'a new card slides in at the top');
  Assert.equal(stack.children[1].classList.contains('was-office-partner-new'), false);
  browser.advanceTime(10 * 60000);
  browser.runTimers();
  browser.flush();
  var opacities = stack.children.map(function (item) { return Number(item.style.opacity); });
  Assert.equal(opacities[0], 1, 'a card is at full strength for the first half of its life');
  Assert.ok(opacities[1] < 1 && opacities[1] > 0.5, 'older cards have started to fade');
  Assert.ok(opacities[2] < opacities[1], 'the oldest card at the bottom is the dimmest');
  browser.advanceTime(10 * 60000);
  browser.runTimers();
  browser.flush();
  Assert.deepEqual(cardNames(stack), ['claude-alpha-newest'], 'the two older cards are past their 30 minutes, the newest one is still shown');
  Assert.equal(stack.children.length, 3, 'leaving cards stay while they fade out');
  Assert.equal(stack.children[2].style.opacity, '0');
  browser.advanceTime(2000);
  browser.runTimers();
  browser.flush();
  Assert.equal(stack.children.length, 1, 'removed once the fade-out has finished');
  browser.advanceTime(20 * 60000);
  browser.runTimers();
  browser.flush();
  browser.advanceTime(2000);
  browser.runTimers();
  browser.flush();
  Assert.equal(stack.children.length, 0);
  Assert.equal(stack.hidden, true, 'an empty stack takes no room');
  scene.destroy();
});

Test('a partner who writes again moves back to the top and pressing a card selects that session', function ()
{
  var browser = partnerBrowser();
  var selected = [];
  var scene = browser.renderer.create({ container: browser.container, onSelect: function (id, info) { selected.push([id, info.again]); } });
  scene.setOffice(makeOffice());
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-first', 1), partnerCard('d', 'claude-alpha-second', 5)] });
  browser.flush();
  var stack = stackFor(browser, 'a');
  Assert.deepEqual(cardNames(stack), ['claude-alpha-first', 'claude-alpha-second']);
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-first', 1), partnerCard('d', 'claude-alpha-second', 0)] });
  browser.flush();
  Assert.deepEqual(cardNames(stack), ['claude-alpha-second', 'claude-alpha-first']);
  Assert.ok(stack.children[0].classList.contains('was-office-partner-fresh'));
  stack.dispatch('click', { target: stack.children[1].children[0].children[0].children[1] });
  Assert.deepEqual(selected, [['c', false]], 'a click on the card text counts as a click on the card');
  Assert.equal(scene.getState().selectedId, 'c');
  scene.destroy();
});

Test('the sticky-note layer rides the floor transition together with the room and the nameplates', function ()
{
  var css = Fs.readFileSync(Path.join(__dirname, '../public/office-scene.css'), 'utf8');
  ['up', 'down'].forEach(function (direction)
  {
    var rule = css.match(new RegExp('((?:\\.was-office-floor-' + direction + ' [^{,]+,?\\s*)+)\\{\\s*animation: was-office-floor-' + direction));
    Assert.ok(rule, 'a rule animates the floor ' + direction + ' transition');
    ['was-office-canvas', 'was-office-labels', 'was-office-partner-layer'].forEach(function (layer)
    {
      Assert.ok(rule[1].indexOf('.was-office-floor-' + direction + ' .' + layer) >= 0, layer + ' slides with the floor ' + direction + ' transition');
    });
  });
  var reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  Assert.ok(reduced.indexOf('.was-office-floor-up .was-office-partner-layer') >= 0 && reduced.indexOf('.was-office-floor-down .was-office-partner-layer') >= 0, 'reduced motion switches it off as well');
});

Test('a working session with recent activity gets a green outline on its plate and its tail without changing the plate size', function ()
{
  var css = Fs.readFileSync(Path.join(__dirname, '../public/office-scene.css'), 'utf8');
  var selector = '.was-office-actor-label[data-was-status="running"][data-was-activity="recent"]';
  function rule(text)
  {
    var start = css.indexOf(text + '\n{');
    Assert.ok(start >= 0, text + ' has a rule');
    return css.slice(start, css.indexOf('}', start));
  }
  var plate = rule(selector);
  Assert.ok(plate.indexOf('border: 2px solid rgb(79, 209, 139);') >= 0, 'the plate outline is 2px green');
  Assert.ok(plate.indexOf('padding: 5px 11px 6px;') >= 0, 'the padding gives back the extra border pixel (base 6px 12px 7px)');
  var tail = rule(selector + '::after');
  Assert.ok(/border-right: 2px solid;/.test(tail) && /border-bottom: 2px solid;/.test(tail), 'the tail outline is 2px as well');
  Assert.ok(tail.indexOf('border-right-color: inherit;') >= 0 && tail.indexOf('border-bottom-color: inherit;') >= 0, 'the tail follows the plate color in hover and selection');
  Assert.ok(css.indexOf(selector) < css.indexOf('.was-office-actor-label.was-office-actor-selected[data-was-provider="codex"]'), 'a selected plate keeps its own color');
  Assert.ok(/width: 10px;/.test(tail) && /height: 10px;/.test(tail) && /margin-left: -5px;/.test(tail), 'the tail box keeps the plain tail size, its center on the plate edge');
});

Test('a name tag is an opaque plate and its tail inherits fill and outline, so both are always the same color', function ()
{
  var css = Fs.readFileSync(Path.join(__dirname, '../public/office-scene.css'), 'utf8');
  function rule(text)
  {
    var at = css.indexOf(text + '\n{');
    Assert.ok(at >= 0, text + ' has a rule');
    return css.slice(at, css.indexOf('}', at));
  }
  ['--was-plate', '--was-plate-strong', '--was-plate-dim'].forEach(function (name)
  {
    Assert.ok(new RegExp(name + ': rgb\\(\\d+, \\d+, \\d+\\);').test(css), name + ' is an opaque color');
  });
  var plate = rule('.was-office-actor-label');
  Assert.ok(plate.indexOf('background: var(--was-plate);') >= 0, 'the plate fill is the opaque plate color');
  Assert.ok(plate.indexOf('backdrop-filter') < 0, 'nothing shows through the plate, so there is no backdrop blur to differ from the tail');
  [rule('.was-office-actor-label[data-was-activity="inactive"]'), rule('.was-office-actor-label:hover,\n.was-office-actor-label:focus-visible'),
    rule('.was-office-actor-label.was-office-actor-selected')].forEach(function (state)
  {
    Assert.ok(/background: var\(--was-plate(-strong|-dim)\);/.test(state), 'every plate state keeps an opaque fill');
  });
  var tail = rule('.was-office-actor-label::after');
  Assert.ok(tail.indexOf('background: inherit;') >= 0, 'the tail takes the plate background in every state');
  Assert.ok(tail.indexOf('border-right-color: inherit;') >= 0 && tail.indexOf('border-bottom-color: inherit;') >= 0, 'the tail outline follows the plate border in every state');
  Assert.ok(tail.indexOf('clip-path') < 0, 'an opaque tail needs no cut, with or without its rotation');
});

Test('stacks follow their character across floors and wheel input over a stack still pans or switches floors', function ()
{
  var browser = partnerBrowser();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-first', 1)], b: [partnerCard('a', 'claude-alpha-master', 1)] });
  browser.flush();
  var layer = find(browser.container, 'was-office-partner-layer');
  Assert.equal(layer.children.length, 1, 'b lives on another floor and has no stack here');
  var cameraX = scene.getState().cameraX;
  layer.children[0].dispatch('wheel', { deltaX: 0, deltaY: 300 });
  Assert.ok(scene.getState().cameraX > cameraX, 'a stack that does not scroll passes the wheel on to the stage');
  layer.children[0].dispatch('wheel', { deltaX: 0, deltaY: -100, shiftKey: true });
  browser.flush();
  Assert.equal(scene.getState().floorId, 'second');
  Assert.equal(layer.children.length, 1);
  Assert.equal(stackFor(browser, 'b').attributes['aria-label'], 'codex-project-b와 최근 통신한 세션 1개');
  scene.destroy();
});

Test('the floor session list is the single picker: it marks the selection and closes after a choice', function ()
{
  var browser = createBrowserHarness({ width: 1400 });
  var selected = [];
  var scene = browser.renderer.create({ container: browser.container, onSelect: function (id) { selected.push(id); } });
  scene.setOffice(makeOffice());
  browser.flush();
  var index = find(browser.container, 'was-office-session-index');
  var list = find(index, 'was-office-session-list');
  Assert.equal(list.children.length, 3, 'every session of the current floor');
  Assert.ok(list.children.every(function (item) { return item.attributes['aria-current'] === 'false'; }), 'nothing is marked before a selection');
  index.open = true;
  list.children.find(function (item) { return item.attributes['data-was-actor-id'] === 'd'; }).dispatch('click');
  Assert.deepEqual(selected, ['d']);
  Assert.equal(index.open, false, 'the list closes after a pick, like a menu');
  var marked = list.children.filter(function (item) { return item.attributes['aria-current'] === 'true'; });
  Assert.equal(marked.length, 1);
  Assert.equal(marked[0].attributes['data-was-actor-id'], 'd');
  Assert.ok(marked[0].classList.contains('was-office-session-selected'));
  scene.select('c');
  Assert.equal(list.children.filter(function (item) { return item.attributes['aria-current'] === 'true'; })[0].attributes['data-was-actor-id'], 'c', 'a selection made on the stage moves the mark');
  scene.select(null);
  Assert.ok(list.children.every(function (item) { return item.attributes['aria-current'] === 'false'; }));
  scene.destroy();
});

Test('current delivery filters and legacy identifiers are respected', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  scene.setOffice(office);
  browser.flush();
  var excluded = delivery('excluded');
  Assert.equal(scene.observe([excluded]), 0);
  var legacy = { id: 'legacy', type: 'collaboration', from: 'a', to: 'c', status: 'sent' };
  office.edges.push(legacy);
  scene.setOffice(office);
  Assert.equal(scene.observe([legacy]), 1);
  Assert.equal(scene.observe([legacy]), 0);
  Assert.equal(scene.observe([{ id: 'document', type: 'dependency', from: 'a', to: 'c', requestId: 'not-a-delivery' }]), 0);
  scene.destroy();
});

Test('visibility, motion preferences and destruction stop frames and discard stale call animations', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = makeOffice();
  office.actorById.get('a').status = 'running';
  scene.setOffice(office);
  browser.flush();
  Assert.equal(browser.pending.size, 1);
  scene.setVisible(false);
  Assert.equal(browser.pending.size, 0);
  scene.setVisible(true);
  browser.flush();
  Assert.equal(browser.pending.size, 1);
  browser.media.dispatch('change', { matches: true });
  browser.flush();
  Assert.equal(browser.pending.size, 0);
  var edge = delivery('hidden');
  office.edges.push(edge);
  scene.setOffice(office);
  Assert.equal(scene.observe([edge]), 0);
  Assert.equal(scene.getState().calls, 0);
  browser.document.hidden = true;
  browser.document.dispatch('visibilitychange');
  Assert.equal(browser.pending.size, 0);
  scene.destroy();
  Assert.equal(browser.listenerCount(), 0);
});

Test('WebGL unavailability is disclosed instead of substituting an old sprite or quarter view', function ()
{
  var browser = createBrowserHarness({ webgl: false });
  var notices = [];
  var scene = browser.renderer.create({ container: browser.container, onTravel: function (notice) { notices.push(notice); } });
  scene.setOffice(makeOffice());
  browser.flush();
  Assert.equal(scene.getState().webglAvailable, false);
  Assert.ok(find(browser.container, 'was-office-webgl-notice').textContent.includes('WebGL'));
  Assert.ok(find(browser.container, 'was-office-session-index').children.length > 0);
  Assert.equal(notices[0].phase, 'fallback');
  scene.destroy();
});

Test('programmatic selection is silent and clearing the office removes stale labels and calls', function ()
{
  var browser = createBrowserHarness();
  var selected = [];
  var scene = browser.renderer.create({ container: browser.container, onSelect: function (id) { selected.push(id); } });
  scene.setOffice(makeOffice());
  browser.flush();
  scene.select('c', { focus: true });
  Assert.equal(selected.length, 0);
  var label = find(browser.container, 'was-office-labels').children.find(function (entry) { return entry.attributes['data-was-actor-id'] === 'a'; });
  label.dispatch('click');
  Assert.deepEqual(selected, ['a']);
  scene.setOffice(null);
  browser.flush();
  Assert.equal(find(browser.container, 'was-office-labels').children.length, 0);
  Assert.equal(scene.getState().actorCount, 0);
  Assert.equal(scene.getState().calls, 0);
  Assert.equal(browser.pending.size, 0);
  scene.destroy();
});

Test('short-stage camera keeps every full nameplate on stage and above the highest hair point', function ()
{
  [[816, 332, 1], [816, 332, 1.6], [1400, 640, 1], [640, 260, 0.7]].forEach(function (size)
  {
    var browser = createBrowserHarness({ width: size[0], height: size[1] });
    var scene = browser.renderer.create({ container: browser.container });
    var office = makeOffice();
    office.actors.push(actor('rest', { activity: { category: 'inactive' }, seatIndex: 9 }));
    office.actorById.set('rest', office.actors[office.actors.length - 1]);
    scene.setOffice(office);
    scene.zoom(size[2]);
    browser.flush();
    var state = scene.getState();
    var matrix = Renderer.stageMatrix(state.cameraX, state.zoom, size[0], size[1]);
    var labels = find(browser.container, 'was-office-labels').children;
    state.visibleActorIds.forEach(function (id)
    {
      var position = state.positions.find(function (entry) { return entry.id === id; });
      var stance = position.zone === 'rest' ? 'sofa' : 'desk';
      var rootZ = position.zone === 'rest' ? position.z + 0.02 : position.z;
      var hair = Model.parts(id, { stance: stance }).reduce(function (top, part) { return Math.max(top, Model.partTop(part)); }, 0) * Renderer.characterScale;
      var highest = Renderer.project({ x: position.x, y: hair, z: rootZ }, matrix, size[0], size[1]);
      var label = labels.find(function (entry) { return entry.attributes['data-was-actor-id'] === id; });
      Assert.equal(label.hidden, false);
      Assert.ok(parseFloat(label.style.top) >= 0, id + ' top ' + label.style.top + ' at ' + size.join('x'));
      Assert.ok(parseFloat(label.style.top) + Renderer.labelHeight <= highest.y - 4, id + ' overlaps hair at ' + size.join('x'));
      Assert.equal(find(label, 'was-office-actor-call'), null, 'no chip beside the nameplate');
    });
    scene.destroy();
  });
});

Test('a floor containing only inactive sessions opens at its sofas instead of an empty desk area', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(officeWithActors([actor('a', { activity: { category: 'inactive' } }), actor('c', { activity: { category: 'inactive' } })]));
  browser.flush();
  Assert.ok(scene.getState().visibleActorIds.includes('a'));
  Assert.equal(scene.getState().positions.find(function (entry) { return entry.id === 'a'; }).seated, true);
  Assert.ok(find(browser.container, 'was-office-zone-label').textContent.includes('소파'));
  scene.destroy();
});

Test('mixed floors allocate desks only to working actors and place sofas immediately after the work zone', function ()
{
  var actors = Array.from({ length: 11 }, function (_, index)
  {
    return actor('session-' + index, { seatIndex: index, activity: { category: index < 4 ? 'recent' : 'inactive' } });
  });
  var office = officeWithActors(actors);
  var before = JSON.stringify(office.actors);
  var layout = Renderer.layoutFloor(office, 'first', null, { pixelsPerUnit: 84 });
  Assert.ok(Math.abs(layout.workEnd - (0.6 + 4 * 3.5)) < 0.000001);
  Assert.ok(Math.abs(layout.restStart - layout.workEnd - 2.4) < 0.000001);
  Assert.equal(layout.restSeats.size, 7);
  Assert.equal(layout.seats.size, 11);
  Assert.equal(layout.seats.get('session-4'), layout.restSeats.get('session-4'));
  Assert.equal(layout.seats.get('session-4').zone, 'rest');
  Assert.equal(layout.seats.get('session-3').zone, 'work');
  Assert.equal(JSON.stringify(office.actors), before);
});

Test('thousands of inactive actors have no hidden workstation strip before their sofa zone', function ()
{
  var actors = Array.from({ length: 1500 }, function (_, index)
  {
    return actor('session-' + index, { seatIndex: index, activity: { category: 'inactive' } });
  });
  var layout = Renderer.layoutFloor(officeWithActors(actors), 'first');
  Assert.equal(layout.workEnd, 0.6);
  Assert.equal(layout.restStart, 0.6);
  Assert.equal(layout.restSeats.size, 1500);
  Assert.equal(layout.seats.size, 1500);
  Assert.ok(layout.restSeats.get('session-0').x < 3);
  Assert.ok(Math.abs(layout.width - (1500 * 3.5 + 1.2)) < 0.000001);
});

Test('seated workers face their monitors and swivel toward the camera only for calls and selection', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = officeWithActors([actor('a', { role: 'manager', status: 'running' }), actor('c', { seatIndex: 1, status: 'running' }),
    actor('r', { seatIndex: 2, activity: { category: 'inactive' } })]);
  scene.setOffice(office);
  browser.flush();
  function yaw(id) { return scene.getState().facings.find(function (entry) { return entry.id === id; }).yaw; }
  Assert.ok(Math.abs(yaw('a') - Math.PI) < 0.001);
  Assert.ok(Math.abs(yaw('c') - Math.PI) < 0.001);
  var initial = JSON.stringify(scene.getState().positions);
  scene.select('a');
  var step;
  for (step = 0; step < 40; step += 1) { browser.advanceTime(34); browser.flush(); }
  Assert.ok(Math.abs(yaw('a')) < 0.01);
  Assert.ok(Math.abs(yaw('c') - Math.PI) < 0.001);
  var call = delivery('turn', 'c', 'a');
  office.edges.push(call);
  scene.setOffice(office);
  Assert.equal(scene.observe([call]), 1);
  for (step = 0; step < 40; step += 1) { browser.advanceTime(34); browser.flush(); }
  Assert.ok(Math.abs(Math.atan2(Math.sin(yaw('c')), Math.cos(yaw('c')))) < 0.01);
  Assert.equal(JSON.stringify(scene.getState().positions), initial);
  browser.advanceTime(6000);
  for (step = 0; step < 60; step += 1) { browser.advanceTime(34); browser.flush(); }
  Assert.ok(Math.abs(Math.abs(Math.atan2(Math.sin(yaw('c')), Math.cos(yaw('c')))) - Math.PI) < 0.01);
  scene.pan(5);
  browser.flush();
  scene.destroy();
});

Test('reduced motion snaps every character straight to its facing without animation frames', function ()
{
  var browser = createBrowserHarness({ reduced: true });
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(officeWithActors([actor('a', { role: 'manager' }), actor('c', { seatIndex: 1 })]));
  browser.flush();
  scene.select('c');
  browser.flush();
  var facing = scene.getState().facings.find(function (entry) { return entry.id === 'c'; });
  Assert.equal(facing.yaw, 0);
  Assert.equal(browser.pending.size, 0);
  scene.destroy();
});

Test('idle workers rest facing the camera while running and waiting workers keep their monitors', function ()
{
  var browser = createBrowserHarness();
  var scene = browser.renderer.create({ container: browser.container });
  var office = officeWithActors([actor('a', { role: 'manager', status: 'running' }), actor('i', { seatIndex: 1, status: 'idle' }),
    actor('w', { seatIndex: 2, status: 'waiting' })]);
  scene.setOffice(office);
  browser.flush();
  function yaw(id) { return scene.getState().facings.find(function (entry) { return entry.id === id; }).yaw; }
  Assert.equal(yaw('i'), 0);
  Assert.ok(Math.abs(yaw('a') - Math.PI) < 0.001);
  Assert.ok(Math.abs(yaw('w') - (Math.PI - 0.8)) < 0.001);
  var changed = officeWithActors(office.actors.map(function (entry) { return entry.id === 'a' ? Object.assign({}, entry, { status: 'idle' }) : entry; }));
  scene.setOffice(changed);
  var step;
  for (step = 0; step < 60; step += 1) { browser.advanceTime(34); browser.flush(); }
  Assert.ok(Math.abs(Math.atan2(Math.sin(yaw('a')), Math.cos(yaw('a')))) < 0.01);
  scene.destroy();
});

Test('pressing a nameplate or character twice reports a repeat so the host can close the detail, and clearing the selection is silent', function ()
{
  var browser = createBrowserHarness();
  var presses = [];
  var scene = browser.renderer.create({ container: browser.container, onSelect: function (id, info) { presses.push([id, info.again]); } });
  scene.setOffice(makeOffice());
  browser.flush();
  var label = find(browser.container, 'was-office-labels').children.find(function (entry) { return entry.attributes['data-was-actor-id'] === 'a'; });
  label.dispatch('click');
  label.dispatch('click');
  Assert.deepEqual(presses, [['a', false], ['a', true]]);
  Assert.equal(scene.getState().selectedId, 'a');
  Assert.equal(scene.select(null), true);
  Assert.equal(scene.getState().selectedId, null);
  Assert.equal(presses.length, 2);
  label.dispatch('click');
  var other = find(browser.container, 'was-office-labels').children.find(function (entry) { return entry.attributes['data-was-actor-id'] === 'c'; });
  other.dispatch('click');
  other.dispatch('click');
  Assert.deepEqual(presses.slice(2), [['a', false], ['c', false], ['c', true]]);
  scene.destroy();
});

function tagTexts(label)
{
  return { provider: find(label, 'was-office-actor-provider').textContent, activity: find(label, 'was-office-actor-activity').textContent,
    status: find(label, 'was-office-actor-role').textContent, tooltip: label.title || label.attributes.title || '', aria: label.attributes['aria-label'] };
}

function englishStack(browser, actorId)
{
  return find(browser.container, 'was-office-partner-layer').children.find(function (stack) { return /with codex-project-(\w)$/.exec(stack.attributes['aria-label'])[1] === actorId; });
}

Test('English name tags show the status, activity and provider wording the glossary asks for', function ()
{
  var browser = createBrowserHarness({ locale: 'en' });
  var scene = browser.renderer.create({ container: browser.container });
  var unconfirmed = { category: 'unconfirmed' };
  var inactive = { category: 'inactive' };
  scene.setOffice(officeWithActors([actor('a', { role: 'manager', seatIndex: 0, status: 'running' }), actor('w', { seatIndex: 1, status: 'waiting' }),
    actor('i', { seatIndex: 2, status: 'idle' }), actor('e', { seatIndex: 3, status: 'error' }), actor('x', { seatIndex: 4, status: 'mystery', activity: unconfirmed }),
    actor('o', { seatIndex: 5, status: 'completed', activity: inactive }), actor('s', { seatIndex: 6, status: 'interrupted', activity: inactive }),
    actor('u', { seatIndex: 7, provider: '', status: 'blocked', activity: unconfirmed })]));
  browser.flush();
  var expected = { a: ['Codex', 'Recent', 'Working'], w: ['Codex', 'Recent', 'Waiting for reply'], i: ['Codex', 'Recent', 'Idle'], e: ['Codex', 'Recent', 'Error'],
    x: ['Codex', 'Time unknown', 'Status unknown'], o: ['Codex', 'Inactive', 'Completed'], s: ['Codex', 'Inactive', 'Interrupted'],
    u: ['Provider unknown', 'Time unknown', 'Waiting for reply'] };
  Object.keys(expected).forEach(function (id)
  {
    var texts = tagTexts(labelFor(browser, id));
    Assert.deepEqual([texts.provider, texts.activity, texts.status], expected[id], id);
    Assert.equal(texts.aria, 'codex-project-' + id + ' · ' + expected[id].join(' · '));
    Assert.equal(texts.tooltip, '', 'a name tag has no title attribute, so the browser shows no native tooltip over it');
  });
  var items = find(browser.container, 'was-office-session-list').children;
  Assert.equal(items.length, 8);
  Assert.equal(items[0].textContent, labelFor(browser, 'a').attributes['aria-label']);
  Assert.equal(find(browser.container, 'was-office-session-index').children[0].textContent, 'All sessions on this floor · 8');
  Assert.equal(browser.renderer.statusText({ status: 'failed' }), 'Error');
  Assert.equal(browser.renderer.activityText({ activity: { category: 'recent' }, status: 'idle' }), 'Recent');
  scene.destroy();
});

Test('English stage text: aria labels, help line, floor badge, zone caption, head count and the empty state', function ()
{
  var browser = createBrowserHarness({ locale: 'en' });
  var scene = browser.renderer.create({ container: browser.container });
  var root = find(browser.container, 'was-office-arcade');
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  var empty = find(browser.container, 'was-office-empty');
  Assert.match(root.attributes['aria-label'], /^Side-scrolling office\. .*arrow keys to select a session\. Phone animations .* are not real calls\.$/);
  Assert.match(canvas.attributes['aria-label'], /^3D character office\. .*arrow keys to select a session\.$/);
  Assert.equal(find(browser.container, 'was-office-stage-help').textContent.indexOf('Drag left or right'), 0);
  Assert.equal(empty.textContent, 'No sessions to show.');
  browser.flush();
  Assert.equal(empty.hidden, false, 'no office yet');
  Assert.equal(find(browser.container, 'was-office-zone-label').textContent, 'Session office');
  Assert.equal(find(browser.container, 'was-office-stage-counter').textContent, '');
  scene.setOffice(makeOffice());
  browser.flush();
  Assert.equal(empty.hidden, true);
  Assert.equal(find(browser.container, 'was-office-floor-number').textContent, '1F');
  Assert.equal(find(browser.container, 'was-office-floor-position').textContent, 'Floor 1 of 2');
  Assert.equal(find(browser.container, 'was-office-zone-label').textContent, 'Work area  ·  one desk per session');
  Assert.match(find(browser.container, 'was-office-stage-counter').textContent, /^3 on this floor · \d+ on screen · scroll sideways to explore$/);
  scene.setFloor('second');
  browser.flush();
  Assert.equal(find(browser.container, 'was-office-floor-position').textContent, 'Floor 2 of 2');
  scene.setOffice(officeWithActors([]));
  browser.flush();
  Assert.equal(empty.hidden, false, 'a floor without sessions shows the empty state');
  Assert.equal(find(browser.container, 'was-office-stage-counter').textContent, '0 on this floor · 0 on screen · scroll sideways to explore');
  scene.destroy();
});

Test('English sofa lounge caption and head count when a floor holds only inactive sessions', function ()
{
  var browser = createBrowserHarness({ locale: 'en' });
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(officeWithActors([actor('a', { activity: { category: 'inactive' } }), actor('c', { activity: { category: 'inactive' } })]));
  browser.flush();
  Assert.equal(find(browser.container, 'was-office-zone-label').textContent, 'Sofa lounge  ·  inactive sessions');
  Assert.match(find(browser.container, 'was-office-stage-counter').textContent, /^2 on this floor · \d+ on screen · 2 inactive$/);
  scene.destroy();
});

Test('English partner stack labels pick the singular and plural form and leave the cards the host wrote untouched', function ()
{
  var browser = partnerBrowser();
  browser.setLocale('en');
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-one', 2), partnerCard('d', 'claude-alpha-two', 3)], c: [partnerCard('a', 'claude-alpha-master', 1)] });
  browser.flush();
  Assert.equal(englishStack(browser, 'a').attributes['aria-label'], '2 sessions recently in contact with codex-project-a');
  Assert.equal(englishStack(browser, 'c').attributes['aria-label'], '1 session recently in contact with codex-project-c');
  Assert.equal(cardNames(englishStack(browser, 'c'))[0], 'claude-alpha-master');
  Assert.equal(englishStack(browser, 'c').children[0].children[0].children[1].textContent, '1 min ago', 'the card meta stays as the host supplied it');
  scene.destroy();
});

Test('refreshText re-renders every text for the new language and leaves camera, selection, floor and animation alone', function ()
{
  var browser = partnerBrowser();
  var selected = [];
  var scene = browser.renderer.create({ container: browser.container, onSelect: function (id) { selected.push(id); } });
  scene.setOffice(makeOffice());
  scene.setPartners({ a: [partnerCard('c', 'claude-alpha-one', 2), partnerCard('d', 'claude-alpha-two', 3)] });
  scene.select('c', { focus: true });
  scene.zoom(1.2);
  scene.pan(0.2);
  browser.flush();
  var root = find(browser.container, 'was-office-arcade');
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  var label = labelFor(browser, 'c');
  var stack = stackFor(browser, 'a');
  var zone = find(browser.container, 'was-office-zone-label');
  var counter = find(browser.container, 'was-office-stage-counter');
  Assert.deepEqual([tagTexts(label).activity, tagTexts(label).status], ['최근', '유휴']);
  Assert.equal(zone.textContent, '업무 공간  ·  세션별 책상');
  Assert.equal(stack.attributes['aria-label'], 'codex-project-a와 최근 통신한 세션 2개');
  var koreanRoot = root.attributes['aria-label'];
  function snapshot()
  {
    var state = scene.getState();
    return JSON.stringify({ floorId: state.floorId, selectedId: state.selectedId, zoom: state.zoom, cameraX: state.cameraX, positions: state.positions,
      facings: state.facings, calls: state.calls, visibleActorIds: state.visibleActorIds, pan: state.panX,
      classes: [label.classList.contains('was-office-actor-selected'), label.attributes['aria-pressed']],
      cards: stack.children.map(function (item) { return item.children[0].children[1].textContent; }), opacities: stack.children.map(function (item) { return item.style.opacity; }) });
  }
  var before = snapshot();
  var pendingBefore = browser.pending.size;
  browser.setLocale('en');
  scene.refreshText();
  Assert.equal(snapshot(), before, 'only text changed');
  Assert.ok(browser.pending.size >= pendingBefore, 'the stage asks for a redraw');
  Assert.deepEqual(selected, [], 'a language change does not report a selection');
  Assert.strictEqual(labelFor(browser, 'c'), label, 'name tags are kept, not rebuilt');
  Assert.strictEqual(stackFor(browser, 'a'), undefined, 'the Korean lookup no longer matches');
  Assert.strictEqual(englishStack(browser, 'a'), stack);
  var english = tagTexts(label);
  Assert.deepEqual([english.provider, english.activity, english.status], ['Codex', 'Recent', 'Idle']);
  Assert.equal(english.aria, 'codex-project-c · Codex · Recent · Idle');
  Assert.equal(english.tooltip, '');
  Assert.equal(tagTexts(labelFor(browser, 'a')).status, 'Idle');
  Assert.equal(find(browser.container, 'was-office-session-list').children[0].textContent.indexOf('codex-project-') === 0, true);
  Assert.equal(find(browser.container, 'was-office-session-index').children[0].textContent, 'All sessions on this floor · 3');
  Assert.notEqual(root.attributes['aria-label'], koreanRoot);
  Assert.match(root.attributes['aria-label'], /^Side-scrolling office\./);
  Assert.match(canvas.attributes['aria-label'], /^3D character office\./);
  Assert.equal(find(browser.container, 'was-office-empty').textContent, 'No sessions to show.');
  Assert.equal(find(browser.container, 'was-office-stage-help').textContent.indexOf('Drag left or right'), 0);
  Assert.equal(find(browser.container, 'was-office-floor-position').textContent, 'Floor 1 of 2');
  Assert.equal(zone.textContent, 'Work area  ·  one desk per session');
  Assert.match(counter.textContent, /^3 on this floor · \d+ on screen · scroll sideways to explore$/);
  Assert.equal(stack.attributes['aria-label'], '2 sessions recently in contact with codex-project-a');
  Assert.equal(stack.children[0].children[0].children[1].textContent, '2 min ago', 'host supplied card text is not translated');
  browser.flush();
  Assert.equal(snapshot(), before, 'the redraw keeps the same camera and positions');
  scene.setFloor('second');
  browser.flush();
  Assert.equal(find(browser.container, 'was-office-floor-position').textContent, 'Floor 2 of 2');
  Assert.equal(tagTexts(labelFor(browser, 'b')).status, 'Waiting for reply');
  var floorState = scene.getState();
  browser.setLocale('ko');
  scene.refreshText();
  browser.flush();
  Assert.equal(scene.getState().floorId, floorState.floorId);
  Assert.equal(scene.getState().cameraX, floorState.cameraX);
  Assert.equal(scene.getState().selectedId, 'c');
  Assert.equal(tagTexts(labelFor(browser, 'b')).status, '응답 대기');
  Assert.equal(find(browser.container, 'was-office-floor-position').textContent, '2 / 2층');
  Assert.equal(root.attributes['aria-label'], koreanRoot);
  scene.destroy();
  Assert.doesNotThrow(function () { scene.refreshText(); }, 'refreshText after destroy is harmless');
});

Test('refreshText works before any office exists and the graphics notice follows the language', function ()
{
  var browser = createBrowserHarness({ webgl: false, locale: 'en' });
  var warn = console.warn;
  console.warn = function () {};
  var travel = [];
  var scene = browser.renderer.create({ container: browser.container, onTravel: function (notice) { travel.push(notice); } });
  console.warn = warn;
  var notice = find(browser.container, 'was-office-webgl-notice');
  Assert.match(notice.textContent, /^WebGL 3D characters cannot be shown in this browser\./);
  Assert.equal(travel[0].phase, 'fallback');
  Assert.equal(travel[0].text, notice.textContent, 'the travel note is the localized notice');
  scene.refreshText();
  Assert.equal(find(browser.container, 'was-office-zone-label').textContent, 'Session office');
  browser.setLocale('ko');
  scene.refreshText();
  Assert.equal(notice.hidden, false);
  Assert.match(notice.textContent, /^이 브라우저에서 WebGL 3D 캐릭터를 표시할 수 없습니다\./);
  Assert.equal(find(browser.container, 'was-office-empty').textContent, '표시할 세션이 없습니다.');
  Assert.equal(find(browser.container, 'was-office-zone-label').textContent, '세션 오피스');
  scene.destroy();
});

Test('a lost graphics context shows a notice in the current language and recovers cleanly', function ()
{
  var browser = createBrowserHarness({ locale: 'en' });
  var scene = browser.renderer.create({ container: browser.container });
  var canvas = find(browser.container, 'was-office-canvas was-office-character-canvas');
  var notice = find(browser.container, 'was-office-webgl-notice');
  Assert.equal(notice.hidden, true);
  canvas.dispatch('webglcontextlost');
  Assert.equal(notice.hidden, false);
  Assert.equal(notice.textContent, 'The 3D graphics connection was lost. Please use the full session list while it recovers.');
  browser.setLocale('ko');
  scene.refreshText();
  Assert.equal(notice.textContent, '3D 그래픽 연결이 중단되었습니다. 복구하는 동안 전체 세션 목록을 이용해 주세요.');
  canvas.dispatch('webglcontextrestored');
  Assert.equal(notice.hidden, true);
  browser.setLocale('en');
  scene.refreshText();
  Assert.equal(notice.hidden, true, 'a recovered stage keeps the notice hidden');
  scene.destroy();
});

Test('floor names the office model prepares as message tokens render in the viewer language', function ()
{
  var browser = createBrowserHarness({ locale: 'en' });
  var scene = browser.renderer.create({ container: browser.container });
  var office = OfficeModel.buildOffice({ nodes: [{ id: 'solo', name: 'solo', project: 'p', provider: 'codex', status: 'idle', activity: { category: 'recent' } }], edges: [] }, { activity: 'all' });
  scene.setOffice(office);
  browser.flush();
  var name = find(browser.container, 'was-office-floor-name');
  Assert.equal(name.textContent, 'Independent sessions');
  browser.setLocale('ko');
  scene.refreshText();
  Assert.equal(name.textContent, '독립 세션');
  browser.setLocale('en');
  browser.flush();
  Assert.equal(name.textContent, 'Independent sessions', 'the next frame also follows the language');
  scene.destroy();
});

Test('without a message catalog the stage still loads and falls back to the message keys', function ()
{
  var browser = createBrowserHarness({ i18n: false });
  var scene = browser.renderer.create({ container: browser.container });
  scene.setOffice(makeOffice());
  browser.flush();
  var texts = tagTexts(labelFor(browser, 'a'));
  Assert.equal(texts.activity, 'scene.activity.recent');
  Assert.equal(texts.status, 'scene.status.idle');
  Assert.equal(find(browser.container, 'was-office-empty').textContent, 'scene.stage.empty');
  Assert.equal(find(browser.container, 'was-office-floor-name').textContent, 'Work team');
  Assert.doesNotThrow(function () { scene.refreshText(); });
  Assert.equal(Renderer.statusText({ status: 'running' }), 'scene.status.running', 'the module itself needs no catalog at load time');
  scene.destroy();
});
