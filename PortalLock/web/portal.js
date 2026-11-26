'use strict';
/* global VS_FULL, FS_IMAGE, VS_SPRITE, FS_SPRITE, VS_PORTAL, FS_FLASH, VS_PART, FS_PART, FS_FADE,
          GATE, VS_STONE, FS_STONE, VS_SWIRL, FS_SWIRL, VS_LAYER, FS_LAYER, VS_SKY, FS_SKY */

const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
const host = window.chrome && window.chrome.webview;
const send = m => host ? host.postMessage(m) : (window.onPortalMessage && window.onPortalMessage(m));
// Two animation frames after drawing, the frame has been composited, not just queued.
const afterShown = fn => requestAnimationFrame(() => requestAnimationFrame(fn));

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
    else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    else if (v.length === 16) gl.uniformMatrix4fv(loc, false, v);
    else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
  }
}
/** A mipmapped texture from raw pixels (w x h of them), or from a loaded picture. repeat: it tiles. */
function makeTex(src, w, h, repeat) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  return t;
}

const P_IMG = program(VS_FULL, FS_IMAGE);
const P_SPR = program(VS_SPRITE, FS_SPRITE, 'aPos');
const P_FLASH = program(VS_PORTAL, FS_FLASH, 'aPos');
const P_PAR = program(VS_PART, FS_PART, 'aSeed');
const P_FADE = program(VS_FULL, FS_FADE);
const P_SKY = program(VS_SKY, FS_SKY);
const P_STONE = program(VS_STONE, FS_STONE);
const P_SWIRL = program(VS_SWIRL, FS_SWIRL);
const P_LAYER = program(VS_LAYER, FS_LAYER, 'aPos');
gl.useProgram(P_STONE.p); gl.uniform1i(P_STONE.u.uLight, 1); // the baked light stays on texture unit 1

// The gate's mesh and textures (see tools/convert-gate.ps1). Nothing is drawn before they have loaded.
// G also holds the off-screen picture the gate is drawn into, and the fit of the gate to the screen.
const G = { vao: null, tex: {}, pos: null, fit: null, w: 0, h: 0, fbo: null, color: null, depth: null, flat: null, out: null };
const gateReady = (async () => {
  const names = [...new Set([...GATE.stone, ...GATE.swirl, ...GATE.sky].map(b => b.tex)), 'light.png'];
  const pictures = Promise.all(names.map(n => new Promise((done, fail) => {
    const im = new Image();
    im.onload = () => done(im);
    im.onerror = () => fail(new Error('gate/' + n + ' did not load'));
    im.src = 'gate/' + n;
  })));
  const res = await fetch('gate/gate.bin');
  if (!res.ok) throw new Error('gate/gate.bin did not load');
  const buf = await res.arrayBuffer();
  const light = (await pictures).pop();
  (await pictures).forEach((im, i) => {
    G.tex[names[i]] = makeTex(im, 0, 0, true);
    // The spiral arms slide sideways only; tiling them upwards too would draw a seam along their rim.
    if (names[i].includes('greenswirl')) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  });
  gl.activeTexture(gl.TEXTURE1);
  makeTex(light);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // its patches must not blur into each other
  gl.activeTexture(gl.TEXTURE0);
  const stride = GATE.floats * 4;
  G.pos = new Float32Array(buf, 0, GATE.verts * GATE.floats);
  G.vao = gl.createVertexArray();
  gl.bindVertexArray(G.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, G.pos, gl.STATIC_DRAW);
  for (const [loc, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 2, 32]]) { // position, normal, uv, light map uv
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(buf, GATE.verts * stride, GATE.indices), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
})();

const emptyVao = gl.createVertexArray();
const quadVao = gl.createVertexArray();
gl.bindVertexArray(quadVao);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

// Seeded so the sparks land in the same places every time: the lock screen picture must match
// the last frame of the lock animation.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261106);
const NPART = 700;
const partVao = gl.createVertexArray();
gl.bindVertexArray(partVao);
const seeds = new Float32Array(NPART * 4);
for (let i = 0; i < NPART; i++) {
  seeds.set([rnd() * Math.PI * 2, 1.15 + Math.pow(rnd(), 1.5) * 3.2, 0.22 + rnd() * 0.45, rnd()], i * 4);
}
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// ---------------------------------------------------------------- scene state
const SEAL_T = 7.3; // the moment the lock screen picture shows
const S = {
  mode: null, started: false, t0: null, t: 0, speed: 1,
  vw: 1, vh: 1, P: [0, 0], R0: [1, 1], F: [0, 0, 1, 1], views: [],
  shot: null, bg: null, wins: [], layersT: null,
  sealT0: null, sealAnim: false, tau0: SEAL_T,
};

function setGeometry(m) {
  S.vw = m.vw; S.vh = m.vh;
  if (cv.width !== m.vw || cv.height !== m.vh) { cv.width = m.vw; cv.height = m.vh; }
  S.F = m.fw ? [m.fx, m.fy, m.fw, m.fh] : [0, 0, m.vw, m.vh];
  S.R0 = [m.rx, m.ry];
  S.views = skyViews(m.screens || [[0, 0, m.vw, m.vh]]);
  fitGate(); // the gate fills the primary monitor; the middle of its opening is the portal's (S.P)
}

// ---------------------------------------------------------------- the gate, in 3D
const mixv = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
/** 4x4 matrices, stored column by column as WebGL wants them. */
function matMul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function matPerspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
}
function matLookAt(eye, at) { // y is up
  const unit = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = unit([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const x = unit([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
/** A point of the model, to where it lands in the picture: x and y from -1 to 1, y up. */
function project(m, p) {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w, (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w];
}

// Where the camera stands, in the model's units. CAM[1] is where every show settles and what the lock
// screen shows; CAM[0] is where it starts from while the gate is conjured.
const CAM = [
  { eye: [-3, 6, 860], at: [-3, 72, -60], fov: 28 },
  { eye: [-3, 22, 700], at: [-3, 70, -60], fov: 28 },
];
// The middle of the gate's opening, between the statues: where the sparks and the windows' spiral are centred.
const OPENING = [-3, 24, -65];

/** Model space to picture space, for a camera pose between CAM[0] (k = 0) and CAM[1] (k = 1). */
function gateCamera(k) {
  const eye = mixv(CAM[0].eye, CAM[1].eye, k), at = mixv(CAM[0].at, CAM[1].at, k);
  const fov = CAM[0].fov + (CAM[1].fov - CAM[0].fov) * k;
  const m = matMul(matPerspective(fov * Math.PI / 180, S.F[2] / S.F[3], 20, 5000), matLookAt(eye, at));
  return G.fit ? matMul(G.fit, m) : m;
}

/** Scales and shifts the settled camera's picture so the gate fills the monitor from top to bottom
 *  (or from side to side on a narrow one), and finds where the middle of its opening lands on the desktop. */
function fitGate() {
  G.fit = null;
  let m = gateCamera(1), x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < GATE.stoneVerts * GATE.floats; i += GATE.floats) {
    const [x, y] = project(m, [G.pos[i], G.pos[i + 1], G.pos[i + 2]]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const s = Math.min(2 / (y1 - y0), 2 / (x1 - x0));
  G.fit = new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, -(x0 + x1) / 2 * s, -(y0 + y1) / 2 * s, 0, 1]);
  const q = project(gateCamera(1), OPENING);
  S.P = [S.F[0] + (q[0] + 1) / 2 * S.F[2], S.F[1] + (1 - q[1]) / 2 * S.F[3]];
}

/** The off-screen picture the gate is drawn into: as big as the primary monitor, edges smoothed. */
function ensureLayer() {
  const w = Math.round(S.F[2]), h = Math.round(S.F[3]);
  if (G.fbo && G.w === w && G.h === h) return;
  [G.color, G.depth].forEach(r => r && gl.deleteRenderbuffer(r));
  if (G.out) gl.deleteTexture(G.out);
  G.w = w; G.h = h;
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
  G.fbo = G.fbo || gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo);
  [G.color, G.depth] = [[gl.RGBA8, gl.COLOR_ATTACHMENT0], [gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT]].map(([format, slot]) => {
    const r = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, r);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, slot, gl.RENDERBUFFER, r);
    return r;
  });
  G.out = gl.createTexture(); // the smoothed result, as a texture
  gl.bindTexture(gl.TEXTURE_2D, G.out);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  G.flat = G.flat || gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.flat);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, G.out, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** How one part of the swirl looks at time tau: its colour and strength, how its texture has slid,
 *  and whether it covers what is behind it. Part numbers are the swirl model's own. Parts 0 to 12,
 *  streaks of bright light that flash along the swirl's edge where it meets the stone, are left out. */
function swirlLook(part, tau) {
  if (part < 13) return null;
  if (part === 15) return { tint: [1, 1, 1, 1], cover: 1 };              // the starry depths behind it all
  if (part === 13) return { tint: [1, 1, 1, 1], slide: -tau / 3.333 };   // the spiral arms, turning
  if (part === 18) return { tint: [1, 1, 1, 1], slide: -tau / 6.667 };   // and a slower ring of them
  if (part === 17) return { tint: [1, 1, 1, 0.5] };                      // the twisting nether, faintly
  return { tint: [1, 1, 1, 1] };                                         // 14 green backdrop, 16 more stars
}

/** Draws the gate into its picture and lays that into the scene, shaken by sh. g: build (0..1 conjured,
 *  swirl and all: the portal is never shut), ignite (0..1; the eyes catch near the end), eyes (how hard
 *  they glow), flash (a burst of light from the swirl), cam (camera pose: 1 = settled). */
function drawGate(c, sh, g, tau) {
  if (g.build <= 0.001) return;
  ensureLayer();
  const vp = gateCamera(g.cam);
  const f = g.ignite * 1.15 - (GATE.eyes[0][1] - GATE.box[1]) / (GATE.box[4] - GATE.box[1]);
  const eyes = f < 0 ? 0 : Math.min(f / 0.04, 1) * (g.eyes * 2 + 3 * Math.exp(-f * f / 0.003));

  gl.bindFramebuffer(gl.FRAMEBUFFER, G.fbo);
  gl.viewport(0, 0, G.w, G.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(G.vao);
  use(P_STONE, { uVP: vp, uBuild: g.build, uFlash: [0.30 * g.flash, 1.0 * g.flash, 0.14 * g.flash] });
  for (const b of GATE.stone) {
    gl.bindTexture(gl.TEXTURE_2D, G.tex[b.tex]);
    gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, b.first * 4);
  }
  // The swirl is light: it is hidden by stone in front of it, but hides nothing itself.
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  for (const b of GATE.swirl) {
    const isEyes = b.part === 19, look = swirlLook(b.part, tau), k = isEyes ? eyes : 1 + 1.2 * g.flash;
    if (!look || k <= 0.001) continue;
    gl.bindTexture(gl.TEXTURE_2D, G.tex[b.tex]);
    use(P_SWIRL, { uVP: vp, uBuild: g.build, uScroll: [look.slide || 0, 0], uCover: look.cover || 0,
                   uTint: [look.tint[0], look.tint[1], look.tint[2], look.tint[3] * k] });
    gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, b.first * 4);
  }
  gl.depthMask(true);
  gl.disable(gl.DEPTH_TEST);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, G.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, G.flat);
  gl.blitFramebuffer(0, 0, G.w, G.h, 0, 0, G.w, G.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.bindVertexArray(quadVao);
  gl.bindTexture(gl.TEXTURE_2D, G.out);
  use(P_LAYER, { uRes: c.res, uRect: [S.F[0] + sh[0], S.F[1] + sh[1], S.F[2], S.F[3]] });
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function clearScene() {
  new Set([S.shot, S.bg, ...S.wins.map(w => w.tex)]).forEach(t => t && gl.deleteTexture(t));
  Object.assign(S, { shot: null, bg: null, wins: [], layersT: null, started: false, t0: null, t: 0, sealAnim: false });
}

function drawBlack() {
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

// ---------------------------------------------------------------- timing helpers
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutBack = (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
const bell = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
// A bell that is exactly nothing away from its peak, for flashes next to a frame that must match a still.
const burst = (t, c, w, amp) => Math.max(bell(t, c, w) * amp - 0.02, 0);
const shakeAmt = (t, t0, dur, amp) => (t >= t0 && t < t0 + dur) ? amp * (1 - (t - t0) / dur) : 0;

// ---------------------------------------------------------------- shared drawing
function frameSetup() {
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  gl.viewport(0, 0, W, H);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha everywhere
  gl.activeTexture(gl.TEXTURE0);
  return { res: [S.vw, S.vh], buf: [W, H] };
}
// The sky behind the gate: the Hellfire sky, seen from its middle. Which way the camera looks into it,
// in degrees (yaw 0 = along the sky model's -z, turning right; pitch up), and how wide it sees.
const SKY = { yaw: 15, pitch: 22, fov: 56 };
// The sky's parts in the order they are laid on: the six faces of the sky itself, the stars, the
// planets and the galaxy, then the nebulae and the nether streams. Part numbers are the sky model's own.
const SKY_ORDER = [6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4, 5, 14, 17, 23, 24, 15, 16, 18, 19, 20, 21, 22, 25, 26, 27, 12, 13];
/** How one part of the sky looks at time tau: how it goes onto what is behind it (mode 0 covers, 1 lies
 *  over, 2 adds light), how strongly, and how far its texture has slid. The speeds are its model's. */
function skyLook(part, tau) {
  const twinkle = (period, t = (tau % period) / period) => 1 - 0.15 * (1 - Math.abs(2 * t - 1) ** 2);
  if (part >= 6 && part <= 11) return { mode: 0 };                                   // the sky's six faces
  if (part === 0 || part === 1) return { mode: 2 };                                  // stars
  if (part === 2) return { mode: 1, strength: 0.15 };
  if (part === 3) return { mode: 2, strength: 0.75 };
  if (part === 4 || part === 5) return { mode: 1, strength: twinkle(0.4) };          // the brightest stars twinkle
  if (part === 14 || part === 17 || part === 23 || part === 27) return { mode: 1 };  // planets, and the haze low down
  if (part === 24) return { mode: 1, strength: twinkle(2.533) };                     // the galaxy
  if (part === 12 || part === 15) return { mode: 2, slide: -tau / 28.6 };            // nebulae, drifting
  if (part === 13 || part === 16) return { mode: 2, slide: -tau / 124.95 };
  if (part === 25) return { mode: 1, slide: -tau / 28.6 };
  if (part === 26) return { mode: 1, slide: -tau / 124.95 };
  return { mode: 2, slide: -tau / { 18: 17.87, 19: 20.02, 20: 19.89, 21: 44.49, 22: 44.35 }[part] }; // nether streams
}
const skyParts = SKY_ORDER.map(n => GATE.sky.find(b => b.part === n)).filter(Boolean);

const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vadd = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; // a + b * k
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vunit = a => vadd([0, 0, 0], a, 1 / Math.hypot(a[0], a[1], a[2]));

/** How each monitor (x, y, width, height on the desktop) looks into the sky: a list of views, each a
 *  monitor and the matrix that takes a direction (as the sky's camera sees it: x right, y up, -z ahead)
 *  to where it lands on that monitor.
 *
 *  Think of the monitors as windows in walls standing round you, a pixel wide per pixel. The primary's
 *  wall is straight ahead, and monitors above or below it are in the same wall. A monitor beside it is
 *  in a wall of its own, turned about the seam between them as far as the primary's wall would have to
 *  be turned to mirror it. So the sky runs on across the seam, and at its own size: on one flat wall it
 *  would be smeared ever wider towards the far monitors. The primary looks up into the sky (SKY.pitch),
 *  so its seams lean back; a side wall's window is slanted to match, its rows following the horizon.
 *  Without that the horizon would climb across the side monitors and leave them looking at the ground. */
function skyViews(screens) {
  const [fx, fy, fw, fh] = S.F, cx = fx + fw / 2, cy = fy + fh / 2, rad = Math.PI / 180;
  const depth = fh / 2 / Math.tan(SKY.fov * rad / 2); // from the eye to the primary's wall, in pixels
  const up = [0, 1, 0];                                // a seam between two walls
  const zenith = [0, Math.cos(SKY.pitch * rad), -Math.sin(SKY.pitch * rad)]; // straight up in the sky
  // A wall: the desktop pixel (x, cy) is at `at + (x - x0) * along`, and one pixel higher is one `up` further.
  const view = (r, wall) => {
    const A = wall.along, B = up;
    const O = vadd(vadd(wall.at, A, r[0] + r[2] / 2 - wall.x0), B, cy - (r[1] + r[3] / 2)); // the monitor's middle
    // Rows of the inverse of [A B O]: a direction d meets the wall at O + a A + b B, a = r0.d / r2.d, b = r1.d / r2.d.
    const n = vcross(A, B), det = vdot(O, n), far = Math.abs(det) / Math.hypot(n[0], n[1], n[2]); // how far off the wall is
    const r0 = vadd([0, 0, 0], vcross(B, O), 2 * far / det / r[2]);
    const r1 = vadd([0, 0, 0], vcross(O, A), 2 * far / det / r[3]);
    const r2 = vadd([0, 0, 0], n, far / det);
    // Depth: nothing nearer the wall's own plane through the eye than 1 is drawn (z = w - 2).
    return { rect: r, m: new Float32Array([r0[0], r1[0], r2[0], r2[0], r0[1], r1[1], r2[1], r2[1],
                                           r0[2], r1[2], r2[2], r2[2], 0, 0, -2, 0]) };
  };
  const ahead = { at: [0, 0, -depth], x0: cx, along: [1, 0, 0], flat: [1, 0, 0] };
  const views = [], beside = [[], []];
  for (const r of screens) {
    const mid = r[0] + r[2] / 2;
    if (mid < fx) beside[0].push(r); else if (mid > fx + fw) beside[1].push(r); else views.push(view(r, ahead));
  }
  beside.forEach((list, right) => {
    const dir = right ? 1 : -1; // walking outwards from the primary
    let wall = ahead, seam = right ? fx + fw : fx;
    list.sort((a, b) => right ? a[0] - b[0] : b[0] + b[2] - a[0] - a[2]);
    for (const r of list) {
      const inner = right ? r[0] : r[0] + r[2], outer = right ? r[0] + r[2] : r[0];
      if (dir * (inner - seam) > -2) { // it starts where the last wall ends: a new wall, turned about the seam
        const at = vadd(wall.at, wall.along, seam - wall.x0);
        const mirror = vunit(vcross(at, up));                                   // through the eye and the seam
        const flat = vadd(wall.flat, mirror, -2 * vdot(wall.flat, mirror)).map(x => -x); // along it, square to the seam
        const along = vadd(flat, up, -vdot(flat, zenith) / vdot(up, zenith));            // along it, level with the horizon
        wall = { at, x0: seam, along, flat };
      }
      views.push(view(r, wall));
      if (dir * (outer - seam) > 0) seam = outer;
    }
  });
  return views;
}

/** Draws the sky on every monitor, faded in by alpha. The primary monitor sees it through SKY; the
 *  others see the sky beside that (see skyViews). */
function drawSky(tau, alpha) {
  if (alpha <= 0.001) return;
  const rad = Math.PI / 180, cp = Math.cos(SKY.pitch * rad);
  const look = [Math.sin(SKY.yaw * rad) * cp, Math.sin(SKY.pitch * rad), -Math.cos(SKY.yaw * rad) * cp];
  const cam = matLookAt([0, 0, 0], look);
  const kx = gl.drawingBufferWidth / S.vw, ky = gl.drawingBufferHeight / S.vh;
  gl.bindVertexArray(G.vao);
  for (const v of S.views) {
    const [x, y, w, h] = v.rect, vp = matMul(v.m, cam);
    gl.viewport(Math.round(x * kx), Math.round((S.vh - y - h) * ky), Math.round(w * kx), Math.round(h * ky));
    for (const b of skyParts) {
      const k = skyLook(b.part, tau);
      gl.bindTexture(gl.TEXTURE_2D, G.tex[b.tex]);
      use(P_SKY, { uVP: vp, uScroll: [k.slide || 0, 0], uMode: k.mode, uStrength: k.strength === undefined ? 1 : k.strength, uAlpha: alpha });
      gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, b.first * 4);
    }
  }
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
}
/** A burst of light round the portal. It is drawn before the gate, so it shows round and behind it. */
function drawFlash(c, P, flash) {
  if (flash <= 0.003) return;
  gl.bindVertexArray(quadVao);
  use(P_FLASH, { uRes: c.res, uP: P, uHalf: [S.R0[0] * 2.9, S.R0[1] * 2.9], uR0: S.R0, uFlash: flash });
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function drawSparks(c, P, tau, flow, amt) {
  if (amt <= 0.01) return;
  gl.bindVertexArray(partVao);
  use(P_PAR, { uRes: c.res, uBuf: c.buf, uP: P, uR0: S.R0, uTime: tau, uFlow: flow, uAmt: amt });
  gl.drawArrays(gl.POINTS, 0, NPART);
}

// ---------------------------------------------------------------- the gate at rest
// What the lock screen and the screensaver show: the gate in the dark, its portal open as always.
// ("Sealed" is the host's word for this state, from when the portal still closed into a crack.)
const eyeGlow = tau => 0.85 + 0.15 * Math.sin(tau * 1.7); // the statues' eyes breathe
const sealTau = now => SEAL_T + (now - S.sealT0) / 1000;

function drawSealed(tau) {
  const c = frameSetup();
  drawSky(tau, 1);
  drawGate(c, [0, 0], { build: 1, ignite: 1, eyes: eyeGlow(tau), flash: 0, cam: 1 }, tau);
}

let lastSeal = 0;
function sealLoop(now) {
  if (S.mode !== 'sealed' || !S.sealAnim) return;
  if (now - lastSeal > 30) { lastSeal = now; drawSealed(sealTau(now)); } // ~30 fps is plenty
  requestAnimationFrame(sealLoop);
}

/** Show the gate at rest, frozen at the lock screen's moment, optionally coming alive from there. */
function showSealed(animate) {
  S.mode = 'sealed';
  S.sealT0 = performance.now();
  drawSealed(SEAL_T);
  S.sealAnim = animate;
  if (animate) requestAnimationFrame(sealLoop);
}

// ---------------------------------------------------------------- scenes from the host
/** A batch of images arrived (one shared buffer). part: 'shot' | 'layers' | 'all'. */
function onScene(meta, buffer) {
  if (meta.part !== 'layers') {
    // The intro continues the gate at rest from wherever its idle animation has got to.
    const tau0 = S.mode === 'sealed' && S.sealT0 !== null ? sealTau(performance.now()) : SEAL_T;
    clearScene();
    S.mode = meta.mode;
    S.tau0 = tau0;
    setGeometry(meta);
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
    afterShown(() => send('frame'));
  } else if (meta.part === 'layers') {
    S.layersT = S.started ? S.t : 0;
  } else {
    S.layersT = 0;
    start();
  }
}

function handleCommand(m) {
  if (m.cmd === 'go') {
    start();
  } else if (m.cmd === 'sealed') {
    clearScene();
    setGeometry(m);
    showSealed(!!m.animate);
    afterShown(() => send('frame'));
  } else if (m.cmd === 'picture') {
    // The lock screen picture: the gate at rest, as the lock animation ends on it, cut to the primary monitor.
    clearScene();
    setGeometry(m);
    showSealed(false);
    const c = document.createElement('canvas');
    c.width = m.fw; c.height = m.fh;
    c.getContext('2d').drawImage(cv, m.fx, m.fy, m.fw, m.fh, 0, 0, m.fw, m.fh);
    send('picture:' + c.toDataURL('image/png'));
  } else if (m.cmd === 'alive') {
    // The lock animation has ended on the gate at rest: it lives on from there until the PC is touched.
    if (S.mode === 'sealed' && !S.sealAnim) { S.sealAnim = true; requestAnimationFrame(sealLoop); }
  } else if (m.cmd === 'unlocked') {
    // Restart the idle animation at the lock screen's moment so it matches the picture you just saw.
    if (S.mode === 'sealed') { S.sealT0 = performance.now(); S.sealAnim = true; requestAnimationFrame(sealLoop); }
  } else if (m.cmd === 'abort') {
    clearScene();
    S.mode = null;
    drawBlack();
  }
}

function start() {
  if (S.started || !S.mode) return;
  S.started = true;
  S.t0 = null;
  S.frames = 0;
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!S.started) return;
  if (S.t0 === null) S.t0 = now;
  const st = render((now - S.t0) / 1000 * S.speed);
  if (++S.frames === 3) send('running'); // the host can lift its cover now
  if (st.done) {
    const mode = S.mode;
    clearScene();
    if (mode === 'outro') { S.mode = 'sealed'; S.sealT0 = now; } // the last frame is the gate at rest
    send(mode + 'Done');
    return;
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- the two shows
const GATE_UP = 0.85;   // outro: the gate has risen, its portal open in it

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

function outroState(t) {
  const st = { sky: 0, dim: 0.55 * smooth(0.05, 0.9, t), shotMix: 1, screenFlash: bell(t, GATE_UP + 0.02, 0.07) * 0.12,
               night: 0, stream: 0, flash: bell(t, GATE_UP + 0.1, 0.12) * 0.7, flow: 1, done: false, poses: [],
               build: smooth(0.1, GATE_UP, t),                    // the gate is conjured from the ground up, portal and all
               cam: smooth(0.05, GATE_UP + 0.1, t),               // while the camera closes in on it
               ignite: clamp01((t - GATE_UP + 0.13) / 0.4) };     // the statues' eyes catch as it completes
  let shake = (t > 0.1 && t < GATE_UP ? 1.6 : 0) + shakeAmt(t, GATE_UP, 0.45, 9);
  let doneT = 5.5;
  if (S.layersT !== null) {
    const N = S.wins.length, tl = S.layersT;
    const W0 = Math.max(GATE_UP + 0.5, tl + 0.35), s = Math.min(0.2, 1.8 / Math.max(N, 1));
    const fadeAt = Math.max(tl, 0.45);
    st.shotMix = 1 - smooth(fadeAt, fadeAt + 0.35, t);
    st.sky = smooth(fadeAt, fadeAt + 0.6, t); // the wallpaper gives way to the sky: only the windows go in
    st.stream = smooth(W0 - 0.3, W0, t);      // sparks stream in with the windows
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
      // While it trembles the window is pulled off the desktop, through the gate's stone, to the front.
      st.poses[i] = e >= 1 ? null : { ...pose(S.wins[i], e, jit), lift: smooth(0, 0.28, tau) };
    }
    const WE = N ? W0 + (N - 1) * s + 1.18 : W0 + 0.3;
    const C0 = WE + 0.05;                     // the last window is gone: the portal flares, and all is still
    st.night = smooth(C0 + 0.1, C0 + 0.5, t);
    st.flash += burst(t, C0 + 0.3, 0.12, 1.6);
    st.screenFlash = bell(t, C0 + 0.34, 0.1) * 0.4;
    shake += shakeAmt(t, C0 - 0.1, 0.5, 9);
    doneT = C0 + 0.62;
    st.done = t > doneT;
  }
  st.tau = SEAL_T + t - doneT;                // lands exactly on the lock screen's moment
  return finishState(st, shake);
}

function introState(t) {
  const N = S.wins.length, flare = 0.2;      // the portal flares, then gives everything back
  const st = { flow: -1, screenFlash: 0, poses: [], tau: S.tau0 + t, ignite: 1, cam: 1, stream: 1 };
  st.flash = burst(t, flare + 0.08, 0.12, 0.9);
  const shake = shakeAmt(t, flare, 0.5, 5);
  const W0 = 0.6, s = Math.min(0.13, 1.4 / Math.max(N, 1));
  st.night = 1 - smooth(W0 - 0.3, W0, t);   // sparks stream out with the windows
  for (let i = 0; i < N; i++) {             // bottom window first, topmost lands last, in front of the gate
    const tau = t - (W0 + (N - 1 - i) * s);
    st.poses[i] = tau <= 0 ? null : { ...pose(S.wins[i], 1 - easeOutBack(clamp01(tau / 0.8), 1.4), [0, 0, 0]), lift: 1 };
  }
  const land = N ? W0 + (N - 1) * s + 0.8 : W0 + 0.3;
  const C0 = Math.max(land - 0.05, 1.2);
  st.build = 1 - smooth(C0 - 0.15, C0 + 0.4, t); // the gate burns away, top first, its portal with it
  st.sky = st.build;                              // and the wallpaper comes back in its place
  st.dim = 0.42 * (1 - smooth(C0 - 0.2, C0 + 0.4, t));
  st.shotMix = smooth(C0 + 0.3, C0 + 0.55, t); // hand over to the live desktop
  st.done = t > C0 + 0.62;
  return finishState(st, shake);
}

function finishState(st, shake) {
  st.eyes = eyeGlow(st.tau);
  // night: 1 while the windows are gone and the gate stands alone under the sky, as on the lock screen.
  // Sparks stream in (or out) only while windows are on the move; the gate at rest has none.
  st.amt = (1 - st.night) * smooth(0.5, 1, st.build) * st.stream;
  st.shake = shake;
  return st;
}

// ---------------------------------------------------------------- drawing a frame of a show
function render(t) {
  S.t = t;
  const st = S.mode === 'intro' ? introState(t) : outroState(t);
  const c = frameSetup();
  const sh = [st.shake * Math.sin(t * 71), st.shake * Math.cos(t * 53)];
  const P = [S.P[0] + sh[0], S.P[1] + sh[1]];

  const image = (tex, alpha) => {
    gl.bindVertexArray(emptyVao);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    use(P_IMG, { uRes: c.res, uBuf: c.buf, uP: S.P, uShake: [-sh[0], -sh[1]], uAlpha: alpha,
                 uDim: st.dim, uAmb: st.build, uRy: S.R0[1] });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Windows lying on the desktop are behind the gate; once lifted (pose.lift) they fly in front of it.
  const sprites = lifted => {
    gl.bindVertexArray(quadVao);
    for (let i = S.wins.length - 1; i >= 0; i--) {
      const p = st.poses[i], w = S.wins[i];
      if (!p || p.alpha <= 0.001 || p.scale <= 0.001) continue;
      const a = lifted ? p.lift : (p.lift < 1 ? 1 : 0);
      if (a <= 0.001) continue;
      gl.bindTexture(gl.TEXTURE_2D, w.tex);
      use(P_SPR, { uRes: c.res, uC: [p.cx + sh[0], p.cy + sh[1]], uSize: [w.w, w.h], uRot: p.rot,
                   uScale: p.scale, uMargin: 30, uRadius: w.r, uAlpha: p.alpha * a, uTint: p.tint,
                   uShadow: p.shadow, uTime: t });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
  const shotOnTop = S.mode === 'intro'; // the intro ends by handing over to the live desktop

  // The wallpaper (with icons and taskbar) never goes into the portal: the sky takes its place.
  const bgTex = S.bg || S.shot;
  if (st.sky > 0) drawSky(st.tau, 1);
  if (S.layersT !== null && st.shotMix < 1 && bgTex && st.sky < 1) image(bgTex, 1 - st.sky);
  sprites(false);
  if (!shotOnTop && st.shotMix > 0 && S.shot) image(S.shot, st.shotMix);
  drawFlash(c, P, st.flash);
  drawGate(c, sh, st, st.tau);
  sprites(true);
  if (shotOnTop && st.shotMix > 0 && S.shot) image(S.shot, st.shotMix);
  drawSparks(c, P, st.tau, st.flow, st.amt);

  if (st.screenFlash > 0.003) {
    const f = st.screenFlash;
    gl.bindVertexArray(emptyVao);
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
  host.addEventListener('message', e => handleCommand(e.data || {}));
}
drawBlack();
gateReady.catch(e => send('error: ' + e.message)).then(() => send('ready'));
