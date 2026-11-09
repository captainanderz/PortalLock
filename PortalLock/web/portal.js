'use strict';
/* global VS_FULL, FS_IMAGE, VS_SPRITE, FS_SPRITE, VS_PORTAL, FS_PORTAL, VS_PART, FS_PART, FS_FADE */

const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
const host = window.chrome && window.chrome.webview;
const send = m => host ? host.postMessage(m) : (window.onPortalMessage && window.onPortalMessage(m));

// ---------------------------------------------------------------- GL plumbing
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(vs, fs, attrib) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  if (attrib) gl.bindAttribLocation(p, 0, attrib);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}
function use(pr, uniforms) {
  gl.useProgram(pr.p);
  for (const k in uniforms) {
    const loc = pr.u[k], v = uniforms[k];
    if (!loc) continue;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
  }
}
function makeTex(bytes, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const P_IMG = program(VS_FULL, FS_IMAGE);
const P_SPR = program(VS_SPRITE, FS_SPRITE, 'aPos');
const P_POR = program(VS_PORTAL, FS_PORTAL, 'aPos');
const P_PAR = program(VS_PART, FS_PART, 'aSeed');
const P_FADE = program(VS_FULL, FS_FADE);

const emptyVao = gl.createVertexArray();
const quadVao = gl.createVertexArray();
gl.bindVertexArray(quadVao);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const NPART = 700;
const partVao = gl.createVertexArray();
gl.bindVertexArray(partVao);
const seeds = new Float32Array(NPART * 4);
for (let i = 0; i < NPART; i++) {
  seeds.set([Math.random() * Math.PI * 2, 1.15 + Math.pow(Math.random(), 1.5) * 3.2,
             0.22 + Math.random() * 0.45, Math.random()], i * 4);
}
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// ---------------------------------------------------------------- scene state
const S = {
  mode: null, started: false, t0: null, t: 0, speed: 1,
  vw: 1, vh: 1, P: [0, 0], R0: [1, 1],
  shot: null, bg: null, wins: [], layersT: null,
};

function clearScene() {
  new Set([S.shot, S.bg, ...S.wins.map(w => w.tex)]).forEach(t => t && gl.deleteTexture(t));
  Object.assign(S, { shot: null, bg: null, wins: [], layersT: null, started: false, t0: null, t: 0 });
}

function drawBlack() {
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/** A batch of images arrived (one shared buffer). part: 'shot' | 'layers' | 'all'. */
function onScene(meta, buffer) {
  if (meta.part !== 'layers') {
    clearScene();
    S.mode = meta.mode;
    S.vw = meta.vw; S.vh = meta.vh;
    if (cv.width !== meta.vw || cv.height !== meta.vh) { cv.width = meta.vw; cv.height = meta.vh; }
    S.P = [meta.px, meta.py];
    S.R0 = [meta.rx, meta.ry];
  } else if (S.mode !== 'outro') {
    return; // stale layers for a show that was cancelled
  }
  for (const im of meta.images) {
    const tex = makeTex(new Uint8Array(buffer, im.off, im.w * im.h * 4), im.w, im.h);
    if (im.kind === 'shot') S.shot = tex;
    else if (im.kind === 'bg') S.bg = tex;
    else S.wins.push({ tex, w: im.w, h: im.h, cx: im.x + im.w / 2, cy: im.y + im.h / 2, r: im.r });
  }
  if (meta.part === 'shot') {
    render(0);
    requestAnimationFrame(() => send('frame'));
  } else if (meta.part === 'layers') {
    S.layersT = S.started ? S.t : 0;
  } else {
    S.layersT = 0;
    start();
  }
}

function start() {
  if (S.started || !S.mode) return;
  S.started = true;
  S.t0 = null;
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!S.started) return;
  if (S.t0 === null) S.t0 = now;
  const st = render((now - S.t0) / 1000 * S.speed);
  if (st.done) {
    S.started = false;
    send(S.mode + 'Done');
    return;
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- timing helpers
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
const easeInCubic = x => x * x * x;
const easeOutBack = (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
const bell = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
const shakeAmt = (t, t0, dur, amp) => (t >= t0 && t < t0 + dur) ? amp * (1 - (t - t0) / dur) : 0;

/** Portal tears open: a vertical crack first, then it widens. */
function portalOpen(t, t0) {
  return [S.R0[0] * easeOutBack(clamp01((t - t0 - 0.17) / 0.55)),
          S.R0[1] * easeOutCubic(clamp01((t - t0) / 0.3))];
}

/** Where a window is at path progress e (0 = home, 1 = gone into the portal, <0 = overshoot). */
function pose(w, e, jit) {
  const [Px, Py] = S.P;
  const dx = w.cx - Px, dy = w.cy - Py;
  const r0 = Math.hypot(dx, dy) || 1, th0 = Math.atan2(dy, dx);
  const ec = Math.min(e, 1);
  const r = ec >= 0 ? r0 * (1 - ec) : r0 + -ec * Math.min(r0, 400);
  const Rs = S.R0[1] * 2.6;                       // inside this radius windows start to orbit
  const zone = x => { const z = clamp01(1 - x / Rs); return z * z; };
  const th = th0 - (zone(r) - zone(r0)) * 2.4;
  const bow = Math.sin(Math.PI * clamp01(ec)) * Math.min(0.1 * r0, 180);
  const pos = Math.max(ec, 0);
  return {
    cx: Px + Math.cos(th) * r - Math.sin(th0) * bow + jit[0],
    cy: Py + Math.sin(th) * r + Math.cos(th0) * bow + jit[1],
    scale: ec >= 0 ? Math.pow(1 - ec, 1.25) : 1 + -ec * 0.25,
    rot: -Math.pow(pos, 2.2) * 4.2 + jit[2],
    tint: smooth(0.05, 0.7, ec),
    alpha: 1 - smooth(0.82, 1.0, ec),
    shadow: 1 - smooth(0.0, 0.25, Math.abs(ec)),
  };
}

// ---------------------------------------------------------------- the two shows
function outroState(t) {
  const st = { v: 0, dim: 0.42 * smooth(0.15, 1.3, t), shotMix: 1, black: 0, screenFlash: 0,
               flash: bell(t, 0.22, 0.12) * 0.7, flow: 1, done: false, poses: [] };
  const [rx, ry] = portalOpen(t, 0.15);
  let shake = shakeAmt(t, 0.15, 0.5, 5), k = 1;
  if (S.layersT !== null) {
    const N = S.wins.length, tl = S.layersT;
    const W0 = Math.max(0.9, tl + 0.35), s = Math.min(0.2, 1.8 / Math.max(N, 1));
    const fadeAt = Math.max(tl, 0.45);
    st.shotMix = 1 - smooth(fadeAt, fadeAt + 0.35, t);
    for (let i = 0; i < N; i++) {           // i = 0 is the topmost window: it goes first
      const tau = t - (W0 + i * s);
      let e = 0, jit = [0, 0, 0];
      if (tau > 0 && tau < 0.28) {            // tremble and lean back before being yanked
        const a = 3.5 * tau / 0.28;
        jit = [a * Math.sin(t * 97 + i * 1.7), a * Math.cos(t * 83 + i * 2.3), a * 0.0015 * Math.sin(t * 61 + i)];
        e = -0.02 * Math.sin(Math.PI * tau / 0.28);
      } else if (tau >= 0.28) {
        e = Math.pow(clamp01((tau - 0.28) / 0.9), 2.4);
      }
      st.poses[i] = e >= 1 ? null : pose(S.wins[i], e, jit);
    }
    const WE = N ? W0 + (N - 1) * s + 1.18 : W0 + 0.3;
    const VS = Math.max(WE - 0.35, W0 + 0.5);
    st.v = easeInCubic(clamp01((t - VS) / 1.3));
    const C0 = VS + 1.15;                     // portal collapses
    k = 1 - easeInCubic(clamp01((t - C0) / 0.35));
    st.flash += bell(t, C0 + 0.3, 0.12) * 2.0;
    st.screenFlash = bell(t, C0 + 0.34, 0.1) * 0.55;
    shake += shakeAmt(t, C0 - 0.1, 0.5, 9);
    st.black = smooth(C0 + 0.28, C0 + 0.5, t);
    st.done = t > C0 + 0.62;
  }
  return finishState(st, rx * k, ry * k, shake);
}

function introState(t) {
  const N = S.wins.length;
  const st = { flow: -1, black: 0, screenFlash: 0, flash: bell(t, 0.22, 0.12) * 0.9, poses: [] };
  const [rx, ry] = portalOpen(t, 0.15);
  const shake = shakeAmt(t, 0.15, 0.5, 5);
  st.v = 1 - easeOutCubic(clamp01((t - 0.5) / 1.3));   // desktop spirals back out
  const W0 = 1.05, s = Math.min(0.13, 1.4 / Math.max(N, 1));
  for (let i = 0; i < N; i++) {             // bottom window first, topmost lands last
    const tau = t - (W0 + (N - 1 - i) * s);
    st.poses[i] = tau <= 0 ? null : pose(S.wins[i], 1 - easeOutBack(clamp01(tau / 0.8), 1.4), [0, 0, 0]);
  }
  const land = N ? W0 + (N - 1) * s + 0.8 : 1.6;
  const C0 = Math.max(land - 0.05, 1.9);
  const k = 1 - easeInCubic(clamp01((t - C0) / 0.4));
  st.dim = 0.42 * (1 - smooth(C0 - 0.2, C0 + 0.4, t));
  st.shotMix = smooth(C0 + 0.3, C0 + 0.55, t); // hand over to the live desktop
  st.done = t > C0 + 0.62;
  return finishState(st, rx * k, ry * k, shake);
}

function finishState(st, rx, ry, shake) {
  st.ry = ry;
  st.rx = Math.max(rx, ry > 1 ? 3 : 0);       // never thinner than a glowing crack
  st.amt = clamp01(ry / S.R0[1]) * clamp01(st.rx / S.R0[0] * 1.5);
  st.shake = shake;
  return st;
}

// ---------------------------------------------------------------- drawing
function render(t) {
  S.t = t;
  const st = S.mode === 'intro' ? introState(t) : outroState(t);
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const res = [S.vw, S.vh], buf = [W, H];
  const sh = [st.shake * Math.sin(t * 71), st.shake * Math.cos(t * 53)];
  const P = [S.P[0] + sh[0], S.P[1] + sh[1]];
  const open = clamp01(st.ry / S.R0[1]);

  gl.viewport(0, 0, W, H);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha everywhere
  gl.activeTexture(gl.TEXTURE0);

  const image = (tex, v, alpha) => {
    gl.bindVertexArray(emptyVao);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    use(P_IMG, { uRes: res, uBuf: buf, uP: S.P, uShake: [-sh[0], -sh[1]], uV: v, uAlpha: alpha,
                 uDim: st.dim, uAmb: open, uRy: S.R0[1] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const bgTex = S.bg || S.shot;
  if (S.layersT !== null && st.shotMix < 1 && bgTex) image(bgTex, st.v, 1);

  gl.bindVertexArray(quadVao);
  for (let i = S.wins.length - 1; i >= 0; i--) {
    const p = st.poses[i], w = S.wins[i];
    if (!p || p.alpha <= 0.001 || p.scale <= 0.001) continue;
    gl.bindTexture(gl.TEXTURE_2D, w.tex);
    use(P_SPR, { uRes: res, uC: [p.cx + sh[0], p.cy + sh[1]], uSize: [w.w, w.h], uRot: p.rot,
                 uScale: p.scale, uMargin: 30, uRadius: w.r, uAlpha: p.alpha, uTint: p.tint,
                 uShadow: p.shadow, uTime: t });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  if (st.shotMix > 0 && S.shot) image(S.shot, 0, st.shotMix);

  if (st.ry > 0.5 || st.flash > 0.01) {
    gl.bindVertexArray(quadVao);
    use(P_POR, { uRes: res, uP: P, uHalf: [S.R0[0] * 2.9, S.R0[1] * 2.9], uR: [st.rx, st.ry], uR0: S.R0,
                 uTime: t, uFlow: st.flow, uFlash: st.flash, uVis: clamp01(open * 4) });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  if (st.amt > 0.01) {
    gl.bindVertexArray(partVao);
    use(P_PAR, { uRes: res, uBuf: buf, uP: P, uR0: S.R0, uTime: t, uFlow: st.flow, uAmt: st.amt });
    gl.drawArrays(gl.POINTS, 0, NPART);
  }

  gl.bindVertexArray(emptyVao);
  if (st.black > 0) {
    use(P_FADE, { uC: [0, 0, 0, st.black] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (st.screenFlash > 0.003) {
    const f = st.screenFlash;
    use(P_FADE, { uC: [0.55 * f, 0.9 * f, 0.45 * f, 0] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  return st;
}

// ---------------------------------------------------------------- host bridge
if (host) {
  host.addEventListener('sharedbufferreceived', e => {
    const buffer = e.getBuffer();
    try {
      const meta = typeof e.additionalData === 'string' ? JSON.parse(e.additionalData) : e.additionalData;
      onScene(meta, buffer);
    } catch (err) {
      send('error: ' + err.message);
    } finally {
      host.releaseBuffer(buffer);
      send('loaded');
    }
  });
  host.addEventListener('message', e => {
    const m = e.data || {};
    if (m.cmd === 'go') start();
    else if (m.cmd === 'black' || m.cmd === 'abort') {
      clearScene();
      S.mode = null;
      drawBlack();
      if (m.cmd === 'black') requestAnimationFrame(() => send('frame'));
    }
  });
}
drawBlack();
send('ready');
