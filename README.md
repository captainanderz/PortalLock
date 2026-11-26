# PortalLock

The Dark Portal burns its way up out of your desktop, as tall as your screen: two hooded statues
leaning on their swords, a dragon's skull and horns above them, the green swirl open between them.
Your wallpaper gives way to the Hellfire sky, the statues' eyes catch fire, and the portal swallows
your windows one by one, leaving the gate alive under the sky until you touch the PC, which then
locks. When you unlock, the portal flares, throws your windows back out to where they were, and the
gate burns away, your wallpaper coming back in its place. The portal never closes: it comes and goes
with the gate. Leave the PC alone for 3 minutes and the portal opens by itself.

The gate, its swirl and the sky are World of Warcraft's own 3D models (the Outland Dark Portal, its
effect model and the Hellfire skybox), drawn live, so they are sharp at any screen size and across
every monitor.

> **The Dark Portal is not included.** Its models and textures belong to Blizzard Entertainment, so
> this repository has none of them: you export them from the game yourself with
> [wow.export](https://github.com/Kruithne/wow.export), and a script converts them on your PC (see
> *Setup*). PortalLock is a fan project, not affiliated with or endorsed by Blizzard.

Windows only (10 or 11).

## Setup

You need:

- the [.NET 10 SDK](https://dotnet.microsoft.com/download),
- the WebView2 runtime (part of Windows 11; on Windows 10 install it from Microsoft if it's missing),
- [wow.export](https://github.com/Kruithne/wow.export) and access to World of Warcraft's game data
  (a local installation, or Blizzard's CDN through wow.export),
- [Blender](https://www.blender.org/) (tested with 5.3), which bakes the light on the stone.

Then:

1. **Export the Dark Portal.** In wow.export, export these three models as OBJ, into its default
   export folder (`%USERPROFILE%\wow.export`), keeping the `.json` files it writes next to them:
   - `world/wmo/outland/darkportal/darkportal_temple.wmo`
   - `world/expansion01/doodads/hellfirepeninsula/darkportal/hellfire_darkportal_fx.m2`
   - `environments/stars/hellfireskybox.m2`
2. **Convert it.** From the repository's folder:
   ```
   powershell -ExecutionPolicy Bypass -File tools\convert-gate.ps1
   ```
   It finds Blender (or pass `-Blender <path to blender.exe>`; `-Export <folder>` if you exported
   elsewhere) and takes a few minutes. It writes `PortalLock/web/gate.js` and `PortalLock/web/gate/`,
   which git ignores.
3. **Build and start it.** In PowerShell:
   ```
   dotnet build PortalLock.slnx -c Release -o "$env:LOCALAPPDATA\PortalLock\app"
   & "$env:LOCALAPPDATA\PortalLock\app\PortalLock.exe"
   ```
   Quit PortalLock from the tray before building again, since Windows locks a running exe.
4. **Set the lock screen picture.** Tray icon → *Save lock screen picture* saves the gate at rest to
   your Pictures folder and opens Windows' lock screen settings: choose *Picture* and pick it.
5. Tray icon → *Start with Windows*, if you like.

## Use

| Action | How |
| --- | --- |
| Portal + lock | `Ctrl+Alt+Shift+L`, or tray icon → *Open portal and lock* |
| Preview without locking | `Ctrl+Alt+Shift+T`, double-click the tray icon, or tray → *Preview* |
| Cancel mid-animation | `Esc` (cancelling the outro also cancels the lock) |
| Plain `Win+L` | Locks instantly as usual, but you still get the unlock animation |
| Leave the PC alone | After 3 minutes the portal opens and locks by itself (see *Idle* below) |

After the lock animation the gate stays up, alive, on every monitor, and the PC locks the moment you
touch the mouse or keyboard (see *Holding the gate* below). Untick tray menu → *Keep the gate up until
the PC is touched* to lock as soon as the animation ends.

From a shortcut or script: `PortalLock.exe lock`, `PortalLock.exe test` or `PortalLock.exe lockscreen`
(saves the lock screen picture). If PortalLock is already running, the command goes to that copy.

Logs: `%LOCALAPPDATA%\PortalLock\log.txt` (tray → *Open log folder*).

## Lock screen and idle

Windows doesn't let anyone draw on its lock screen; it can only show a still picture. So the
animation plays just *before* the PC locks and just *after* it unlocks, and hands over to that
picture seamlessly:

- **Lock screen picture:** the gate at rest under the Hellfire sky, at your primary monitor's size:
  the exact frame the lock animation ends on and the unlock animation starts from. Save it again
  (tray → *Save lock screen picture*) after changing anything the gate at rest shows. Windows has one
  lock screen picture and repeats it on every monitor; it cannot spread a picture across them.
- **Holding the gate:** because of that, the lock animation does not end on Windows' lock screen.
  PortalLock keeps its own gate up instead, one scene across all monitors, and asks Windows to lock
  at the first touch. Until then the PC is covered but not locked:
  - Key presses are swallowed, so neither the key that wakes the PC nor a password typed blind
    reaches the app that had the keyboard.
  - A second process (`PortalLock.exe guard`) locks the PC if PortalLock dies, or has not locked two
    seconds after a touch.
  - Windows is not locked yet, so whatever it does for a locked PC (hiding notifications, showing you
    as away) waits until the touch. Windows' own idle timeout still locks it on its own.
  - `Win+L` still locks at once.
- **Idle:** after 3 minutes without mouse or keyboard input the portal opens by itself, as a
  screensaver would: the lock animation plays and the gate is held, the swirl turning, the nebulae
  and nether streams drifting and the statues' eyes breathing. Touch the PC while the animation is
  still playing and you get your desktop back unlocked, as with a screensaver's grace period; touch
  it once the gate stands and the PC locks. It waits while an app is full screen (a video, a game,
  a slide show) and while any app has played sound in the last 10 seconds, since unlike Windows'
  screensaver it cannot hear an app asking for the screen to stay on. Untick tray → *Open the portal
  after 3 minutes idle* to turn it off.
- **Windows' screensaver:** the idle portal replaces it, so PortalLock unregisters itself as Windows'
  screensaver while the idle portal is on (on a managed PC, Windows' screensaver timeout may be set
  by policy anyway). With the idle portal off, `PortalLock.exe screensaver-on` installs it as
  `PortalLock.scr` instead.

## How it works

1. **Capture.** A screenshot of all monitors, `PrintWindow` of the desktop shell (wallpaper and icons
   without any windows), plus each visible window captured on its own, so windows hidden behind others
   are complete too.
2. **Overlay.** One borderless WebView2 window covers every monitor. It waits off-screen between runs,
   so the first frame is already drawn when it moves on-screen and you never see a flash. It also
   excludes itself from screen capture, so after an unlock the app can photograph the live desktop
   *underneath* its own cover.
3. **Animation.** WebGL in `PortalLock/web/`: shaders in `shaders.js`, timelines in `portal.js`.
   Windows are textured quads that get pulled along a spiral. The wallpaper (with the icons and the
   taskbar) never goes in: the sky fades in in its place. The gate is a 3D model (`PortalLock/web/gate/`,
   made by `tools/convert-gate.ps1`): about 46,000 triangles of stone plus the swirl, whose spiral arms
   turn at the speed the game's model gives. Each frame it is drawn into a picture of its own, with a
   depth buffer and smoothed edges; that picture is then laid into the scene, fitted so the gate fills
   the primary monitor from top to bottom. The stone's light from the sky and from a key light, with
   the shadows they leave, is baked into a light map by Blender (`gate/light.png`). The swirl's steady
   glow does not light the stone; only its flashes do. Behind everything is the Hellfire sky, drawn
   round the camera with its nebulae and nether streams drifting at the model's speeds. A monitor
   beside the primary one looks into the stretch of sky next to the primary's, as if the monitors
   stood round you, so the sky runs on from one monitor to the next at its own size (`skyViews` in
   `portal.js`). Green sparks stream into the portal (and out of it) only while windows are on the
   move. Windows still lying on the desktop are behind the gate; once torn loose they fly in front of it.

## Working on it

- Preview in a browser with a fake desktop: `dotnet run tools/serve.cs -- PortalLock/web 8787 out/lockscreen.png`,
  then open `http://localhost:8787/portal.html` (`?speed=0.4` for slow motion, `?mode=outro&t=2.4`
  for a frozen frame, `?screens=3&w=5760&h=1080` for three monitors side by side) or
  `lockscreen.html?w=2560&h=1440` for the gate at rest.
- The models: `tools/convert-gate.py` does the work inside Blender. The key light's direction (`KEY`),
  its softness and the light map's size (`SIZE`) are at its top; run the tool again after changing
  them. How strongly the sky and the key light show is in `FS_STONE` in `PortalLock/web/shaders.js`.
- Camera: `CAM` in `PortalLock/web/portal.js` (where it starts while the gate is conjured, and where
  it settles). `fitGate` then scales the settled view so the gate fills the monitor's height, and
  `OPENING` says where the sparks and the windows' spiral are centred.
- The swirl: its layers are in `swirlLook` in `portal.js`. The model's streaks of bright light along
  the swirl's edge (its parts 0 to 12) are left out there; return a look for them to bring them back.
  How a flash lights the stone is in `FS_STONE`.
- The sky: `SKY` in `portal.js` is which way the camera looks into it and how wide; `skyLook` has
  its layers. Turning `yaw` brings other planets and streams into view beside the gate.
- Timing: `outroState` / `introState` in `portal.js` (`GATE_UP` is when the gate has risen).
- Idle: `IdleWatch` in `PortalLock/Idle.cs` has the 3 minutes (`After`) and what holds the portal off.
  The environment variable `PORTALLOCK_IDLE_SECONDS` overrides the time, for testing.

## License

PortalLock's code is under the MIT License (see [LICENSE](LICENSE)).

World of Warcraft, the Dark Portal and everything exported from the game are Blizzard
Entertainment's. This repository contains none of their files, and its license does not cover them:
keep `PortalLock/web/gate/`, `PortalLock/web/gate.js` and pictures rendered from them to yourself, and
don't publish builds that contain them.
