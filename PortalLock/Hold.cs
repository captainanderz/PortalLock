using System.Diagnostics;
using Microsoft.Win32;

namespace PortalLock;

// Windows' lock screen shows one picture, repeated on every monitor. So after the lock animation the PC
// is not locked straight away: PortalLock keeps its own gate up, alive across all monitors, and locks
// the moment someone touches the PC (see Director.HoldGate). This file has what makes that safe.

/// <summary>The tray menu's on/off settings, in HKCU\Software\PortalLock. All are on unless turned off.</summary>
static class Settings
{
    const string Key = @"Software\PortalLock";

    /// <summary>Hold the gate after the lock animation. Off: the PC locks as soon as it ends.</summary>
    public static bool HoldGate { get => Get(nameof(HoldGate)); set => Set(nameof(HoldGate), value); }

    /// <summary>Open the portal by itself after a few minutes idle (see IdleWatch).</summary>
    public static bool IdlePortal { get => Get(nameof(IdlePortal)); set => Set(nameof(IdlePortal), value); }

    static readonly Dictionary<string, bool> known = []; // read often: from the registry once

    static bool Get(string name)
    {
        if (known.TryGetValue(name, out bool on)) return on;
        using var k = Registry.CurrentUser.OpenSubKey(Key);
        return known[name] = (k?.GetValue(name) as int? ?? 1) != 0;
    }

    static void Set(string name, bool on)
    {
        using var k = Registry.CurrentUser.CreateSubKey(Key);
        k.SetValue(name, on ? 1 : 0);
        known[name] = on;
    }
}

/// <summary>
/// While the gate is held the keyboard still belongs to whichever app had it. The key that wakes the PC,
/// and anything typed before Windows' lock screen is up (a password, typed blind), must not land there:
/// this swallows every key press and reports it.
/// </summary>
sealed class KeyCatcher : IDisposable
{
    readonly Native.HookProc proc; // kept alive here: Windows calls it
    readonly Action pressed;
    IntPtr hook;

    public KeyCatcher(Action pressed)
    {
        this.pressed = pressed;
        proc = OnKey;
        hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, proc, Native.GetModuleHandle(null), 0);
    }

    public bool Working => hook != IntPtr.Zero;

    IntPtr OnKey(int code, IntPtr w, IntPtr l)
    {
        if (code < 0) return Native.CallNextHookEx(hook, code, w, l);
        pressed();
        // Releases pass: one may belong to a key that went down before we were listening.
        bool down = (int)w is Native.WM_KEYDOWN or Native.WM_SYSKEYDOWN;
        return down ? 1 : Native.CallNextHookEx(hook, code, w, l);
    }

    public void Dispose()
    {
        if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
    }
}

/// <summary>
/// A second pair of eyes while the gate is held: a copy of PortalLock run as "PortalLock.exe guard pid".
/// The PC looks locked but is not yet. If the tray app dies, or has not locked two seconds after the PC
/// was touched, the guard locks it.
/// </summary>
static class HoldGuard
{
    /// <summary>Set whenever there is no hold to watch. The tray app owns it; a guard waits on it.</summary>
    public static EventWaitHandle Flag() => new(true, EventResetMode.ManualReset, @"Local\PortalLock.HoldOver");

    /// <summary>In the tray app, with the flag reset: starts a guard.</summary>
    public static void Start()
    {
        try
        {
            Process.Start(Environment.ProcessPath!, $"guard {Environment.ProcessId}")?.Dispose();
        }
        catch (Exception ex)
        {
            Log.Write($"could not start the guard: {ex.Message}");
        }
    }

    /// <summary>In the guard: watches until the hold is over.</summary>
    public static void Run(string? pid)
    {
        uint baseline = Native.LastInputTick();
        Process? app = null;
        try { app = Process.GetProcessById(int.Parse(pid ?? "")); }
        catch (Exception) { /* gone already */ }
        if (app == null || app.HasExited) { Lock("PortalLock is gone"); return; }
        using var over = Flag(); // the tray app made it long ago; this opens the same one
        while (!over.WaitOne(50))
        {
            if (app.HasExited) { Lock("PortalLock is gone"); return; }
            if (Native.LastInputTick() == baseline) continue;
            if (!over.WaitOne(2000)) Lock("PortalLock has not locked");
            return;
        }
    }

    static void Lock(string why)
    {
        Log.Write($"guard: {why}, locking");
        Native.LockWorkStation();
    }
}
