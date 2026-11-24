// A tiny web server for working on the animation in a browser (run it from the repository's folder):
//
//   dotnet run tools/serve.cs -- PortalLock/web 8787 out/lockscreen.png
//
// then open http://localhost:8787/portal.html (the animation on a fake desktop) or
// http://localhost:8787/lockscreen.html?w=2560&h=1440 (the gate at rest). Anything the page POSTs to
// /save is written to the given file, or with /save?name=x.png to x.png next to it; lockscreen.js uses
// this for `await savePng()` in the browser console.
using System.Net;

var root = Path.GetFullPath(args.ElementAtOrDefault(0) ?? "PortalLock/web");
var port = int.Parse(args.ElementAtOrDefault(1) ?? "8787");
var save = Path.GetFullPath(args.ElementAtOrDefault(2) ?? "out/lockscreen.png");
Directory.CreateDirectory(Path.GetDirectoryName(save)!);
var http = new HttpListener();
http.Prefixes.Add($"http://localhost:{port}/");
http.Start();
Console.WriteLine($"serving {root} on http://localhost:{port}/");
var types = new Dictionary<string, string> { [".html"] = "text/html", [".js"] = "text/javascript", [".png"] = "image/png", [".bin"] = "application/octet-stream" };
while (true)
{
    var ctx = await http.GetContextAsync();
    try
    {
        var path = Uri.UnescapeDataString(ctx.Request.Url!.AbsolutePath.TrimStart('/'));
        if (ctx.Request.HttpMethod == "POST" && path == "save")
        {
            var name = ctx.Request.QueryString["name"];
            var to = name == null ? save : Path.Combine(Path.GetDirectoryName(save)!, Path.GetFileName(name));
            using var fs = File.Create(to);
            await ctx.Request.InputStream.CopyToAsync(fs);
            Console.WriteLine($"saved {fs.Length} bytes to {to}");
        }
        else
        {
            var file = Path.GetFullPath(Path.Combine(root, path == "" ? "portal.html" : path));
            if (!file.StartsWith(root + Path.DirectorySeparatorChar) || !File.Exists(file)) ctx.Response.StatusCode = 404;
            else
            {
                ctx.Response.ContentType = types.GetValueOrDefault(Path.GetExtension(file), "application/octet-stream");
                ctx.Response.Headers["Cache-Control"] = "no-store";
                await ctx.Response.OutputStream.WriteAsync(await File.ReadAllBytesAsync(file));
            }
        }
    }
    catch (Exception e) { Console.WriteLine(e.Message); ctx.Response.StatusCode = 500; }
    ctx.Response.Close();
}
