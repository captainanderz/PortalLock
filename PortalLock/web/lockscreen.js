'use strict';
/* global cv, S, SEAL_T, drawSealed */
// Renders the lock screen picture: the portal sealed into a glowing crack. It is the exact frame
// the lock animation ends on and the unlock animation starts from (same shader, same moment).
// Open lockscreen.html?w=2560&h=1440 with the primary monitor's size.

const q = new URLSearchParams(location.search);
const W = +q.get('w') || 2560, H = +q.get('h') || 1440;
cv.width = W;
cv.height = H;
Object.assign(S, { vw: W, vh: H, P: [W / 2, H / 2], R0: [H * 0.19, H * 0.27], F: [0, 0, W, H] });
drawSealed(SEAL_T);

/** Dev helper: POST the PNG to the local preview server, which writes it to disk. */
window.savePng = async () => {
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return (await fetch('/save', { method: 'POST', body: blob })).status;
};
