using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace PortalLock;

/// <summary>
/// A plain layered window showing the screenshot pixel-for-pixel, so it looks exactly like the
/// desktop. It goes up first; the WebView2 overlay then moves on-screen underneath it and is only
/// revealed once it has drawn a few frames there. Whatever WebView2 shows right after the move
/// (it briefly drops its content) stays hidden. Layered windows get their pixels before they are
/// shown, so the cover itself can't flash.
/// </summary>
sealed class Cover : Form
{
    const int WS_EX_LAYERED = 0x80000, ULW_ALPHA = 2;
    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_HIDEWINDOW = 0x80;

    public Cover()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    public unsafe void ShowImage(Bitmap shot, Rectangle at)
    {
        var info = new BITMAPINFOHEADER
        {
            biSize = Marshal.SizeOf<BITMAPINFOHEADER>(), biWidth = shot.Width, biHeight = -shot.Height, // top-down
            biPlanes = 1, biBitCount = 32,
        };
        var screenDc = GetDC(IntPtr.Zero);
        var memDc = CreateCompatibleDC(screenDc);
        var dib = CreateDIBSection(screenDc, ref info, 0, out var bits, IntPtr.Zero, 0);
        var old = SelectObject(memDc, dib);
        try
        {
            var data = shot.LockBits(new Rectangle(Point.Empty, shot.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            long row = shot.Width * 4L;
            for (int y = 0; y < shot.Height; y++)
                Buffer.MemoryCopy((byte*)data.Scan0 + (long)y * data.Stride, (byte*)bits + y * row, row, row);
            shot.UnlockBits(data);

            var dst = at.Location;
            var size = at.Size;
            var src = Point.Empty;
            var blend = new BLENDFUNCTION { SourceConstantAlpha = 255 }; // opaque; per-pixel alpha ignored
            UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA);
        }
        finally
        {
            SelectObject(memDc, old);
            DeleteObject(dib);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
        Native.SetWindowPos(Handle, Native.HWND_TOPMOST, at.X, at.Y, at.Width, at.Height,
                            Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
    }

    public void HideNow()
    {
        if (IsHandleCreated)
            Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
                                Native.SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_HIDEWINDOW);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    [DllImport("user32")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage,
                                                               out IntPtr bits, IntPtr section, uint offset);
    [DllImport("user32")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dstDc, ref Point dst, ref Size size,
                                                                 IntPtr srcDc, ref Point src, int key,
                                                                 ref BLENDFUNCTION blend, int flags);
}
