using System.Runtime.InteropServices;

namespace PortalLock;

/// <summary>
/// When the PC has been left alone long enough for the portal to open by itself, as a screensaver
/// would. Windows' own screensaver can't do this here: on a managed PC its timeout is set by policy.
/// A screensaver is held off by apps playing video or giving a presentation; this has no such hook, so
/// it waits while an app is full screen or while any app has played sound in the last few seconds.
/// </summary>
static class IdleWatch
{
    public static readonly TimeSpan After = TimeSpan.FromSeconds(
        int.TryParse(Environment.GetEnvironmentVariable("PORTALLOCK_IDLE_SECONDS"), out int s) ? s : 180); // debugging override

    static readonly TimeSpan Quiet = TimeSpan.FromSeconds(10); // no sound for this long before it
    static int lastSound = Environment.TickCount - 60_000, heardAt;
    static IAudioSessionManager2? sessions;
    static int sessionsAt;

    /// <summary>How long since the last mouse or keyboard input.</summary>
    public static TimeSpan Idle => TimeSpan.FromMilliseconds((uint)Environment.TickCount - Native.LastInputTick());

    /// <summary>Called every tick: listens for sound from shortly before the portal is due.</summary>
    public static void Listen()
    {
        if (Idle < After - Quiet || Environment.TickCount - heardAt < 250) return;
        heardAt = Environment.TickCount;
        if (Peak() > 0.001f) lastSound = Environment.TickCount;
    }

    /// <summary>Why the portal should not open now, or null if it may.</summary>
    public static string? Busy()
    {
        if (SHQueryUserNotificationState(out int state) == 0)
        {
            if (state is 2 or 3 or 4) return "an app is full screen";
            if (state == 1) return "the PC is locked or away";
        }
        if (Environment.TickCount - lastSound < Quiet.TotalMilliseconds) return "sound is playing";
        return null;
    }

    /// <summary>The loudest sample any app is playing right now (0 to 1). It is measured per app, so it
    /// hears a video even with the speakers muted, and an app that keeps a silent stream open (as remote
    /// desktop tools do) does not count.</summary>
    static float Peak()
    {
        try
        {
            if (sessions == null || Environment.TickCount - sessionsAt > 5000) // the default speakers can change
            {
                Release(sessions);
                sessions = null;
                sessionsAt = Environment.TickCount;
                var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                try
                {
                    if (devices.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out var device) != 0) return 0;
                    var iid = typeof(IAudioSessionManager2).GUID;
                    if (device.Activate(ref iid, 0x17 /* CLSCTX_ALL */, IntPtr.Zero, out var m) == 0) sessions = (IAudioSessionManager2)m;
                    Release(device);
                }
                finally { Release(devices); }
            }
            if (sessions == null || sessions.GetSessionEnumerator(out var list) != 0) return 0;
            float loudest = 0;
            try
            {
                if (list.GetCount(out int n) != 0) return 0;
                for (int i = 0; i < n; i++)
                {
                    if (list.GetSession(i, out var session) != 0) continue;
                    if (session is IAudioMeterInformation meter && meter.GetPeakValue(out float peak) == 0)
                        loudest = Math.Max(loudest, peak);
                    Release(session);
                }
            }
            finally { Release(list); }
            return loudest;
        }
        catch (Exception ex) // only a hint: never worth crashing over
        {
            if (sessions != null || !failed) Log.Write($"idle: cannot hear the apps' sound: {ex.Message}");
            failed = true;
            sessions = null;
            return 0;
        }
    }
    static bool failed;

    static void Release(object? com)
    {
        if (com != null) Marshal.ReleaseComObject(com);
    }

    [DllImport("shell32")] static extern int SHQueryUserNotificationState(out int state);

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object item);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr group, int flags, out IntPtr control); // IAudioSessionManager
        [PreserveSig] int GetSimpleAudioVolume(IntPtr group, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }
}
