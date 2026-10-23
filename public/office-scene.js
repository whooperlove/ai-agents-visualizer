/* Horizontal arcade stage. Recorded deliveries are illustrated as phone calls without changing seats. */
var WasOfficeScene = null;

(function ()
{
  'use strict';

  var CHARACTER_SCALE = 1.2;
  var WORK_Z = -0.25;
  var REST_Z = -0.42;
  var WALL_Z = -1.75;
  var PITCH = 0.24;
  var FLOOR_FRACTION = 0.15;
  var LABEL_HEIGHT = 46;
  var LABEL_GAP = 8;
  var LABEL_RESERVE = LABEL_HEIGHT + LABEL_GAP + 12;
  var FLOOR_WHEEL_STEP = 40;
  var FLOOR_WHEEL_HOLD = 450;
  var PARTNER_GAP = 8;
  var PARTNER_MIN_WIDTH = 112;
  var PARTNER_MAX_WIDTH = 180;
  var PARTNER_LIFETIME = 30 * 60 * 1000;
  var PARTNER_FADE_FROM = 0.5;
  var PARTNER_LEAVE = 900;
  var PARTNER_AGE_STEP = 1000;
  var ANCHOR_TOP = 2.74;
  var SHADOW_SIZE = 2048;
  /* Least time between two redraws that nothing asked for: about 30 frames a second. A window without the focus and a hidden
     tab draw no in-between frames at all: the stage redraws only when something changes, and shows the new state at once. */
  var ACTIVE_FRAME_GAP = 30;
  /* Frames per second the characters are posed at, like stop-motion clay. 0 keeps the motion smooth. */
  var STOP_MOTION_FPS = 0;
  var LIGHT = { direction: [-0.3, 0.9, 0.78], color: [2.1, 1.84, 1.5], sky: [0.42, 0.35, 0.36], ground: [0.34, 0.25, 0.18],
    lamp: [1, 0.66, 0.36], exposure: 1.0 };

  var VERTEX_SOURCE = [
    'attribute vec3 aDirection;',
    'attribute vec3 aCorner;',
    'uniform mat4 uModel;',
    'uniform mat4 uProjection;',
    'uniform mat4 uLightMatrix;',
    'uniform vec3 uInner;',
    'uniform vec3 uRadius;',
    'uniform float uShadowOffset;',
    'uniform float uTaper;',
    'uniform float uWobble;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'varying vec3 vDirection;',
    'varying vec3 vLocal;',
    'varying vec4 vShadow;',
    'varying vec3 vExtent;',
    'varying vec3 vAxis;',
    /* Hand-made irregularity: a few slow lumps along the surface, tied to the part, never to where it stands. */
    'float wobble(vec3 local) {',
    '  float lump = sin(local.x * 9.0 + uRadius.x * 31.0) * sin(local.y * 7.0 + uRadius.y * 23.0) + sin(local.z * 8.0 + local.y * 3.0 + uRadius.z * 17.0);',
    '  return lump * uWobble * min(0.01, 0.15 * min(uRadius.x, min(uRadius.y, uRadius.z)));',
    '}',
    'void main() {',
    '  vec3 local = aCorner * uInner + aDirection * uRadius;',
    '  vec3 extent = uInner + uRadius;',
    '  vExtent = extent;',
    '  vec3 normal = aDirection / max(uRadius, vec3(0.0004));',
    '  float slope = uTaper / max(extent.y, 0.0004);',
    '  float lean = 1.0 + slope * local.y;',
    '  normal = vec3(normal.x, normal.y * lean - slope * (local.x * normal.x + local.z * normal.z), normal.z);',
    '  local.xz *= lean;',
    '  local += aDirection * wobble(local);',
    '  vec4 world = uModel * vec4(local, 1.0);',
    '  vNormal = (uModel * vec4(normal, 0.0)).xyz;',
    '  vWorld = world.xyz;',
    '  vDirection = aDirection;',
    '  vLocal = local;',
    '  vec3 longest = (extent.x > extent.y && extent.x > extent.z) ? vec3(1.0, 0.0, 0.0) : (extent.z > extent.y && extent.z > extent.x) ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);',
    '  vAxis = (uModel * vec4(longest, 0.0)).xyz;',
    '  vShadow = uLightMatrix * (world + vec4(normalize(vNormal) * uShadowOffset, 0.0));',
    '  gl_Position = uProjection * world;',
    '}'].join('\n');

  var DEPTH_VERTEX_SOURCE = [
    'attribute vec3 aDirection;',
    'attribute vec3 aCorner;',
    'uniform mat4 uModel;',
    'uniform mat4 uLightMatrix;',
    'uniform vec3 uInner;',
    'uniform vec3 uRadius;',
    'uniform float uTaper;',
    'uniform float uWobble;',
    /* Hand-made irregularity: a few slow lumps along the surface, tied to the part, never to where it stands. */
    'float wobble(vec3 local) {',
    '  float lump = sin(local.x * 9.0 + uRadius.x * 31.0) * sin(local.y * 7.0 + uRadius.y * 23.0) + sin(local.z * 8.0 + local.y * 3.0 + uRadius.z * 17.0);',
    '  return lump * uWobble * min(0.01, 0.15 * min(uRadius.x, min(uRadius.y, uRadius.z)));',
    '}',
    'void main() {',
    '  vec3 local = aCorner * uInner + aDirection * uRadius;',
    '  local.xz *= 1.0 + uTaper * local.y / max(uInner.y + uRadius.y, 0.0004);',
    '  local += aDirection * wobble(local);',
    '  gl_Position = uLightMatrix * (uModel * vec4(local, 1.0));',
    '}'].join('\n');

  var PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  var DEPTH_FRAGMENT_SOURCE = PRECISION + [
    'void main() {',
    '  vec4 value = fract(gl_FragCoord.z * vec4(1.0, 255.0, 65025.0, 16581375.0));',
    '  value -= value.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);',
    '  gl_FragColor = value;',
    '}'].join('\n');

  var FRAGMENT_SOURCE = PRECISION + '#define LAMP_SLOTS 8\n' + [
    'uniform vec4 uColor;',
    'uniform vec4 uMaterial;',
    'uniform vec4 uPaint;',
    'uniform vec4 uPaint2;',
    'uniform vec3 uColor2;',
    'uniform vec3 uColor3;',
    'uniform vec4 uFrame;',
    'uniform vec3 uLightDirection;',
    'uniform vec3 uLightColor;',
    'uniform vec3 uSkyColor;',
    'uniform vec3 uGroundColor;',
    'uniform vec3 uViewDirection;',
    'uniform vec4 uShadowInfo;',
    'uniform vec4 uLamps[LAMP_SLOTS];',
    'uniform vec3 uLampColors[LAMP_SLOTS];',
    'uniform sampler2D uShadowMap;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'varying vec3 vDirection;',
    'varying vec3 vLocal;',
    'varying vec4 vShadow;',
    'varying vec3 vExtent;',
    'varying vec3 vAxis;',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'float cover(float distance, float aa) { return 1.0 - smoothstep(-aa, aa, distance); }',
    'float unpackDepth(vec4 value) { return dot(value, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }',
    'vec3 display(vec3 c) {',
    '  c *= uFrame.z;',
    '  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);',
    '  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));',
    '  float luma = dot(c, vec3(0.299, 0.587, 0.114));',
    '  c = mix(vec3(luma), c, 0.84) * vec3(1.035, 1.0, 0.95);',
    '  return c * 0.93 + vec3(0.045, 0.032, 0.036);',
    '}',
    'float shadowAt(vec3 n) {',
    '  if (uFrame.w < 0.5) return 1.0;',
    '  vec3 c = vShadow.xyz / vShadow.w * 0.5 + 0.5;',
    '  if (c.x <= 0.002 || c.x >= 0.998 || c.y <= 0.002 || c.y >= 0.998 || c.z >= 1.0) return 1.0;',
    '  float bias = uShadowInfo.y * (1.0 + 4.0 * (1.0 - clamp(dot(n, uLightDirection), 0.0, 1.0)));',
    '  float lit = 0.0;',
    '  for (int x = -1; x <= 1; x++) {',
    '    for (int y = -1; y <= 1; y++) {',
    '      lit += step(c.z - bias, unpackDepth(texture2D(uShadowMap, c.xy + vec2(float(x), float(y)) * uShadowInfo.x)));',
    '    }',
    '  }',
    '  return mix(1.0, lit / 9.0, uShadowInfo.z);',
    '}',
    'vec2 sphereCoord(vec3 d) { return vec2(atan(d.x, d.z), asin(clamp(d.y, -1.0, 1.0))); }',
    'vec3 paintEye(vec3 col, vec2 p, vec2 c, float side, float aa, inout float shine) {',
    '  float open = uPaint.y;',
    '  float style = uPaint.w;',
    '  vec3 ink = vec3(0.09, 0.06, 0.06);',
    '  if (style < 0.5 && open > 0.22) {',
    '    vec2 r = vec2(0.122, 0.165 * open);',
    '    vec2 q = (p - c) / r;',
    '    float e = length(q);',
    '    float inside = cover(e - 1.0, aa / r.x);',
    '    float t = clamp(q.y * 0.5 + 0.5, 0.0, 1.0);',
    '    vec2 ic = c + vec2(uPaint2.w * 0.04, 0.0);',
    '    vec2 ri = vec2(0.1, r.y);',
    '    float irisArea = cover(length((p - ic) / ri) - 1.0, aa / ri.x);',
    '    vec3 white = vec3(0.86, 0.8, 0.77) * (1.0 - 0.3 * smoothstep(0.45, 1.0, t));',
    '    vec3 iris = mix(uColor2 * 2.2 + vec3(0.025), uColor2 * 0.3, smoothstep(0.05, 0.85, t));',
    '    float pupil = cover(length((p - ic - vec2(0.0, 0.012)) / (ri * vec2(0.5, 0.56))) - 1.0, aa / (ri.x * 0.5));',
    '    iris = mix(iris, vec3(0.01), pupil * 0.8);',
    '    float h1 = cover(length((p - ic - vec2(-0.32 * ri.x, 0.34 * ri.y)) / vec2(0.34 * ri.x, 0.32 * ri.x)) - 1.0, aa / (0.33 * ri.x));',
    '    float h2 = cover(length((p - ic - vec2(0.36 * ri.x, -0.46 * ri.y)) / vec2(0.15 * ri.x)) - 1.0, aa / (0.15 * ri.x));',
    '    iris = mix(iris, vec3(1.0), h1);',
    '    iris = mix(iris, vec3(0.95), h2 * 0.8);',
    '    col = mix(col, mix(white, iris, irisArea), inside);',
    '    shine = max(shine, inside);',
    '    float lash = cover(abs(e - 1.03) - 0.075, aa / r.x) * smoothstep(-0.05, 0.5, q.y);',
    '    vec2 flick = p - c - vec2(side * r.x * 0.92, r.y * 0.62);',
    '    float tail = cover(length(flick / vec2(0.034, 0.014)) - 1.0, aa / 0.014) * step(0.0, side * flick.x);',
    '    return mix(col, ink, max(lash, tail));',
    '  }',
    '  float stroke;',
    '  if (style > 0.5 && style < 1.5 && open > 0.22) {',
    '    vec2 cc = c - vec2(0.0, 0.07);',
    '    stroke = cover(abs(length(p - cc) - 0.092) - 0.014, aa) * step(cc.y + 0.012, p.y);',
    '  } else {',
    '    vec2 cc = c + vec2(0.0, 0.05);',
    '    stroke = cover(abs(length(p - cc) - 0.092) - 0.013, aa) * step(p.y, cc.y - 0.012);',
    '  }',
    '  return mix(col, ink, stroke);',
    '}',
    'vec3 paintMouth(vec3 col, vec2 p, float aa) {',
    '  float mouth = uPaint.z;',
    '  vec2 m = p - vec2(0.0, -0.3);',
    '  vec3 ink = vec3(0.32, 0.11, 0.1);',
    '  float closed = (mouth < 0.5 || (mouth > 1.98 && mouth < 2.5) || mouth > 3.5) ? 1.0 : 0.0;',
    '  float lips = 1.0 - smoothstep(0.35, 1.0, length((m - vec2(0.0, -0.012)) / vec2(0.085, 0.034)));',
    '  col = mix(col, col * vec3(1.0, 0.8, 0.78) + vec3(0.02, 0.0, 0.0), lips * closed * 0.55);',
    '  if (mouth < 0.5) {',
    '    float curve = m.y - (3.4 * m.x * m.x - 0.014);',
    '    col = mix(col, ink, cover(max(abs(curve) - 0.012, abs(m.x) - 0.075), aa));',
    '  } else if (mouth < 1.98) {',
    '    float o = clamp(mouth - 1.0, 0.0, 1.0);',
    '    vec2 r = vec2(0.056, 0.014 + 0.046 * o);',
    '    float inside = cover(length(m / r) - 1.0, aa / r.y);',
    '    vec3 inner = mix(vec3(0.34, 0.07, 0.09), vec3(0.88, 0.45, 0.47), 1.0 - smoothstep(-0.85, -0.1, m.y / r.y));',
    '    col = mix(col, inner, inside);',
    '  } else if (mouth < 2.5) {',
    '    col = mix(col, ink, cover(max(abs(m.y + 0.004) - 0.0095, abs(m.x) - 0.044), aa));',
    '  } else if (mouth < 3.5) {',
    '    col = mix(col, vec3(0.36, 0.1, 0.11), cover(length(m / vec2(0.03, 0.035)) - 1.0, aa / 0.03));',
    '  } else {',
    '    float curve = m.y - (-3.2 * m.x * m.x + 0.006);',
    '    col = mix(col, ink, cover(max(abs(curve) - 0.0105, abs(m.x) - 0.058), aa));',
    '  }',
    '  return col;',
    '}',
    'vec3 paintFace(vec3 skin, vec3 d, float aa, inout float shine) {',
    '  vec2 p = sphereCoord(d);',
    '  vec3 col = skin;',
    '  for (int i = 0; i < 2; i++) {',
    '    float side = i == 0 ? -1.0 : 1.0;',
    '    float blush = length((p - vec2(side * 0.52, -0.23)) / vec2(0.12, 0.065));',
    '    col = mix(col, col * vec3(1.02, 0.72, 0.7) + vec3(0.04, 0.0, 0.0), uPaint2.y * 0.55 * (1.0 - smoothstep(0.15, 1.0, blush)));',
    '    vec2 b = p - vec2(side * 0.34, 0.16);',
    '    float line = 0.012 - 2.4 * b.x * b.x - side * uPaint2.z * 0.32 * b.x;',
    '    col = mix(col, uColor3, cover(max(abs(b.y - line) - 0.0115, abs(b.x) - 0.072), aa));',
    '  }',
    '  if (uPaint2.x > 1.5) {',
    '    for (int i = 0; i < 2; i++) {',
    '      float side = i == 0 ? -1.0 : 1.0;',
    '      vec2 home = p - vec2(side * 0.3, -0.16);',
    '      vec2 f = home * vec2(46.0, 52.0);',
    '      vec2 cell = floor(f);',
    '      vec2 jitter = vec2(hash(cell + 3.1), hash(cell + 8.7)) * 0.5 + 0.25;',
    '      float spot = 1.0 - smoothstep(0.1, 0.2, length(fract(f) - jitter));',
    '      float zone = 1.0 - smoothstep(0.5, 1.0, length(home / vec2(0.2, 0.075)));',
    '      col = mix(col, col * vec3(0.8, 0.6, 0.52), spot * zone * step(0.45, hash(cell + side * 5.0)) * 0.8);',
    '    }',
    '  }',
    '  col *= 1.0 - 0.1 * (1.0 - smoothstep(0.25, 1.0, length((p - vec2(0.0, -0.15)) / vec2(0.032, 0.022))));',
    '  shine = max(shine, 0.55 * (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0, -0.118)) / vec2(0.045, 0.028)))));',
    '  col = paintEye(col, p, vec2(-0.34, -0.06), -1.0, aa, shine);',
    '  col = paintEye(col, p, vec2(0.34, -0.06), 1.0, aa, shine);',
    '  if (mod(uPaint2.x, 2.0) > 0.5) {',
    '    float frame = cover(max(abs(p.y + 0.035) - 0.011, abs(p.x) - 0.135), aa);',
    '    for (int i = 0; i < 2; i++) {',
    '      float side = i == 0 ? -1.0 : 1.0;',
    '      float g = length((p - vec2(side * 0.34, -0.065)) / vec2(0.21, 0.185)) - 1.0;',
    '      col = mix(col, col * 1.04 + vec3(0.03, 0.04, 0.05), 0.5 * cover(g, aa / 0.18));',
    '      frame = max(frame, cover(abs(g) * 0.185 - 0.012, aa));',
    '    }',
    '    col = mix(col, vec3(0.15, 0.14, 0.16), frame);',
    '  }',
    '  return paintMouth(col, p, aa);',
    '}',
    'float hairKeep(vec3 d) {',
    '  vec2 p = sphereCoord(d);',
    '  float side = abs(p.x);',
    '  float fringe = uPaint.y + uPaint2.z * p.x + uPaint.z * abs(sin(p.x * uPaint2.w));',
    '  float bottom = mix(uPaint2.y, uPaint.w, smoothstep(1.2, 2.7, side));',
    '  return min(max(p.y - fringe, side - uPaint2.x), p.y - bottom);',
    '}',
    'vec3 paintFloor(vec3 base, inout float ao) {',
    '  vec2 w = vec2(mod(vWorld.x, 1024.0), vWorld.z);',
    '  float rowWidth = 0.44;',
    '  float row = floor(w.y / rowWidth);',
    '  float along = w.x + hash(vec2(row, 4.7)) * 3.0;',
    '  float plankLength = 2.6;',
    '  float id = hash(vec2(floor(along / plankLength), row));',
    '  vec3 col = base * (0.86 + 0.26 * id);',
    '  col *= 0.93 + 0.1 * noise(vec2(along * 1.2 + id * 17.0, fract(w.y / rowWidth) * 8.0 + row * 3.0));',
    '  col *= 0.95 + 0.07 * noise(vec2(along * 6.0, w.y * 60.0));',
    '  float fz = fract(w.y / rowWidth) * rowWidth;',
    '  float fx = fract(along / plankLength) * plankLength;',
    '  float seamZ = 1.0 - smoothstep(0.0, uFrame.x * 4.2 + 0.008, min(fz, rowWidth - fz));',
    '  float seamX = 1.0 - smoothstep(0.0, uFrame.x * 1.2 + 0.006, min(fx, plankLength - fx));',
    '  col *= 1.0 - 0.22 * max(seamZ, seamX);',
    '  ao *= mix(0.5, 1.0, smoothstep(-1.75, -0.85, w.y));',
    '  return col;',
    '}',
    'vec3 paintWall(vec3 base) {',
    '  vec2 w = vec2(mod(vWorld.x, 1024.0), vWorld.y);',
    '  vec3 col = base * (0.975 + 0.045 * noise(w * 6.0));',
    '  if (uPaint.y > 0.5) {',
    '    float width = uPaint.z;',
    '    float fx = fract(w.x / width) * width;',
    '    float edge = min(fx, width - fx);',
    '    float y = vWorld.y;',
    '    float panel = step(0.1, edge) * step(0.22, y) * step(y, uPaint.w);',
    '    float outline = cover(abs(min(edge - 0.1, min(y - 0.22, uPaint.w - y))) - 0.008, uFrame.x * 1.3) * step(0.08, edge) * step(0.2, y) * step(y, uPaint.w + 0.02);',
    '    col *= mix(1.0, 1.07, panel);',
    '    col *= 1.0 - 0.24 * outline;',
    '    col *= 1.0 - 0.3 * cover(edge - 0.012, uFrame.x * 1.3);',
    '  }',
    '  return col * mix(1.0, 0.78, smoothstep(2.4, 6.0, vWorld.y));',
    '}',
    'vec3 paintWindow() {',
    '  vec2 uv = vLocal.xy / max(vExtent.xy, vec2(0.001));',
    '  float t = uv.y * 0.5 + 0.5;',
    '  float wx = mod(vWorld.x, 1024.0);',
    '  vec3 sky = mix(uColor2, uColor.rgb, smoothstep(0.05, 1.0, t));',
    '  sky += uColor3 * exp(-t * 4.0) * 0.5;',
    '  float clouds = noise(vec2(wx * 0.55, t * 2.5 + 3.0)) * 0.65 + noise(vec2(wx * 1.6 + 4.0, t * 6.0)) * 0.35;',
    '  sky = mix(sky, sky * 1.2 + uColor3 * 0.06, smoothstep(0.58, 0.82, clouds) * smoothstep(0.3, 0.75, t) * 0.55);',
    '  float far = 0.15 + hash(vec2(floor(wx * 2.6), 11.0)) * 0.2;',
    '  sky = mix(sky, mix(uColor2, vec3(0.2, 0.17, 0.3), 0.65), step(t, far) * 0.85);',
    '  float near = 0.06 + hash(vec2(floor(wx * 1.5), 5.0)) * 0.26;',
    '  if (t < near) {',
    '    vec3 building = vec3(0.075, 0.07, 0.13);',
    '    vec2 cell = vec2(wx * 9.0, t * 30.0);',
    '    vec2 f = fract(cell);',
    '    float lit = step(0.6, hash(floor(cell))) * step(0.3, f.x) * step(f.x, 0.7) * step(0.35, f.y) * step(f.y, 0.75);',
    '    sky = building + vec3(1.0, 0.68, 0.34) * lit * 0.85;',
    '  }',
    '  float glare = (1.0 - smoothstep(0.0, 0.1, abs(uv.x + uv.y * 0.55 - 0.25))) * 0.05 + (1.0 - smoothstep(0.0, 0.05, abs(uv.x + uv.y * 0.55 - 0.48))) * 0.035;',
    '  return sky + vec3(glare);',
    '}',
    'vec3 paintScreen() {',
    '  vec2 uv = vLocal.xy / max(vExtent.xy, vec2(0.001));',
    '  vec2 s = uv * 0.5 + 0.5;',
    '  float kind = uPaint2.x;',
    '  float t = uPaint2.y;',
    '  vec3 accent = kind > 2.5 && kind < 3.5 ? vec3(1.0, 0.36, 0.36) : uColor2;',
    '  vec3 col = uColor.rgb;',
    '  if (kind > 1.5 && kind < 2.5) {',
    '    col = mix(vec3(0.03, 0.04, 0.08), vec3(0.09, 0.07, 0.16), s.y);',
    '    float orb = 1.0 - smoothstep(0.0, 0.42, length((s - vec2(0.5 + uPaint2.z * 0.08, 0.55)) * vec2(1.6, 1.0)));',
    '    return col + accent * orb * 0.22 + vec3(0.02);',
    '  }',
    '  float y = (1.0 - s.y) * 9.0 + uPaint.y;',
    '  float row = floor(y);',
    '  float fy = fract(y);',
    '  float seed = uPaint.z;',
    '  float x = s.x - 0.1;',
    '  float indent = floor(hash(vec2(row, seed)) * 3.0) * 0.08;',
    '  float len = 0.12 + hash(vec2(row + 7.0, seed)) * 0.62;',
    '  float bar = step(indent, x) * step(x, indent + len) * step(0.32, fy) * step(fy, 0.68) * step(s.y, 0.86);',
    '  float pick = hash(vec2(row, seed + 3.0));',
    '  vec3 tint = pick < 0.35 ? accent : pick < 0.6 ? vec3(0.45, 0.72, 1.0) : pick < 0.8 ? vec3(0.76, 0.6, 1.0) : vec3(0.82, 0.85, 0.9);',
    '  if (kind > 3.5) tint = vec3(0.5, 0.53, 0.58);',
    '  col += tint * bar * 0.7 * uPaint.w;',
    '  col = mix(col, col * 0.5 + accent * 0.24, step(0.88, s.y));',
    '  col += vec3(0.015, 0.02, 0.03) * step(x, 0.0);',
    '  if (kind > 0.5 && kind < 1.5) {',
    '    vec2 d = abs(s - vec2(0.5, 0.48)) - vec2(0.3, 0.17);',
    '    float box = max(d.x, d.y);',
    '    float pulse = 0.55 + 0.45 * sin(t * 3.0);',
    '    col = mix(col * 0.45, vec3(0.08, 0.07, 0.05), step(box, 0.0));',
    '    col += vec3(1.0, 0.78, 0.36) * (1.0 - smoothstep(0.0, 0.012, abs(box))) * (0.5 + 0.5 * pulse);',
    '    for (int i = 0; i < 3; i++) {',
    '      float on = step(fract(t * 0.8 - float(i) * 0.25), 0.55);',
    '      col += vec3(1.0, 0.82, 0.45) * (1.0 - smoothstep(0.018, 0.03, length((s - vec2(0.42 + float(i) * 0.08, 0.48)) * vec2(1.0, 0.6)))) * mix(0.35, 1.0, on);',
    '    }',
    '  }',
    '  if (kind < 0.5) {',
    '    float cursor = step(0.5, fract(t * 1.6)) * step(abs(s.y - 0.18), 0.03) * step(abs(x - 0.32), 0.018);',
    '    col += accent * cursor * 0.9;',
    '  }',
    '  return col * (0.82 + 0.18 * (1.0 - smoothstep(0.2, 1.2, length(uv))));',
    '}',
    'vec3 paintRug(vec3 base) {',
    '  if (uPaint.y > 0.5) {',
    '    float edge = min(vExtent.x - abs(vLocal.x), vExtent.z - abs(vLocal.z));',
    '    float aaRug = uFrame.x * 4.0;',
    '    vec2 fibre = vec2(mod(vWorld.x, 1024.0), vLocal.z);',
    '    vec3 runner = base * (0.94 + 0.08 * noise(fibre * 26.0));',
    '    runner = mix(runner, uColor2, cover(abs(edge - 0.11) - 0.05, aaRug));',
    '    runner = mix(runner, uColor3, cover(abs(edge - 0.22) - 0.012, aaRug));',
    '    float chevron = abs(fract(fibre.x * 0.9 + abs(vLocal.z) * 0.9) - 0.5);',
    '    return mix(runner, uColor3, step(0.3, edge) * cover(abs(chevron - 0.25) - 0.03, aaRug) * 0.35);',
    '  }',
    '  float r = length(vDirection.xz);',
    '  float aa = uFrame.x * 3.0;',
    '  vec3 col = base * (0.94 + 0.08 * noise(vLocal.xz * 26.0));',
    '  col = mix(col, uColor2, cover(abs(r - 0.86) - 0.06, aa));',
    '  col = mix(col, uColor3, cover(abs(r - 0.72) - 0.018, aa));',
    '  col = mix(col, uColor2, cover(abs(r - 0.38) - 0.02, aa) * 0.8);',
    '  col = mix(col, uColor3, cover(r - 0.14, aa) * 0.6);',
    '  return col * mix(1.0, 0.9, smoothstep(0.9, 1.0, r));',
    '}',
    'vec3 paintArt() {',
    '  vec2 uv = vLocal.xy / max(vExtent.xy, vec2(0.001));',
    '  float seed = uPaint.y;',
    '  vec3 col = uColor.rgb;',
    '  vec2 sun = vec2(hash(vec2(seed, 1.0)) - 0.5, hash(vec2(seed, 2.0)) * 0.6) * 1.1;',
    '  col = mix(col, uColor2, cover(length((uv - sun) * vec2(1.0, 0.8)) - 0.32 - hash(vec2(seed, 3.0)) * 0.2, 0.02));',
    '  float hill = uv.y + 0.35 - 0.25 * sin(uv.x * (2.0 + hash(vec2(seed, 4.0)) * 3.0) + seed);',
    '  col = mix(col, uColor3, cover(hill, 0.02));',
    '  col = mix(col, uColor3 * 0.7, cover(uv.y + 0.62 - 0.12 * sin(uv.x * 5.0 + seed * 2.0), 0.02));',
    '  return col;',
    '}',
    'vec3 lighting(vec3 albedo, vec3 n, float gloss, float rim, float sss, float ao, vec3 strandSheen) {',
    '  float ndl = dot(n, uLightDirection);',
    '  float wrap = 0.2 + 0.25 * sss;',
    '  float diffuse = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);',
    /* Skin scatters light, so a cast shadow on it is half as dark as on a hard surface. */
    '  float shadow = mix(shadowAt(n), 1.0, 0.5 * smoothstep(0.4, 0.9, sss));',
    '  float direct = diffuse * shadow;',
    '  vec3 hemi = mix(uGroundColor, uSkyColor, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * ao;',
    '  vec3 warm = mix(vec3(1.0), vec3(1.1, 0.8, 0.72), sss);',
    '  vec3 color = albedo * (hemi * warm + uLightColor * direct);',
    '  float facing = clamp(dot(n, uViewDirection), 0.0, 1.0);',
    '  float fres = pow(1.0 - facing, 3.0);',
    '  float edge = pow(1.0 - facing, 2.0);',
    '  for (int i = 0; i < LAMP_SLOTS; i++) {',
    '    vec3 toLamp = uLamps[i].xyz - vWorld;',
    '    float dist = length(toLamp);',
    '    vec3 dir = toLamp / max(dist, 0.001);',
    '    float fall = max(1.0 - dist / 4.2, 0.0);',
    '    float lambert = clamp(dot(n, dir) * 0.65 + 0.35, 0.0, 1.0);',
    '    float behind = max(dot(dir, -uViewDirection), 0.0);',
    '    color += uLampColors[i] * uLamps[i].w * fall * fall * (albedo * lambert + edge * behind * rim * 1.6);',
    '  }',
    '  vec3 h = normalize(uLightDirection + uViewDirection);',
    '  float spec = pow(max(dot(n, h), 0.0), 8.0 + gloss * 110.0) * gloss * (0.25 + 0.75 * shadow);',
    '  color += uLightColor * (spec * 0.4 + strandSheen * (0.4 + 0.6 * shadow));',
    '  return color + uSkyColor * fres * rim * 0.9;',
    '}',
    /* Strand noise on a sphere: x is clumps of strands, y is single strands. Periodic around the axis, so no seam. */
    'vec2 strands(vec2 p, float density) {',
    '  vec2 ring = vec2(cos(p.x), sin(p.x));',
    '  float clump = noise(ring * 4.5 + vec2(p.y * 2.6, 7.0));',
    '  float wobble = noise(ring * 9.0 + vec2(p.y * 5.0, 21.0));',
    '  float line = sin(p.x * density + clump * 14.0 + wobble * 6.0);',
    '  float second = sin(p.x * density * 0.5 + wobble * 9.0 + p.y * 3.0);',
    '  return vec2(clump, 0.5 + 0.28 * line + 0.22 * second);',
    '}',
    /* A lock runs along its longest axis; this turns that axis into the pole the strands radiate from. */
    'vec3 strandFrame(vec3 d) {',
    '  if (vExtent.x > vExtent.y && vExtent.x > vExtent.z) return d.yxz;',
    '  if (vExtent.z > vExtent.y && vExtent.z > vExtent.x) return d.xzy;',
    '  return d;',
    '}',
    /* Two-lobe anisotropic hair highlight: a sharp band plus a broad tinted one, both across the strand direction. */
    'vec3 hairGloss(vec3 albedo, vec3 n, vec3 axis, vec2 s) {',
    '  vec3 tangent = normalize(axis) - n * dot(normalize(axis), n);',
    '  float span = length(tangent);',
    '  tangent = span > 0.001 ? tangent / span : vec3(1.0, 0.0, 0.0);',
    '  vec3 halfway = normalize(uLightDirection + uViewDirection);',
    '  float sharp = dot(normalize(tangent + n * 0.08), halfway);',
    '  float broad = dot(normalize(tangent - n * 0.3), halfway);',
    '  float lit = clamp(dot(n, uLightDirection) * 2.0 + 0.4, 0.0, 1.0);',
    '  vec3 lobes = pow(sqrt(max(1.0 - sharp * sharp, 0.0)), 140.0) * 0.26 * vec3(1.0)',
    '    + pow(sqrt(max(1.0 - broad * broad, 0.0)), 28.0) * 0.16 * (albedo * 3.0 + 0.1);',
    '  return lobes * (0.35 + 0.65 * s.y * (0.6 + 0.8 * s.x)) * lit;',
    '}',
    /* Shoe: toe-cap seam, darker toe cap and lace rows across the instep. The box is axis aligned, toe at +z. */
    'vec3 paintShoe(vec3 base, vec3 d) {',
    '  float z = vLocal.z / max(vExtent.z, 0.001);',
    '  float x = vLocal.x / max(vExtent.x, 0.001);',
    '  vec3 col = base * mix(1.0, 0.9, smoothstep(0.42, 0.5, z));',
    '  col *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 0.035, abs(z - 0.46))) * step(-0.3, d.y);',
    '  float rung = abs(fract((z + 0.3) * 4.0) - 0.5);',
    '  float lace = (1.0 - smoothstep(0.07, 0.15, rung)) * step(-0.3, z) * step(z, 0.42);',
    '  lace *= (1.0 - smoothstep(0.55, 0.85, abs(x))) * smoothstep(0.35, 0.7, d.y);',
    '  vec3 tape = dot(base, vec3(0.2126, 0.7152, 0.0722)) > 0.35 ? base * 0.78 : vec3(0.7);',
    '  return mix(col, tape, lace * 0.85);',
    '}',
    /* Woven or knitted cloth on a part, in part space so it stays with the garment. The pattern fades out once its
       period gets close to a pixel. kind: 1 knit ribs, 2 fleece, 3 twill or denim, 4 plain cotton. */
    'vec3 paintFabric(vec3 base, float kind) {',
    '  vec3 p = vLocal;',
    '  float tone = 1.0;',
    '  float period = 0.07;',
    '  if (kind < 1.5) {',
    '    tone = 0.9 + 0.1 * (0.5 + 0.5 * sin((p.x + p.z) * 90.0)) + 0.05 * noise(p.xy * 60.0 + p.z * 60.0);',
    '  } else if (kind < 2.5) {',
    '    period = 0.025;',
    '    tone = 0.95 + 0.08 * noise(p.xy * 80.0 + p.zy * 80.0);',
    '  } else if (kind < 3.5) {',
    '    period = 0.04;',
    '    tone = 0.97 + 0.03 * sin((p.x + p.y) * 150.0);',
    '  } else {',
    '    period = 0.02;',
    '    tone = 0.985 + 0.03 * noise(p.xz * 100.0 + p.y * 100.0);',
    '  }',
    '  tone = mix(1.0, tone, smoothstep(2.0, 4.0, period / max(uFrame.x, 0.0001)));',
    '  float limb = step(2.0, vExtent.y / max(max(vExtent.x, vExtent.z), 0.001));',
    '  float crease = smoothstep(0.8, 1.0, abs(vLocal.y) / max(vExtent.y, 0.001));',
    '  return base * tone * (1.0 - 0.1 * limb * crease);',
    '}',
    'void main() {',
    '  float facing = gl_FrontFacing ? 1.0 : -1.0;',
    '  vec3 n = normalize(vNormal) * facing;',
    '  vec3 d = normalize(vDirection);',
    '  vec3 albedo = uColor.rgb;',
    '  float alpha = uColor.a;',
    '  float ao = mix(0.6, 1.0, smoothstep(0.0, 0.5, vWorld.y));',
    '  float shine = 0.0;',
    '  vec3 hairSpec = vec3(0.0);',
    '  float gloss = uMaterial.x;',
    '  float rimAmount = uMaterial.z;',
    '  float mode = uPaint.x;',
    '  if (mode > 0.5 && mode < 1.5) {',
    '    albedo = paintFace(albedo, d, uFrame.x, shine);',
    '  } else if ((mode > 1.5 && mode < 2.5) || (mode > 16.5 && mode < 19.5)) {',
    '    float keep = hairKeep(d);',
    '    if (mode > 18.5) {',
    '      vec2 q = sphereCoord(d);',
    '      keep = min(keep, mix(uPaint2.y, uPaint.w, smoothstep(1.2, 2.7, abs(q.x))) + uPaint2.w - q.y);',
    '    }',
    '    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '    float cut = smoothstep(-uFrame.x, uFrame.x, keep);',
    '    alpha = clamp(cut + (dither - 0.5) * 1.4 * cut * (1.0 - cut), 0.0, 1.0);',
    '    if (cut < 0.02 || alpha < 0.02) discard;',
    '    if (mode > 16.5) {',
    '      vec2 q = sphereCoord(d);',
    '      albedo = paintFabric(albedo, mode > 17.5 ? 1.0 : 4.0) * mix(0.72, 1.0, smoothstep(0.0, 0.1, keep));',
    '      if (mode < 17.5) albedo *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.05, abs(sin(q.x * 3.0)) * cos(q.y)));',
    '      gloss = 0.04;',
    '      rimAmount = 0.2;',
    '    } else {',
    '      vec2 s = strands(sphereCoord(d), 20.0);',
    '      albedo *= (0.9 + 0.1 * s.y) * (0.82 + 0.36 * s.x) * mix(0.6, 1.0, smoothstep(0.0, 0.14, keep));',
    '      hairSpec = hairGloss(albedo, n, vec3(0.0, 1.0, 0.0), s);',
    '      gloss = 0.03;',
    '      rimAmount = 0.12;',
    '    }',
    '    if (facing < 0.0) albedo *= 0.45;',
    '  } else if (mode > 2.5 && mode < 3.5) {',
    '    albedo = paintFloor(albedo, ao);',
    '  } else if (mode > 3.5 && mode < 4.5) {',
    '    albedo = paintWall(albedo);',
    '  } else if (mode > 4.5 && mode < 5.5) {',
    '    gl_FragColor = vec4(display(paintWindow()), 1.0);',
    '    return;',
    '  } else if (mode > 5.5 && mode < 6.5) {',
    '    gl_FragColor = vec4(display(paintScreen()), 1.0);',
    '    return;',
    '  } else if (mode > 6.5 && mode < 7.5) {',
    '    albedo = paintRug(albedo);',
    '  } else if (mode > 7.5 && mode < 8.5) {',
    '    gl_FragColor = vec4(display(albedo), alpha * pow(1.0 - smoothstep(0.0, 1.0, length(d.xz)), 1.6));',
    '    return;',
    '  } else if (mode > 8.5 && mode < 9.5) {',
    '    float glow = pow(1.0 - smoothstep(0.0, 1.0, length(d.xy)), 2.2);',
    '    gl_FragColor = vec4(display(albedo), alpha * glow);',
    '    return;',
    '  } else if (mode > 9.5 && mode < 10.5) {',
    '    albedo = paintArt();',
    '  } else if (mode > 11.5 && mode < 12.5) {',
    '    albedo *= (0.82 + 0.3 * (d.z * 0.5 + 0.5)) * (1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.08, abs(d.x))));',
    '  } else if (mode > 12.5 && mode < 13.5) {',
    '    vec2 s = strands(sphereCoord(strandFrame(d)), 14.0);',
    '    albedo *= (0.88 + 0.12 * s.y) * (0.84 + 0.32 * s.x) * mix(0.82, 1.0, smoothstep(-0.9, 0.3, d.y));',
    '    hairSpec = hairGloss(albedo, n, vAxis, s);',
    '    gloss = 0.03;',
    '    rimAmount = 0.12;',
    '  } else if (mode > 13.5 && mode < 14.5) {',
    '    albedo = mix(albedo, albedo * vec3(0.86, 0.6, 0.56), 0.8 * smoothstep(0.5, 0.92, d.x * uPaint.y));',
    '  } else if (mode > 14.5 && mode < 15.5) {',
    '    albedo = paintShoe(albedo, d);',
    '  } else if (mode > 15.5 && mode < 16.5) {',
    '    albedo = paintFabric(albedo, uPaint.y);',
    '  }',
    '  if (uMaterial.y > 0.99) {',
    '    gl_FragColor = vec4(display(albedo), alpha);',
    '    return;',
    '  }',
    /* Clay: thumb-sized dents plus finer tool marks, a little pigment mottling, matte with a soft warm sheen. */
    '  vec3 fine = vLocal * 11.0;',
    '  vec3 broad = vLocal * 4.0;',
    '  vec3 dent = vec3(noise(fine.xy + fine.z), noise(fine.yz - fine.x + 7.0), noise(fine.zx + fine.y + 13.0)) - 0.5;',
    '  vec3 thumb = vec3(noise(broad.xy + broad.z + 3.0), noise(broad.yz - broad.x + 11.0), noise(broad.zx + broad.y + 19.0)) - 0.5;',
    '  float reachFine = smoothstep(2.5, 5.0, 0.09 / max(uFrame.x, 0.0001));',
    '  float reachBroad = smoothstep(2.5, 5.0, 0.25 / max(uFrame.x, 0.0001));',
    '  float soft = (mode > 0.5 && mode < 1.5) ? 0.3 : 1.0;',
    '  n = normalize(n + (dent * reachFine * 0.28 + thumb * reachBroad * 0.5) * soft);',
    '  albedo *= 0.96 + 0.08 * noise(fine.xy * 0.6 + fine.z * 0.4);',
    '  vec3 color = lighting(albedo, n, gloss * 0.4 + shine * 0.75, rimAmount * 0.6, uMaterial.w + 0.08, ao, hairSpec * 0.5) + albedo * uMaterial.y;',
    '  gl_FragColor = vec4(display(color), alpha);',
    '}'].join('\n');

  function clamp(value, minimum, maximum)
  {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function text(value)
  {
    return typeof value === 'undefined' || value === null ? '' : String(value);
  }

  /* Texts are looked up when they are drawn, never cached, because the language can change while the stage is open.
     Without the catalog the key itself is shown so the stage still loads. */
  function sceneT(key, params)
  {
    return typeof WasI18n !== 'undefined' && WasI18n && typeof WasI18n.t === 'function' ? WasI18n.t(key, params) : key;
  }

  /* Renders message tokens in text the office model prepared (floor names), in the current language. */
  function sceneResolve(value)
  {
    return typeof WasI18n !== 'undefined' && WasI18n && typeof WasI18n.resolve === 'function' ? WasI18n.resolve(value) : value;
  }

  function resting(actor)
  {
    if (typeof WasOfficeModel !== 'undefined' && WasOfficeModel.isResting) return WasOfficeModel.isResting(actor);
    return !!(actor && (actor.activity && actor.activity.category === 'inactive' || /^(completed|interrupted)$/.test(actor.status || '')));
  }

  function running(actor)
  {
    return !resting(actor) && /^(running|active|working)$/.test(actor.status || '') &&
      (!actor.activity || actor.activity.category === 'recent');
  }

  function activityText(actor)
  {
    var category = actor.activity && actor.activity.category;
    if (resting(actor)) return sceneT('scene.activity.inactive');
    if (category === 'recent') return sceneT('scene.activity.recent');
    return sceneT('scene.activity.unconfirmed');
  }

  function statusText(actor)
  {
    var status = text(actor.status).toLowerCase();
    if (/^(running|active|working)$/.test(status)) return sceneT('scene.status.running');
    if (/^(waiting|blocked|needs-input)$/.test(status)) return sceneT('scene.status.waiting');
    if (/^(idle|ready)$/.test(status)) return sceneT('scene.status.idle');
    if (/^(completed|done|stopped)$/.test(status)) return sceneT('scene.status.completed');
    if (status === 'interrupted') return sceneT('scene.status.interrupted');
    if (/^(failed|error)$/.test(status)) return sceneT('scene.status.error');
    return sceneT('scene.status.unknown');
  }

  function statusKey(actor)
  {
    var status = text(actor.status).toLowerCase();
    if (/^(running|active|working)$/.test(status)) return 'running';
    if (/^(waiting|blocked|needs-input)$/.test(status)) return 'waiting';
    if (/^(idle|ready)$/.test(status)) return 'idle';
    if (/^(completed|done|stopped)$/.test(status)) return 'completed';
    if (status === 'interrupted') return 'interrupted';
    if (/^(failed|error)$/.test(status)) return 'error';
    return 'unknown';
  }

  function estimateNameWidth(name)
  {
    var width = 0;
    Array.from(text(name)).forEach(function (character)
    {
      width += character.charCodeAt(0) > 255 ? 12 : /[ilI1.,:_\-]/.test(character) ? 4.5 : /[MW@]/.test(character) ? 10.5 : 7.2;
    });
    return width;
  }

  function layoutFloor(office, floorId, previous, settings)
  {
    settings = settings || {};
    var pixelsPerUnit = Math.max(12, Number(settings.pixelsPerUnit) || 84);
    var measure = typeof settings.measure === 'function' ? settings.measure : estimateNameWidth;
    var actors = (office && office.actors || []).filter(function (actor) { return actor.floorId === floorId; }).slice();
    var floor = office && office.floorById && office.floorById.get(floorId) || (office && office.floors || []).find(function (entry) { return entry.id === floorId; });
    actors.sort(function (first, second)
    {
      var firstPriority = floor && floor.managerId === first.id ? 0 : resting(first) ? 2 : 1;
      var secondPriority = floor && floor.managerId === second.id ? 0 : resting(second) ? 2 : 1;
      return firstPriority - secondPriority || (Number(first.seatIndex) || 0) - (Number(second.seatIndex) || 0) || text(first.id).localeCompare(text(second.id));
    });
    var byId = new Map(actors.map(function (actor) { return [actor.id, actor]; }));
    var order = previous ? previous.order.filter(function (id) { return byId.has(id); }) : [];
    var included = new Set(order);
    actors.forEach(function (actor)
    {
      if (!included.has(actor.id)) order.push(actor.id);
    });
    var seats = new Map();
    var restSeats = new Map();
    var names = new Map();
    var widths = new Map();
    var cursor = 0.6;
    order.forEach(function (id)
    {
      var actor = byId.get(id);
      var nameWidth = Math.max(180, Math.ceil(measure(text(actor.name || actor.id))) + 30);
      var slotWidth = Math.max(3.5, (nameWidth + 30) / pixelsPerUnit);
      names.set(id, nameWidth);
      widths.set(id, slotWidth);
      if (resting(actor)) return;
      seats.set(id, { x: cursor + slotWidth / 2, z: 0, width: slotWidth, seatIndex: actor.seatIndex, zone: 'work' });
      cursor += slotWidth;
    });
    var workEnd = cursor;
    var restStart = cursor + (seats.size ? 2.4 : 0);
    cursor = restStart;
    order.forEach(function (id)
    {
      if (!resting(byId.get(id))) return;
      var width = widths.get(id);
      var seat = { x: cursor + width / 2, z: 0, width: width, seatIndex: byId.get(id).seatIndex, zone: 'rest' };
      restSeats.set(id, seat);
      seats.set(id, seat);
      cursor += width;
    });
    return { floorId: floorId, actors: actors, actorById: byId, order: order, seats: seats, restSeats: restSeats,
      nameWidths: names, workEnd: workEnd, restStart: restStart, restEnd: cursor,
      width: restSeats.size ? cursor + 0.6 : workEnd + 0.6, pixelsPerUnit: pixelsPerUnit };
  }

  /* Orthographic front camera tilted down by PITCH. The floor line sits near the bottom fifth of the stage
     and the camera rises only when a short stage would otherwise push the tallest nameplate off the top. */
  function stageMatrix(centerX, zoom, width, height)
  {
    var halfHeight = 3 / zoom;
    var halfWidth = halfHeight * width / Math.max(1, height);
    var cosine = Math.cos(PITCH);
    var sine = Math.sin(PITCH);
    var pixelsPerUnit = height / (halfHeight * 2);
    var floorCenter = halfHeight - halfHeight * 2 * FLOOR_FRACTION;
    var labelCenter = ANCHOR_TOP * cosine - WORK_Z * sine + LABEL_RESERVE / Math.max(1, pixelsPerUnit) - halfHeight;
    var verticalCenter = Math.max(floorCenter, labelCenter);
    return [1 / halfWidth, 0, 0, 0, 0, cosine / halfHeight, -sine / 30, 0,
      0, -sine / halfHeight, -cosine / 30, 0, -centerX / halfWidth, -verticalCenter / halfHeight, 0, 1];
  }

  function project(point, matrix, width, height)
  {
    return { x: (matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12] + 1) * width / 2,
      y: (1 - matrix[1] * point.x - matrix[5] * point.y - matrix[9] * point.z - matrix[13]) * height / 2 };
  }

  function normalize(value)
  {
    var length = Math.hypot(value[0], value[1], value[2]) || 1;
    return [value[0] / length, value[1] / length, value[2] / length];
  }

  function cross(first, second)
  {
    return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
  }

  function dot(first, second)
  {
    return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  }

  /* Orthographic light camera that covers the visible stage so desks, characters and sofas shadow the floor and wall. */
  function lightMatrix(centerX, halfWidth)
  {
    var toLight = normalize(LIGHT.direction);
    var right = normalize(cross([0, 1, 0], toLight));
    var up = cross(toLight, right);
    var bounds = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
    [centerX - halfWidth - 3, centerX + halfWidth + 3].forEach(function (x)
    {
      [-0.1, 4.9].forEach(function (y)
      {
        [WALL_Z - 0.2, 6].forEach(function (z)
        {
          [right, up, toLight].forEach(function (axis, index)
          {
            var value = dot([x, y, z], axis);
            bounds[index][0] = Math.min(bounds[index][0], value);
            bounds[index][1] = Math.max(bounds[index][1], value);
          });
        });
      });
    });
    var spanX = (bounds[0][1] - bounds[0][0]) / 2;
    var spanY = (bounds[1][1] - bounds[1][0]) / 2;
    var centerA = (bounds[0][1] + bounds[0][0]) / 2;
    var centerB = (bounds[1][1] + bounds[1][0]) / 2;
    var depth = bounds[2][1] - bounds[2][0] + 1;
    var near = bounds[2][1] + 0.5;
    return [right[0] / spanX, up[0] / spanY, -2 * toLight[0] / depth, 0,
      right[1] / spanX, up[1] / spanY, -2 * toLight[1] / depth, 0,
      right[2] / spanX, up[2] / spanY, -2 * toLight[2] / depth, 0,
      -centerA / spanX, -centerB / spanY, 2 * near / depth - 1, 1];
  }

  /* Part basis and position combined with a character or furniture root (translation, yaw, uniform scale). */
  function partMatrix(part, root, out)
  {
    root = root || {};
    out = out || new Array(16);
    var scale = typeof root.scale === 'number' ? root.scale : 1;
    var cosine = Math.cos(root.yaw || 0);
    var sine = Math.sin(root.yaw || 0);
    var basis = part.basis;
    var column;
    for (column = 0; column < 3; column += 1)
    {
      var axis = basis[column];
      out[column * 4] = (cosine * axis[0] + sine * axis[2]) * scale;
      out[column * 4 + 1] = axis[1] * scale;
      out[column * 4 + 2] = (-sine * axis[0] + cosine * axis[2]) * scale;
      out[column * 4 + 3] = 0;
    }
    var position = part.position;
    out[12] = (root.x || 0) + (cosine * position.x + sine * position.z) * scale;
    out[13] = (root.y || 0) + position.y * scale;
    out[14] = (root.z || 0) + (-sine * position.x + cosine * position.z) * scale;
    out[15] = 1;
    return out;
  }

  var colorCache = new Map();

  function hex(value)
  {
    if (!colorCache.has(value))
    {
      colorCache.set(value, [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255, 1]);
    }
    return colorCache.get(value);
  }

  function withAlpha(value, alpha)
  {
    return [value[0], value[1], value[2], alpha];
  }

  function seeded(value)
  {
    var number = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return number - Math.floor(number);
  }

  function pickFrom(list, value)
  {
    var length = list.length;
    return list[((Math.floor(value) % length) + length) % length];
  }

  function providerAccent(provider)
  {
    return provider === 'codex' ? hex('7ea6ff') : provider === 'claude' ? hex('e5895f') : hex('a3abb6');
  }

  function create(options)
  {
    options = options || {};
    var suppliedCanvas = options.canvas || null;
    var container = options.container || suppliedCanvas && suppliedCanvas.parentElement;
    if (!container) throw new Error('A stage container is required.');
    var originalDisplay = suppliedCanvas ? suppliedCanvas.style.display : '';
    if (suppliedCanvas) suppliedCanvas.style.display = 'none';
    var office = null;
    var floorId = null;
    var floorBadgeKey = '';
    var floorWheel = { sum: 0, at: 0, until: 0 };
    var partnerData = new Map();
    var partnerVersion = 0;
    var partnerStacks = new Map();
    var agingTimer = null;
    var selectedId = null;
    var layouts = new Map();
    var labels = new Map();
    var palettes = new Map();
    var tops = new Map();
    var facings = new Map();
    var lastFrameAt = 0;
    var focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    var selectedAt = 0;
    var positions = new Map();
    var transitions = new Map();
    var calls = [];
    var seen = new Set();
    var baseline = false;
    var width = 1;
    var height = 1;
    var ratio = 1;
    var cameraX = 0;
    var zoomValue = 1;
    var matrix = stageMatrix(0, 1, 1, 1);
    var visible = true;
    var motion = true;
    var destroyed = false;
    var contextLost = false;
    var frame = null;
    var dirty = true;
    var renderedActors = [];
    var hitRegions = [];
    var listeners = [];
    var drag = null;
    var lastTravel = '';
    var fallbackKind = '';
    var indexCount = null;
    var frameCount = 0;
    var media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(media && media.matches);
    var measurement = document.createElement('canvas').getContext('2d');
    if (measurement) measurement.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    var root = document.createElement('div');
    root.className = 'was-office-arcade';
    root.setAttribute('role', 'region');
    var canvas = document.createElement('canvas');
    canvas.className = 'was-office-canvas was-office-character-canvas';
    canvas.tabIndex = 0;
    root.appendChild(canvas);
    var partnerLayer = document.createElement('div');
    partnerLayer.className = 'was-office-partner-layer';
    root.appendChild(partnerLayer);
    var labelLayer = document.createElement('div');
    labelLayer.className = 'was-office-labels';
    root.appendChild(labelLayer);
    var heading = document.createElement('div');
    heading.className = 'was-office-stage-heading';
    root.appendChild(heading);
    var floorBadge = document.createElement('div');
    floorBadge.className = 'was-office-floor-badge';
    floorBadge.hidden = true;
    floorBadge.setAttribute('aria-hidden', 'true');
    var floorNumber = document.createElement('strong');
    floorNumber.className = 'was-office-floor-number';
    var floorName = document.createElement('span');
    floorName.className = 'was-office-floor-name';
    var floorPosition = document.createElement('span');
    floorPosition.className = 'was-office-floor-position';
    floorBadge.appendChild(floorNumber);
    floorBadge.appendChild(floorName);
    floorBadge.appendChild(floorPosition);
    heading.appendChild(floorBadge);
    var zoneLabel = document.createElement('div');
    zoneLabel.className = 'was-office-zone-label';
    heading.appendChild(zoneLabel);
    var counter = document.createElement('div');
    counter.className = 'was-office-stage-counter';
    heading.appendChild(counter);
    var empty = document.createElement('div');
    empty.className = 'was-office-empty';
    root.appendChild(empty);
    var fallback = document.createElement('div');
    fallback.className = 'was-office-webgl-notice';
    fallback.hidden = true;
    fallback.setAttribute('role', 'status');
    root.appendChild(fallback);
    var index = document.createElement('details');
    index.className = 'was-office-session-index';
    var summary = document.createElement('summary');
    index.appendChild(summary);
    var indexList = document.createElement('div');
    indexList.className = 'was-office-session-list';
    index.appendChild(indexList);
    root.appendChild(index);
    var indexItems = new Map();
    listen(index, 'toggle', function ()
    {
      var item = index.open && selectedId && indexItems.get(selectedId);
      if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' });
    });
    var help = document.createElement('div');
    help.className = 'was-office-stage-help';
    root.appendChild(help);
    renderStaticText();
    container.classList.add('was-office-viewport');
    container.appendChild(root);
    var gl = null;
    var programs = null;
    var meshes = new Map();
    var buffers = [];
    var shadow = null;
    var resizeObserver = null;
    var items = [];
    var itemCount = 0;
    var lamps = [];
    var lampSlots = 8;
    var floatScratch = { matrix: new Float32Array(16), lamps: new Float32Array(32), lampColors: new Float32Array(24) };

    function listen(target, event, callback, settings)
    {
      target.addEventListener(event, callback, settings);
      listeners.push({ target: target, event: event, callback: callback, settings: settings });
    }

    function now()
    {
      return Date.now();
    }

    function measureName(name)
    {
      return measurement && measurement.measureText ? measurement.measureText(name).width : estimateNameWidth(name);
    }

    function pixelsPerUnit()
    {
      return height / 6 * zoomValue;
    }

    function currentLayout()
    {
      return layouts.get(floorId) || null;
    }

    function motionAllowed()
    {
      return motion && !reduced && focused && visible && !document.hidden;
    }

    function notifyTravel(info)
    {
      if (typeof options.onTravel === 'function') options.onTravel(info);
    }

    function fallbackText()
    {
      if (fallbackKind === 'model') return sceneT('scene.fallback.modelMissing');
      if (fallbackKind === 'webgl') return sceneT('scene.fallback.webglUnavailable');
      if (fallbackKind === 'context') return sceneT('scene.fallback.contextLost');
      return '';
    }

    function showFallback(kind)
    {
      fallbackKind = kind;
      fallback.textContent = fallbackText();
      fallback.hidden = false;
    }

    function summaryText()
    {
      return indexCount === null ? sceneT('scene.index.summary') : sceneT('scene.index.summaryCount', { count: indexCount });
    }

    /* The texts that do not depend on the office data: aria labels, empty state, help line, session list title and the graphics notice. */
    function renderStaticText()
    {
      root.setAttribute('aria-label', sceneT('scene.stage.regionLabel'));
      canvas.setAttribute('aria-label', sceneT('scene.stage.canvasLabel'));
      empty.textContent = sceneT('scene.stage.empty');
      help.textContent = sceneT('scene.stage.help');
      summary.textContent = summaryText();
      if (fallbackKind) fallback.textContent = fallbackText();
    }

    /* The zone caption and the head count under the floor badge. */
    function renderStageHeading(layout)
    {
      if (!layout)
      {
        zoneLabel.textContent = sceneT('scene.stage.zoneEmpty');
        counter.textContent = '';
        return;
      }
      var inRest = layout.restSeats.size && cameraX > layout.restStart - 0.8;
      zoneLabel.textContent = inRest ? sceneT('scene.stage.zoneLounge') : sceneT('scene.stage.zoneWork');
      counter.textContent = inRest ?
        sceneT('scene.stage.counterLounge', { total: layout.actors.length, visible: renderedActors.length, inactive: layout.restSeats.size }) :
        sceneT('scene.stage.counterWork', { total: layout.actors.length, visible: renderedActors.length });
    }

    function requestDraw()
    {
      if (destroyed) return;
      dirty = true;
      if (!visible || document.hidden || contextLost || frame !== null) return;
      frame = requestAnimationFrame(draw);
    }

    function releaseGraphics()
    {
      if (!gl) return;
      buffers.forEach(function (buffer) { gl.deleteBuffer(buffer); });
      buffers = [];
      meshes.clear();
      if (programs)
      {
        gl.deleteProgram(programs.main.program);
        gl.deleteProgram(programs.depth.program);
      }
      programs = null;
      if (shadow)
      {
        gl.deleteFramebuffer(shadow.framebuffer);
        gl.deleteRenderbuffer(shadow.depth);
        gl.deleteTexture(shadow.texture);
      }
      shadow = null;
    }

    function compileProgram(vertexSource, fragmentSource, uniformNames)
    {
      function compile(type, source)
      {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        {
          var log = gl.getShaderInfoLog ? gl.getShaderInfoLog(shader) : '';
          gl.deleteShader(shader);
          throw new Error('Character shader failed ' + (log || ''));
        }
        return shader;
      }
      var vertex = compile(gl.VERTEX_SHADER, vertexSource);
      var fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      var program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.bindAttribLocation(program, 0, 'aDirection');
      gl.bindAttribLocation(program, 1, 'aCorner');
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Character shader linking failed');
      var uniforms = {};
      uniformNames.forEach(function (name) { uniforms[name] = gl.getUniformLocation(program, name); });
      return { program: program, uniforms: uniforms };
    }

    function createShadowTarget()
    {
      try
      {
        var maximum = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || SHADOW_SIZE;
        var size = Math.min(SHADOW_SIZE, maximum);
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
        var framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        var complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        shadow = { texture: texture, depth: depth, framebuffer: framebuffer, size: size, enabled: complete };
      }
      catch (error)
      {
        shadow = null;
      }
    }

    function initializeGraphics()
    {
      if (typeof WasCharacterModel === 'undefined')
      {
        showFallback('model');
        return;
      }
      try
      {
        gl = canvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL unavailable');
        var vectors = Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)) || 16;
        lampSlots = clamp(Math.floor((vectors - 14) / 2), 1, 8);
        programs = {
          main: compileProgram(VERTEX_SOURCE, FRAGMENT_SOURCE.replace('#define LAMP_SLOTS 8', '#define LAMP_SLOTS ' + lampSlots), ['uModel', 'uProjection', 'uLightMatrix', 'uInner', 'uRadius', 'uShadowOffset', 'uColor', 'uMaterial', 'uPaint',
            'uPaint2', 'uColor2', 'uColor3', 'uFrame', 'uLightDirection', 'uLightColor', 'uSkyColor', 'uGroundColor', 'uViewDirection', 'uShadowInfo',
            'uLamps[0]', 'uLampColors[0]', 'uShadowMap', 'uTaper', 'uWobble']),
          depth: compileProgram(DEPTH_VERTEX_SOURCE, DEPTH_FRAGMENT_SOURCE, ['uModel', 'uLightMatrix', 'uInner', 'uRadius', 'uTaper', 'uWobble'])
        };
        var vertices = [];
        var indices = [];
        [['round', 7], ['low', 3]].forEach(function (entry)
        {
          var geometry = WasCharacterModel.roundedGeometry(entry[1]);
          var base = vertices.length / 6;
          meshes.set(entry[0], { offset: indices.length * 2, count: geometry.indices.length });
          Array.prototype.push.apply(vertices, geometry.vertices);
          geometry.indices.forEach(function (value) { indices.push(value + base); });
        });
        var vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        var indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        buffers = [vertexBuffer, indexBuffer];
        createShadowTarget();
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0.16, 0.15, 0.17, 1);
        fallbackKind = '';
        fallback.hidden = true;
      }
      catch (error)
      {
        if (typeof console !== 'undefined' && console.warn) console.warn('WasOfficeScene WebGL init failed', error && error.message);
        releaseGraphics();
        gl = null;
        showFallback('webgl');
        notifyTravel({ phase: 'fallback', text: fallback.textContent, illustrative: false });
      }
    }

    /* Draw items are pooled per frame; each one is one indexed draw of the shared rounded mesh. */
    function emit(part, rootTransform, receive)
    {
      var item = items[itemCount];
      if (!item)
      {
        item = { model: new Float32Array(16), inner: new Float32Array(3), radius: new Float32Array(3), color: new Float32Array(4), material: new Float32Array(4),
          paint: new Float32Array(4), paint2: new Float32Array(4), color2: new Float32Array(3), color3: new Float32Array(3), frame: new Float32Array(4), taper: 0, wobble: 0 };
        items.push(item);
      }
      itemCount += 1;
      var scale = rootTransform && typeof rootTransform.scale === 'number' ? rootTransform.scale : 1;
      partMatrix(part, rootTransform, item.model);
      item.inner.set(part.inner);
      item.radius.set(part.radius);
      item.taper = part.taper || 0;
      item.wobble = 0;
      var source = part.color;
      item.color[0] = Math.pow(source[0], 2.2);
      item.color[1] = Math.pow(source[1], 2.2);
      item.color[2] = Math.pow(source[2], 2.2);
      item.color[3] = typeof source[3] === 'number' ? source[3] : 1;
      item.material[0] = part.gloss || 0;
      item.material[1] = part.emissive || 0;
      item.material[2] = typeof part.rim === 'number' ? part.rim : 0.35;
      item.material[3] = part.sss || 0;
      item.paint.set(part.paint || [0, 0, 0, 0]);
      item.paint2.set(part.paint2 || [0, 0, 0, 0]);
      var second = part.color2 || source;
      var third = part.color3 || source;
      item.color2[0] = Math.pow(second[0], 2.2); item.color2[1] = Math.pow(second[1], 2.2); item.color2[2] = Math.pow(second[2], 2.2);
      item.color3[0] = Math.pow(third[0], 2.2); item.color3[1] = Math.pow(third[1], 2.2); item.color3[2] = Math.pow(third[2], 2.2);
      var pixel = 1 / Math.max(1, pixelsPerUnit());
      var mode = item.paint[0];
      item.frame[0] = mode === 1 || mode === 2 || (mode >= 17 && mode <= 19) ? pixel * 1.1 / Math.max(0.01, scale * part.radius[0]) : pixel;
      item.mesh = part.mesh || 'round';
      item.cast = part.cast !== false && part.blend !== 'alpha' && part.blend !== 'add' && part.emissive < 1 && mode !== 5;
      item.pass = part.blend === 'alpha' ? 1 : part.blend === 'add' ? 2 : 0;
      item.receive = typeof receive === 'boolean' ? receive : !rootTransform || rootTransform === ENV;
      item.coverage = mode === 2 || (mode >= 17 && mode <= 19);
      return item;
    }

    function renderScene(timestamp)
    {
      var program = programs.main;
      var uniforms = program.uniforms;
      var halfWidth = width / Math.max(1, pixelsPerUnit()) / 2;
      var light = lightMatrix(cameraX, halfWidth);
      var lightArray = new Float32Array(light);
      var shadowsOn = !!(shadow && shadow.enabled);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers[1]);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      var index;
      var item;
      var mesh;
      if (shadowsOn)
      {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.framebuffer);
        gl.viewport(0, 0, shadow.size, shadow.size);
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.BLEND);
        gl.useProgram(programs.depth.program);
        gl.uniformMatrix4fv(programs.depth.uniforms.uLightMatrix, false, lightArray);
        for (index = 0; index < itemCount; index += 1)
        {
          item = items[index];
          if (!item.cast) continue;
          mesh = meshes.get(item.mesh);
          gl.uniformMatrix4fv(programs.depth.uniforms.uModel, false, item.model);
          gl.uniform3fv(programs.depth.uniforms.uInner, item.inner);
          gl.uniform3fv(programs.depth.uniforms.uRadius, item.radius);
          gl.uniform1f(programs.depth.uniforms.uTaper, item.taper);
          gl.uniform1f(programs.depth.uniforms.uWobble, item.wobble);
          gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, mesh.offset);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.16, 0.15, 0.17, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program.program);
      gl.uniformMatrix4fv(uniforms.uProjection, false, new Float32Array(matrix));
      gl.uniformMatrix4fv(uniforms.uLightMatrix, false, lightArray);
      gl.uniform3fv(uniforms.uLightDirection, new Float32Array(normalize(LIGHT.direction)));
      gl.uniform3fv(uniforms.uLightColor, new Float32Array(LIGHT.color));
      gl.uniform3fv(uniforms.uSkyColor, new Float32Array(LIGHT.sky));
      gl.uniform3fv(uniforms.uGroundColor, new Float32Array(LIGHT.ground));
      gl.uniform3fv(uniforms.uViewDirection, new Float32Array([0, Math.sin(PITCH), Math.cos(PITCH)]));
      gl.uniform4fv(uniforms.uShadowInfo, new Float32Array([shadowsOn ? 1.2 / shadow.size : 0, 0.0012, 0.66, 0]));
      gl.uniform1f(uniforms.uShadowOffset, shadowsOn ? (halfWidth * 2 + 6) / shadow.size * 3.0 : 0);
      floatScratch.lamps.fill(0);
      floatScratch.lampColors.fill(0);
      lamps.slice().sort(function (first, second) { return Math.abs(first.position[0] - cameraX) - Math.abs(second.position[0] - cameraX); }).slice(0, lampSlots).forEach(function (lamp, slot)
      {
        var fade = clamp(1 - (Math.abs(lamp.position[0] - cameraX) - halfWidth) / 2.5, 0, 1);
        floatScratch.lamps.set([lamp.position[0], lamp.position[1], lamp.position[2], lamp.position[3] * fade], slot * 4);
        floatScratch.lampColors.set(lamp.color, slot * 3);
      });
      gl.uniform4fv(uniforms['uLamps[0]'], floatScratch.lamps.subarray(0, lampSlots * 4));
      gl.uniform3fv(uniforms['uLampColors[0]'], floatScratch.lampColors.subarray(0, lampSlots * 3));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowsOn ? shadow.texture : null);
      gl.uniform1i(uniforms.uShadowMap, 0);
      var seconds = timestamp % 600000 / 1000;
      [0, 1, 2].forEach(function (pass)
      {
        if (pass === 0) gl.disable(gl.BLEND);
        else
        {
          gl.enable(gl.CULL_FACE);
          gl.enable(gl.BLEND);
          gl.depthMask(false);
          if (pass === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          else gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        }
        for (index = 0; index < itemCount; index += 1)
        {
          item = items[index];
          if (item.pass !== pass) continue;
          mesh = meshes.get(item.mesh);
          item.frame[1] = seconds;
          item.frame[2] = LIGHT.exposure;
          item.frame[3] = shadowsOn && item.receive ? 1 : 0;
          if (pass === 0)
          {
            if (item.coverage) gl.disable(gl.CULL_FACE);
            else gl.enable(gl.CULL_FACE);
          }
          if (item.coverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
          gl.uniformMatrix4fv(uniforms.uModel, false, item.model);
          gl.uniform3fv(uniforms.uInner, item.inner);
          gl.uniform3fv(uniforms.uRadius, item.radius);
          gl.uniform1f(uniforms.uTaper, item.taper);
          gl.uniform1f(uniforms.uWobble, item.wobble);
          gl.uniform4fv(uniforms.uColor, item.color);
          gl.uniform4fv(uniforms.uMaterial, item.material);
          gl.uniform4fv(uniforms.uPaint, item.paint);
          gl.uniform4fv(uniforms.uPaint2, item.paint2);
          gl.uniform3fv(uniforms.uColor2, item.color2);
          gl.uniform3fv(uniforms.uColor3, item.color3);
          gl.uniform4fv(uniforms.uFrame, item.frame);
          gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, mesh.offset);
          if (item.coverage) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        }
      });
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
    }

    var shapes = typeof WasCharacterModel !== 'undefined' ? WasCharacterModel.shapes : null;
    var ENV = { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };

    function P(x, y, z)
    {
      return { x: x, y: y, z: z };
    }

    function put(part)
    {
      emit(part, ENV);
    }

    function boxAt(name, x, y, z, hx, hy, hz, round, material, settings)
    {
      put(shapes.box(name, P(x, y, z), [hx, hy, hz], round, material, settings));
    }

    function blob(x, z, rx, rz, alpha, material)
    {
      put(shapes.ellipsoid('blob', P(x, 0.016, z), [rx, 0.002, rz], withAlpha(material || hex('1c1410'), alpha), { paint: [8, 0, 0, 0], blend: 'alpha', cast: false }));
    }

    function glow(x, y, z, radius, material, alpha)
    {
      put(shapes.ellipsoid('glow', P(x, y, z), [radius, radius, 0.001], withAlpha(material, alpha), { paint: [9, 0, 0, 0], blend: 'add', cast: false }));
    }

    function plant(x, z, size, seed)
    {
      var pot = pickFrom([hex('e8e2d6'), hex('c9714f')], seed);
      put(shapes.cylinder('pot', P(x, 0.2 * size, z), 0.2 * size, 0.2 * size, pot, { gloss: 0.2 }));
      put(shapes.cylinder('pot-rim', P(x, 0.41 * size, z), 0.215 * size, 0.025 * size, WasCharacterModel.tone(pot, 0.92), { gloss: 0.2 }));
      put(shapes.cylinder('soil', P(x, 0.43 * size, z), 0.18 * size, 0.01, hex('4a3528')));
      var count = 7 + seed % 3;
      var leaf;
      for (leaf = 0; leaf < count; leaf += 1)
      {
        var angle = leaf / count * Math.PI * 2 + seed;
        var lift = 0.55 + seeded(seed * 13 + leaf) * 0.5;
        var reach = 0.18 + seeded(seed * 7 + leaf) * 0.12;
        var tilt = 0.5 + seeded(seed * 3 + leaf) * 0.5;
        var green = leaf % 3 === 0 ? hex('5f9a5c') : leaf % 3 === 1 ? hex('4c8a55') : hex('74ad63');
        put(shapes.ellipsoid('leaf', P(x + Math.cos(angle) * reach * size, (0.45 + lift * 0.55) * size, z + Math.sin(angle) * reach * size * 0.7),
          [0.11 * size, 0.022 * size, 0.27 * size], green, { rotation: { x: -tilt, y: Math.PI / 2 - angle, z: 0 }, paint: [12, 0, 0, 0], sss: 0.6, gloss: 0.25, rim: 0.5 }));
      }
    }

    function windowUnit(x)
    {
      var frameColor = hex('2b2f37');
      var y = 3.02;
      put(shapes.box('window', P(x, y, WALL_Z + 0.004), [1.18, 0.86, 0.006], 0.004, hex('1d2a52'),
        { paint: [5, 0, 0, 0], color2: hex('d9876a'), color3: hex('ffb877'), emissive: 1, cast: false }));
      boxAt('window-frame', x, y + 0.88, WALL_Z + 0.04, 1.26, 0.045, 0.045, 0.02, frameColor);
      boxAt('window-frame', x, y - 0.88, WALL_Z + 0.04, 1.26, 0.045, 0.045, 0.02, frameColor);
      boxAt('window-frame', x - 1.22, y, WALL_Z + 0.04, 0.045, 0.9, 0.045, 0.02, frameColor);
      boxAt('window-frame', x + 1.22, y, WALL_Z + 0.04, 0.045, 0.9, 0.045, 0.02, frameColor);
      boxAt('window-mullion', x, y, WALL_Z + 0.03, 0.022, 0.86, 0.03, 0.01, frameColor);
      boxAt('window-mullion', x, y + 0.3, WALL_Z + 0.03, 1.2, 0.02, 0.03, 0.01, frameColor);
      boxAt('window-sill', x, y - 0.95, WALL_Z + 0.1, 1.36, 0.035, 0.11, 0.02, hex('d8c7ad'), { gloss: 0.25 });
    }

    function corkboard(x, seed)
    {
      boxAt('board-frame', x, 2.85, WALL_Z + 0.03, 0.62, 0.44, 0.03, 0.02, hex('a07b55'));
      boxAt('board', x, 2.85, WALL_Z + 0.05, 0.56, 0.38, 0.015, 0.01, hex('c9a27a'));
      var notes = ['f7d774', 'f4a7b0', '9ed6c6', 'a9c7f2', 'f7d774'];
      notes.forEach(function (color, slot)
      {
        var nx = x - 0.4 + slot * 0.2 + (seeded(seed + slot) - 0.5) * 0.06;
        var ny = 2.85 + (slot % 2 ? 0.12 : -0.1) + (seeded(seed * 3 + slot) - 0.5) * 0.08;
        boxAt('note', nx, ny, WALL_Z + 0.066, 0.075, 0.075, 0.004, 0.003, hex(color), { rotation: { x: 0, y: 0, z: (seeded(seed * 5 + slot) - 0.5) * 0.3 }, cast: false });
      });
    }

    function clock(x)
    {
      put(shapes.cylinder('clock', P(x, 3.05, WALL_Z + 0.04), 0.3, 0.03, hex('f4efe6'), { rotation: { x: Math.PI / 2, y: 0, z: 0 }, gloss: 0.3 }));
      put(shapes.cylinder('clock-rim', P(x, 3.05, WALL_Z + 0.03), 0.33, 0.025, hex('2b2f37'), { rotation: { x: Math.PI / 2, y: 0, z: 0 } }));
      var time = typeof Date === 'function' ? new Date(now()) : null;
      var hours = time ? time.getHours() % 12 : 10;
      var minutes = time ? time.getMinutes() : 10;
      [[hours / 12 + minutes / 720, 0.16, 0.018], [minutes / 60, 0.24, 0.012]].forEach(function (hand)
      {
        var angle = hand[0] * Math.PI * 2;
        put(shapes.capsule('clock-hand', P(x, 3.05, WALL_Z + 0.08), P(x + Math.sin(angle) * hand[1], 3.05 + Math.cos(angle) * hand[1], WALL_Z + 0.08), hand[2], hex('2b2f37'), { cast: false }));
      });
    }

    function frameArt(x, y, hx, hy, seed)
    {
      boxAt('art-frame', x, y, WALL_Z + 0.03, hx + 0.06, hy + 0.06, 0.03, 0.015, hex('2b2f37'));
      boxAt('art-mat', x, y, WALL_Z + 0.056, hx, hy, 0.006, 0.004, hex('f2ede3'));
      var palettesArt = [['e7c9a5', 'e07a5f', '3d405b'], ['c9d6df', 'f2b880', '52796f'], ['f4e3d7', 'c08497', '5e548e'], ['e9edc9', 'd4a373', '588157']];
      var colors = pickFrom(palettesArt, seed);
      put(shapes.box('art', P(x, y, WALL_Z + 0.066), [hx - 0.07, hy - 0.07, 0.003], 0.002, hex(colors[0]),
        { paint: [10, seed * 1.7, 0, 0], color2: hex(colors[1]), color3: hex(colors[2]), cast: false }));
    }

    function shelf(x, y, seed)
    {
      boxAt('shelf', x, y, WALL_Z + 0.17, 0.72, 0.025, 0.16, 0.012, hex('d8c7ad'), { gloss: 0.2 });
      var cursor = x - 0.62;
      var book;
      for (book = 0; book < 6; book += 1)
      {
        var widthBook = 0.05 + seeded(seed * 9 + book) * 0.04;
        var heightBook = 0.2 + seeded(seed * 4 + book) * 0.12;
        var colors = ['c8553d', '2d6a8f', 'e0b45c', '4f7d5c', '8e6c8a', 'efe6d6'];
        boxAt('book', cursor + widthBook, y + 0.025 + heightBook / 2, WALL_Z + 0.16, widthBook, heightBook / 2, 0.11, 0.008, hex(pickFrom(colors, seed + book)),
          { rotation: { x: 0, y: 0, z: book === 5 ? -0.25 : 0 } });
        cursor += widthBook * 2 + 0.008;
      }
      plantSmall(x + 0.45, y + 0.025, WALL_Z + 0.16, seed);
    }

    function plantSmall(x, y, z, seed)
    {
      put(shapes.cylinder('pot', P(x, y + 0.07, z), 0.08, 0.07, pickFrom([hex('c9714f'), hex('e8e2d6')], seed), { gloss: 0.2 }));
      var leaf;
      for (leaf = 0; leaf < 5; leaf += 1)
      {
        var angle = leaf / 5 * Math.PI * 2;
        put(shapes.ellipsoid('leaf', P(x + Math.cos(angle) * 0.05, y + 0.2, z + Math.sin(angle) * 0.04), [0.045, 0.012, 0.11], hex(leaf % 2 ? '5f9a5c' : '74ad63'),
          { mesh: 'low', rotation: { x: -0.9, y: Math.PI / 2 - angle, z: 0 }, paint: [12, 0, 0, 0], sss: 0.6 }));
      }
    }

    function bookcase(x)
    {
      var wood = hex('8a6446');
      boxAt('bookcase-back', x, 1.25, WALL_Z + 0.04, 0.6, 1.22, 0.02, 0.01, hex('5a4231'));
      [-1, 1].forEach(function (side)
      {
        boxAt('bookcase-side', x + side * 0.6, 1.25, WALL_Z + 0.29, 0.03, 1.25, 0.26, 0.02, wood, { gloss: 0.15 });
      });
      boxAt('bookcase-top', x, 2.48, WALL_Z + 0.29, 0.64, 0.03, 0.27, 0.02, wood, { gloss: 0.2 });
      boxAt('bookcase-plinth', x, 0.07, WALL_Z + 0.29, 0.63, 0.07, 0.26, 0.02, WasCharacterModel.tone(wood, 0.8));
      [0.32, 0.92, 1.52, 2.12].forEach(function (y, row)
      {
        boxAt('bookcase-shelf', x, y, WALL_Z + 0.3, 0.58, 0.022, 0.24, 0.008, hex('a37a57'));
        var cursor = x - 0.5;
        var book;
        for (book = 0; book < 7; book += 1)
        {
          var widthBook = 0.045 + seeded(row * 11 + book) * 0.03;
          var heightBook = 0.3 + seeded(row * 5 + book * 3) * 0.16;
          if (cursor + widthBook * 2 > x + 0.52) break;
          var colors = ['c8553d', '2d6a8f', 'e0b45c', '4f7d5c', '8e6c8a', 'efe6d6', '3d405b'];
          boxAt('book', cursor + widthBook, y + 0.022 + heightBook / 2, WALL_Z + 0.3, widthBook, heightBook / 2, 0.17, 0.008, hex(pickFrom(colors, row * 3 + book)));
          cursor += widthBook * 2 + 0.006;
        }
      });
    }

    function light(x, y, z, intensity, color)
    {
      lamps.push({ position: [x, y, z, intensity], color: color || LIGHT.lamp });
    }

    function pendant(x, z)
    {
      put(shapes.capsule('lamp-cord', P(x, 6.5, z), P(x, 4.5, z), 0.01, hex('22252b'), { cast: false }));
      put(shapes.ellipsoid('lamp-shade', P(x, 4.4, z), [0.24, 0.15, 0.24], hex('c9a46a'), { gloss: 0.7, rim: 0.6, cast: false }));
      put(shapes.cylinder('lamp-rim', P(x, 4.29, z), 0.235, 0.02, hex('ffd9a0'), { emissive: 1, cast: false }));
      glow(x, 4.25, z + 0.35, 0.55, hex('ffb36b'), 0.16);
      light(x, 3.6, z + 0.5, 0.8);
    }

    /* Workstations face the wall: the desk and two monitors sit behind the character, screens toward the camera. */
    function desk(seat, actor, variant)
    {
      var x = seat.x;
      var z = WORK_Z;
      var top = 0.68 * CHARACTER_SCALE;
      var deskZ = z - 0.31 - 0.41;
      var wood = variant.wood;
      var side = variant.monitorSide;
      blob(x, deskZ + 0.1, 1.55, 0.9, 0.22);
      boxAt('desk-top', x, top - 0.03, deskZ, 1.16, 0.03, 0.42, 0.025, wood, { gloss: 0.28 });
      boxAt('desk-edge', x, top - 0.066, deskZ + 0.4, 1.14, 0.01, 0.012, 0.006, WasCharacterModel.tone(wood, 0.7), { cast: false });
      [-1, 1].forEach(function (sx)
      {
        [-1, 1].forEach(function (sz)
        {
          put(shapes.cylinder('desk-leg', P(x + sx * 1.06, (top - 0.06) / 2, deskZ + sz * 0.34), 0.028, (top - 0.06) / 2, hex('3a3f47'), { gloss: 0.5 }));
        });
      });
      if (variant.pedestal)
      {
        var px = x + side * 0.74;
        boxAt('pedestal', px, 0.37, deskZ, 0.25, 0.34, 0.33, 0.03, hex('e9e4da'), { gloss: 0.2 });
        [0.58, 0.36, 0.14].forEach(function (y)
        {
          boxAt('drawer-line', px, y - 0.1, deskZ + 0.332, 0.23, 0.004, 0.004, 0.003, hex('b9b2a6'), { cast: false });
          put(shapes.capsule('drawer-handle', P(px - 0.08, y, deskZ + 0.34), P(px + 0.08, y, deskZ + 0.34), 0.012, hex('7a7f88'), { gloss: 0.6 }));
        });
      }
      var screenY = top + 0.6;
      var mountZ = deskZ - 0.26;
      put(shapes.cylinder('monitor-clamp', P(x, top + 0.03, mountZ - 0.06), 0.07, 0.03, hex('2a2e35'), { gloss: 0.4 }));
      put(shapes.capsule('monitor-pole', P(x, top + 0.04, mountZ - 0.06), P(x, screenY + 0.05, mountZ - 0.06), 0.028, hex('2a2e35'), { gloss: 0.6 }));
      put(shapes.capsule('monitor-arm', P(x - 0.62, screenY, mountZ - 0.04), P(x + 0.62, screenY, mountZ - 0.04), 0.024, hex('2a2e35'), { gloss: 0.6 }));
      [-1, 1].forEach(function (screenSide)
      {
        var yaw = -screenSide * 0.24;
        var basis = shapes.euler(0, yaw, 0);
        var normal = [Math.sin(yaw), 0, Math.cos(yaw)];
        var mx = x + screenSide * 0.6;
        var mz = mountZ + 0.02 + Math.abs(Math.sin(yaw)) * 0.3;
        put(shapes.box('monitor', P(mx, screenY, mz), [0.54, 0.32, 0.03], 0.026, hex('20242b'), { basis: basis, gloss: 0.5 }));
        put(shapes.box('monitor-screen', P(mx + normal[0] * 0.033, screenY + 0.006, mz + normal[2] * 0.033), [0.51, 0.29, 0.003], 0.003, hex('141c27'),
          { basis: basis, paint: [6, variant.scroll * (screenSide > 0 ? 0.6 : 1), variant.seed + (screenSide > 0 ? 31 : 0), variant.screenBrightness],
            paint2: [variant.screenKind, variant.seconds, screenSide, 0], color2: variant.accent, emissive: 1, cast: false }));
        glow(mx + normal[0] * 0.1, screenY, mz + 0.12, 0.85, variant.screenKind === 3 ? hex('ff7a7a') : variant.screenKind === 1 ? hex('ffd27a') : variant.accent,
          0.05 + 0.06 * variant.screenBrightness);
      });
      var screenLight = variant.screenKind === 3 ? hex('ff8f8f') : variant.screenKind === 1 ? hex('ffd9a0') : hex('9cc4ff');
      light(x, screenY, mountZ + 0.4, 0.55 + 0.55 * variant.screenBrightness, [Math.pow(screenLight[0], 2.2), Math.pow(screenLight[1], 2.2), Math.pow(screenLight[2], 2.2)]);
      var kz = z - 0.5;
      boxAt('keyboard', x, top + 0.012, kz, 0.33, 0.012, 0.095, 0.01, hex('e4e0d8'), { gloss: 0.25 });
      boxAt('keys', x, top + 0.024, kz, 0.3, 0.004, 0.075, 0.003, hex('c9c4bb'), { cast: false });
      put(shapes.ellipsoid('mouse', P(x + 0.48, top + 0.02, kz - 0.02), [0.045, 0.022, 0.068], hex('e4e0d8'), { gloss: 0.4 }));
      if (!variant.holdingMug)
      {
        put(shapes.cylinder('mug', P(x - side * 0.92, top + 0.075, deskZ + 0.12), 0.065, 0.075, variant.mug, { gloss: 0.4 }));
        put(shapes.capsule('mug-handle', P(x - side * 0.92 - side * 0.075, top + 0.11, deskZ + 0.12), P(x - side * 0.92 - side * 0.075, top + 0.04, deskZ + 0.12), 0.016, variant.mug));
      }
      if (variant.lamp)
      {
        var lx = x + side * 0.95;
        var lz = deskZ - 0.12;
        put(shapes.cylinder('lamp-base', P(lx, top + 0.02, lz), 0.1, 0.02, hex('2f3540'), { gloss: 0.4 }));
        put(shapes.capsule('lamp-arm', P(lx, top + 0.03, lz), P(lx - side * 0.05, top + 0.5, lz - 0.06), 0.016, hex('2f3540')));
        put(shapes.capsule('lamp-arm', P(lx - side * 0.05, top + 0.5, lz - 0.06), P(lx - side * 0.2, top + 0.62, lz + 0.06), 0.016, hex('2f3540')));
        put(shapes.ellipsoid('lamp-head', P(lx - side * 0.24, top + 0.58, lz + 0.09), [0.11, 0.07, 0.09], variant.lampColor, { gloss: 0.5, rotation: { x: 0.35, y: 0, z: -side * 0.5 } }));
        glow(lx - side * 0.28, top + 0.5, lz + 0.3, 0.3, hex('ffd08a'), 0.14);
      }
      else if (variant.plant)
      {
        plantSmall(x + side * 0.96, top, deskZ - 0.12, variant.seed);
      }
      if (variant.papers)
      {
        boxAt('paper', x - side * 0.55, top + 0.006, deskZ + 0.05, 0.14, 0.005, 0.19, 0.003, hex('f7f5ef'), { rotation: { x: 0, y: 0.2, z: 0 }, cast: false });
        boxAt('paper', x - side * 0.57, top + 0.014, deskZ + 0.04, 0.14, 0.005, 0.19, 0.003, hex('eef3f7'), { rotation: { x: 0, y: -0.1, z: 0 }, cast: false });
      }
      pendant(x, deskZ + 0.2);
    }

    /* The chair turns with its character; local +z is the direction the sitter faces. */
    function chair(root, color)
    {
      var metal = hex('3a3f47');
      var parts = [
        shapes.box('chair-seat', P(0, 0.49, -0.02), [0.34, 0.045, 0.31], 0.045, color, { gloss: 0.2 }),
        shapes.box('chair-back', P(0, 0.82, -0.4), [0.37, 0.2, 0.07], 0.07, color, { gloss: 0.18, sss: 0.1, rotation: { x: -0.12, y: 0, z: 0 } }),
        shapes.capsule('chair-spine', P(0, 0.47, -0.27), P(0, 0.74, -0.4), 0.03, metal, { gloss: 0.5 }),
        shapes.cylinder('chair-post', P(0, 0.28, -0.02), 0.035, 0.17, metal, { gloss: 0.6 })
      ];
      [-1, 1].forEach(function (sideArm)
      {
        parts.push(shapes.capsule('chair-arm', P(sideArm * 0.36, 0.5, -0.2), P(sideArm * 0.37, 0.7, -0.12), 0.022, metal, { gloss: 0.5 }));
        parts.push(shapes.box('chair-armrest', P(sideArm * 0.37, 0.71, -0.04), [0.04, 0.025, 0.15], 0.022, WasCharacterModel.tone(color, 0.7)));
      });
      var leg;
      for (leg = 0; leg < 5; leg += 1)
      {
        var angle = leg / 5 * Math.PI * 2 + 0.3;
        var end = P(Math.cos(angle) * 0.32, 0.075, -0.02 + Math.sin(angle) * 0.3);
        parts.push(shapes.capsule('chair-leg', P(0, 0.1, -0.02), end, 0.025, metal, { gloss: 0.5 }));
        parts.push(shapes.ellipsoid('chair-wheel', P(end.x, 0.04, end.z), [0.04, 0.04, 0.04], hex('1f2227'), { mesh: 'low' }));
      }
      var turn = { x: root.x, y: 0, z: root.z, yaw: root.yaw, scale: 1 };
      parts.forEach(function (part) { emit(part, turn, true); });
    }

    function sofa(seat, variant)
    {
      var x = seat.x;
      var z = REST_Z;
      var fabric = variant.fabric;
      var dark = WasCharacterModel.tone(fabric, 0.82);
      blob(x, z + 0.25, 1.35, 0.85, 0.26);
      put(shapes.ellipsoid('rug', P(x, 0.006, z + 0.55), [1.6, 0.004, 0.95], variant.rug,
        { paint: [7, 0, 0, 0], color2: variant.rugBorder, color3: variant.rugAccent, cast: false, gloss: 0.02 }));
      [-1, 1].forEach(function (sx)
      {
        [-1, 1].forEach(function (sz)
        {
          put(shapes.cylinder('sofa-leg', P(x + sx * 0.76, 0.055, z + sz * 0.3), 0.035, 0.055, hex('6b4a33')));
        });
      });
      boxAt('sofa-base', x, 0.25, z, 0.88, 0.13, 0.43, 0.1, dark, { gloss: 0.06 });
      boxAt('sofa-cushion', x, 0.43, z + 0.04, 0.66, 0.09, 0.38, 0.08, fabric, { gloss: 0.08, sss: 0.15 });
      boxAt('sofa-back', x, 0.8, z - 0.33, 0.88, 0.36, 0.12, 0.12, fabric, { gloss: 0.06, rotation: { x: -0.1, y: 0, z: 0 } });
      [-1, 1].forEach(function (sx)
      {
        boxAt('sofa-arm', x + sx * 0.79, 0.5, z, 0.13, 0.27, 0.43, 0.12, fabric, { gloss: 0.06 });
        put(shapes.ellipsoid('pillow', P(x + sx * 0.5, 0.76, z - 0.16), [0.2, 0.19, 0.07], variant.pillow, { rotation: { x: -0.15, y: 0, z: sx * 0.22 }, sss: 0.2 }));
      });
    }

    function lounge(x, seed)
    {
      if (seed % 3 === 0)
      {
        plant(x, REST_Z - 0.05, 1.15, seed);
      }
      else if (seed % 3 === 1)
      {
        put(shapes.cylinder('lamp-foot', P(x, 0.02, REST_Z - 0.1), 0.2, 0.02, hex('2f3540'), { gloss: 0.4 }));
        put(shapes.capsule('lamp-pole', P(x, 0.03, REST_Z - 0.1), P(x, 1.95, REST_Z - 0.1), 0.02, hex('2f3540'), { gloss: 0.5 }));
        put(shapes.cylinder('lamp-shade', P(x, 2.06, REST_Z - 0.1), 0.26, 0.16, hex('f3e6cf'), { emissive: 0.65, sss: 1, cast: false }));
        glow(x, 2.0, REST_Z + 0.25, 0.8, hex('ffc07a'), 0.16);
        light(x, 1.9, REST_Z + 0.2, 0.9);
      }
      else
      {
        put(shapes.cylinder('table', P(x, 0.5, REST_Z + 0.05), 0.28, 0.025, hex('c99a6b'), { gloss: 0.3 }));
        put(shapes.cylinder('table-post', P(x, 0.25, REST_Z + 0.05), 0.03, 0.24, hex('3a3f47')));
        put(shapes.cylinder('table-foot', P(x, 0.015, REST_Z + 0.05), 0.16, 0.015, hex('3a3f47')));
        boxAt('book', x - 0.06, 0.55, REST_Z + 0.05, 0.12, 0.022, 0.16, 0.006, hex('2d6a8f'), { rotation: { x: 0, y: 0.3, z: 0 } });
        put(shapes.cylinder('mug', P(x + 0.13, 0.6, REST_Z + 0.1), 0.05, 0.06, hex('e8e2d6'), { gloss: 0.4 }));
      }
    }

    function wallSegment(left, right, colors)
    {
      if (right <= left) return;
      var center = (left + right) / 2;
      var half = (right - left) / 2;
      boxAt('wall', center, 4.6, WALL_Z - 0.05, half, 4.6, 0.05, 0.004, colors.wall, { paint: [4, 0, 0, 0], cast: false });
      boxAt('wainscot', center, 0.56, WALL_Z + 0.02, half, 0.56, 0.035, 0.004, colors.panel, { paint: [4, 1, 1.0, 0.98], cast: false });
      boxAt('rail', center, 1.14, WALL_Z + 0.055, half, 0.03, 0.05, 0.02, colors.rail, { gloss: 0.25, cast: false });
      boxAt('baseboard', center, 0.08, WALL_Z + 0.06, half, 0.08, 0.03, 0.01, colors.base, { cast: false });
    }

    function environment(layout, left, right)
    {
      var boundary = layout && layout.restSeats.size && layout.seats.size > layout.restSeats.size ? layout.restStart - 1.2 : layout && layout.restSeats.size ? -Infinity : Infinity;
      put(shapes.box('floor', P((left + right) / 2, -0.05, 3), [(right - left) / 2 + 1, 0.05, 4.8], 0.004, hex('a47650'), { paint: [3, 0, 0, 0], gloss: 0.22, cast: false }));
      var work = { wall: hex('cfc8bb'), panel: hex('5f7a72'), rail: hex('e9e2d4'), base: hex('3b3430') };
      var rest = { wall: hex('d9b9a0'), panel: hex('8a5a4a'), rail: hex('f1e4d4'), base: hex('3b3430') };
      wallSegment(left - 1, Math.min(right + 1, boundary), work);
      if (layout && layout.seats.size > layout.restSeats.size)
      {
        var aisleLeft = 0.2;
        var aisleRight = layout.workEnd + 0.4;
        if (aisleRight > left - 1 && aisleLeft < right + 1)
        {
          put(shapes.box('runner', P((aisleLeft + aisleRight) / 2, 0.006, 1.35), [(aisleRight - aisleLeft) / 2, 0.005, 0.85], 0.004, hex('5b6b78'),
            { paint: [7, 1, 0, 0], color2: hex('3f4b57'), color3: hex('c9a46a'), cast: false, gloss: 0.03 }));
        }
      }
      wallSegment(Math.max(left - 1, boundary), right + 1, rest);
      if (isFinite(boundary) && boundary > left - 2 && boundary < right + 2)
      {
        boxAt('pilaster', boundary, 4.6, WALL_Z + 0.06, 0.13, 4.6, 0.09, 0.02, hex('ece4d6'), { cast: false });
        bookcase(boundary - 0.05);
        plant(boundary + 0.85, WALL_Z + 0.9, 1.3, 5);
      }
      var spacing = 5.4;
      var unit;
      for (unit = Math.floor((left - 3) / spacing); unit <= Math.ceil((right + 3) / spacing); unit += 1)
      {
        var center = unit * spacing + spacing / 2;
        if (center + 1.5 < Math.min(boundary, Infinity) - 0.5)
        {
          windowUnit(center);
          var between = center + spacing / 2;
          if (between + 0.8 < boundary - 0.4)
          {
            var kind = ((unit % 3) + 3) % 3;
            if (kind === 0) corkboard(between, unit);
            else if (kind === 1) clock(between);
            else frameArt(between, 2.95, 0.38, 0.5, unit);
          }
        }
      }
      var loungeSpacing = 4.6;
      for (unit = Math.floor((left - 3) / loungeSpacing); unit <= Math.ceil((right + 3) / loungeSpacing); unit += 1)
      {
        var spot = unit * loungeSpacing + loungeSpacing / 2;
        if (spot - 1 <= boundary + 0.6) continue;
        var variety = ((unit % 2) + 2) % 2;
        if (variety === 0) frameArt(spot, 2.9, 0.78, 0.55, unit + 3);
        else
        {
          frameArt(spot, 3.35, 0.34, 0.3, unit + 7);
          shelf(spot, 2.45, unit);
        }
        put(shapes.box('sconce', P(spot + 1.3, 2.75, WALL_Z + 0.08), [0.08, 0.14, 0.06], 0.05, hex('f3e6cf'), { emissive: 0.8, cast: false }));
        glow(spot + 1.3, 2.75, WALL_Z + 0.4, 0.55, hex('ffc07a'), 0.12);
      }
    }

    function stationVariant(actor)
    {
      var seed = WasCharacterModel.hashId('desk:' + actor.id);
      var woods = ['caa077', 'b98a5e', 'd8b48a', '9c7350'];
      var chairs = ['2f3540', '3f5872', '7a4b3a', '3e5b4f', '5a4a6b'];
      var mugs = ['e8e2d6', 'd9604f', '4f7fd0', 'f0b04c', '6aa58e'];
      return { seed: seed % 97, monitorSide: seed % 2 ? 1 : -1, wood: hex(woods[(seed >>> 3) % woods.length]), chair: hex(chairs[(seed >>> 6) % chairs.length]),
        mug: hex(mugs[(seed >>> 9) % mugs.length]), lamp: (seed >>> 12) % 3 === 0, plant: (seed >>> 12) % 3 === 1, papers: (seed >>> 14) % 2 === 0,
        pedestal: (seed >>> 16) % 3 !== 0, lampColor: hex(['f0b04c', 'e8e4dc', 'd9604f'][(seed >>> 18) % 3]),
        accent: providerAccent(actor.provider), scroll: 0, screenBrightness: 1, screenKind: 0, seconds: 0, holdingMug: false };
    }

    function sofaVariant(actor)
    {
      var seed = WasCharacterModel.hashId('sofa:' + actor.id);
      var fabrics = ['5f8a86', 'd4a24c', 'c46e52', '7d9a6a', '4c5f8a', 'a87f9e'];
      var pillows = ['f3e6cf', 'e9c46a', 'f4a261', 'e5e5e5', '9ed6c6'];
      var rugs = [['e6d6bd', 'b5643f', '3f5872'], ['d5ddd3', '4f7d5c', 'c8553d'], ['eadbc9', '8e6c8a', 'e0b45c'], ['d9d2e4', '5e548e', 'f2b880']];
      var rug = rugs[(seed >>> 5) % rugs.length];
      return { fabric: hex(fabrics[seed % fabrics.length]), pillow: hex(pillows[(seed >>> 3) % pillows.length]), rug: hex(rug[0]), rugBorder: hex(rug[1]), rugAccent: hex(rug[2]) };
    }

    /* Seated workers face their monitors with their backs to the camera; calls and selection swivel them around. */
    function facingTarget(actor, position, call)
    {
      if (position.walking) return position.direction < 0 ? -Math.PI / 2 : Math.PI / 2;
      if (position.zone !== 'work' || call || selectedId === actor.id) return 0;
      var status = statusKey(actor);
      if (status === 'idle') return 0;
      if (status === 'waiting') return Math.PI - 0.8;
      return Math.PI;
    }

    function characterPose(actor, position, call, timestamp, variant)
    {
      var status = statusKey(actor);
      var stance = position.walking ? 'stand' : position.zone === 'rest' ? 'sofa' : 'desk';
      var turned = stance === 'desk' && !call && selectedId === actor.id;
      var activity = position.walking ? 'walk' : stance === 'sofa' ? status === 'completed' ? 'sleep' : 'relax' : turned ? 'turned'
        : status === 'running' ? 'typing' : status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : status === 'error' ? 'error' : 'unknown';
      var animated = motionAllowed();
      var clock = STOP_MOTION_FPS > 0 ? Math.floor(timestamp / 1000 * STOP_MOTION_FPS) / STOP_MOTION_FPS * 1000 : timestamp;
      var seconds = clock / 1000;
      var materials = palettes.get(actor.id);
      var wave = turned && animated && clock - selectedAt < 1800 ? Math.max(0, clock - selectedAt) / 1800 : 0;
      return { stance: stance, activity: activity, phone: call && call.phase, time: animated ? clock : 0, wave: wave,
        look: activity === 'typing' && animated ? Math.sin(seconds * 0.35 + (materials ? materials.phase : 0) * 6.28) : 0,
        accent: providerAccent(actor.provider), materials: materials };
    }

    function headWorld(actor, position)
    {
      var stance = position.walking ? 'stand' : position.zone === 'rest' ? 'sofa' : 'desk';
      var key = actor.id + ':' + stance;
      if (!tops.has(key)) tops.set(key, WasCharacterModel.silhouetteTop(stance, palettes.get(actor.id)));
      return tops.get(key) * CHARACTER_SCALE + 0.04;
    }

    function phoneWorld(position, rootZ, yaw)
    {
      var stance = position.walking ? 'stand' : position.zone === 'rest' ? 'sofa' : 'desk';
      var headY = stance === 'desk' ? 1.58 : stance === 'sofa' ? 1.46 : 1.63;
      var cosine = Math.cos(yaw || 0);
      var sine = Math.sin(yaw || 0);
      return P(position.x + (cosine * 0.42 + sine * 0.2) * CHARACTER_SCALE, (headY + 0.02) * CHARACTER_SCALE, rootZ + (-sine * 0.42 + cosine * 0.2) * CHARACTER_SCALE);
    }

    function signal(from, to, progress, seconds, color)
    {
      var distance = Math.hypot(to.x - from.x, to.y - from.y);
      var lift = 0.7 + Math.min(2.2, distance * 0.14);
      var count = Math.max(10, Math.min(40, Math.round(distance * 3)));
      var dot;
      for (dot = 0; dot <= count; dot += 1)
      {
        var t = dot / count;
        if (t > progress) break;
        var pulse = Math.exp(-Math.pow((t - (seconds * 0.9 % 1.2) + 0.1) / 0.08, 2));
        put(shapes.ellipsoid('signal', P(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t + Math.sin(t * Math.PI) * lift, from.z + (to.z - from.z) * t + 0.3),
          [0.03 + pulse * 0.03, 0.03 + pulse * 0.03, 0.03 + pulse * 0.03], color, { mesh: 'low', emissive: 1, cast: false }));
        if (pulse > 0.3) glow(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t + Math.sin(t * Math.PI) * lift, from.z + 0.4, 0.3, color, 0.35 * pulse);
      }
    }

    function destination(actor, layout)
    {
      return resting(actor) ? layout.restSeats.get(actor.id) : layout.seats.get(actor.id);
    }

    function rebuildLayouts()
    {
      if (!office) return;
      var retained = new Set();
      office.floors.forEach(function (floor)
      {
        retained.add(floor.id);
        layouts.set(floor.id, layoutFloor(office, floor.id, layouts.get(floor.id), { pixelsPerUnit: pixelsPerUnit(), measure: measureName }));
      });
      layouts.forEach(function (layout, id)
      {
        if (!retained.has(id)) layouts.delete(id);
      });
    }

    function clampCamera()
    {
      var layout = currentLayout();
      if (!layout) return;
      var halfWidth = width / Math.max(1, pixelsPerUnit()) / 2;
      if (layout.width <= halfWidth * 2) cameraX = layout.width / 2;
      else cameraX = clamp(cameraX, halfWidth - 0.35, layout.width - halfWidth + 0.35);
    }

    /* Estimate from the name alone, used while a plate cannot be measured (no layout yet, or no DOM metrics). */
    function labelWidth(name)
    {
      return Math.max(156, Math.ceil(measureName(name)) + 46);
    }

    /* The width the plate needs as laid out: its wider row, name or provider and status, plus padding and border. Measured
       rather than guessed so the side space is the same on every plate and translated texts and fonts always fit. */
    function naturalLabelWidth(label)
    {
      var style = label.element.style;
      style.width = 'max-content';
      var measured = label.element.offsetWidth || 0;
      style.width = '';
      return measured > 0 ? Math.ceil(measured) : 0;
    }

    function makeLabel(actor)
    {
      var element = document.createElement('button');
      element.type = 'button';
      element.className = 'was-office-actor-label';
      element.setAttribute('data-was-actor-id', actor.id);
      var heading = document.createElement('span');
      heading.className = 'was-office-actor-heading';
      var state = document.createElement('span');
      state.className = 'was-office-actor-state';
      state.setAttribute('aria-hidden', 'true');
      var name = document.createElement('strong');
      name.className = 'was-office-actor-name';
      heading.appendChild(state);
      heading.appendChild(name);
      var row = document.createElement('span');
      row.className = 'was-office-actor-metadata';
      var provider = document.createElement('span');
      provider.className = 'was-office-actor-provider';
      var activity = document.createElement('span');
      activity.className = 'was-office-actor-activity';
      var status = document.createElement('span');
      status.className = 'was-office-actor-role';
      row.appendChild(provider);
      row.appendChild(activity);
      row.appendChild(status);
      element.appendChild(heading);
      element.appendChild(row);
      listen(element, 'click', function () { clickActor(actor.id); });
      labelLayer.appendChild(element);
      return { element: element, name: name, provider: provider, activity: activity, status: status };
    }

    function makePartnerCard(card)
    {
      function part(tag, className)
      {
        var element = document.createElement(tag);
        element.className = className;
        return element;
      }
      var item = part('div', 'was-office-partner-item');
      var button = part('button', 'was-office-partner-card');
      button.type = 'button';
      button.setAttribute('data-was-partner-id', card.id);
      var title = part('span', 'was-office-partner-title');
      title.appendChild(part('i', 'was-office-partner-dot'));
      var name = part('span', 'was-office-partner-name');
      title.appendChild(name);
      var meta = part('span', 'was-office-partner-meta');
      button.appendChild(title);
      button.appendChild(meta);
      item.appendChild(button);
      return { item: item, button: button, name: name, meta: meta, lastTime: card.lastTime };
    }

    function fillPartnerCard(view, card)
    {
      var name = text(card.name);
      var meta = text(card.meta);
      if (view.name.textContent !== name) view.name.textContent = name;
      if (view.meta.textContent !== meta) view.meta.textContent = meta;
      view.button.setAttribute('data-was-status', text(card.status));
    }

    /* Full strength for the first half of a card's life, then a steady fade, so the oldest cards at the bottom dim first. */
    function partnerOpacity(age)
    {
      var fadeFrom = PARTNER_LIFETIME * PARTNER_FADE_FROM;
      return age <= fadeFrom ? 1 : clamp(1 - (age - fadeFrom) / (PARTNER_LIFETIME - fadeFrom), 0, 1);
    }

    /* Newest conversation on top. A partner who writes again moves back to the top; cards past their lifetime melt away from the bottom. */
    function syncPartnerStack(entry, id, timestamp)
    {
      var live = (partnerData.get(id) || []).filter(function (card)
      {
        return card.lastTime > 0 && timestamp - card.lastTime < PARTNER_LIFETIME;
      }).sort(function (first, second) { return second.lastTime - first.lastTime; });
      var keep = new Set();
      live.forEach(function (card, position)
      {
        keep.add(card.id);
        var view = entry.views.get(card.id);
        if (!view)
        {
          view = makePartnerCard(card);
          entry.views.set(card.id, view);
          if (entry.populated) view.item.classList.add('was-office-partner-new');
        }
        else if (entry.populated && card.lastTime > view.lastTime)
        {
          view.item.classList.remove('was-office-partner-fresh');
          if (typeof view.item.offsetWidth === 'number') void view.item.offsetWidth;
          view.item.classList.add('was-office-partner-fresh');
        }
        view.lastTime = card.lastTime;
        fillPartnerCard(view, card);
        view.item.style.opacity = String(Math.round(partnerOpacity(timestamp - card.lastTime) * 100) / 100);
        if (entry.element.children[position] !== view.item) entry.element.insertBefore(view.item, entry.element.children[position] || null);
      });
      entry.views.forEach(function (view, viewId)
      {
        if (keep.has(viewId)) return;
        entry.views.delete(viewId);
        view.item.classList.add('was-office-partner-leaving');
        view.item.style.opacity = '0';
        entry.leaving.push({ item: view.item, since: timestamp });
      });
      entry.leaving = entry.leaving.filter(function (gone)
      {
        if (timestamp - gone.since < PARTNER_LEAVE) return true;
        gone.item.remove();
        return false;
      });
      entry.populated = true;
      entry.agedAt = timestamp;
      entry.version = partnerVersion;
      labelPartnerStack(entry, id);
    }

    function labelPartnerStack(entry, id)
    {
      var actor = office && office.actorById.get(id);
      entry.element.setAttribute('aria-label', sceneT('scene.partner.stackLabel', { name: text(actor && actor.name || id), count: entry.views.size }));
    }

    /* The stack beside an actor's nameplate. Names are never shortened; the stack is kept in step with the clock. */
    function partnerStack(id, timestamp)
    {
      var entry = partnerStacks.get(id);
      var cards = partnerData.get(id);
      if (!entry && (!cards || !cards.length)) return null;
      if (!entry)
      {
        entry = { element: document.createElement('div'), views: new Map(), leaving: [], populated: false, agedAt: -Infinity, version: -1 };
        entry.element.className = 'was-office-partner-stack';
        entry.element.hidden = true;
        listen(entry.element, 'click', function (event)
        {
          var node = event.target;
          var partnerId = node && node.getAttribute && node.getAttribute('data-was-partner-id');
          while (!partnerId && node && node !== entry.element)
          {
            node = node.parentNode;
            partnerId = node && node.getAttribute && node.getAttribute('data-was-partner-id');
          }
          if (partnerId) selectActor(partnerId, { focus: true, notify: true, again: false });
        });
        listen(entry.element, 'wheel', function (event)
        {
          var element = entry.element;
          if (!event.shiftKey && element.scrollHeight > element.clientHeight + 1) return;
          didWheel(event);
        }, { passive: false });
        partnerLayer.appendChild(entry.element);
        partnerStacks.set(id, entry);
      }
      if (entry.version !== partnerVersion || timestamp - entry.agedAt >= PARTNER_AGE_STEP) syncPartnerStack(entry, id, timestamp);
      if (!cards && !entry.views.size && !entry.leaving.length)
      {
        entry.element.remove();
        partnerStacks.delete(id);
        return null;
      }
      return entry;
    }

    /* Cards age with the clock, so a light tick keeps the stage redrawing while any card is on screen. */
    function scheduleAging()
    {
      if (agingTimer !== null || destroyed || typeof setTimeout !== 'function') return;
      agingTimer = setTimeout(function ()
      {
        agingTimer = null;
        requestDraw();
      }, PARTNER_AGE_STEP);
    }

    function setPartners(value)
    {
      partnerData = new Map(Object.keys(value || {}).map(function (id) { return [id, value[id]]; }));
      partnerVersion += 1;
      requestDraw();
    }

    /* Each stack starts right of its nameplate and stops before the next nameplate; a hub with many partners scrolls inside its stack. */
    function placePartnerStacks(placed, timestamp)
    {
      placed.sort(function (first, second) { return first.left - second.left; });
      placed.forEach(function (item, position)
      {
        var entry = partnerStack(item.id, timestamp);
        if (!entry) return;
        if (!entry.element.children.length)
        {
          entry.element.hidden = true;
          return;
        }
        var next = placed[position + 1];
        var left = item.right + PARTNER_GAP;
        var room = Math.floor((next ? next.left : width) - left - PARTNER_GAP);
        entry.element.hidden = false;
        entry.element.style.left = left + 'px';
        entry.element.style.top = item.top + 'px';
        entry.element.style.width = clamp(room, PARTNER_MIN_WIDTH, PARTNER_MAX_WIDTH) + 'px';
        entry.element.style.maxHeight = Math.max(96, height - item.top - 64) + 'px';
        scheduleAging();
      });
    }

    function reconcileLabels()
    {
      var layout = currentLayout();
      var ids = new Set(layout ? layout.actors.map(function (actor) { return actor.id; }) : []);
      [labels, indexItems, partnerStacks].forEach(function (entries)
      {
        entries.forEach(function (entry, id)
        {
          if (ids.has(id)) return;
          (entry.element || entry).remove();
          entries.delete(id);
        });
      });
      if (!layout) return;
      layout.actors.forEach(function (actor)
      {
        var label = labels.get(actor.id);
        if (!label)
        {
          label = makeLabel(actor);
          labels.set(actor.id, label);
        }
        var name = text(actor.name || actor.id);
        if (label.name.textContent !== name)
        {
          label.name.textContent = name;
          label.height = 0;
        }
        label.provider.textContent = actor.provider === 'codex' ? 'Codex' : actor.provider === 'claude' ? 'Claude' : text(actor.provider || sceneT('scene.label.providerUnknown'));
        label.activity.textContent = activityText(actor);
        label.status.textContent = statusText(actor);
        var contentKey = [label.name.textContent, label.provider.textContent, label.activity.textContent, label.status.textContent].join('\n');
        if (label.contentKey !== contentKey)
        {
          label.contentKey = contentKey;
          label.width = 0;
        }
        label.element.setAttribute('data-was-provider', text(actor.provider));
        label.element.setAttribute('data-was-activity', resting(actor) ? 'inactive' : actor.activity && actor.activity.category || 'unconfirmed');
        label.element.setAttribute('data-was-status', statusKey(actor));
        /* Read out by assistive technology and listed in the session index; never a title attribute, which browsers show as a tooltip over the plate. */
        var description = name + ' · ' + label.provider.textContent + ' · ' + label.activity.textContent + ' · ' + label.status.textContent;
        label.element.setAttribute('aria-label', description);
        var item = indexItems.get(actor.id);
        if (!item)
        {
          item = document.createElement('button');
          item.type = 'button';
          item.className = 'was-office-session-item';
          item.setAttribute('data-was-actor-id', actor.id);
          listen(item, 'click', function ()
          {
            selectActor(actor.id, { focus: true, notify: true });
            index.open = false;
          });
          indexList.appendChild(item);
          indexItems.set(actor.id, item);
        }
        item.textContent = description;
      });
      indexCount = layout.actors.length;
      summary.textContent = summaryText();
      markSessionIndex();
    }

    /* The session list doubles as the character picker, so it always shows which session is selected. */
    function markSessionIndex()
    {
      indexItems.forEach(function (item, id)
      {
        var current = id === selectedId;
        item.classList.toggle('was-office-session-selected', current);
        item.setAttribute('aria-current', current ? 'true' : 'false');
      });
    }

    function actorPosition(actor, layout, timestamp)
    {
      var target = destination(actor, layout);
      if (!target) return null;
      var z = resting(actor) ? REST_Z : WORK_Z;
      var transition = transitions.get(actor.id);
      if (!transition || !motionAllowed()) return { x: target.x, z: z, seated: resting(actor), zone: target.zone };
      var progress = clamp((timestamp - transition.startedAt) / 1100, 0, 1);
      if (progress >= 1)
      {
        transitions.delete(actor.id);
        return { x: target.x, z: z, seated: resting(actor), zone: target.zone };
      }
      var smooth = progress * progress * (3 - 2 * progress);
      return { x: transition.fromX + (target.x - transition.fromX) * smooth, z: WORK_Z + (z - WORK_Z) * smooth, seated: progress > 0.88 && resting(actor),
        zone: target.zone, walking: progress <= 0.88, direction: target.x >= transition.fromX ? 1 : -1 };
    }

    function observationKey(edge)
    {
      var message = edge.message || {};
      var id = message.deliveryId || (edge.type === 'collaboration' ? edge.id : '');
      if (!id) return null;
      return text(id) + '|' + text(edge.status) + '|' + text(message.outcome) + '|' + text(message.acceptedAt) + '|' + text(message.finishedAt);
    }

    function observationAllowed(edge)
    {
      if (!office || !office.actorById || !office.actorById.has(edge.from) || !office.actorById.has(edge.to)) return false;
      if (!Array.isArray(office.edges)) return true;
      var id = edge.message && edge.message.deliveryId;
      return office.edges.some(function (current)
      {
        if (current.from !== edge.from || current.to !== edge.to) return false;
        return edge.id && current.id === edge.id || id && current.message && current.message.deliveryId === id;
      });
    }

    function callStates(timestamp)
    {
      var result = new Map();
      var remaining = [];
      var latest = null;
      calls.forEach(function (call)
      {
        var state = WasOfficeModel.callAt(call, timestamp);
        if (!state) return;
        if (state.phase === 'done')
        {
          emitCall(call, state);
          return;
        }
        remaining.push(call);
        if (state.senderPhase !== 'idle') result.set(call.from, { phase: state.senderPhase, replay: call.replay, direction: 'sender', call: call, state: state });
        if (state.receiverPhase !== 'idle') result.set(call.to, { phase: state.receiverPhase, replay: call.replay, direction: 'receiver', call: call, state: state });
        if (call.fromFloorId === floorId || call.toFloorId === floorId) latest = { call: call, state: state };
      });
      calls = remaining;
      if (latest) emitCall(latest.call, latest.state);
      return result;
    }

    function emitCall(call, state)
    {
      var key = call.deliveryId + ':' + call.startedAt + ':' + state.phase;
      if (lastTravel === key) return;
      lastTravel = key;
      var from = office.actorById.get(call.from);
      var to = office.actorById.get(call.to);
      notifyTravel({ phase: state.phase, text: text(from && from.name || call.from) + ' → ' + text(to && to.name || call.to),
        replay: call.replay, from: call.from, to: call.to, fromFloorId: call.fromFloorId, toFloorId: call.toFloorId,
        visibleFloorId: floorId, floorId: floorId, illustrative: true });
    }

    function buildScene(layout, states, timestamp, margin)
    {
      itemCount = 0;
      lamps = [];
      var halfWidth = width / Math.max(1, pixelsPerUnit()) / 2;
      environment(layout, cameraX - halfWidth - 2, cameraX + halfWidth + 2);
      if (!layout) return;
      var rootById = new Map();
      var variants = new Map();
      var seconds = timestamp / 1000;
      layout.actors.forEach(function (actor)
      {
        var workSeat = layout.seats.get(actor.id);
        var restSeat = layout.restSeats.get(actor.id);
        if (!resting(actor) && Math.abs(workSeat.x - cameraX) < margin)
        {
          var variant = stationVariant(actor);
          var status = statusKey(actor);
          var screenClock = timestamp % 600000 / 1000;
          variant.scroll = running(actor) && motionAllowed() ? screenClock * 1.6 : 0;
          variant.seconds = motionAllowed() ? screenClock : 0;
          variant.screenKind = running(actor) ? 0 : status === 'waiting' ? 1 : status === 'idle' ? 2 : status === 'error' ? 3 : 4;
          variant.screenBrightness = running(actor) ? 1 : status === 'waiting' ? 0.8 : status === 'error' ? 0.8 : 0.45;
          variants.set(actor.id, variant);
          variant.holdingMug = status === 'idle' && !states.get(actor.id) && selectedId !== actor.id;
          desk(workSeat, actor, variant);
        }
        if (!resting(actor) && Math.abs(workSeat.x - cameraX) < margin && workSeat.x + workSeat.width / 2 < layout.workEnd - 0.1 &&
          WasCharacterModel.hashId('aisle:' + actor.id) % 2 === 0)
        {
          plant(workSeat.x + workSeat.width / 2, 1.65, 0.85, WasCharacterModel.hashId('aisle:' + actor.id) % 7);
        }
        if (restSeat && Math.abs(restSeat.x - cameraX) < margin)
        {
          sofa(restSeat, sofaVariant(actor));
          if (restSeat.x + restSeat.width / 2 < layout.restEnd - 0.1) lounge(restSeat.x + restSeat.width / 2, WasCharacterModel.hashId('lounge:' + actor.id) % 3);
        }
      });
      renderedActors.forEach(function (id)
      {
        var actor = office.actorById.get(id);
        var position = positions.get(id);
        if (!actor || !position) return;
        var call = states.get(id);
        var rootZ = position.zone === 'rest' && !position.walking ? REST_Z + 0.02 : position.z;
        var variant = position.zone === 'work' ? variants.get(id) || null : null;
        var pose = characterPose(actor, position, call, timestamp, variant);
        var facing = facings.get(id);
        var yaw = facing ? facing.yaw : 0;
        var root = { x: position.x, y: 0, z: rootZ, yaw: yaw, scale: CHARACTER_SCALE };
        rootById.set(id, { root: root, position: position });
        if (selectedId === id) blob(position.x, rootZ + 0.1, 0.95, 0.6, 0.55, providerAccent(actor.provider));
        else if (pose.stance !== 'desk') blob(position.x, rootZ + 0.3, 0.7, 0.45, 0.2);
        if (pose.stance === 'desk' && variant) chair(root, variant.chair);
        WasCharacterModel.parts(actor.id, pose).forEach(function (part) { emit(part, root, true).wobble = 1; });
        if (call && call.phase === 'ringing' && motionAllowed())
        {
          var ring = phoneWorld(position, rootZ, yaw);
          glow(ring.x, ring.y, ring.z + 0.2, 0.32 + Math.abs(Math.sin(seconds * 8)) * 0.18, hex('ffd27a'), 0.5);
        }
      });
      if (!motionAllowed()) return;
      var drawnCalls = new Set();
      states.forEach(function (entry)
      {
        var call = entry.call;
        if (drawnCalls.has(call)) return;
        drawnCalls.add(call);
        var state = entry.state;
        var from = rootById.get(call.from);
        var to = rootById.get(call.to);
        if (!from && !to) return;
        var color = call.replay ? hex('c3b0ff') : hex('8fe3c4');
        var start = from ? phoneWorld(from.position, from.root.z, from.root.yaw) : null;
        var end = to ? phoneWorld(to.position, to.root.z, to.root.yaw) : null;
        if (!start) start = P(end.x + (call.fromFloorId === floorId ? -halfWidth : 0), 6, end.z);
        if (!end) end = P(start.x + (call.toFloorId === floorId ? halfWidth : 0), 6, start.z);
        var progress = state.phase === 'outgoing' ? state.progress : 1;
        signal(start, end, progress, seconds, color);
      });
    }

    function draw(timestamp)
    {
      frame = null;
      if (destroyed || !visible || document.hidden || contextLost) return;
      timestamp = now();
      if (!focused && !dirty) return;
      if (!dirty && timestamp - lastFrameAt < ACTIVE_FRAME_GAP)
      {
        frame = requestAnimationFrame(draw);
        return;
      }
      matrix = stageMatrix(cameraX, zoomValue, width, height);
      var layout = currentLayout();
      var states = motionAllowed() && typeof WasOfficeModel !== 'undefined' && WasOfficeModel.callAt ? callStates(timestamp) : new Map();
      renderedActors = [];
      hitRegions = [];
      var placed = [];
      var unit = pixelsPerUnit();
      var margin = width / Math.max(1, unit) / 2 + 2;
      if (layout)
      {
        empty.hidden = layout.actors.length > 0;
        layout.actors.forEach(function (actor)
        {
          var position = actorPosition(actor, layout, timestamp);
          positions.set(actor.id, position);
          var onscreen = Math.abs(position.x - cameraX) < margin;
          var label = labels.get(actor.id);
          if (!onscreen)
          {
            if (label) label.element.hidden = true;
            if (partnerStacks.has(actor.id)) partnerStacks.get(actor.id).element.hidden = true;
            return;
          }
          renderedActors.push(actor.id);
          if (!palettes.has(actor.id) && typeof WasCharacterModel !== 'undefined') palettes.set(actor.id, WasCharacterModel.palette(actor.id));
          var top = typeof WasCharacterModel !== 'undefined' ? headWorld(actor, position) : 2.6;
          var rootZ = position.zone === 'rest' && !position.walking ? REST_Z + 0.02 : position.z;
          var head = project({ x: position.x, y: top, z: rootZ }, matrix, width, height);
          var foot = project({ x: position.x, y: 0, z: rootZ + 0.4 }, matrix, width, height);
          hitRegions.push({ id: actor.id, x: foot.x, top: head.y, bottom: foot.y + 10, radius: unit * 0.75 });
          if (label)
          {
            label.element.hidden = false;
            if (!label.width) label.width = naturalLabelWidth(label) || labelWidth(text(actor.name || actor.id));
            var widthLabel = label.width;
            label.element.style.width = widthLabel + 'px';
            label.element.style.left = Math.round(head.x - widthLabel / 2) + 'px';
            if (!label.height) label.height = label.element.offsetHeight || 0;
            var labelHeight = label.height || LABEL_HEIGHT;
            label.element.style.top = Math.round(head.y - labelHeight - LABEL_GAP) + 'px';
            placed.push({ id: actor.id, left: Math.round(head.x - widthLabel / 2), right: Math.round(head.x - widthLabel / 2) + widthLabel, top: Math.round(head.y - labelHeight - LABEL_GAP) });
            label.element.classList.toggle('was-office-actor-selected', selectedId === actor.id);
            label.element.setAttribute('aria-pressed', selectedId === actor.id ? 'true' : 'false');
          }
        });
        placePartnerStacks(placed, timestamp);
        renderFloorBadge();
        renderStageHeading(layout);
      }
      else
      {
        empty.hidden = false;
        renderFloorBadge();
        renderStageHeading(null);
      }
      transitions.forEach(function (transition, id)
      {
        if (timestamp - transition.startedAt > 1200) transitions.delete(id);
      });
      var step = lastFrameAt ? clamp(timestamp - lastFrameAt, 0, 34) : 0;
      lastFrameAt = timestamp;
      var turning = false;
      renderedActors.forEach(function (id)
      {
        var position = positions.get(id);
        var target = facingTarget(office.actorById.get(id), position, states.get(id));
        var facing = facings.get(id);
        if (!facing || !motionAllowed())
        {
          facings.set(id, { yaw: target });
          return;
        }
        var delta = Math.atan2(Math.sin(target - facing.yaw), Math.cos(target - facing.yaw));
        if (Math.abs(delta) < 0.004) facing.yaw = target;
        else
        {
          facing.yaw += delta * (1 - Math.exp(-step / 120));
          turning = true;
        }
      });
      var waving = selectedId && renderedActors.indexOf(selectedId) >= 0 && timestamp - selectedAt < 1800;
      if (gl && programs && shapes)
      {
        buildScene(layout, states, timestamp, margin);
        renderScene(timestamp);
      }
      frameCount += 1;
      dirty = false;
      var lively = calls.length || transitions.size || turning || waving;
      /* Characters breathe, blink and sip even when nothing else moves, so any character on stage keeps the loop running,
         paced by the frame gap above; an empty stage, or a window without the focus, stays a still image. */
      var animate = motionAllowed() && (lively || renderedActors.length > 0);
      if (animate) frame = requestAnimationFrame(draw);
    }

    function setOffice(value)
    {
      if (destroyed) return;
      var previousOffice = office;
      var previousPositions = positions;
      office = value || null;
      positions = new Map();
      if (!office)
      {
        floorId = null;
        calls = [];
        layouts.clear();
        reconcileLabels();
        requestDraw();
        return;
      }
      if (!office.actorById) office.actorById = new Map(office.actors.map(function (actor) { return [actor.id, actor]; }));
      if (!office.floorById) office.floorById = new Map(office.floors.map(function (floor) { return [floor.id, floor]; }));
      [palettes, facings].forEach(function (cache)
      {
        cache.forEach(function (value, id) { if (!office.actorById.has(id)) cache.delete(id); });
      });
      tops.forEach(function (value, key) { if (!office.actorById.has(key.slice(0, key.lastIndexOf(':')))) tops.delete(key); });
      var first = !floorId || !office.floorById.has(floorId);
      if (first) floorId = office.floors.length ? office.floors[0].id : null;
      if (selectedId && !office.actorById.has(selectedId)) selectedId = null;
      rebuildLayouts();
      if (previousOffice && motionAllowed())
      {
        office.actors.forEach(function (actor)
        {
          var previous = previousOffice.actorById.get(actor.id);
          var oldPosition = previousPositions.get(actor.id);
          if (previous && oldPosition && resting(previous) !== resting(actor) && actor.floorId === previous.floorId && actor.floorId === floorId)
          {
            transitions.set(actor.id, { fromX: oldPosition.x, startedAt: now() });
          }
        });
      }
      transitions.forEach(function (transition, id)
      {
        if (!office.actorById.has(id)) transitions.delete(id);
      });
      calls = calls.filter(function (call)
      {
        return office.actorById.has(call.from) && office.actorById.has(call.to) &&
          (!Array.isArray(office.edges) || office.edges.some(function (edge)
          {
            return edge.from === call.from && edge.to === call.to && text(edge.message && edge.message.deliveryId || edge.type === 'collaboration' && edge.id) === call.deliveryId;
          }));
      });
      if (!baseline && office.actors.length)
      {
        (office.edges || []).forEach(function (edge)
        {
          var key = observationKey(edge);
          if (key) seen.add(key);
        });
        baseline = true;
      }
      reconcileLabels();
      if (first) fit();
      else clampCamera();
      requestDraw();
    }

    /* The current floor is always spelled out on the stage: number, team name and position among the floors. */
    function renderFloorBadge()
    {
      var index = office ? office.floors.findIndex(function (floor) { return floor.id === floorId; }) : -1;
      var floor = index >= 0 ? office.floors[index] : null;
      var name = floor ? sceneResolve(text(floor.name)) : '';
      var position = floor ? sceneT('scene.floor.position', { index: index + 1, total: office.floors.length }) : '';
      var key = floor ? [index, name, position].join('|') : '';
      if (key === floorBadgeKey) return;
      floorBadgeKey = key;
      floorBadge.hidden = !floor;
      if (!floor) return;
      floorNumber.textContent = (index + 1) + 'F';
      floorName.textContent = name;
      floorPosition.textContent = position;
    }

    /* Public: re-renders every text the stage owns for the current language (name tags, session list, floor badge, stage heading,
       empty state, graphics notice, partner stack labels and all aria labels). The host calls it after a language change. It only
       rewrites text: camera, zoom, selection, floor, partner cards and animation state stay exactly as they are. */
    function refreshText()
    {
      if (destroyed) return;
      renderStaticText();
      labels.forEach(function (label) { label.height = 0; label.width = 0; });
      reconcileLabels();
      renderFloorBadge();
      renderStageHeading(currentLayout());
      partnerStacks.forEach(function (entry, id) { labelPartnerStack(entry, id); });
      requestDraw();
    }

    /* Shift + wheel rides the elevator: up with the wheel up, one floor per gesture even while a trackpad keeps coasting. */
    function wheelFloor(event)
    {
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta || !office) return;
      var time = now();
      if (time < floorWheel.until)
      {
        floorWheel.until = Math.max(floorWheel.until, time + 150);
        return;
      }
      if (time - floorWheel.at > 200) floorWheel.sum = 0;
      floorWheel.at = time;
      floorWheel.sum += delta;
      if (Math.abs(floorWheel.sum) < FLOOR_WHEEL_STEP) return;
      var step = floorWheel.sum < 0 ? 1 : -1;
      floorWheel.sum = 0;
      var next = office.floors[office.floors.findIndex(function (floor) { return floor.id === floorId; }) + step];
      if (!next) return;
      floorWheel.until = time + FLOOR_WHEEL_HOLD;
      setFloor(next.id);
    }

    function setFloor(id, settings)
    {
      settings = settings || {};
      if (!office || !office.floorById.has(id)) return false;
      var changed = floorId !== id;
      var previousIndex = office.floors.findIndex(function (floor) { return floor.id === floorId; });
      var nextIndex = office.floors.findIndex(function (floor) { return floor.id === id; });
      floorId = id;
      if (changed) positions = new Map();
      if (changed && previousIndex >= 0 && motionAllowed())
      {
        root.classList.remove('was-office-floor-up', 'was-office-floor-down');
        if (typeof root.offsetWidth === 'number') void root.offsetWidth;
        root.classList.add(nextIndex > previousIndex ? 'was-office-floor-up' : 'was-office-floor-down');
      }
      if (changed && previousIndex >= 0 && motionAllowed())
      {
        floorBadge.classList.remove('was-office-badge-flash');
        if (typeof floorBadge.offsetWidth === 'number') void floorBadge.offsetWidth;
        floorBadge.classList.add('was-office-badge-flash');
      }
      transitions.clear();
      reconcileLabels();
      fit();
      if (changed && typeof options.onFloorChange === 'function') options.onFloorChange(id);
      requestDraw();
      return true;
    }

    function fit()
    {
      zoomValue = 1;
      rebuildLayouts();
      var layout = currentLayout();
      var actor = selectedId && office && office.actorById.get(selectedId);
      var seat = actor && layout && destination(actor, layout);
      if (seat) cameraX = seat.x;
      else if (layout && layout.actors.length)
      {
        var first = layout.actors.find(function (entry) { return !resting(entry); }) || layout.actors[0];
        var firstSeat = destination(first, layout);
        cameraX = firstSeat.x + width / Math.max(1, pixelsPerUnit()) / 2 - firstSeat.width / 2 - 0.35;
      }
      else cameraX = width / Math.max(1, pixelsPerUnit()) / 2 + 0.25;
      clampCamera();
      requestDraw();
    }

    function zoom(factor)
    {
      var next = clamp(zoomValue * (Number(factor) || 1), 0.7, 1.6);
      if (next === zoomValue) return;
      var layout = currentLayout();
      var selected = selectedId && layout && layout.actorById.get(selectedId);
      var anchor = selected || (layout && layout.actors.reduce(function (best, actor)
      {
        var seat = destination(actor, layout);
        var previous = best && destination(best, layout);
        return !previous || Math.abs(seat.x - cameraX) < Math.abs(previous.x - cameraX) ? actor : best;
      }, null));
      zoomValue = next;
      rebuildLayouts();
      layout = currentLayout();
      if (anchor && layout) cameraX = destination(anchor, layout).x;
      clampCamera();
      requestDraw();
    }

    function pan(step)
    {
      cameraX += (Number(step) || 0) * width / Math.max(1, pixelsPerUnit());
      clampCamera();
      requestDraw();
    }

    /* A pointer click on an already selected session is reported as "again" so the host can toggle its detail panel. */
    function clickActor(id)
    {
      selectActor(id, { notify: true, again: selectedId === id });
    }

    function clearSelection()
    {
      if (selectedId === null) return;
      selectedId = null;
      selectedAt = 0;
      markSessionIndex();
      requestDraw();
    }

    /* A tap on empty stage lets go of the selection, like an empty click on the graph; the host decides what that closes. */
    function releaseSelection()
    {
      if (selectedId === null) return;
      clearSelection();
      if (typeof options.onDeselect === 'function') options.onDeselect();
    }

    function selectActor(id, settings)
    {
      settings = settings || {};
      if (id === null || id === undefined)
      {
        clearSelection();
        return true;
      }
      if (!office || !office.actorById.has(id)) return false;
      var actor = office.actorById.get(id);
      if (floorId !== actor.floorId) setFloor(actor.floorId, { animate: false });
      if (selectedId !== id) selectedAt = now();
      selectedId = id;
      markSessionIndex();
      if (settings.focus)
      {
        var seat = destination(actor, currentLayout());
        if (seat) cameraX = seat.x;
        clampCamera();
      }
      requestDraw();
      if (settings.notify && typeof options.onSelect === 'function') options.onSelect(id, { again: !!settings.again });
      return true;
    }

    function observe(edges, settings)
    {
      settings = settings || {};
      if (!office || destroyed || typeof WasOfficeModel === 'undefined' || !WasOfficeModel.createCall) return 0;
      var count = 0;
      (edges || []).forEach(function (edge)
      {
        var key = observationKey(edge);
        if (!key || !observationAllowed(edge) || !settings.replay && seen.has(key)) return;
        if (!settings.replay) seen.add(key);
        if (!motionAllowed()) return;
        var call = WasOfficeModel.createCall(edge, office, { startedAt: now(), replay: !!settings.replay, duration: 5000 });
        if (!call) return;
        calls.push(call);
        count += 1;
      });
      if (count) requestDraw();
      return count;
    }

    function stopReplay()
    {
      calls = calls.filter(function (call) { return !call.replay; });
      lastTravel = '';
      requestDraw();
    }

    function setVisible(value)
    {
      var next = !!value;
      if (visible === next)
      {
        if (next) resize();
        return;
      }
      visible = next;
      root.hidden = !visible;
      if (!visible)
      {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        calls = [];
        transitions.clear();
      }
      else
      {
        resize();
        requestDraw();
      }
    }

    function setMotion(value)
    {
      var next = !!value;
      if (motion === next) return;
      motion = next;
      if (!motion)
      {
        calls = [];
        transitions.clear();
      }
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      requestDraw();
    }

    function resize()
    {
      if (destroyed) return;
      var bounds = container.getBoundingClientRect();
      var nextWidth = Math.max(1, Math.round(bounds.width));
      var nextHeight = Math.max(1, Math.round(bounds.height));
      var nextRatio = clamp(Number(typeof devicePixelRatio === 'undefined' ? 1 : devicePixelRatio) || 1, 1, 2);
      var changed = width !== nextWidth || height !== nextHeight || ratio !== nextRatio;
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
      var backingWidth = Math.round(width * ratio);
      var backingHeight = Math.round(height * ratio);
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      if (changed)
      {
        rebuildLayouts();
        reconcileLabels();
        var layout = currentLayout();
        var actor = selectedId && office && office.actorById.get(selectedId);
        if (actor && layout)
        {
          var seat = destination(actor, layout);
          if (seat) cameraX = seat.x;
        }
        clampCamera();
        requestDraw();
      }
    }

    function eventPoint(event)
    {
      var bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    function pick(point)
    {
      var result = null;
      hitRegions.forEach(function (region)
      {
        if (Math.abs(point.x - region.x) <= region.radius && point.y >= region.top && point.y <= region.bottom) result = region.id;
      });
      return result;
    }

    function didPointerDown(event)
    {
      if (event.button !== 0 && typeof event.button !== 'undefined') return;
      var point = eventPoint(event);
      drag = { id: event.pointerId, startX: point.x, lastX: point.x, moved: false };
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      root.classList.add('was-office-dragging');
    }

    function didPointerMove(event)
    {
      var point = eventPoint(event);
      if (!drag || drag.id !== event.pointerId)
      {
        canvas.style.cursor = pick(point) ? 'pointer' : 'grab';
        return;
      }
      if (Math.abs(point.x - drag.startX) > 4) drag.moved = true;
      if (drag.moved)
      {
        cameraX -= (point.x - drag.lastX) / Math.max(1, pixelsPerUnit());
        clampCamera();
        requestDraw();
      }
      drag.lastX = point.x;
    }

    function didPointerUp(event)
    {
      if (!drag || drag.id !== event.pointerId) return;
      var clicked = !drag.moved && event.type !== 'pointercancel';
      drag = null;
      root.classList.remove('was-office-dragging');
      if (!clicked) return;
      var id = pick(eventPoint(event));
      if (id) clickActor(id);
      else releaseSelection();
    }

    function didWheel(event)
    {
      event.preventDefault();
      if (event.shiftKey)
      {
        wheelFloor(event);
        return;
      }
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      cameraX += delta / Math.max(1, pixelsPerUnit());
      clampCamera();
      requestDraw();
    }

    function didKeyDown(event)
    {
      if (!office) return;
      if (event.key === 'Home') { event.preventDefault(); fit(); return; }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); return; }
      if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var layout = currentLayout();
      if (!layout || !layout.actors.length) return;
      var ordered = layout.actors.slice().sort(function (first, second) { return destination(first, layout).x - destination(second, layout).x; });
      var index = ordered.findIndex(function (actor) { return actor.id === selectedId; });
      var next = clamp(index < 0 ? 0 : index + (event.key === 'ArrowLeft' ? -1 : 1), 0, ordered.length - 1);
      selectActor(ordered[next].id, { focus: true, notify: true });
    }

    function didVisibilityChange()
    {
      if (document.hidden)
      {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        calls = [];
        transitions.clear();
      }
      else requestDraw();
    }

    function didFocusChange()
    {
      focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      if (focused) requestDraw();
    }

    function didReducedMotionChange(event)
    {
      reduced = !!event.matches;
      if (reduced)
      {
        calls = [];
        transitions.clear();
      }
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      requestDraw();
    }

    function getState()
    {
      var layout = currentLayout();
      return { mode: '2d', renderer: gl ? 'webgl-characters' : 'unavailable', floorId: floorId, selectedId: selectedId,
        zoom: zoomValue, panX: cameraX, cameraX: cameraX, fixedCamera: true, pitch: PITCH, yaw: 0,
        calls: calls.length, journeys: calls.length, replaying: calls.some(function (call) { return call.replay; }),
        webglAvailable: !!gl, shadows: !!(shadow && shadow.enabled), meshCount: meshes.size, bufferCount: buffers.length, drawItems: itemCount,
        actorCount: layout ? layout.actors.length : 0, visibleActorCount: renderedActors.length,
        visibleActorIds: renderedActors.slice(), width: width, height: height, frameCount: frameCount, pendingFrame: frame !== null,
        positions: Array.from(positions.entries()).map(function (entry) { return { id: entry[0], x: entry[1].x, z: entry[1].z, seated: entry[1].seated, zone: entry[1].zone }; }),
        facings: Array.from(facings.entries()).map(function (entry) { return { id: entry[0], yaw: entry[1].yaw }; }),
        visible: visible, motion: motion && !reduced, destroyed: destroyed };
    }

    function destroy()
    {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (agingTimer !== null && typeof clearTimeout === 'function') clearTimeout(agingTimer);
      agingTimer = null;
      if (resizeObserver) resizeObserver.disconnect();
      listeners.forEach(function (entry) { entry.target.removeEventListener(entry.event, entry.callback, entry.settings); });
      listeners = [];
      if (media && !media.removeEventListener && media.removeListener) media.removeListener(didReducedMotionChange);
      releaseGraphics();
      root.remove();
      container.classList.remove('was-office-viewport');
      if (suppliedCanvas) suppliedCanvas.style.display = originalDisplay;
      labels.clear();
      indexItems.clear();
      layouts.clear();
      palettes.clear();
      tops.clear();
      facings.clear();
      transitions.clear();
      positions.clear();
      calls = [];
      seen.clear();
      items = [];
    }

    initializeGraphics();
    listen(canvas, 'pointerdown', didPointerDown);
    listen(canvas, 'pointermove', didPointerMove);
    listen(canvas, 'pointerup', didPointerUp);
    listen(canvas, 'pointercancel', didPointerUp);
    listen(canvas, 'wheel', didWheel, { passive: false });
    listen(canvas, 'keydown', didKeyDown);
    listen(root, 'animationend', function (event)
    {
      if (/^was-office-floor/.test(event.animationName || '')) root.classList.remove('was-office-floor-up', 'was-office-floor-down');
    });
    listen(canvas, 'dblclick', fit);
    listen(canvas, 'contextmenu', function (event) { event.preventDefault(); });
    listen(canvas, 'webglcontextlost', function (event)
    {
      event.preventDefault();
      contextLost = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      showFallback('context');
    });
    listen(canvas, 'webglcontextrestored', function ()
    {
      contextLost = false;
      buffers = [];
      meshes.clear();
      programs = null;
      shadow = null;
      initializeGraphics();
      requestDraw();
    });
    listen(document, 'visibilitychange', didVisibilityChange);
    if (typeof window !== 'undefined')
    {
      listen(window, 'focus', didFocusChange);
      listen(window, 'blur', didFocusChange);
    }
    if (media && media.addEventListener) listen(media, 'change', didReducedMotionChange);
    else if (media && media.addListener) media.addListener(didReducedMotionChange);
    if (typeof ResizeObserver === 'function')
    {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
    }
    else if (typeof window !== 'undefined') listen(window, 'resize', resize);
    resize();
    requestDraw();

    return { setOffice: setOffice, setPartners: setPartners, setFloor: setFloor, setMode: function () { return '2d'; }, observe: observe,
      stopReplay: stopReplay, setVisible: setVisible, setMotion: setMotion, fit: fit, zoom: zoom, pan: pan,
      select: function (id, settings) { return selectActor(id, settings || {}); }, resize: resize, getState: getState, refreshText: refreshText, destroy: destroy };
  }

  WasOfficeScene = { create: create, layoutFloor: layoutFloor, stageMatrix: stageMatrix, project: project, lightMatrix: lightMatrix,
    partMatrix: partMatrix, statusText: statusText, statusKey: statusKey, activityText: activityText, isResting: resting,
    labelHeight: LABEL_HEIGHT, labelGap: LABEL_GAP, characterScale: CHARACTER_SCALE };
  if (typeof module !== 'undefined' && module.exports) module.exports = WasOfficeScene;
}());
