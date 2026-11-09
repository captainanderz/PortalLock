using System.Runtime.InteropServices;
using System.Text;

namespace PortalLock;

static class Native
{
    public const int WM_HOTKEY = 0x0312, WM_WTSSESSION_CHANGE = 0x02B1, WM_DPICHANGED = 0x02E0,
        WM_DISPLAYCHANGE = 0x007E, WM_GETMINMAXINFO = 0x0024;
    public const int WTS_SESSION_LOCK = 7, WTS_SESSION_UNLOCK = 8;
    public const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_SHIFT = 4, MOD_NOREPEAT = 0x4000;
    public const uint SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
    public const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000,
        WS_EX_NOACTIVATE = 0x08000000;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
    public static readonly IntPtr HWND_TOPMOST = new(-1), HWND_NOTOPMOST = new(-2);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int L, T, R, B;
        public readonly Rectangle ToRect() => Rectangle.FromLTRB(L, T, R, B);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO
    {
        public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize;
    }

    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32")] public static extern bool LockWorkStation();
    [DllImport("user32")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
    [DllImport("user32")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
    [DllImport("user32")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32")] public static extern IntPtr GetShellWindow();
    [DllImport("user32")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("dwmapi", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowRect(IntPtr h, int attr, out RECT value, int size);
    [DllImport("wtsapi32")] public static extern bool WTSRegisterSessionNotification(IntPtr h, int flags);
    [DllImport("wtsapi32")] public static extern bool WTSUnRegisterSessionNotification(IntPtr h);

    public static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(128);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static bool IsCloaked(IntPtr h) =>
        DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out int c, 4) == 0 && c != 0;

    public static Rectangle FrameBounds(IntPtr h)
    {
        if (DwmGetWindowRect(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out var r, 16) == 0) return r.ToRect();
        GetWindowRect(h, out r);
        return r.ToRect();
    }
}

static class Log
{
    static readonly string Path = System.IO.Path.Combine(App.DataDir, "log.txt");

    public static void Write(string msg)
    {
        try
        {
            Directory.CreateDirectory(App.DataDir);
            File.AppendAllText(Path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {msg}{Environment.NewLine}");
        }
        catch { /* logging must never break the app */ }
    }
}
