var Assert = require('node:assert/strict');
var Test = require('node:test');
var Model = require('../public/character-model');

function determinant(basis)
{
  var x = basis[0];
  var y = basis[1];
  var z = basis[2];
  return x[0] * (y[1] * z[2] - y[2] * z[1]) - y[0] * (x[1] * z[2] - x[2] * z[1]) + z[0] * (x[1] * y[2] - x[2] * y[1]);
}

function named(parts, name)
{
  return parts.filter(function (part) { return part.name === name; });
}

function placement(parts, names)
{
  return parts.filter(function (part) { return names.includes(part.name); }).map(function (part)
  {
    return { name: part.name, position: part.position, inner: part.inner, radius: part.radius, basis: part.basis };
  });
}

Test('one indexed rounded mesh is reusable with deterministic independent material palettes', function ()
{
  var mesh = Model.roundedGeometry(6);
  Assert.equal(mesh.vertices.length, 6 * 14 * 14 * 6);
  Assert.equal(mesh.indices.length, 6 * 13 * 13 * 6);
  Assert.ok(Math.max.apply(null, mesh.indices) < mesh.vertices.length / 6);
  var index;
  for (index = 0; index < mesh.vertices.length; index += 6)
  {
    Assert.ok(Math.abs(Math.hypot(mesh.vertices[index], mesh.vertices[index + 1], mesh.vertices[index + 2]) - 1) < 0.000001);
    Assert.ok([mesh.vertices[index + 3], mesh.vertices[index + 4], mesh.vertices[index + 5]].every(function (sign) { return sign === 1 || sign === -1; }));
  }
  Assert.deepEqual(Model.palette('session-a'), Model.palette('session-a'));
  Assert.notDeepEqual(Model.palette('session-a'), Model.palette('session-b'));
  ['skin', 'hair', 'shirt', 'pants', 'shoes', 'hairStyle', 'outfit', 'eyes', 'accessory'].forEach(function (key)
  {
    Assert.ok(Object.prototype.hasOwnProperty.call(Model.palette('session-a'), key), key);
  });
  var styles = new Set();
  var outfits = new Set();
  for (index = 0; index < 200; index += 1)
  {
    styles.add(Model.palette('similar-session-' + index).hairStyle);
    outfits.add(Model.palette('similar-session-' + index).outfit);
  }
  Assert.equal(styles.size, Model.HAIR_STYLES.length);
  Assert.equal(outfits.size, Model.OUTFITS.length);
});

Test('rounded chibi anatomy keeps a large painted face, real hands and separate outfit materials', function ()
{
  var materials = Model.palette('session-a');
  var parts = Model.parts('session-a', { stance: 'desk', activity: 'typing' });
  var head = named(parts, 'head')[0];
  var body = named(parts, 'body')[0];
  Assert.ok(head.radius[0] > (body.inner[0] + body.radius[0]) * 1.4);
  Assert.equal(head.paint[0], Model.PAINT.face);
  Assert.equal(named(parts, 'hair').length, 1);
  Assert.equal(named(parts, 'hair')[0].paint[0], Model.PAINT.hair);
  Assert.equal(named(parts, 'hand').length, 2);
  Assert.equal(named(parts, 'shoe').length, 2);
  named(parts, 'leg').forEach(function (part) { Assert.deepEqual(part.color, materials.pants); });
  named(parts, 'shoe').forEach(function (part) { Assert.deepEqual(part.color, materials.shoes); });
  Assert.notDeepEqual(materials.pants, materials.skin);
  Assert.ok(parts.every(function (part)
  {
    var values = [part.position.x, part.position.y, part.position.z].concat(part.inner, part.radius);
    return (part.mesh === 'round' || part.mesh === 'low') && values.every(Number.isFinite) && part.radius.every(function (value) { return value > 0; }) &&
      Math.abs(determinant(part.basis) - 1) < 0.000001;
  }));
});

Test('phone poses raise one arm and add a handset while legs, body and head stay in their seats', function ()
{
  ['desk', 'sofa'].forEach(function (stance)
  {
    var idle = Model.parts('session-a', { stance: stance });
    var calling = Model.parts('session-a', { stance: stance, phone: 'outgoing' });
    Assert.equal(idle.some(function (part) { return part.name === 'phone-body'; }), false);
    Assert.equal(calling.some(function (part) { return part.name === 'phone-body'; }), true);
    var names = ['body', 'head', 'shoe', 'pants', 'leg'];
    Assert.deepEqual(placement(calling, names), placement(idle, names));
  });
  var standing = named(Model.parts('session-a', { stance: 'stand' }), 'head')[0];
  var resting = named(Model.parts('session-a', { stance: 'sofa' }), 'head')[0];
  Assert.ok(resting.position.y < standing.position.y);
});

Test('the silhouette top covers every hair style and accessory so nameplates never hide hair', function ()
{
  var covered = new Set();
  var index;
  for (index = 0; index < 400 && covered.size < Model.HAIR_STYLES.length * 3; index += 1)
  {
    var id = 'probe-' + index;
    var materials = Model.palette(id);
    var key = materials.hairStyle + ':' + materials.accessory;
    if (covered.has(key)) continue;
    covered.add(key);
    ['desk', 'sofa', 'stand'].forEach(function (stance)
    {
      var highest = Model.parts(id, { stance: stance, materials: materials }).reduce(function (top, part) { return Math.max(top, Model.partTop(part)); }, 0);
      Assert.ok(Model.silhouetteTop(stance, materials) >= highest - 0.000001, key + ' ' + stance);
      Assert.ok(highest > 1.9 && highest < 2.45, key + ' ' + stance + ' ' + highest);
    });
  }
  Assert.ok(covered.size >= Model.HAIR_STYLES.length * 2);
});

Test('hands touch the head at most and the handset stays outside it so calls are visible', function ()
{
  function distance(part, head)
  {
    var basis = head.basis;
    var delta = [part.position.x - head.position.x, part.position.y - head.position.y, part.position.z - head.position.z];
    return Math.hypot.apply(null, [0, 1, 2].map(function (axis)
    {
      return (basis[axis][0] * delta[0] + basis[axis][1] * delta[1] + basis[axis][2] * delta[2]) / head.radius[axis];
    }));
  }
  ['desk', 'sofa', 'stand'].forEach(function (stance)
  {
    ['typing', 'waiting', 'idle', 'unknown', 'turned', 'relax', 'sleep'].forEach(function (activity)
    {
      [undefined, 'outgoing', 'ringing', 'connected'].forEach(function (phone)
      {
        var parts = Model.parts('reach-' + stance + activity, { stance: stance, activity: activity, phone: phone, time: 1234567, wave: activity === 'turned' ? 0.4 : 0 });
        var head = named(parts, 'head')[0];
        named(parts, 'hand').forEach(function (hand) { Assert.ok(distance(hand, head) > 0.95, stance + ' ' + activity + ' hand'); });
        named(parts, 'phone-body').forEach(function (handset) { Assert.ok(distance(handset, head) > 1.1, stance + ' ' + activity + ' ' + phone); });
      });
    });
  });
});
