using Microsoft.Web.WebView2.Core;

namespace PortalLock;

enum Phase { Idle, Outro, Locked, Intro }

/// <summary>Runs the show: the portal swallows the windows, the gate is held until the PC is touched and
/// locks, and on unlock the portal throws everything back out.</summary>
sealed class Director
{
    readonly Overlay ov;
    readonly uint selfPid = (uint)Environment.ProcessId;
    readonly System.Windows.Forms.Timer tick = new() { Interval = 40 };
    readonly List<CoreWebView2SharedBuffer> inFlight = [];
    readonly Cover cover = new();
    TaskCompletionSource? frameReady, running;
    TaskCompletionSource<string>? picture;
    Phase phase = Phase.Idle;
    bool lockAfter;
    DateTime phaseStart;

    // After the lock animation the gate is held (see HoldGate) until the PC is touched.
    readonly EventWaitHandle holdOver = HoldGuard.Flag();
    KeyCatcher? keys;
    bool alive;             // the gate at rest is animating, not frozen
    bool holding;           // waiting for a touch
    bool byItself;          // this show was started by the PC being left alone (see WatchIdle)
    uint touchBaseline;     // the last input there had been when we began watching for a touch
    DateTime? touched;      // when the PC was touched and Windows asked to lock
    uint idleDoneFor;       // the last input before the portal last opened by itself: once per idle spell
    string? busyLogged;

    public Director(Overlay ov)
    {
        this.ov = ov;
        ov.JsMessage += OnJs;
        ov.SessionLocked += OnSession;
        tick.Tick += (_, _) => Watchdog();
        tick.Start();
    }

    /// <summary>At startup: draw a frame while parked off-screen and log whether it arrives.
    /// If it doesn't, the first frame of every show would flash.</summary>
    public async Task CheckParkedRenderingAsync()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        frameReady = new TaskCompletionSource();
        ov.PostSealed(animate: false);
        bool drawn = await Task.WhenAny(frameReady.Task, Task.Delay(2000)) == frameReady.Task;
        ov.Post(new { cmd = "abort" });
        Log.Write(drawn ? $"parked render check: frame after {sw.ElapsedMilliseconds} ms"
                        : "parked render check: NO frame while off-screen (shows will flash)");
    }

    /// <summary>Saves the lock screen picture: the gate at rest at the primary monitor's size, the frame the
    /// lock animation ends on and the unlock animation starts from. Returns where, or null if the portal
    /// is busy or missing.</summary>
    public async Task<string?> SaveLockScreenPicture()
    {
        if (phase != Phase.Idle || !ov.Ready || picture != null) return null;
        picture = new TaskCompletionSource<string>();
        try
        {
            ov.SyncBounds();
            ov.PostPicture();
            var answer = await picture.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "PortalLock lock screen.png");
            await File.WriteAllBytesAsync(path, Convert.FromBase64String(answer[(answer.IndexOf(',') + 1)..]));
            Log.Write($"lock screen picture saved to {path}");
            return path;
        }
        finally
        {
            picture = null;
            if (phase == Phase.Idle) ov.Post(new { cmd = "abort" });
        }
    }

    void Enter(Phase p)
    {
        phase = p;
        phaseStart = DateTime.UtcNow;
        Log.Write($"phase {p}");
    }

    /// <summary>Hotkey / menu entry point. <paramref name="doLock"/> false = preview without locking.
    /// <paramref name="idle"/>: opened by itself; a touch before the gate is up gives the desktop back.</summary>
    public async void Open(bool doLock, bool idle = false)
    {
        if (phase != Phase.Idle || picture != null) return;
        if (!ov.Ready) { if (doLock) Native.LockWorkStation(); return; }
        Enter(Phase.Outro);
        lockAfter = doLock;
        byItself = idle;
        if (idle) WatchForTouch();
        Bitmap? shot = null;
        var keep = new List<Img>();
        try
        {
            ov.SyncBounds();
            var vs = ov.Virtual;
            var full = new Rectangle(Point.Empty, vs.Size);
            shot = Capture.Screen(vs);
            cover.ShowImage(shot, vs); // looks exactly like the desktop; hides the overlay's arrival

            frameReady = new TaskCompletionSource();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            Track(ov.PostScene("outro", "shot", [new Img("shot", shot, full, full, 0)]));
            var s = shot;
            var layersTask = Task.Run(() => Capture.Layers(vs, s, selfPid)); // runs while the cover is up
            bool drawn = await Task.WhenAny(frameReady.Task, Task.Delay(800)) == frameReady.Task;
            if (phase == Phase.Outro)
            {
                ov.MoveOn(below: cover.Handle);
                running = new TaskCompletionSource();
                ov.Post(new { cmd = "go" });
                bool settled = await Task.WhenAny(running.Task, Task.Delay(400)) == running.Task;
                cover.HideNow();
                Log.Write($"overlay up: first frame {(drawn ? "ok" : "timed out")}, " +
                          $"{(settled ? "drawing" : "not drawing yet")} after {sw.ElapsedMilliseconds} ms");
            }

            var layers = await layersTask;
            keep.AddRange(layers);
            if (phase != Phase.Outro) return;
            Track(ov.PostScene("outro", "layers", layers));
        }
        catch (Exception ex)
        {
            Log.Write($"outro failed: {ex}");
            Finish();
            if (doLock) Native.LockWorkStation();
        }
        finally
        {
            DisposeAll(keep, shot);
        }
    }

    async void StartIntro()
    {
        Enter(Phase.Intro);
        ov.Post(new { cmd = "unlocked" }); // the gate comes alive while we photograph the desktop
        var keep = new List<Img>();
        Bitmap? shot = null;
        try
        {
            await Task.Delay(250); // let the desktop compositor wake up after the lock screen
            if (phase != Phase.Intro) return;
            ov.SyncBounds();
            var vs = ov.Virtual;
            var full = new Rectangle(Point.Empty, vs.Size);
            List<Img>? layers = null;
            shot = await Task.Run(() => Capture.Screen(vs));
            // The overlay is excluded from capture, so this is the real desktop underneath it.
            // If capture exclusion ever fails we'd just get our own black overlay back: skip the show.
            if (!Capture.MostlyBlack(shot, full))
            {
                var s = shot;
                layers = await Task.Run(() => Capture.Layers(vs, s, selfPid));
            }
            if (phase != Phase.Intro) return;
            if (layers == null) { Log.Write("intro skipped: capture was black"); Finish(); return; }
            keep.AddRange(layers);
            layers.Insert(0, new Img("shot", shot, full, full, 0));
            Track(ov.PostScene("intro", "all", layers));
        }
        catch (Exception ex)
        {
            Log.Write($"intro failed: {ex}");
            Finish();
        }
        finally
        {
            DisposeAll(keep, shot);
        }
    }

    void OnJs(string msg)
    {
        switch (msg)
        {
            case "frame":
                frameReady?.TrySetResult();
                break;
            case "running":
                running?.TrySetResult();
                break;
            case "loaded" when inFlight.Count > 0: // the page handles scenes in order
                inFlight[0].Dispose();
                inFlight.RemoveAt(0);
                break;
            case "outroDone" when phase == Phase.Outro:
                if (lockAfter)
                {
                    Enter(Phase.Locked);
                    if (Settings.HoldGate) HoldGate(); else LockNow();
                }
                else
                {
                    Enter(Phase.Locked);
                    _ = Task.Delay(700).ContinueWith(_ => ov.BeginInvoke(() =>
                    {
                        if (phase == Phase.Locked) StartIntro();
                    }));
                }
                break;
            case "introDone" when phase == Phase.Intro:
                Finish();
                break;
            case var m when m.StartsWith("picture:"):
                picture?.TrySetResult(m["picture:".Length..]);
                break;
            case var m when m.StartsWith("error"):
                Log.Write($"page {m}");
                break;
        }
    }

    void LockNow()
    {
        if (!Native.LockWorkStation()) StartIntro();
    }

    /// <summary>
    /// The lock animation has ended on the gate at rest. Windows' lock screen can only repeat one picture
    /// on every monitor, so the PC is not locked yet: the gate stays up, alive across all monitors, and
    /// the PC locks the moment it is touched. Until then keys are swallowed (KeyCatcher), and a second
    /// process (HoldGuard) locks the PC should this one fail to.
    /// </summary>
    void HoldGate()
    {
        ov.Post(new { cmd = "alive" });
        alive = true;
        touched = null;
        holding = true;
        WatchForTouch();
        holdOver.Reset();
        HoldGuard.Start();
        Log.Write("holding the gate until the PC is touched" + (keys!.Working ? "" : " (keys are not caught)"));
    }

    /// <summary>From now on the first touch counts: keys are swallowed and reported, and WatchTouch
    /// notices the mouse.</summary>
    void WatchForTouch()
    {
        touchBaseline = Native.LastInputTick();
        keys ??= new KeyCatcher(() => ov.BeginInvoke(() => Touched("a key")));
    }

    void Touched(string by)
    {
        if (phase == Phase.Outro && byItself)
        {
            // It opened by itself, and someone is there after all: no lock, as with a screensaver's grace.
            Log.Write($"touched ({by}) while the portal opened by itself: giving the desktop back");
            Finish();
            return;
        }
        if (!holding) return;
        holding = false;
        touched = DateTime.UtcNow;
        Log.Write($"touched ({by}): locking");
        if (!Native.LockWorkStation()) { EndHold(); StartIntro(); }
    }

    /// <summary>Windows has locked (or the hold is called off): nothing is left to watch.</summary>
    void EndHold()
    {
        holding = false;
        byItself = false;
        touched = null;
        keys?.Dispose();
        keys = null;
        holdOver.Set();
        if (!alive) return;
        alive = false;
        // Back to the still picture the lock screen shows and the unlock animation starts from.
        if (phase == Phase.Locked) ov.PostSealed(animate: false);
    }

    /// <summary>Opens the portal by itself once the PC has been left alone for IdleWatch.After.</summary>
    void WatchIdle()
    {
        if (phase != Phase.Idle || !ov.Ready || picture != null || !Settings.IdlePortal) return;
        uint last = Native.LastInputTick();
        if (last == idleDoneFor) return;
        IdleWatch.Listen();
        if (IdleWatch.Idle < IdleWatch.After) return;
        if (IdleWatch.Busy() is { } why)
        {
            if (why != busyLogged) Log.Write($"idle, but {why}: waiting");
            busyLogged = why;
            return;
        }
        busyLogged = null;
        idleDoneFor = last;
        Log.Write($"idle for {IdleWatch.Idle.TotalSeconds:0} s: opening the portal");
        Open(doLock: true, idle: true);
    }

    void WatchTouch()
    {
        bool watching = holding || (phase == Phase.Outro && byItself);
        if (watching && Native.LastInputTick() != touchBaseline) Touched("input"); // keys also come through the catcher
        // Windows locks within moments of being asked. If it has not, do not go on swallowing keys.
        if (touched == null || DateTime.UtcNow - touched < TimeSpan.FromSeconds(5)) return;
        Log.Write("Windows did not lock: giving the desktop back");
        EndHold();
        StartIntro();
    }

    async void OnSession(bool locked)
    {
        Log.Write(locked ? "session locked" : "session unlocked");
        if (locked)
        {
            EndHold();
            if (phase == Phase.Locked || !ov.Ready) return;
            // Locked some other way (Win+L, Ctrl+Alt+Del, screensaver, timeout): cover the desktop with
            // the gate at rest now, behind the lock screen, so the portal can throw it back out on unlock.
            var wasIdle = phase == Phase.Idle;
            Enter(Phase.Locked);
            frameReady = new TaskCompletionSource();
            ov.PostSealed(animate: false);
            if (wasIdle) await Task.WhenAny(frameReady.Task, Task.Delay(800));
            if (phase == Phase.Locked) ov.MoveOn();
        }
        else if (phase == Phase.Locked)
        {
            StartIntro();
        }
    }

    void Watchdog()
    {
        WatchTouch();
        WatchIdle();
        if (phase is not (Phase.Outro or Phase.Intro)) return;
        bool esc = (Native.GetAsyncKeyState(0x1B) & 0x8000) != 0;
        bool stuck = DateTime.UtcNow - phaseStart > TimeSpan.FromSeconds(20);
        if (esc || stuck)
        {
            Log.Write(esc ? "cancelled with Esc" : "watchdog: animation took too long");
            Finish();
        }
    }

    void Finish()
    {
        cover.HideNow();
        ov.MoveOff();
        ov.Post(new { cmd = "abort" });
        Enter(Phase.Idle);
        EndHold();
    }

    void Track(CoreWebView2SharedBuffer? buf)
    {
        if (buf != null) inFlight.Add(buf);
    }

    static void DisposeAll(List<Img> imgs, Bitmap? shot)
    {
        foreach (var bmp in imgs.Select(i => i.Bmp).Append(shot).Distinct())
            bmp?.Dispose();
    }
}
