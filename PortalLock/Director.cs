using Microsoft.Web.WebView2.Core;

namespace PortalLock;

enum Phase { Idle, Outro, Locked, Intro }

/// <summary>Runs the show: portal swallows the desktop, PC locks, and on unlock the portal spits it back out.</summary>
sealed class Director
{
    readonly Overlay ov;
    readonly uint selfPid = (uint)Environment.ProcessId;
    readonly System.Windows.Forms.Timer tick = new() { Interval = 40 };
    readonly List<CoreWebView2SharedBuffer> inFlight = [];
    readonly Cover cover = new();
    TaskCompletionSource? frameReady, running;
    Phase phase = Phase.Idle;
    bool lockAfter;
    DateTime phaseStart;

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

    void Enter(Phase p)
    {
        phase = p;
        phaseStart = DateTime.UtcNow;
        Log.Write($"phase {p}");
    }

    /// <summary>Hotkey / menu entry point. <paramref name="doLock"/> false = preview without locking.</summary>
    public async void Open(bool doLock)
    {
        if (phase != Phase.Idle) return;
        if (!ov.Ready) { if (doLock) Native.LockWorkStation(); return; }
        Enter(Phase.Outro);
        lockAfter = doLock;
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
        ov.Post(new { cmd = "unlocked" }); // the crack comes alive while we photograph the desktop
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
                    if (!Native.LockWorkStation()) StartIntro();
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
            case var m when m.StartsWith("error"):
                Log.Write($"page {m}");
                break;
        }
    }

    async void OnSession(bool locked)
    {
        Log.Write(locked ? "session locked" : "session unlocked");
        if (locked)
        {
            if (phase == Phase.Locked || !ov.Ready) return;
            // Locked some other way (Win+L, Ctrl+Alt+Del, screensaver, timeout): cover the desktop with
            // the sealed crack now, behind the lock screen, so the portal can tear it open on unlock.
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
