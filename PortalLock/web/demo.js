'use strict';
/* global onScene, start, render, S */
// Browser-only preview with a fake desktop. Ignored inside the app (WebView2 host present).
// portal.html            -> loops outro, intro, outro...
// portal.html?mode=outro&t=2.4 -> one frozen frame (for checking a moment in detail)
// portal.html?speed=0.4  -> slow motion
(function demo() {
  if (window.chrome && window.chrome.webview) return;
  const q = new URLSearchParams(location.search);
  const vw = Math.round(innerWidth * devicePixelRatio) || 1600;
  const vh = Math.round(innerHeight * devicePixelRatio) || 900;
  const u = vh / 1440; // scale fake UI to the viewport

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c.getContext('2d'); };

  // Wallpaper, icons and taskbar.
  const bg = mk(vw, vh);
  const g = bg.createRadialGradient(vw * 0.5, vh * 1.1, 0, vw * 0.5, vh * 0.6, vh * 1.2);
  g.addColorStop(0, '#2b7a9b'); g.addColorStop(0.45, '#1b2f6b'); g.addColorStop(1, '#0b0b1e');
  bg.fillStyle = g; bg.fillRect(0, 0, vw, vh);
  for (let i = 0; i < 7; i++) {
    bg.fillStyle = ['#4fa3ff', '#ffb648', '#7ddc6f', '#ff6b8a', '#b48cff', '#5fe0d0', '#f5f5f5'][i];
    bg.fillRect(20 * u, (30 + i * 120) * u, 64 * u, 64 * u);
  }
  bg.fillStyle = 'rgba(20,22,30,0.92)'; bg.fillRect(0, vh - 64 * u, vw, 64 * u);
  for (let i = 0; i < 8; i++) {
    bg.fillStyle = i === 0 ? '#3b82f6' : '#59607a';
    bg.fillRect(vw / 2 + (i - 4) * 72 * u, vh - 52 * u, 44 * u, 40 * u);
  }

  // Windows, topmost first (same order the app sends).
  const specs = [
    { x: 0.52, y: 0.18, w: 0.30, h: 0.42, c: '#1f2937', a: '#22c55e', t: 'Terminal' },
    { x: 0.12, y: 0.10, w: 0.38, h: 0.55, c: '#f8fafc', a: '#2563eb', t: 'Browser' },
    { x: 0.40, y: 0.45, w: 0.33, h: 0.38, c: '#fff7ed', a: '#ea580c', t: 'Notes' },
    { x: 0.05, y: 0.55, w: 0.28, h: 0.33, c: '#111827', a: '#a855f7', t: 'Chat' },
    { x: 0.66, y: 0.08, w: 0.30, h: 0.70, c: '#f1f5f9', a: '#0ea5e9', t: 'Mail' },
  ];
  const wins = specs.map(s => {
    const w = Math.round(s.w * vw), h = Math.round(s.h * vh), x = Math.round(s.x * vw), y = Math.round(s.y * vh);
    const c = mk(w, h);
    c.fillStyle = s.c; c.fillRect(0, 0, w, h);
    c.fillStyle = s.a; c.fillRect(0, 0, w, 44 * u);
    c.fillStyle = '#fff'; c.font = `${22 * u}px Segoe UI, sans-serif`; c.fillText(s.t, 16 * u, 30 * u);
    const dark = s.c < '#5';
    for (let l = 0; l < 14; l++) {
      c.fillStyle = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
      c.fillRect(24 * u, (70 + l * 34) * u, (0.3 + ((l * 37) % 60) / 100) * (w - 48 * u), 12 * u);
    }
    return { ctx: c, x, y, w, h, r: Math.round(8 * u) };
  });

  const shot = mk(vw, vh);
  shot.drawImage(bg.canvas, 0, 0);
  for (let i = wins.length - 1; i >= 0; i--) {
    const w = wins[i];
    shot.save(); shot.shadowColor = 'rgba(0,0,0,0.45)'; shot.shadowBlur = 28 * u;
    shot.drawImage(w.ctx.canvas, w.x, w.y); shot.restore();
  }

  // Pack like the app: BGRA, tightly packed, one buffer.
  function pack(list) {
    let total = 0;
    list.forEach(i => { total += i.w * i.h * 4; });
    const buf = new ArrayBuffer(total), bytes = new Uint8Array(buf), images = [];
    let off = 0;
    for (const i of list) {
      const d = i.ctx.getImageData(0, 0, i.w, i.h).data;
      for (let p = 0; p < d.length; p += 4) {
        bytes[off + p] = d[p + 2]; bytes[off + p + 1] = d[p + 1]; bytes[off + p + 2] = d[p]; bytes[off + p + 3] = 255;
      }
      images.push({ kind: i.kind, off, w: i.w, h: i.h, x: i.x, y: i.y, r: i.r || 0 });
      off += i.w * i.h * 4;
    }
    return { buf, images };
  }
  const geo = { cmd: 'scene', vw, vh, px: vw / 2, py: vh / 2, rx: vh * 0.19, ry: vh * 0.27 };
  const shotImg = { kind: 'shot', ctx: shot, x: 0, y: 0, w: vw, h: vh };
  const layerImgs = [{ kind: 'bg', ctx: bg, x: 0, y: 0, w: vw, h: vh }, ...wins.map(w => ({ kind: 'win', ...w }))];
  const shotPack = pack([shotImg]), layerPack = pack(layerImgs), allPack = pack([shotImg, ...layerImgs]);

  const outro = () => {
    onScene({ ...geo, mode: 'outro', part: 'shot', images: shotPack.images }, shotPack.buf);
    start();
    setTimeout(() => onScene({ ...geo, mode: 'outro', part: 'layers', images: layerPack.images }, layerPack.buf), 250);
  };
  const intro = () => onScene({ ...geo, mode: 'intro', part: 'all', images: allPack.images }, allPack.buf);

  S.speed = parseFloat(q.get('speed') || '1');
  if (q.has('t')) {
    const mode = q.get('mode') || 'outro';
    if (mode === 'intro') { intro(); S.started = false; }
    else {
      onScene({ ...geo, mode: 'outro', part: 'shot', images: shotPack.images }, shotPack.buf);
      onScene({ ...geo, mode: 'outro', part: 'layers', images: layerPack.images }, layerPack.buf);
      S.layersT = 0.25;
    }
    render(parseFloat(q.get('t')));
    return;
  }
  window.onPortalMessage = m => {
    if (m === 'outroDone') setTimeout(intro, 900);
    if (m === 'introDone') setTimeout(outro, 1500);
  };
  setTimeout(outro, 600);
})();
