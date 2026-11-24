using System.Drawing.Drawing2D;
using Microsoft.Win32;

namespace PortalLock;

static class App
{
    public static readonly string DataDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PortalLock");

    /// <summary>Commands for the running copy (<c>PortalLock.exe lock</c>, ...); a second copy passes them on.</summary>
    public static readonly string[] Commands = ["lock", "test", "lockscreen"];
    public static string EventName(string command) => @"Local\PortalLock." + command;

    [STAThread]
    static void Main(string[] args)
    {
        var action = args.FirstOrDefault()?.TrimStart('-', '/').ToLowerInvariant() ?? "";

        // Windows runs screensavers as "PortalLock.scr /s"; "/p <hwnd>" (preview) and "/c" (settings)
        // are not supported, and an .scr started with no arguments means "settings" too.
        if (action == "s" || action.StartsWith("s:"))
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new ScreenSaverApp());
            return;
        }
        bool isScr = Environment.ProcessPath?.EndsWith(".scr", StringComparison.OrdinalIgnoreCase) == true;
        if (isScr || action.StartsWith('p') || action.StartsWith('c')) return;
        if (action == "guard") { HoldGuard.Run(args.ElementAtOrDefault(1)); return; }
        if (action == "screensaver-on") { ScreenSaverSetup.Enable(); return; }
        if (action == "screensaver-off") { ScreenSaverSetup.Disable(); return; }

        using var mutex = new Mutex(true, @"Local\PortalLock.Instance", out bool first);
        if (!first)
        {
            // Already running: pass the command on to that copy.
            if (Commands.Contains(action) && EventWaitHandle.TryOpenExisting(EventName(action), out var ev)) ev.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp(action));
    }
}

sealed class TrayApp : ApplicationContext
{
    const int HotkeyLock = 1, HotkeyTest = 2;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    readonly Overlay ov = new();
    readonly Director director;
    readonly NotifyIcon icon;

    public TrayApp(string initial)
    {
        director = new Director(ov);
        ov.Hotkey += id => director.Open(doLock: id == HotkeyLock);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open portal and lock\tCtrl+Alt+Shift+L", null, (_, _) => director.Open(true));
        menu.Items.Add("Preview (no lock)\tCtrl+Alt+Shift+T", null, (_, _) => director.Open(false));
        menu.Items.Add("Save lock screen picture", null, (_, _) => SavePicture());
        menu.Items.Add(new ToolStripSeparator());
        var autostart = new ToolStripMenuItem("Start with Windows") { Checked = IsAutostart(), CheckOnClick = true };
        autostart.CheckedChanged += (_, _) => SetAutostart(autostart.Checked);
        menu.Items.Add(autostart);
        var idle = new ToolStripMenuItem($"Open the portal after {IdleWatch.After.TotalMinutes:0.#} minutes idle")
            { Checked = Settings.IdlePortal, CheckOnClick = true };
        idle.CheckedChanged += (_, _) => Settings.IdlePortal = idle.Checked;
        menu.Items.Add(idle);
        var hold = new ToolStripMenuItem("Keep the gate up until the PC is touched") { Checked = Settings.HoldGate, CheckOnClick = true };
        hold.CheckedChanged += (_, _) => Settings.HoldGate = hold.Checked;
        menu.Items.Add(hold);
        // The idle portal replaces PortalLock as Windows' screensaver: both would cover the same idle PC.
        if (Settings.IdlePortal && ScreenSaverSetup.IsEnabled())
        {
            Log.Write("the idle portal replaces the Windows screensaver");
            ScreenSaverSetup.Disable();
        }
        ScreenSaverSetup.RefreshIfEnabled();
        menu.Items.Add("Open log folder", null, (_, _) => System.Diagnostics.Process.Start("explorer.exe", App.DataDir));
        menu.Items.Add("Exit", null, (_, _) => Quit());

        icon = new NotifyIcon { Icon = MakeIcon(), Text = "PortalLock", ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += (_, _) => director.Open(false);

        ListenForSignals();
        _ = StartAsync(initial);
    }

    async Task StartAsync(string initial)
    {
        try
        {
            var web = Path.Combine(AppContext.BaseDirectory, "web");
            if (File.Exists(Path.Combine(web, "gate.js")))
            {
                await ov.InitAsync(web);
                await director.CheckParkedRenderingAsync();
            }
            else
            {
                // The Dark Portal is Blizzard's, so it is not in the repository: everyone converts their own.
                Log.Write("no Dark Portal yet: web\\gate.js is missing (see the README: tools\\convert-gate.ps1)");
                icon.ShowBalloonTip(15000, "PortalLock", "The Dark Portal isn't installed yet: export it with wow.export, run " +
                    "tools\\convert-gate.ps1 and build again (see the README). Until then the hotkey just locks.", ToolTipIcon.Warning);
            }
            var mods = Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_SHIFT | Native.MOD_NOREPEAT;
            bool a = Native.RegisterHotKey(ov.Handle, HotkeyLock, mods, (uint)Keys.L);
            bool b = Native.RegisterHotKey(ov.Handle, HotkeyTest, mods, (uint)Keys.T);
            Log.Write($"ready (hotkeys lock={a} test={b})");
            if (!a || !b)
                icon.ShowBalloonTip(5000, "PortalLock", "A hotkey is taken by another app. Use the tray menu instead.", ToolTipIcon.Warning);
            Run(initial);
        }
        catch (Exception ex)
        {
            Log.Write($"startup failed: {ex}");
            icon.ShowBalloonTip(8000, "PortalLock", $"Could not start the portal: {ex.Message}", ToolTipIcon.Error);
        }
    }

    void Run(string command)
    {
        if (command == "lock") director.Open(true);
        else if (command == "test") director.Open(false);
        else if (command == "lockscreen") SavePicture();
    }

    void ListenForSignals()
    {
        var handles = App.Commands.Select(c => (WaitHandle)new EventWaitHandle(false, EventResetMode.AutoReset, App.EventName(c))).ToArray();
        var t = new Thread(() =>
        {
            while (true)
            {
                int i = WaitHandle.WaitAny(handles);
                try { ov.BeginInvoke(() => Run(App.Commands[i])); } catch { return; }
            }
        }) { IsBackground = true, Name = "PortalLock signals" };
        t.Start();
    }

    /// <summary>Saves the lock screen picture to Pictures and opens Windows' lock screen settings to pick it.</summary>
    async void SavePicture()
    {
        try
        {
            var path = await director.SaveLockScreenPicture();
            if (path == null)
            {
                icon.ShowBalloonTip(5000, "PortalLock", ov.Ready ? "The portal is busy. Try again in a moment."
                    : "The Dark Portal isn't installed yet (see the README).", ToolTipIcon.Info);
                return;
            }
            icon.ShowBalloonTip(10000, "PortalLock", $"Saved as {path}. Pick it under Personalize your lock screen → " +
                "Picture → Browse photos.", ToolTipIcon.Info);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:lockscreen") { UseShellExecute = true })?.Dispose();
        }
        catch (Exception ex)
        {
            Log.Write($"saving the lock screen picture failed: {ex}");
            icon.ShowBalloonTip(8000, "PortalLock", $"Could not save the lock screen picture: {ex.Message}", ToolTipIcon.Error);
        }
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
