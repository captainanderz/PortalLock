using Microsoft.Win32;

namespace PortalLock;

/// <summary>
/// <c>PortalLock.scr /s</c>: while the PC is idle the sealed crack comes alive (mist turning, embers
/// drifting, the crack breathing). Any input ends it; Windows then locks ("On resume, display logon
/// screen") and the lock screen shows the same crack, frozen.
/// </summary>
sealed class ScreenSaverApp : ApplicationContext
{
    readonly Overlay ov = new();
    readonly System.Windows.Forms.Timer watch = new() { Interval = 100 };
    uint baseline;

    public ScreenSaverApp()
    {
        watch.Tick += (_, _) => { if (Native.LastInputTick() != baseline) ExitThread(); };
        _ = RunAsync();
    }

    async Task RunAsync()
    {
        try
        {
            await ov.InitAsync(Path.Combine(AppContext.BaseDirectory, "web"), "WebView2-screensaver");
            var frame = new TaskCompletionSource();
            ov.JsMessage += m => { if (m == "frame") frame.TrySetResult(); };
            ov.PostSealed(animate: true);
            await Task.WhenAny(frame.Task, Task.Delay(1500));
            ov.MoveOn();
            await Task.Delay(500); // ignore the tail end of whatever input happened before we started
            baseline = Native.LastInputTick();
            watch.Start();
        }
        catch (Exception ex)
        {
            Log.Write($"screensaver failed: {ex}");
            ExitThread();
        }
    }

    protected override void ExitThreadCore()
    {
        watch.Stop();
        ov.Close();
        base.ExitThreadCore();
    }
}

/// <summary>Installs PortalLock as the user's screensaver: a copy of the exe named PortalLock.scr.</summary>
static class ScreenSaverSetup
{
    const string DesktopKey = @"Control Panel\Desktop";
    const uint Flags = Native.SPIF_UPDATEINIFILE_SENDCHANGE;

    static string ScrPath => Path.ChangeExtension(Environment.ProcessPath!, ".scr");

    public static bool IsEnabled()
    {
        using var k = Registry.CurrentUser.OpenSubKey(DesktopKey);
        return string.Equals(k?.GetValue("SCRNSAVE.EXE") as string, ScrPath, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Starts after <paramref name="minutes"/> idle and locks the PC when it ends.</summary>
    public static void Enable(int minutes = 10)
    {
        File.Copy(Environment.ProcessPath!, ScrPath, overwrite: true);
        using (var k = Registry.CurrentUser.CreateSubKey(DesktopKey))
            k.SetValue("SCRNSAVE.EXE", ScrPath);
        Native.SystemParametersInfo(Native.SPI_SETSCREENSAVETIMEOUT, (uint)(minutes * 60), IntPtr.Zero, Flags);
        Native.SystemParametersInfo(Native.SPI_SETSCREENSAVESECURE, 1, IntPtr.Zero, Flags);
        Native.SystemParametersInfo(Native.SPI_SETSCREENSAVEACTIVE, 1, IntPtr.Zero, Flags);
        Log.Write($"screensaver enabled ({minutes} min)");
    }

    public static void Disable()
    {
        if (!IsEnabled()) return;
        using (var k = Registry.CurrentUser.CreateSubKey(DesktopKey))
            k.DeleteValue("SCRNSAVE.EXE", false);
        Log.Write("screensaver disabled");
    }

    /// <summary>After a rebuild the .scr copy is stale; refresh it if PortalLock is the screensaver.</summary>
    public static void RefreshIfEnabled()
    {
        try
        {
            if (IsEnabled() && File.GetLastWriteTimeUtc(ScrPath) < File.GetLastWriteTimeUtc(Environment.ProcessPath!))
                File.Copy(Environment.ProcessPath!, ScrPath, overwrite: true);
        }
        catch (IOException) { /* the screensaver is running right now; next start will do */ }
    }
}
