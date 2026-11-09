using System.Drawing.Imaging;

namespace PortalLock;

/// <summary>One image to ship to the page: pixels in <see cref="Src"/> of <see cref="Bmp"/>,
/// placed at <see cref="Dest"/> in overlay coordinates (0,0 = top-left of the virtual screen).</summary>
sealed record Img(string Kind, Bitmap Bmp, Rectangle Src, Rectangle Dest, int Radius);

static class Capture
{
    const int MaxWindows = 20;

    static readonly HashSet<string> SkipClasses =
    [
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland",
    ];

    public static Bitmap Screen(Rectangle vs)
    {
        var b = new Bitmap(vs.Width, vs.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(b);
        g.CopyFromScreen(vs.Left, vs.Top, 0, 0, vs.Size, CopyPixelOperation.SourceCopy);
        return b;
    }

    /// <summary>Background (wallpaper + icons + taskbars) followed by window sprites, topmost first.</summary>
    public static List<Img> Layers(Rectangle vs, Bitmap shot, uint selfPid)
    {
        var list = new List<Img>();
        var full = new Rectangle(Point.Empty, vs.Size);

        var bg = DesktopBackground(vs, shot);
        if (bg != null) list.Add(new Img("bg", bg, full, full, 0));

        foreach (var h in VisibleWindows(vs, selfPid).Take(MaxWindows))
        {
            try { if (WindowSprite(h, vs, shot) is { } img) list.Add(img); }
            catch (Exception ex) { Log.Write($"sprite failed: {ex.Message}"); }
        }
        return list;
    }

    static Bitmap? DesktopBackground(Rectangle vs, Bitmap shot)
    {
        var shell = Native.GetShellWindow();
        if (shell == IntPtr.Zero || !Native.GetWindowRect(shell, out var r) || r.ToRect() != vs) return null;
        var bg = PrintBmp(shell, vs.Size);
        if (bg == null || MostlyBlack(bg, new Rectangle(Point.Empty, vs.Size))) { bg?.Dispose(); return null; }

        // Taskbars are not part of the shell window; paste them in from the screenshot.
        Native.EnumWindows((h, _) =>
        {
            var cls = Native.ClassOf(h);
            if ((cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") && Native.IsWindowVisible(h)
                && Native.GetWindowRect(h, out var tr))
            {
                var rect = Rectangle.Intersect(tr.ToRect(), vs);
                rect.Offset(-vs.X, -vs.Y);
                if (rect.Width > 0 && rect.Height > 0) CopyRect(shot, bg, rect);
            }
            return true;
        }, IntPtr.Zero);
        return bg;
    }

    static List<IntPtr> VisibleWindows(Rectangle vs, uint selfPid)
    {
        var found = new List<IntPtr>();
        Native.EnumWindows((h, _) =>
        {
            if (!Native.IsWindowVisible(h) || Native.IsIconic(h) || Native.IsCloaked(h)) return true;
            Native.GetWindowThreadProcessId(h, out var pid);
            if (pid == selfPid || SkipClasses.Contains(Native.ClassOf(h))) return true;
            long ex = Native.GetWindowLongPtr(h, -20 /* GWL_EXSTYLE */).ToInt64();
            if ((ex & Native.WS_EX_TRANSPARENT) != 0 || (ex & Native.WS_EX_NOACTIVATE) != 0) return true;
            if ((ex & Native.WS_EX_TOOLWINDOW) != 0 && (ex & Native.WS_EX_APPWINDOW) == 0) return true;
            var f = Native.FrameBounds(h);
            if (f.Width < 60 || f.Height < 40 || !f.IntersectsWith(vs)) return true;
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static Img? WindowSprite(IntPtr h, Rectangle vs, Bitmap shot)
    {
        var frame = Native.FrameBounds(h);
        if (!Native.GetWindowRect(h, out var wr)) return null;
        var win = wr.ToRect();
        int radius = Native.IsZoomed(h) ? 0 : (int)Math.Round(8 * Math.Max(96u, Native.GetDpiForWindow(h)) / 96.0);

        // Preferred: the window's own pixels, even where other windows cover it.
        var bmp = PrintBmp(h, win.Size);
        if (bmp != null)
        {
            var src = Rectangle.Intersect(new Rectangle(frame.X - win.X, frame.Y - win.Y, frame.Width, frame.Height),
                                          new Rectangle(Point.Empty, win.Size));
            if (src.Width > 0 && src.Height > 0 && !MostlyBlack(bmp, src))
            {
                var dest = new Rectangle(src.X + win.X - vs.X, src.Y + win.Y - vs.Y, src.Width, src.Height);
                return new Img("win", bmp, src, dest, radius);
            }
            bmp.Dispose();
        }

        // Fallback: cut the window's rectangle out of the screenshot.
        var vis = Rectangle.Intersect(frame, vs);
        if (vis.Width <= 0 || vis.Height <= 0) return null;
        vis.Offset(-vs.X, -vs.Y);
        return new Img("win", shot, vis, vis, radius);
    }

    static Bitmap? PrintBmp(IntPtr h, Size size)
    {
        if (size.Width <= 0 || size.Height <= 0) return null;
        var bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        bool ok;
        using (var g = Graphics.FromImage(bmp))
        {
            var dc = g.GetHdc();
            ok = Native.PrintWindow(h, dc, 2 /* PW_RENDERFULLCONTENT */);
            g.ReleaseHdc(dc);
        }
        if (ok) return bmp;
        bmp.Dispose();
        return null;
    }

    /// <summary>True when fewer than 3% of a sampled grid of pixels have any brightness.</summary>
    public static unsafe bool MostlyBlack(Bitmap b, Rectangle r)
    {
        var data = b.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            const int Grid = 16;
            int lit = 0;
            for (int gy = 0; gy < Grid; gy++)
            for (int gx = 0; gx < Grid; gx++)
            {
                int x = (int)((gx + 0.5) * r.Width / Grid), y = (int)((gy + 0.5) * r.Height / Grid);
                byte* p = (byte*)data.Scan0 + (long)y * data.Stride + x * 4;
                if (p[0] + p[1] + p[2] > 30) lit++;
            }
            return lit < Grid * Grid * 3 / 100;
        }
        finally { b.UnlockBits(data); }
    }

    static unsafe void CopyRect(Bitmap src, Bitmap dst, Rectangle r)
    {
        var s = src.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var d = dst.LockBits(r, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (int y = 0; y < r.Height; y++)
                Buffer.MemoryCopy((byte*)s.Scan0 + (long)y * s.Stride, (byte*)d.Scan0 + (long)y * d.Stride,
                                  r.Width * 4L, r.Width * 4L);
        }
        finally { src.UnlockBits(s); dst.UnlockBits(d); }
    }

    /// <summary>Copies the image's pixels (BGRA, tightly packed) to <paramref name="dst"/>.</summary>
    public static unsafe void CopyOut(Img img, byte* dst)
    {
        var data = img.Bmp.LockBits(img.Src, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            long row = img.Src.Width * 4L;
            for (int y = 0; y < img.Src.Height; y++)
                Buffer.MemoryCopy((byte*)data.Scan0 + (long)y * data.Stride, dst + y * row, row, row);
        }
        finally { img.Bmp.UnlockBits(data); }
    }
}
