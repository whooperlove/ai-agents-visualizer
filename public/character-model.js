/* Chibi office character built from one shared rounded primitive, with deterministic per-session looks and poses. */
var WasCharacterModel = null;

(function ()
{
  'use strict';

  var HEAD = [0.5, 0.465, 0.46];
  var HEAD_TAPER = 0.1;
  var HAIR_STYLES = ['tousled', 'swept', 'bob', 'bun', 'curly', 'spiky', 'long', 'ponytail'];
  var OUTFITS = ['tee', 'hoodie', 'cardigan', 'shirt', 'sweater', 'overalls'];
  var PAINT = { none: 0, face: 1, hair: 2, floor: 3, wall: 4, window: 5, screen: 6, rug: 7, blob: 8, glow: 9, art: 10, leaf: 12, strand: 13, ear: 14, shoe: 15, fabric: 16, cap: 17, beanie: 18, cuff: 19 };
  var MOUTH = { smile: 0, talk: 1, flat: 2, round: 3, frown: 4 };
  var EYES = { open: 0, happy: 1, closed: 2 };
  var CLOTH = { knit: 1, fleece: 2, twill: 3, cotton: 4 };

  function cloth(kind)
  {
    return { paint: [PAINT.fabric, kind, 0, 0] };
  }

  function hashId(value)
  {
    var hash = 2166136261;
    var text = String(value || 'session');
    var index;
    for (index = 0; index < text.length; index += 1)
    {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }

  function color(hex)
  {
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, 1];
  }

  function tone(value, amount)
  {
    return [Math.min(1, value[0] * amount), Math.min(1, value[1] * amount), Math.min(1, value[2] * amount), value[3]];
  }

  /* Picks the first entry from start onward that is not too close to the colors it is worn against. */
  function distinct(list, start, against)
  {
    var offset;
    for (offset = 0; offset < list.length; offset += 1)
    {
      var candidate = color(list[(start + offset) % list.length]);
      if (against.every(function (other) { return Math.hypot(candidate[0] - other[0], candidate[1] - other[1], candidate[2] - other[2]) > 0.22; })) return candidate;
    }
    return color(list[start]);
  }

  function palette(id)
  {
    var hash = hashId(id);
    var look = hashId('look:' + id);
    var skins = ['f6d5b8', 'efc29d', 'e2ab83', 'c98f64', 'a8714c', '7f5236'];
    var hairs = ['26232a', '3d2b24', '5e3d2b', '8a5a36', 'c79a5d', '8c3f2e', '2e3a57', '5b4b6e', 'b9b0a6'];
    var shirts = ['7fae96', 'e48f70', '7ea4d6', 'e2b85c', 'a993c7', '41587a', 'c86b56', '86cdb8', 'efe3c8', '4c525c', 'd85f68', '6d8b5a'];
    var pants = ['3f5a85', '383d4a', 'a8946f', '66704e', '2b2e35', '6b5141', '5a6f8e'];
    var shoes = ['f3f0ea', '2c2c31', 'd25d55', 'b98a5c', '3a4d74', '7fb2a0'];
    var trims = ['f1e9d8', 'e9e4da', 'f6d9a8', 'cfe0ea', 'f2c9c0', '333842'];
    var eyes = ['3b2a22', '1f1c22', '30435e', '4f3d2a', '2f4a3d'];
    var gear = ['2f3540', 'e8e4dc', 'd9604f', '4f7fd0', 'f0b04c'];
    var hats = ['3f5a85', 'c86b56', 'efe3c8', '4c525c', '6d8b5a', 'e2b85c'];
    var accessory = look % 20 < 9 ? 'none' : look % 20 < 15 ? 'glasses' : 'headphones';
    var skin = color(skins[hash % skins.length]);
    var freckles = hash % skins.length < 4 && (look >>> 22) % 4 === 0;
    var shirt = distinct(shirts, (hash >>> 7) % shirts.length, [skin]);
    var outfit = (look >>> 4) % OUTFITS.length;
    var bottoms = OUTFITS[outfit] === 'overalls' ? ['5a7bb0', '6f8a5c', 'b08f68', 'c0705c', '7a6ea8'] : pants;
    var hairColor = color(hairs[(hash >>> 3) % hairs.length]);
    var hatRoll = (look >>> 26) % 9;
    return { skin: skin, hair: hairColor,
      shirt: shirt, pants: distinct(bottoms, (hash >>> 12) % bottoms.length, [shirt, skin]),
      shoes: color(shoes[(hash >>> 17) % shoes.length]), hairStyle: (hash >>> 21) % HAIR_STYLES.length,
      outfit: outfit, trim: color(trims[(look >>> 9) % trims.length]),
      eyes: color(eyes[(look >>> 13) % eyes.length]), accessory: accessory, gear: color(gear[(look >>> 17) % gear.length]), freckles: freckles,
      hat: accessory === 'headphones' ? 'none' : hatRoll === 0 ? 'cap' : hatRoll === 1 ? 'beanie' : 'none',
      hatColor: distinct(hats, (look >>> 6) % hats.length, [hairColor]), badge: (look >>> 2) % 4 === 0,
      phase: (look >>> 20) % 1000 / 1000 };
  }

  /* One indexed cube-sphere. Each vertex keeps its unit direction and the sign of its octant, so a vertex
     shader can place it at corner * inner + direction * radius: spheres, capsules, cylinders and rounded
     boxes all come from the same buffer without stretching their rounded edges. */
  function roundedGeometry(segments)
  {
    var steps = Math.max(1, Math.round(segments || 6));
    var count = steps * 2 + 2;
    var vertices = [];
    var indices = [];
    var faces = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
    function coordinate(index)
    {
      var value = index <= steps ? -1 + index / steps : (index - steps - 1) / steps;
      return { value: Math.tan(value * Math.PI / 4), sign: index <= steps ? -1 : 1 };
    }
    faces.forEach(function (face)
    {
      var base = vertices.length / 6;
      var row;
      var column;
      for (row = 0; row < count; row += 1)
      {
        for (column = 0; column < count; column += 1)
        {
          var first = coordinate(row);
          var second = coordinate(column);
          var point = [0, 0, 0];
          var corner = [0, 0, 0];
          point[face[0]] = face[1];
          corner[face[0]] = face[1];
          point[face[2]] = first.value;
          corner[face[2]] = first.sign;
          point[face[3]] = second.value;
          corner[face[3]] = second.sign;
          var length = Math.hypot(point[0], point[1], point[2]);
          vertices.push(point[0] / length, point[1] / length, point[2] / length, corner[0], corner[1], corner[2]);
        }
      }
      for (row = 0; row < count - 1; row += 1)
      {
        for (column = 0; column < count - 1; column += 1)
        {
          var a = base + row * count + column;
          var b = base + (row + 1) * count + column;
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    });
    return { vertices: vertices, indices: indices };
  }

  function point(x, y, z)
  {
    return { x: x, y: y, z: z };
  }

  function rotate(basis, value)
  {
    return point(basis[0][0] * value.x + basis[1][0] * value.y + basis[2][0] * value.z,
      basis[0][1] * value.x + basis[1][1] * value.y + basis[2][1] * value.z,
      basis[0][2] * value.x + basis[1][2] * value.y + basis[2][2] * value.z);
  }

  function multiply(first, second)
  {
    return second.map(function (column) { var value = rotate(first, point(column[0], column[1], column[2])); return [value.x, value.y, value.z]; });
  }

  /* Columns of Ry(yaw) * Rx(pitch) * Rz(roll). */
  function euler(pitch, yaw, roll)
  {
    var cx = Math.cos(pitch || 0);
    var sx = Math.sin(pitch || 0);
    var cy = Math.cos(yaw || 0);
    var sy = Math.sin(yaw || 0);
    var cz = Math.cos(roll || 0);
    var sz = Math.sin(roll || 0);
    var ry = [[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]];
    var rx = [[1, 0, 0], [0, cx, sx], [0, -sx, cx]];
    var rz = [[cz, sz, 0], [-sz, cz, 0], [0, 0, 1]];
    return multiply(ry, multiply(rx, rz));
  }

  function axisBasis(axis)
  {
    var length = Math.hypot(axis.x, axis.y, axis.z) || 1;
    var y = [axis.x / length, axis.y / length, axis.z / length];
    var reference = Math.abs(y[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    var x = [y[1] * reference[2] - y[2] * reference[1], y[2] * reference[0] - y[0] * reference[2], y[0] * reference[1] - y[1] * reference[0]];
    var xLength = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xLength, x[1] / xLength, x[2] / xLength];
    var z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [x, y, z];
  }

  function surface(name, center, inner, radius, material, settings)
  {
    settings = settings || {};
    return { name: name, mesh: settings.mesh || 'round', position: point(center.x, center.y, center.z),
      basis: settings.basis || (settings.rotation ? euler(settings.rotation.x, settings.rotation.y, settings.rotation.z) : euler(0, 0, 0)),
      inner: inner, radius: radius, color: material, gloss: typeof settings.gloss === 'number' ? settings.gloss : 0.12,
      rim: typeof settings.rim === 'number' ? settings.rim : 0.35, sss: settings.sss || 0, emissive: settings.emissive || 0,
      paint: settings.paint || [0, 0, 0, 0], paint2: settings.paint2 || [0, 0, 0, 0], color2: settings.color2 || null,
      color3: settings.color3 || null, cast: settings.cast !== false, blend: settings.blend || '', taper: settings.taper || 0 };
  }

  function ellipsoid(name, center, radii, material, settings)
  {
    return surface(name, center, [0, 0, 0], radii.slice(), material, settings);
  }

  function box(name, center, half, round, material, settings)
  {
    var radius = Math.min(round, half[0], half[1], half[2]);
    return surface(name, center, [half[0] - radius, half[1] - radius, half[2] - radius], [radius, radius, radius], material, settings);
  }

  function capsule(name, start, end, radius, material, settings)
  {
    var axis = point(end.x - start.x, end.y - start.y, end.z - start.z);
    var length = Math.hypot(axis.x, axis.y, axis.z);
    var options = Object.assign({}, settings || {}, { basis: axisBasis(length > 0.0001 ? axis : point(0, 1, 0)) });
    var part = surface(name, point((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2), [0, length / 2, 0], [radius, radius, radius], material, options);
    part.start = start;
    part.end = end;
    return part;
  }

  function cylinder(name, center, radius, halfHeight, material, settings)
  {
    var edge = Math.min(0.012, halfHeight * 0.5);
    return surface(name, center, [0, halfHeight - edge, 0], [radius, edge, radius], material, settings);
  }

  function mix(first, second, amount)
  {
    return point(first.x + (second.x - first.x) * amount, first.y + (second.y - first.y) * amount, first.z + (second.z - first.z) * amount);
  }

  function offset(value, x, y, z)
  {
    return point(value.x + x, value.y + y, value.z + z);
  }

  function transform(list, pivot, basis)
  {
    list.forEach(function (part)
    {
      var moved = rotate(basis, point(part.position.x - pivot.x, part.position.y - pivot.y, part.position.z - pivot.z));
      part.position = point(pivot.x + moved.x, pivot.y + moved.y, pivot.z + moved.z);
      part.basis = multiply(basis, part.basis);
      ['start', 'end'].forEach(function (key)
      {
        if (!part[key]) return;
        var value = rotate(basis, point(part[key].x - pivot.x, part[key].y - pivot.y, part[key].z - pivot.z));
        part[key] = point(pivot.x + value.x, pivot.y + value.y, pivot.z + value.z);
      });
    });
    return list;
  }

  function blinkAt(seconds, phase)
  {
    var period = 3.4 + phase * 2.2;
    var local = (seconds + phase * 11) % period;
    return local < 0.15 ? 1 - Math.sin(local / 0.15 * Math.PI) * 0.92 : 1;
  }

  /* Joint positions in character space (y up, facing +z, feet on y = 0) before the scene scales and turns it. */
  function skeleton(stance, activity, seconds, animated, phase, look, wave)
  {
    var breath = animated ? Math.sin(seconds * 1.7 + phase * 6.28) * 0.007 : 0;
    var joints;
    if (stance === 'desk')
    {
      joints = { pelvis: point(0, 0.52, 0), torso: point(0, 0.84 + breath, -0.01), lean: 0.04, head: point(0, 1.58 + breath * 1.4, 0.03),
        hips: [point(-0.125, 0.52, 0.02), point(0.125, 0.52, 0.02)], knees: [point(-0.14, 0.47, 0.38), point(0.14, 0.47, 0.38)],
        ankles: [point(-0.14, 0.13, 0.4), point(0.14, 0.13, 0.4)] };
    }
    else if (stance === 'sofa')
    {
      joints = { pelvis: point(0, 0.47, -0.04), torso: point(0, 0.76 + breath, -0.09), lean: -0.16, head: point(0, 1.46 + breath * 1.4, -0.11),
        hips: [point(-0.13, 0.47, -0.02), point(0.13, 0.47, -0.02)], knees: [point(-0.16, 0.45, 0.33), point(0.16, 0.45, 0.33)],
        ankles: [point(-0.17, 0.13, 0.4), point(0.17, 0.13, 0.4)] };
    }
    else
    {
      var stride = activity === 'walk' && animated ? Math.sin(seconds * 9) : 0;
      var lift = activity === 'walk' && animated ? Math.abs(Math.cos(seconds * 9)) * 0.025 : 0;
      joints = { pelvis: point(0, 0.62 + lift, 0), torso: point(0, 0.9 + breath + lift, 0), lean: 0, head: point(0, 1.63 + breath * 1.4 + lift, 0.02),
        hips: [point(-0.125, 0.6 + lift, 0), point(0.125, 0.6 + lift, 0)],
        knees: [point(-0.13, 0.36 + lift, 0.02 + stride * 0.08), point(0.13, 0.36 + lift, 0.02 - stride * 0.08)],
        ankles: [point(-0.13, 0.13 + Math.max(0, stride) * 0.05, stride * 0.13), point(0.13, 0.13 + Math.max(0, -stride) * 0.05, -stride * 0.13)] };
      joints.stride = stride;
    }
    var top = joints.torso.y + 0.2;
    joints.shoulders = [point(-0.27, top, joints.torso.z), point(0.27, top, joints.torso.z)];
    joints.elbows = [];
    joints.hands = [];
    [-1, 1].forEach(function (side, index)
    {
      var elbow;
      var hand;
      if (stance === 'desk' && activity === 'typing')
      {
        var tap = animated ? Math.max(0, Math.sin(seconds * 15 + index * 1.9 + phase * 4)) * 0.026 : 0;
        elbow = point(side * 0.36, 0.8, 0.16);
        hand = point(side * 0.19, 0.76 + tap, 0.4);
      }
      else if (stance === 'desk' && wave > 0 && side === 1)
      {
        var shake = animated ? Math.sin(seconds * 16) * 0.07 : 0;
        elbow = point(0.44, joints.torso.y + 0.14, 0.12);
        hand = point(0.5 + shake, joints.torso.y + 0.5, 0.2);
      }
      else if (stance === 'desk' && activity === 'turned')
      {
        elbow = point(side * 0.34, 0.75, 0.14);
        hand = point(side * 0.17, 0.66, 0.32);
      }
      else if (stance === 'desk' && activity === 'waiting')
      {
        var tilt = animated ? Math.sin(seconds * 1.3 + phase * 3) * 0.015 : 0;
        elbow = point(side * 0.58, 1.36 + tilt, -0.12);
        hand = point(side * 0.27, 1.64 + tilt, -0.45);
      }
      else if (stance === 'desk' && activity === 'idle' && side === 1)
      {
        var sip = animated ? Math.max(0, Math.sin(seconds * 0.6 + phase * 5)) : 0;
        elbow = point(0.36, 0.8, 0.16);
        hand = point(0.2, 0.88 + sip * 0.16, 0.34 + sip * 0.02);
      }
      else if (stance === 'desk')
      {
        elbow = point(side * 0.36, 0.79, 0.15);
        hand = point(side * 0.23, 0.76, 0.37);
      }
      else if (stance === 'sofa')
      {
        elbow = point(side * 0.37, 0.66, -0.05);
        hand = point(side * 0.28, 0.54, 0.16);
      }
      else
      {
        var swing = (joints.stride || 0) * side * 0.1;
        elbow = point(side * 0.355, joints.torso.y - 0.04, 0.02 - swing);
        hand = point(side * 0.37, joints.torso.y - 0.24, 0.07 - swing * 1.8);
      }
      joints.elbows.push(elbow);
      joints.hands.push(hand);
    });
    joints.headTurn = { pitch: 0, yaw: 0, roll: 0 };
    if (stance === 'desk' && activity === 'typing') joints.headTurn.yaw = (look || 0) * 0.34;
    if (stance === 'desk' && activity === 'waiting')
    {
      joints.headTurn = { pitch: -0.1, yaw: 0.1, roll: 0.06 };
      joints.lean = -0.06;
    }
    if (activity === 'sleep') joints.headTurn = { pitch: 0.16, yaw: 0, roll: 0.24 };
    if (activity === 'relax') joints.headTurn = { pitch: -0.04, yaw: 0, roll: -0.08 };
    return joints;
  }

  function expression(activity, phone, seconds, animated, phase, look)
  {
    var open = animated ? blinkAt(seconds, phase) : 1;
    var face = { open: open, eyes: EYES.open, mouth: MOUTH.smile, gaze: 0, brow: 0, blush: 0.75 };
    if (activity === 'typing') { face.gaze = (look || 0) * 0.7; face.mouth = MOUTH.flat; }
    if (activity === 'waiting') { face.gaze = 0.55; face.mouth = MOUTH.flat; face.brow = 0.35; }
    if (activity === 'unknown') { face.mouth = MOUTH.round; face.gaze = -0.4; }
    if (activity === 'error') { face.mouth = MOUTH.frown; face.brow = 0.6; }
    if (activity === 'relax') { face.eyes = EYES.happy; face.mouth = MOUTH.smile; }
    if (activity === 'sleep') { face.eyes = EYES.closed; face.mouth = MOUTH.round; face.blush = 1; }
    if (phone === 'outgoing' || phone === 'connected')
    {
      face.eyes = EYES.open;
      face.mouth = phone === 'connected' ? MOUTH.talk + (animated ? 0.2 + Math.abs(Math.sin(seconds * 11)) * 0.7 : 0.55) : MOUTH.smile;
      face.gaze = -0.2;
    }
    if (phone === 'ringing') { face.eyes = EYES.open; face.mouth = MOUTH.round; face.open = 1; face.brow = -0.25; }
    return face;
  }

  function hairParts(materials, head, stance)
  {
    var hair = materials.hair;
    var style = HAIR_STYLES[materials.hairStyle % HAIR_STYLES.length];
    var settings = { tousled: [0.21, 0.1, -0.62, 1.15, -0.05, 0, 7], swept: [0.2, 0.06, -0.6, 1.15, -0.08, 0.22, 5],
      bob: [0.15, 0.02, -0.86, 0.95, -0.8, 0, 12], bun: [0.33, 0.08, -0.55, 1.2, -0.05, 0, 4.5], curly: [0.24, 0.1, -0.62, 1.15, -0.1, 0, 8],
      spiky: [0.26, 0.16, -0.55, 1.15, 0, 0, 6.5], long: [0.18, 0.05, -0.92, 0.98, -0.72, 0, 8], ponytail: [0.27, 0.1, -0.5, 1.2, -0.05, 0, 5] }[style];
    var grow = style === 'bob' || style === 'long' ? 1.1 : style === 'curly' ? 1.1 : 1.08;
    var hat = materials.hat === 'cap' || materials.hat === 'beanie';
    var list = [ellipsoid('hair', offset(head, 0, 0.035, -0.02), [HEAD[0] * (grow - 0.005), HEAD[1] * grow, HEAD[2] * grow], hair,
      { gloss: 0.32, rim: 0.5, taper: HEAD_TAPER, paint: [PAINT.hair, settings[0], settings[1], settings[2]], paint2: [settings[3], settings[4], settings[5], settings[6]] })];
    /* A lock is a strand-shaded ellipsoid; a positive taper narrows its lower end, a negative one its tip. */
    function lock(name, x, y, z, radii, rotation, taper)
    {
      list.push(ellipsoid(name, offset(head, x, y, z), radii, hair,
        { gloss: 0.3, rim: 0.5, rotation: rotation, taper: taper || 0, paint: [PAINT.strand, 0, 0, 0] }));
    }
    /* Overlapping locks fanned across the back of the head, so the hair ends in layers rather than blobs. */
    function fan(name, xs, y, backZ, radii, tilt, taper)
    {
      xs.forEach(function (x) { lock(name, x, y, backZ + 1.1 * x * x, radii, { x: tilt, y: 0, z: -x * 0.9 }, taper); });
    }
    if (style === 'tousled' || style === 'swept' || style === 'spiky' || style === 'ponytail')
    {
      [-1, 1].forEach(function (side)
      {
        lock('hair-puff', side * 0.45, 0.14, -0.1, [0.1, 0.2, 0.17], { x: 0.1, y: 0, z: side * -0.3 }, 0.3);
      });
      if (style !== 'ponytail') fan('hair-nape', [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3], -0.22, -0.45, [0.1, 0.16, 0.07], -0.3, 0.35);
    }
    /* A hat covers the crown: no tufts, spikes or bun under it, and only the lower curls. */
    if (!hat && style === 'tousled')
    {
      lock('hair-tuft', 0.05, 0.53, 0.04, [0.05, 0.13, 0.04], { x: -0.2, y: 0, z: -0.35 }, -0.5);
      lock('hair-tuft', -0.03, 0.51, 0.02, [0.04, 0.1, 0.035], { x: -0.1, y: 0, z: 0.45 }, -0.5);
    }
    else if (!hat && style === 'swept')
    {
      lock('hair-lock', -0.12, 0.33, 0.37, [0.3, 0.09, 0.07], { x: -0.35, y: 0, z: -0.32 });
      lock('hair-tuft', 0.12, 0.52, -0.02, [0.05, 0.12, 0.04], { x: 0, y: 0, z: -0.5 }, -0.5);
    }
    else if (!hat && style === 'bun')
    {
      list.push(ellipsoid('hair-bun', offset(head, 0, 0.5, -0.17), [0.17, 0.16, 0.16], hair, { gloss: 0.32, rim: 0.5, paint: [PAINT.strand, 0, 0, 0] }));
      list.push(ellipsoid('hair-tie', offset(head, 0, 0.41, -0.13), [0.11, 0.035, 0.1], materials.gear, { rotation: { x: 0.45, y: 0, z: 0 } }));
    }
    else if (style === 'curly')
    {
      [[0, 0.48, 0.05], [0.24, 0.42, 0.08], [-0.24, 0.42, 0.08], [0.36, 0.22, 0.05], [-0.36, 0.22, 0.05], [0.14, 0.47, -0.2],
        [-0.14, 0.47, -0.2], [0.33, 0.25, -0.24], [-0.33, 0.25, -0.24], [0, 0.32, -0.42], [0.18, 0.33, 0.34], [-0.16, 0.34, 0.35]].filter(function (entry)
      {
        return !hat || entry[1] < 0.3;
      }).forEach(function (entry)
      {
        list.push(ellipsoid('hair-curl', offset(head, entry[0], entry[1], entry[2]), [0.13, 0.12, 0.13], hair,
          { mesh: 'low', gloss: 0.25, rim: 0.5, paint: [PAINT.strand, 0, 0, 0] }));
      });
    }
    else if (!hat && style === 'spiky')
    {
      [[0, 0.5, 0.06, 0, 0.1], [0.17, 0.46, 0.02, -0.4, 0.2], [-0.17, 0.46, 0.02, 0.4, 0.2], [0.09, 0.44, -0.2, -0.2, -0.45], [-0.1, 0.44, -0.2, 0.25, -0.45]].forEach(function (entry)
      {
        lock('hair-spike', entry[0], entry[1], entry[2], [0.075, 0.17, 0.075], { x: entry[4], y: 0, z: entry[3] }, -0.55);
      });
    }
    else if (style === 'long')
    {
      [-1, 1].forEach(function (side)
      {
        lock('hair-long', side * 0.42, -0.44, -0.05, [0.1, 0.36, 0.16], { x: 0.06, y: 0, z: side * 0.08 }, 0.35);
      });
      fan('hair-back', [-0.33, -0.22, -0.11, 0, 0.11, 0.22, 0.33], -0.5, -0.3, [0.13, 0.4, 0.1], -0.12, 0.3);
    }
    else if (style === 'ponytail')
    {
      list.push(ellipsoid('hair-tie', offset(head, 0, 0.16, -0.5), [0.085, 0.085, 0.05], materials.gear, { rotation: { x: 0.5, y: 0, z: 0 } }));
      lock('hair-tail', 0.02, -0.05, -0.6, [0.14, 0.22, 0.11], { x: -0.35, y: 0, z: 0.15 }, 0.3);
      lock('hair-tail', 0.04, -0.3, -0.6, [0.11, 0.2, 0.09], { x: 0.1, y: 0, z: -0.2 }, 0.4);
      lock('hair-tail', 0.08, -0.53, -0.56, [0.075, 0.16, 0.065], { x: 0.25, y: 0, z: -0.4 }, 0.5);
    }
    if (hat)
    {
      var felt = materials.hatColor;
      var shell = [HEAD[0] * 1.14, HEAD[1] * 1.14, HEAD[2] * 1.14];
      if (materials.hat === 'cap')
      {
        /* Six-panel dome cut above the brow, a clearly darker brim sloping down in front, and a button on top. */
        list.push(ellipsoid('hat', offset(head, 0, 0.05, -0.02), shell, felt,
          { gloss: 0.06, rim: 0.3, taper: HEAD_TAPER, cast: false, paint: [PAINT.cap, 0.5, 0, 0], paint2: [1.4, 0.35, 0, 0] }));
        list.push(ellipsoid('hat-brim', offset(head, 0, 0.29, 0.5), [0.28, 0.028, 0.22], tone(felt, 0.72), { gloss: 0.1, rotation: { x: 0.22, y: 0, z: 0 } }));
        list.push(ellipsoid('hat-button', offset(head, 0, 0.57, -0.02), [0.04, 0.03, 0.04], tone(felt, 0.85), { mesh: 'low' }));
      }
      else
      {
        /* Knit dome, a thicker folded cuff around the brow and a pom-pom. Both are cut by the same latitude line.
           The cut shells do not cast: the shadow pass cannot cut them, and they would shade the face. */
        list.push(ellipsoid('hat', offset(head, 0, 0.05, -0.02), shell, felt,
          { gloss: 0.04, rim: 0.3, taper: HEAD_TAPER, cast: false, paint: [PAINT.beanie, 0, 0, 0.05], paint2: [-1, 0.3, 0, 0] }));
        list.push(ellipsoid('hat-cuff', offset(head, 0, 0.05, -0.02), [HEAD[0] * 1.19, HEAD[1] * 1.19, HEAD[2] * 1.19], tone(felt, 0.88),
          { gloss: 0.04, rim: 0.3, taper: HEAD_TAPER, cast: false, paint: [PAINT.cuff, 0, 0, 0.05], paint2: [-1, 0.3, 0, 0.3] }));
        list.push(ellipsoid('hat-pom', offset(head, 0, 0.62, -0.02), [0.11, 0.1, 0.11], tone(felt, 1.12), Object.assign({ mesh: 'low' }, cloth(CLOTH.fleece))));
      }
    }
    return list;
  }

  /* Character-only finish. The sky rim lifts every silhouette edge by the same amount, so dark materials (black hair,
     dark shoes) fog over unless it scales with their brightness, and parts too small to show curvature at stage
     size use the coarse mesh. Furniture shares the shape helpers and keeps its own look. */
  function finish(part)
  {
    var luma = 0.2126 * part.color[0] + 0.7152 * part.color[1] + 0.0722 * part.color[2];
    part.rim *= 0.35 + 0.65 * Math.min(1, luma * 1.6);
    if (part.mesh === 'round' && Math.max(part.radius[0], part.radius[1], part.radius[2]) < 0.05) part.mesh = 'low';
    return part;
  }

  /* Exact top of a part: its inner box spans corner * inner and the rounded shell adds direction * radius. */
  function partTop(part)
  {
    var basis = part.basis;
    var inner = 0;
    var round = 0;
    var axis;
    for (axis = 0; axis < 3; axis += 1)
    {
      inner += Math.abs(basis[axis][1]) * part.inner[axis];
      round += Math.pow(basis[axis][1] * part.radius[axis], 2);
    }
    return part.position.y + inner + Math.sqrt(round);
  }

  /* Highest silhouette point in character units for a stance, used to keep nameplates clear of hair and headphones. */
  function silhouetteTop(stance, materials)
  {
    return parts('silhouette', { stance: stance, materials: materials || palette('silhouette') }).reduce(function (top, part)
    {
      return Math.max(top, partTop(part));
    }, 0);
  }

  function parts(id, pose)
  {
    pose = pose || {};
    var m = pose.materials || palette(id);
    var stance = pose.stance || (pose.seated ? 'sofa' : 'stand');
    var activity = pose.activity || (pose.working ? 'typing' : stance === 'sofa' ? 'relax' : 'idle');
    var seconds = (Number(pose.time) || 0) / 1000;
    var animated = !!pose.time;
    var phone = /^(outgoing|ringing|connected)$/.test(pose.phone || '') ? pose.phone : '';
    var look = Number(pose.look) || 0;
    var accent = pose.accent || color('e5895f');
    var wave = Number(pose.wave) || 0;
    var joints = skeleton(stance, activity, seconds, animated, m.phase, look, wave);
    var face = expression(activity, phone, seconds, animated, m.phase, look);
    if (activity === 'turned') { face.mouth = wave > 0 ? MOUTH.talk + 0.55 : MOUTH.smile; face.gaze = 0; face.blush = 0.9; }
    var outfit = OUTFITS[m.outfit % OUTFITS.length];
    var shirt = m.shirt;
    var sleeve = outfit === 'cardigan' ? m.shirt : shirt;
    var weave = { tee: CLOTH.cotton, hoodie: CLOTH.fleece, cardigan: CLOTH.knit, shirt: CLOTH.twill, sweater: CLOTH.knit, overalls: CLOTH.cotton }[outfit];
    var dark = tone(shirt, 0.78);
    var body = [];
    var arms = [];
    var legs = [];
    var headGroup = [];
    var T = joints.torso;
    var top = T.y + 0.3;
    var pelvis = point(0, joints.pelvis.y, joints.pelvis.z);
    var leanBasis = euler(joints.lean || 0, 0, 0);
    joints.shoulders = joints.shoulders.map(function (shoulder) { return transform([{ position: shoulder, basis: euler(0, 0, 0) }], pelvis, leanBasis)[0].position; });
    if (stance === 'sofa')
    {
      joints.elbows = joints.elbows.map(function (elbow) { return transform([{ position: elbow, basis: euler(0, 0, 0) }], pelvis, leanBasis)[0].position; });
    }

    if (phone)
    {
      var ringShake = phone === 'ringing' && animated ? Math.sin(seconds * 60) * 0.012 : 0;
      joints.elbows[1] = point(0.6, joints.head.y - 0.52, joints.head.z + 0.04);
      joints.hands[1] = point(0.6 + ringShake, joints.head.y - 0.12, joints.head.z + 0.1);
    }

    legs.push(box('pants', point(0, joints.pelvis.y + 0.01, joints.pelvis.z), [0.27, 0.11, 0.2], 0.1, m.pants, Object.assign({ gloss: 0.08 }, cloth(CLOTH.twill))));
    [0, 1].forEach(function (index)
    {
      legs.push(capsule('leg', joints.hips[index], joints.knees[index], 0.108, m.pants, Object.assign({ gloss: 0.08, taper: -0.06 }, cloth(CLOTH.twill))));
      legs.push(capsule('leg', joints.knees[index], joints.ankles[index], 0.098, m.pants, Object.assign({ gloss: 0.08, taper: -0.12 }, cloth(CLOTH.twill))));
      var ankle = joints.ankles[index];
      var footY = Math.max(0.075, ankle.y - 0.055);
      legs.push(box('shoe', point(ankle.x, footY, ankle.z + 0.06), [0.1, 0.075, 0.165], 0.07, m.shoes, { gloss: 0.3, paint: [PAINT.shoe, 0, 0, 0] }));
      legs.push(box('shoe-sole', point(ankle.x, footY - 0.055, ankle.z + 0.065), [0.106, 0.022, 0.172], 0.02,
        m.shoes[0] > 0.8 ? color('d9d3c8') : color('f4f1ea'), { gloss: 0.1 }));
    });

    body.push(box('body', T, [0.29, 0.3, 0.205], 0.18, outfit === 'cardigan' ? m.trim : shirt, Object.assign({ gloss: 0.08 }, cloth(outfit === 'cardigan' ? CLOTH.cotton : weave))));
    body.push(capsule('neck', point(0, top - 0.06, T.z), point(0, top + 0.08, T.z + 0.01), 0.075, m.skin, { sss: 1 }));
    if (outfit === 'tee' || outfit === 'overalls' || outfit === 'sweater')
    {
      body.push(ellipsoid('collar', point(0, top - 0.03, T.z + 0.02), [0.15, 0.04, 0.125], outfit === 'sweater' ? dark : tone(shirt, 0.85), { gloss: 0.06 }));
    }
    if (outfit === 'hoodie')
    {
      body.push(ellipsoid('hood', point(0, top - 0.06, T.z - 0.15), [0.26, 0.13, 0.13], dark, cloth(CLOTH.fleece)));
      body.push(box('pocket', point(0, T.y - 0.13, T.z + 0.192), [0.17, 0.075, 0.02], 0.02, dark, cloth(CLOTH.fleece)));
      [-1, 1].forEach(function (side)
      {
        body.push(capsule('drawstring', point(side * 0.06, top - 0.06, T.z + 0.19), point(side * 0.07, T.y + 0.06, T.z + 0.212), 0.011, m.trim));
      });
    }
    if (outfit === 'cardigan')
    {
      [-1, 1].forEach(function (side)
      {
        body.push(box('cardigan', point(side * 0.17, T.y, T.z + 0.004), [0.15, 0.295, 0.207], 0.14, shirt, Object.assign({ gloss: 0.06 }, cloth(CLOTH.knit))));
      });
      [0.12, 0, -0.12].forEach(function (y) { body.push(ellipsoid('button', point(0.045, T.y + y, T.z + 0.205), [0.016, 0.016, 0.01], m.trim, { mesh: 'low' })); });
    }
    if (outfit === 'shirt')
    {
      body.push(box('placket', point(0, T.y + 0.01, T.z + 0.2), [0.024, 0.26, 0.012], 0.01, tone(shirt, 0.92)));
      [-1, 1].forEach(function (side)
      {
        body.push(box('collar', point(side * 0.085, top - 0.02, T.z + 0.13), [0.085, 0.03, 0.06], 0.025, m.trim, { rotation: { x: 0.25, y: 0, z: side * 0.5 } }));
      });
    }
    if (outfit === 'sweater')
    {
      body.push(box('hem', point(0, T.y - 0.255, T.z), [0.296, 0.05, 0.21], 0.05, dark, cloth(CLOTH.knit)));
      body.push(box('stripe', point(0, T.y + 0.07, T.z), [0.297, 0.03, 0.211], 0.03, tone(shirt, 0.8), cloth(CLOTH.knit)));
    }
    if (outfit === 'overalls')
    {
      body.push(box('bib', point(0, T.y - 0.09, T.z + 0.152), [0.17, 0.15, 0.065], 0.065, m.pants, Object.assign({ gloss: 0.05 }, cloth(CLOTH.twill))));
      body.push(box('bib-pocket', point(0, T.y - 0.07, T.z + 0.214), [0.07, 0.05, 0.006], 0.006, tone(m.pants, 0.86)));
      [-1, 1].forEach(function (side)
      {
        body.push(capsule('strap', point(side * 0.13, T.y + 0.1, T.z + 0.2), point(side * 0.16, top - 0.02, T.z), 0.028, m.pants, cloth(CLOTH.twill)));
        body.push(ellipsoid('button', point(side * 0.12, T.y + 0.08, T.z + 0.215), [0.022, 0.022, 0.012], color('e3c26a'), { mesh: 'low', gloss: 0.6 }));
      });
    }
    body.push(cylinder('pin', point(-0.15, T.y + 0.13, T.z + 0.203), 0.032, 0.008, accent, { rotation: { x: Math.PI / 2, y: 0, z: 0 }, gloss: 0.5, cast: false }));
    if (m.badge && /^(tee|shirt|sweater)$/.test(outfit))
    {
      [-1, 1].forEach(function (side)
      {
        body.push(capsule('lanyard', point(side * 0.075, top - 0.03, T.z + 0.13), point(side * 0.012, T.y + 0.1, T.z + 0.2), 0.011, m.gear, { gloss: 0.3, cast: false }));
      });
      body.push(box('badge', point(0, T.y + 0.02, T.z + 0.21), [0.055, 0.07, 0.008], 0.008, m.trim, { gloss: 0.25, cast: false }));
    }

    var longSleeve = outfit === 'hoodie' || outfit === 'cardigan' || outfit === 'sweater';
    [0, 1].forEach(function (index)
    {
      var shoulder = joints.shoulders[index];
      var elbow = joints.elbows[index];
      var hand = joints.hands[index];
      var wrist = mix(elbow, hand, 0.8);
      arms.push(ellipsoid('sleeve', shoulder, [0.115, 0.12, 0.115], sleeve, Object.assign({ gloss: 0.06 }, cloth(weave))));
      if (longSleeve)
      {
        arms.push(capsule('upper-arm', shoulder, elbow, 0.096, sleeve, Object.assign({ taper: -0.06 }, cloth(weave))));
        arms.push(capsule('forearm', elbow, wrist, 0.09, sleeve, Object.assign({ taper: -0.1 }, cloth(weave))));
        arms.push(capsule('cuff', mix(elbow, hand, 0.68), wrist, 0.097, outfit === 'sweater' ? dark : tone(sleeve, 0.85), cloth(CLOTH.knit)));
      }
      else
      {
        var cuffAt = outfit === 'shirt' ? 0.92 : 0.45;
        arms.push(capsule('sleeve', shoulder, mix(shoulder, elbow, cuffAt), outfit === 'shirt' ? 0.1 : 0.106, sleeve, cloth(weave)));
        arms.push(capsule('upper-arm', mix(shoulder, elbow, 0.3), elbow, 0.075, m.skin, { sss: 1, taper: -0.06 }));
        arms.push(capsule('forearm', elbow, wrist, 0.07, m.skin, { sss: 1, taper: -0.1 }));
      }
      arms.push(ellipsoid('hand', hand, [0.074, 0.078, 0.07], m.skin, { sss: 1, gloss: 0.15 }));
      arms.push(ellipsoid('thumb', offset(hand, (index ? -1 : 1) * 0.048, 0.022, 0.03), [0.03, 0.034, 0.03], m.skin, { mesh: 'low', sss: 1 }));
    });
    if (phone)
    {
      var hand = joints.hands[1];
      var phoneBasis = euler(0.05, 0.9, 0.22);
      var facingOut = rotate(phoneBasis, point(0, 0, 1));
      var phoneCenter = offset(hand, -0.01, 0.09, 0.03);
      arms.push(box('phone-body', phoneCenter, [0.04, 0.085, 0.012], 0.012, color('1d2128'), { basis: phoneBasis, gloss: 0.7 }));
      arms.push(box('phone-screen', offset(phoneCenter, facingOut.x * 0.013, facingOut.y * 0.013, facingOut.z * 0.013), [0.032, 0.07, 0.002], 0.002,
        phone === 'ringing' ? color('ffd27a') : color('8fe3c4'), { basis: phoneBasis, emissive: 1, cast: false }));
    }
    else if (stance === 'desk' && activity === 'idle')
    {
      var mugHand = joints.hands[1];
      arms.push(cylinder('mug', offset(mugHand, -0.075, 0.025, 0.03), 0.06, 0.07, m.gear, { gloss: 0.4 }));
      arms.push(capsule('mug-handle', offset(mugHand, -0.005, 0.06, 0.04), offset(mugHand, -0.005, 0.0, 0.04), 0.014, m.gear));
    }

    var H = joints.head;
    headGroup.push(ellipsoid('head', H, HEAD.slice(), m.skin, { gloss: 0.22, rim: 0.4, sss: 1, taper: HEAD_TAPER,
      paint: [PAINT.face, face.open, face.mouth, face.eyes], paint2: [(m.accessory === 'glasses' ? 1 : 0) + (m.freckles ? 2 : 0), face.blush, face.brow, face.gaze],
      color2: m.eyes, color3: tone(m.hair, 0.9) }));
    if (m.accessory !== 'headphones')
    {
      [-1, 1].forEach(function (side)
      {
        headGroup.push(ellipsoid('ear', offset(H, side * 0.5, -0.045, -0.01), [0.072, 0.1, 0.075], m.skin, { sss: 1, mesh: 'low', paint: [PAINT.ear, side, 0, 0] }));
      });
    }
    hairParts(m, H, stance).forEach(function (part) { headGroup.push(part); });
    if (m.accessory === 'headphones')
    {
      var band = [];
      var index;
      for (index = 0; index <= 6; index += 1)
      {
        var angle = 0.2 + index / 6 * (Math.PI - 0.4);
        band.push(offset(H, Math.cos(angle) * 0.56, 0.04 + Math.sin(angle) * 0.56, -0.04));
      }
      for (index = 0; index < band.length - 1; index += 1) headGroup.push(capsule('headphone-band', band[index], band[index + 1], 0.032, m.gear, { gloss: 0.4 }));
      [-1, 1].forEach(function (side)
      {
        headGroup.push(box('headphone-cup', offset(H, side * 0.53, -0.04, -0.02), [0.075, 0.135, 0.12], 0.07, m.gear, { gloss: 0.45 }));
        headGroup.push(box('headphone-cushion', offset(H, side * 0.475, -0.04, -0.02), [0.03, 0.115, 0.1], 0.03, color('34363d')));
      });
    }
    var turn = joints.headTurn;
    transform(headGroup, offset(H, 0, -0.38, 0), euler(turn.pitch, turn.yaw, turn.roll));
    if (joints.lean) transform(body.concat(headGroup), pelvis, leanBasis);
    return legs.concat(body, arms, headGroup).map(finish);
  }

  WasCharacterModel = { hashId: hashId, palette: palette, parts: parts, roundedGeometry: roundedGeometry, silhouetteTop: silhouetteTop, partTop: partTop,
    shapes: { ellipsoid: ellipsoid, box: box, capsule: capsule, cylinder: cylinder, euler: euler, axisBasis: axisBasis },
    color: color, tone: tone, PAINT: PAINT, HAIR_STYLES: HAIR_STYLES, OUTFITS: OUTFITS, HEAD: HEAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = WasCharacterModel;
}());
