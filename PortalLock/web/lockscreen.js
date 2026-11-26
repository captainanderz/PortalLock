'use strict';
/* global cv, SEAL_T, gateReady, setGeometry, drawSealed */
// Renders the lock screen picture in a browser, for working on it: the gate at rest under the sky, the
// exact frame the lock animation ends on and the unlock animation starts from (same shaders, same
// moment). The app saves the same picture itself (tray → Save lock screen picture).
// Serve this folder with tools/serve.cs and open lockscreen.html?w=2560&h=1440.

const q = new URLSearchParams(location.search);
const W = +q.get('w') || 2560, H = +q.get('h') || 1440;
window.drawn = gateReady.then(() => {
  setGeometry({ vw: W, vh: H, px: W / 2, py: H / 2, rx: H * 0.19, ry: H * 0.27 }); // same numbers the app sends
  drawSealed(SEAL_T);
});

/** Dev helper: POST the PNG to tools/serve.cs, which writes it to disk. */
window.savePng = async () => {
  await window.drawn;
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return (await fetch('/save', { method: 'POST', body: blob })).status;
};
