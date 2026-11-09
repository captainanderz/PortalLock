'use strict';
// All positions are in "virtual pixels": (0,0) = top-left of the whole multi-monitor desktop.

const VS_FULL = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

// Desktop image (screenshot or wallpaper layer). uV = how far it has been sucked into the portal.
const FS_IMAGE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes, uBuf, uP, uShake;
uniform float uV, uAlpha, uDim, uAmb, uRy;
out vec4 o;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uRes / uBuf) + uShake;
  vec2 d = px - uP;
  float r = length(d);
  vec2 src = px;
  if (uV > 0.0) {
    // Contract toward the portal, the middle first, and twist like a drain: hard near, gentle far.
    float ve = min(uV * (1.0 + 0.5 * exp(-r / (uRy * 3.0))), 0.9999);
    float f = pow(1.0 - ve, 2.2);
    float tw = uV * 8.0 * uRy / (r + uRy * 0.6) + uV * uV * 0.6;
    float s = sin(tw), c = cos(tw);
    src = uP + mat2(c, s, -s, c) * d / f;
  }
  vec3 col = texture(uTex, src / uRes).bgr;              // pixels arrive as BGRA
  col *= step(0.0, src.x) * step(0.0, src.y) * step(src.x, uRes.x) * step(src.y, uRes.y);
  col *= (1.0 - uDim) * (1.0 - 0.55 * uV);
  col += vec3(0.22, 0.9, 0.1) * uAmb * exp(-r / (uRy * 2.2)) * 0.35;
  o = vec4(col * uAlpha, uAlpha);
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

const NOISE = `
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}`;

const FS_PORTAL = `#version 300 es
precision highp float;
uniform vec2 uR, uR0;
uniform float uTime, uFlow, uFlash, uVis;
in vec2 vL;
out vec4 o;
${NOISE}
void main() {
  vec2 q = vL / max(uR, vec2(1.0));
  float e = length(q);
  float ang = atan(q.y, q.x);
  float lr = log(max(e, 0.02));
  float a = ang - uTime * 1.7 + lr * 2.6;                       // logarithmic spiral
  float n = fbm(vec3(cos(a) * 1.6, sin(a) * 1.6, lr * 1.4 + uTime * 0.9 * uFlow));
  float arms = 0.5 + 0.5 * sin(a * 3.0 + n * 5.0);

  float edgeN = fbm(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uTime * 1.5)) - 0.5;
  float eb = e + edgeN * 0.10;
  float inside = 1.0 - smoothstep(0.97, 1.0, eb);

  vec3 cDark = vec3(0.01, 0.04, 0.01), cMid = vec3(0.20, 0.85, 0.10), cHot = vec3(0.80, 1.0, 0.45);
  float energy = smoothstep(0.12, 1.0, e) * (0.35 + 1.05 * arms * n);
  vec3 col = mix(cDark, cMid, clamp(energy, 0.0, 1.0));
  col += cHot * pow(clamp(e, 0.0, 1.0), 8.0) * (0.6 + 0.6 * n);
  col += cHot * 0.3 * pow(arms * n, 3.0) * smoothstep(0.2, 0.9, e);
  col *= mix(0.12, 1.0, smoothstep(0.0, 0.55, e));              // deep, dark core

  float rim = exp(-pow((eb - 1.0) / 0.035, 2.0));
  float outer = max(eb - 1.0, 0.0);
  float tendrils = fbm(vec3(cos(ang) * 2.0, sin(ang) * 2.0, uTime * 0.8 - outer * 3.0));
  float glow = exp(-outer * 3.2) * (0.3 + 0.9 * tendrils) * (1.0 - inside);
  vec3 emit = cHot * rim * 1.4 + cMid * glow * 0.85;

  vec2 q0 = vL / uR0;                                           // flash uses the full-size radius
  vec3 flash = vec3(0.85, 1.0, 0.75) * uFlash * exp(-dot(q0, q0) * 0.9);

  float alpha = inside * 0.97 * uVis;
  o = vec4(col * alpha + emit * uVis + flash, alpha);
}`;

// Fel mist spiralling into the sealed crack: the lock screen picture, the screensaver, and the
// frame the lock animation ends on. Everything is relative to the portal centre so all three match.
const FS_MIST = `#version 300 es
precision highp float;
uniform vec2 uRes, uBuf, uP, uR0, uShake;
uniform vec4 uFrame; // primary monitor (x, y, w, h), for the vignette
uniform float uTau, uAlpha;
out vec4 o;
${NOISE}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uRes / uBuf) + uShake;
  vec2 d = (px - uP) / uR0.y;
  float r = length(d);
  float ang = atan(d.y, d.x);
  float a = ang + 1.4 * log(r + 0.15) - uTau * 0.12;            // slowly turning spiral arms
  float n = fbm(vec3(cos(a) * r, sin(a) * r, uTau * 0.05) * 0.9);
  float n2 = fbm(vec3(d * 0.7, 3.7 + uTau * 0.03));
  float smoke = pow(clamp(n * 0.75 + n2 * 0.4, 0.0, 1.0), 2.2);
  vec3 fel = vec3(0.16, 0.75, 0.08);
  vec3 col = vec3(0.004, 0.010, 0.005);
  col += fel * smoke * exp(-r * 0.28) * 0.95;
  col += fel * 0.10 * exp(-r * 0.8);                             // ambient glow from the seam
  vec2 e = vec2(d.x / 0.10, d.y / 0.75);
  col += vec3(0.45, 1.0, 0.25) * 0.55 * exp(-dot(e, e));         // bloom hugging the crack
  vec2 uv = (px - uFrame.xy) / uFrame.zw - 0.5;
  col *= 1.0 - smoothstep(0.25, 0.95, length(uv * vec2(uFrame.z / uFrame.w, 1.0)) * 0.9);
  o = vec4(col * uAlpha, uAlpha);
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
