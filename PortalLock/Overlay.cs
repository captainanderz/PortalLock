using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace PortalLock;

/// <summary>
/// One borderless window covering the whole virtual desktop (all monitors), hosting a WebView2 page
/// that draws the animation. Between runs it is parked off-screen (still "visible", so WebView2 keeps
/// rendering and the first frame is ready before it is moved on-screen). It is excluded from screen
/// capture so we can photograph the real desktop underneath it after an unlock.
/// </summary>
sealed class Overlay : Form
{
    CoreWebView2Environment? env;
    CoreWebView2Controller? ctl;

    public Rectangle Virtual { get; private set; } = SystemInformation.VirtualScreen;
    public bool Ready { get; private set; }
    public event Action<string>? JsMessage;
    public event Action<int>? Hotkey;
    public event Action<bool>? SessionLocked;

    public Overlay()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.Black;
        Text = "PortalLock";
        Bounds = OffRect(Virtual);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    static Rectangle OffRect(Rectangle v) => new(v.Left - v.Width - 500, v.Top, v.Width, v.Height);

    public async Task InitAsync(string webDir, string profile = "WebView2")
    {
        Show();
        Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE);
        Native.WTSRegisterSessionNotification(Handle, 0);

        env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(App.DataDir, profile));
        ctl = await env.CreateCoreWebView2ControllerAsync(Handle);
        ctl.ShouldDetectMonitorScaleChanges = false;
        ctl.BoundsMode = CoreWebView2BoundsMode.UseRawPixels;
        ctl.RasterizationScale = 1.0;
        ctl.DefaultBackgroundColor = Color.Black;
        ctl.Bounds = new Rectangle(Point.Empty, Virtual.Size);

        var web = ctl.CoreWebView2;
        web.Settings.AreDefaultContextMenusEnabled = false;
        web.Settings.IsZoomControlEnabled = false;
        web.Settings.IsStatusBarEnabled = false;
        web.Settings.AreBrowserAcceleratorKeysEnabled = false;
        web.SetVirtualHostNameToFolderMapping("portal.local", webDir, CoreWebView2HostResourceAccessKind.Allow);

        var loaded = new TaskCompletionSource();
        web.WebMessageReceived += (_, e) =>
        {
            var msg = e.TryGetWebMessageAsString();
            if (msg == "ready") loaded.TrySetResult();
            JsMessage?.Invoke(msg);
        };
        web.Navigate("https://portal.local/portal.html");
        if (await Task.WhenAny(loaded.Task, Task.Delay(15000)) != loaded.Task)
            throw new TimeoutException("Portal page did not load.");
        Ready = true;
    }

    /// <summary>Re-reads the monitor layout; returns true if it changed.</summary>
    public bool SyncBounds()
    {
        var v = SystemInformation.VirtualScreen;
        if (v == Virtual) return false;
        Virtual = v;
        var r = OffRect(v);
        Native.SetWindowPos(Handle, Native.HWND_NOTOPMOST, r.X, r.Y, r.Width, r.Height, Native.SWP_NOACTIVATE);
        if (ctl != null) ctl.Bounds = new Rectangle(Point.Empty, v.Size);
        return true;
    }

    public void MoveOn() => Native.SetWindowPos(Handle, Native.HWND_TOPMOST, Virtual.X, Virtual.Y,
        Virtual.Width, Virtual.Height, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);

    public void MoveOff()
    {
        var r = OffRect(Virtual);
        Native.SetWindowPos(Handle, Native.HWND_NOTOPMOST, r.X, r.Y, r.Width, r.Height, Native.SWP_NOACTIVATE);
    }

    public void Post(object message) => ctl?.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));

    /// <summary>Packs the images into one shared buffer and hands it to the page with the scene geometry.
    /// The caller must dispose the returned buffer once the page reports "loaded".</summary>
    public unsafe CoreWebView2SharedBuffer? PostScene(string mode, string part, IReadOnlyList<Img> imgs)
    {
        if (env == null || ctl == null) return null;
        long total = imgs.Sum(i => (long)i.Src.Width * i.Src.Height * 4);
        var buf = env.CreateSharedBuffer((ulong)Math.Max(total, 4));
        var entries = new List<object>();
        long off = 0;
        byte* basePtr = (byte*)buf.Buffer;
        foreach (var img in imgs)
        {
            PortalLock.Capture.CopyOut(img, basePtr + off);
            entries.Add(new { kind = img.Kind, off, w = img.Src.Width, h = img.Src.Height,
                              x = img.Dest.X, y = img.Dest.Y, r = img.Radius });
            off += (long)img.Src.Width * img.Src.Height * 4;
        }

        var meta = Geometry();
        meta["cmd"] = "scene";
        meta["mode"] = mode;
        meta["part"] = part;
        meta["images"] = entries;
        ctl.CoreWebView2.PostSharedBufferToScript(buf, CoreWebView2SharedBufferAccess.ReadWrite,
                                                  JsonSerializer.Serialize(meta));
        return buf;
    }

    /// <summary>Shows the sealed crack (the lock screen picture); animated for the screensaver.</summary>
    public void PostSealed(bool animate)
    {
        var meta = Geometry();
        meta["cmd"] = "sealed";
        meta["animate"] = animate;
        Post(meta);
    }

    /// <summary>Portal centre and size, and the primary monitor (the lock screen picture's frame),
    /// all in overlay pixels.</summary>
    Dictionary<string, object> Geometry()
    {
        var p = Screen.PrimaryScreen!.Bounds;
        return new()
        {
            ["vw"] = Virtual.Width, ["vh"] = Virtual.Height,
            ["px"] = p.X - Virtual.X + p.Width / 2.0, ["py"] = p.Y - Virtual.Y + p.Height / 2.0,
            ["rx"] = p.Height * 0.19, ["ry"] = p.Height * 0.27,
            ["fx"] = p.X - Virtual.X, ["fy"] = p.Y - Virtual.Y, ["fw"] = p.Width, ["fh"] = p.Height,
        };
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case Native.WM_DPICHANGED:
                m.Result = IntPtr.Zero; // keep our raw-pixel bounds; never let WinForms rescale us
                return;
            case Native.WM_GETMINMAXINFO:
                base.WndProc(ref m);
                var mmi = Marshal.PtrToStructure<Native.MINMAXINFO>(m.LParam);
                mmi.MaxTrackSize = new Point(32000, 32000);
                Marshal.StructureToPtr(mmi, m.LParam, false);
                return;
            case Native.WM_HOTKEY:
                Hotkey?.Invoke((int)m.WParam);
                break;
            case Native.WM_WTSSESSION_CHANGE:
                if ((int)m.WParam == Native.WTS_SESSION_LOCK) SessionLocked?.Invoke(true);
                else if ((int)m.WParam == Native.WTS_SESSION_UNLOCK) SessionLocked?.Invoke(false);
                break;
        }
        base.WndProc(ref m);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (IsHandleCreated) Native.WTSUnRegisterSessionNotification(Handle);
            ctl?.Close();
        }
        base.Dispose(disposing);
    }
}
