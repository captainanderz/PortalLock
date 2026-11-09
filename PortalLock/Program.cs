using System.Drawing.Drawing2D;
using Microsoft.Win32;

namespace PortalLock;

static class App
{
    public static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PortalLock");

    const string LockEvent = @"Local\PortalLock.Lock", TestEvent = @"Local\PortalLock.Test";

    [STAThread]
    static void Main(string[] args)
    {
        var action = args.FirstOrDefault()?.TrimStart('-', '/').ToLowerInvariant();
        using var mutex = new Mutex(true, @"Local\PortalLock.Instance", out bool first);
        if (!first)
        {
            // Already running: forward "lock"/"test" to the resident instance.
            var name = action == "test" ? TestEvent : action == "lock" ? LockEvent : null;
            if (name != null && EventWaitHandle.TryOpenExisting(name, out var ev)) ev.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp(action, LockEvent, TestEvent));
    }
}

sealed class TrayApp : ApplicationContext
{
    const int HotkeyLock = 1, HotkeyTest = 2;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    readonly Overlay ov = new();
    readonly Director director;
    readonly NotifyIcon icon;

    public TrayApp(string? initial, string lockEvent, string testEvent)
    {
        director = new Director(ov);
        ov.Hotkey += id => director.Open(doLock: id == HotkeyLock);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open portal and lock\tCtrl+Alt+Shift+L", null, (_, _) => director.Open(true));
        menu.Items.Add("Preview (no lock)\tCtrl+Alt+Shift+T", null, (_, _) => director.Open(false));
        menu.Items.Add(new ToolStripSeparator());
        var autostart = new ToolStripMenuItem("Start with Windows") { Checked = IsAutostart(), CheckOnClick = true };
        autostart.CheckedChanged += (_, _) => SetAutostart(autostart.Checked);
        menu.Items.Add(autostart);
        menu.Items.Add("Open log folder", null, (_, _) => System.Diagnostics.Process.Start("explorer.exe", App.DataDir));
        menu.Items.Add("Exit", null, (_, _) => Quit());

        icon = new NotifyIcon { Icon = MakeIcon(), Text = "PortalLock", ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += (_, _) => director.Open(false);

        ListenForSignals(lockEvent, testEvent);
        _ = StartAsync(initial);
    }

    async Task StartAsync(string? initial)
    {
        try
        {
            await ov.InitAsync(Path.Combine(AppContext.BaseDirectory, "web"));
            var mods = Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_SHIFT | Native.MOD_NOREPEAT;
            bool a = Native.RegisterHotKey(ov.Handle, HotkeyLock, mods, (uint)Keys.L);
            bool b = Native.RegisterHotKey(ov.Handle, HotkeyTest, mods, (uint)Keys.T);
            Log.Write($"ready (hotkeys lock={a} test={b})");
            if (!a || !b)
                icon.ShowBalloonTip(5000, "PortalLock", "A hotkey is taken by another app. Use the tray menu instead.", ToolTipIcon.Warning);
            if (initial == "lock") director.Open(true);
            else if (initial == "test") director.Open(false);
        }
        catch (Exception ex)
        {
            Log.Write($"startup failed: {ex}");
            icon.ShowBalloonTip(8000, "PortalLock", $"Could not start the portal: {ex.Message}", ToolTipIcon.Error);
        }
    }

    void ListenForSignals(string lockEvent, string testEvent)
    {
        var handles = new WaitHandle[]
        {
            new EventWaitHandle(false, EventResetMode.AutoReset, lockEvent),
            new EventWaitHandle(false, EventResetMode.AutoReset, testEvent),
        };
        var t = new Thread(() =>
        {
            while (true)
            {
                int i = WaitHandle.WaitAny(handles);
                try { ov.BeginInvoke(() => director.Open(doLock: i == 0)); } catch { return; }
            }
        }) { IsBackground = true, Name = "PortalLock signals" };
        t.Start();
    }

    static bool IsAutostart()
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey);
        return k?.GetValue("PortalLock") != null;
    }

    static void SetAutostart(bool on)
    {
        using var k = Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) k.SetValue("PortalLock", $"\"{Environment.ProcessPath}\"");
        else k.DeleteValue("PortalLock", false);
    }

    static Icon MakeIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var path = new GraphicsPath();
            path.AddEllipse(5, 1, 22, 30);
            using var brush = new PathGradientBrush(path)
            {
                CenterColor = Color.FromArgb(255, 8, 30, 4),
                SurroundColors = [Color.FromArgb(255, 150, 255, 70)],
                FocusScales = new PointF(0.45f, 0.45f),
            };
            g.FillEllipse(brush, 5, 1, 22, 30);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    void Quit()
    {
        Native.UnregisterHotKey(ov.Handle, HotkeyLock);
        Native.UnregisterHotKey(ov.Handle, HotkeyTest);
        icon.Visible = false;
        ov.Close();
        ExitThread();
    }
}
