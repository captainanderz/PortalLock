# PortalLock

A green fel portal tears open in the middle of your main monitor and swallows your windows one by one,
then the desktop itself, and the PC locks. When you unlock, the portal opens in the dark and throws
everything back out to where it was.

## Use

| Action | How |
| --- | --- |
| Portal + lock | `Ctrl+Alt+Shift+L`, or tray icon → *Open portal and lock* |
| Preview without locking | `Ctrl+Alt+Shift+T`, double-click the tray icon, or tray → *Preview* |
| Cancel mid-animation | `Esc` (cancelling the outro also cancels the lock) |
| Plain `Win+L` | Locks instantly as usual, but you still get the unlock animation |

From a shortcut or script: `PortalLock.exe lock` or `PortalLock.exe test`. If PortalLock is already
running, the command goes to that running copy.

Tray menu → *Start with Windows* adds it to `HKCU\...\Run`.

## Lock screen and screensaver

Windows' lock screen can only show a still picture, so the portal hands over to it seamlessly instead:

- **Lock screen picture:** `assets/lockscreen-2560x1440.png` is the portal sealed into a glowing crack.
  The lock animation ends on exactly this frame, and the unlock animation starts from it and tears
  the crack open. Set it under Settings → Personalization → Lock screen → *Picture*. To render it at
  another size, serve `PortalLock/web/` and open `lockscreen.html?w=3840&h=2160`.
- **Screensaver:** tray → *Use as screensaver (10 min)* (or `PortalLock.exe screensaver-on` / `-off`).
  While the PC is idle the crack comes alive: the mist turns, embers drift and the crack breathes.
  Any input ends it and Windows locks, showing the same crack, frozen. It runs as `PortalLock.scr`,
  a copy of the exe that PortalLock refreshes after a rebuild.

## Build

Open `PortalLock.slnx` in Rider, or from the command line:

```
dotnet build PortalLock.slnx -c Release -o "%LOCALAPPDATA%\PortalLock\app"
```

Quit PortalLock from the tray first if it's running, since Windows locks a running exe.
Needs the .NET 10 SDK and the WebView2 runtime (already part of Windows 11).

## How it works

Windows doesn't let you draw on the lock screen, so the outro plays just *before* the lock and the
intro plays just *after* the unlock.

1. **Capture.** A screenshot of all monitors, `PrintWindow` of the desktop shell (wallpaper and icons
   without any windows), plus each visible window captured on its own, so windows hidden behind others
   are complete too.
2. **Overlay.** One borderless WebView2 window covers every monitor. It waits off-screen between runs,
   so the first frame is already drawn when it moves on-screen and you never see a flash. It also
   excludes itself from screen capture, so after an unlock the app can photograph the live desktop
   *underneath* its own black cover.
3. **Animation.** WebGL in `PortalLock/web/`: shaders in `shaders.js`, timelines in `portal.js`.
   Windows are textured quads that get pulled along a spiral. The desktop layer gets a vortex
   distortion, and the portal is a noise shader.

Logs: `%LOCALAPPDATA%\PortalLock\log.txt`.

## Tweaking

- Portal size and position: `PostScene` in `PortalLock/Overlay.cs` (`rx`/`ry` are fractions of the primary monitor's height).
- Timing: `outroState` / `introState` in `PortalLock/web/portal.js`.
- Colours: `cDark`/`cMid`/`cHot` in `FS_PORTAL` (`PortalLock/web/shaders.js`).
- Preview the animation in a browser with a fake desktop: serve `PortalLock/web/` and open `portal.html`
  (`?speed=0.4` for slow motion, `?mode=outro&t=2.4` for a frozen frame).
