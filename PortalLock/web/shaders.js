'use strict';
// All positions are in "virtual pixels": (0,0) = top-left of the whole multi-monitor desktop.

const VS_FULL = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

// Desktop image (screenshot or wallpaper layer), dimmed while the gate stands and lit green near the portal.
const FS_IMAGE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes, uBuf, uP, uShake;
uniform float uAlpha, uDim, uAmb, uRy;
out vec4 o;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uRes / uBuf) + uShake;
  float r = length(px - uP);
  vec3 col = texture(uTex, px / uRes).bgr;               // pixels arrive as BGRA
  col *= 1.0 - uDim;
  col += vec3(0.22, 0.9, 0.1) * uAmb * exp(-r / (uRy * 2.2)) * 0.35;
  o = vec4(col, 1.0) * uAlpha;
}`;

// One window, drawn as a rounded rectangle with a soft shadow.
const VS_SPRITE = `#version 300 es
in vec2 aPos;
uniform vec2 uRes, uC, uSize;
uniform float uRot, uScale, uMargin;
out vec2 vL;
void main() {
  vec2 l = aPos * (uSize + 2.0 * uMargin);
  vL = l;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = uC + mat2(c, s, -s, c) * (l * uScale);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FS_SPRITE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uRadius, uAlpha, uTint, uShadow, uTime;
in vec2 vL;
out vec4 o;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float d = sdRoundBox(vL, uSize * 0.5, uRadius);
  float inA = clamp(0.5 - d, 0.0, 1.0);
  vec3 col = texture(uTex, clamp(vL / uSize + 0.5, 0.0, 1.0)).bgr;
  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  vec3 fel = vec3(0.22, 0.95, 0.12);
  col = mix(col, fel * (0.2 + 1.2 * lum), uTint * 0.85);
  // crackling fel energy along the edge while it is being pulled
  float crackle = 0.6 + 0.4 * sin(uTime * 37.0 + (vL.x + vL.y) * 0.05);
  col += vec3(0.7, 1.0, 0.4) * uTint * exp(-abs(d) / 7.0) * crackle;
  float a = inA * uAlpha;
  float sh = uShadow * 0.4 * (1.0 - smoothstep(-8.0, 28.0, d)) * (1.0 - inA) * uAlpha;
  o = vec4(col * a, a + sh);
}`;

// The portal itself, drawn on a quad around its centre.
const VS_PORTAL = `#version 300 es
in vec2 aPos;
uniform vec2 uRes, uP, uHalf;
out vec2 vL;
void main() {
  vL = aPos * 2.0 * uHalf;
  vec2 p = uP + vL;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- the gate
// The Dark Portal in 3D: the stone gate and the green swirl that fills it, converted from the game's
// models by tools/convert-gate.ps1 (GATE, in gate.js, says what is where). Each frame it is drawn into
// a picture of its own, with a depth buffer and smoothed edges, and that picture is laid into the
// scene like any other layer. Model space: x sideways, y up, z towards the viewer.
const glsl = a => a.map(v => v.toFixed(3)).join(', ');
const GATE_COMMON = `
// The middle of the swirl.
const vec3 PC = vec3(${glsl([(GATE.portal[0] + GATE.portal[3]) / 2, (GATE.portal[1] + GATE.portal[4]) / 2, GATE.portal[2]])});
float gh(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gvn(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), f.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), f.x), f.y);
}
// How far up the gate a point is: 0 at its foot, 1 at the tips of its horns.
float gateUp(vec3 p) { return (p.y - (${glsl([GATE.box[1]])})) / ${glsl([GATE.box[4] - GATE.box[1]])}; }
// > 0 where the stone is solid. The gate is conjured from the bottom up (build 0 -> 1) and burns
// away from the top down (build 1 -> 0), along a ragged front.
float gateFront(vec3 p, float build) {
  vec2 q = vec2(p.x + p.z * 0.6, p.y) * 0.01;
  float n = gvn(q * 4.0) * 0.6 + gvn(q * 9.0 + 3.7) * 0.3 + gvn(q * 24.0 + 1.3) * 0.1;
  return build * 1.45 - 0.2 - (gateUp(p) + (n - 0.5) * 0.3);
}`;

const VS_STONE = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec2 aLight;
uniform mat4 uVP;
out vec3 vP, vN;
out vec2 vUV, vLight;
void main() {
  vP = aPos; vN = aNorm; vUV = vec2(aUV.x, 1.0 - aUV.y); vLight = vec2(aLight.x, 1.0 - aLight.y);
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

// The stone. Its light from the sky and from the key light (upper left, in front), with the shadows
// they leave, was baked into uLight by tools/convert-gate.py. The swirl's steady glow does not light
// the stone; only its flashes do.
const FS_STONE = `#version 300 es
precision highp float;
uniform sampler2D uTex, uLight;
uniform vec3 uFlash; // a flash from the swirl: its colour, black when there is none
uniform float uBuild;
in vec3 vP, vN;
in vec2 vUV, vLight;
out vec4 o;
${GATE_COMMON}
void main() {
  float m = gateFront(vP, uBuild);
  if (m < 0.0) discard;
  vec3 alb = texture(uTex, vUV).rgb;
  vec3 N = normalize(gl_FrontFacing ? vN : -vN);
  vec2 lit = texture(uLight, vLight).rg; // how much sky this bit of stone sees, and the key light on it
  vec3 col = alb * (vec3(0.50, 0.53, 0.66) * lit.r * 1.3 + vec3(0.15, 0.11, 0.13)); // sky, and a little bounce
  col += alb * vec3(1.0, 0.92, 0.84) * lit.g * 0.85;
  // A flash washes over the stone from the front of the opening, far enough from any of it to stay soft.
  vec3 L = PC + vec3(0.0, 0.0, 60.0) - vP;
  float d2 = dot(L, L);
  col += alb * uFlash * max(dot(N, L * inversesqrt(d2)) * 0.6 + 0.4, 0.0) / (1.0 + d2 / 20000.0);
  // The fire that conjures it.
  col += vec3(0.62, 1.0, 0.36) * exp(-m / 0.02) * 2.0;
  o = vec4(col, 1.0);
}`;

// One part of the swirl. The swirl is never shut: it is conjured and burns away with the stone round it.
const VS_SWIRL = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUV;
uniform mat4 uVP;
uniform vec2 uScroll;
out vec3 vP;
out vec2 vUV;
void main() {
  vP = aPos;
  vUV = vec2(aUV.x, 1.0 - aUV.y) + uScroll;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_SWIRL = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uTint;   // colour and strength
uniform float uCover; // 1 = it covers what is behind it, 0 = it adds its light to that
uniform float uBuild;
in vec3 vP;
in vec2 vUV;
out vec4 o;
${GATE_COMMON}
void main() {
  float m = gateFront(vP, uBuild);
  if (m < 0.0) discard;
  vec4 t = texture(uTex, vUV);
  vec3 c = t.rgb * uTint.rgb * uTint.a;
  o = uCover > 0.0 ? vec4(c + vec3(0.62, 1.0, 0.36) * exp(-m / 0.02) * 2.0, 1.0) : vec4(c * t.a, 0.0);
}`;

// Lays the gate's picture into the scene. uRect: where, in desktop pixels.
const VS_LAYER = `#version 300 es
in vec2 aPos;
uniform vec2 uRes;
uniform vec4 uRect;
out vec2 vUV;
void main() {
  vUV = vec2(aPos.x + 0.5, 0.5 - aPos.y);
  vec2 p = uRect.xy + (aPos + 0.5) * uRect.zw;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FS_LAYER = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uTex, vUV); }`;

// A burst of fel light behind the gate, on a quad round the middle of its opening.
const FS_FLASH = `#version 300 es
precision highp float;
uniform vec2 uR0;
uniform float uFlash;
in vec2 vL;
out vec4 o;
void main() {
  vec2 q = vL / uR0;
  o = vec4(vec3(0.85, 1.0, 0.75) * uFlash * exp(-dot(q, q) * 0.9), 0.0);
}`;

// The sky behind it all: the Hellfire sky, drawn round the camera. One of its parts at a time; uMode says
// how that part goes onto what is already there (0 covers it, 1 lies over it, 2 adds its light to it).
const VS_SKY = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUV;
uniform mat4 uVP;
uniform vec2 uScroll;
out vec2 vUV;
void main() {
  vUV = vec2(aUV.x, 1.0 - aUV.y) + uScroll;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_SKY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uMode, uStrength, uAlpha; // uAlpha: how far the whole sky has faded in
in vec2 vUV;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUV);
  float a = uMode < 0.5 ? 1.0 : t.a * uStrength;
  o = vec4(t.rgb * a, uMode > 1.5 ? 0.0 : a) * uAlpha;
}`;

// Sparks spiralling into (or out of) the portal.
const VS_PART = `#version 300 es
in vec4 aSeed; // angle, start radius (in portal radii), speed, phase
uniform vec2 uRes, uBuf, uP, uR0;
uniform float uTime, uFlow, uAmt;
out float vB;
void main() {
  float life = fract(aSeed.w + uTime * aSeed.z);
  float l = uFlow > 0.0 ? life : 1.0 - life;
  float rr = mix(aSeed.y, 0.12, pow(l, 1.6));
  float ang = aSeed.x - 2.2 * (1.0 / (rr + 0.35) - 1.0 / (aSeed.y + 0.35));
  vec2 p = uP + vec2(cos(ang) * uR0.x, sin(ang) * uR0.y) * rr;
  vB = uAmt * smoothstep(0.0, 0.15, life) * smoothstep(1.0, 0.8, life) * smoothstep(0.1, 0.7, rr);
  gl_PointSize = mix(2.0, 7.0, fract(aSeed.w * 7.13)) * (uBuf.x / uRes.x);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FS_PART = `#version 300 es
precision highp float;
in float vB;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vB;
  o = vec4(vec3(0.75, 1.0, 0.4) * a, 0.0); // purely additive
}`;

// Solid colour over everything (premultiplied).
const FS_FADE = `#version 300 es
precision highp float;
uniform vec4 uC;
out vec4 o;
void main() { o = uC; }`;
