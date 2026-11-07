using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Reflection;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Babagan {
  internal static class Installer {
    [STAThread] static int Main(string[] args) {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      if (args.Length == 3 && args[0] == "--verify-package") {
        // Build/CI path: install only in a caller-owned test directory, no UI,
        // desktop shortcut, browser launch, capture or system registration.
        try { Task.Run(() => Install(args[1], args[2], new Progress<string>(), CancellationToken.None)).GetAwaiter().GetResult(); return 0; }
        catch (Exception e) { File.WriteAllText(Path.Combine(args[1], "verify-error.txt"), e.ToString()); return 1; }
      }
      Application.Run(new SetupForm()); return 0;
    }
    internal static async Task<string> Install(string root, string cache, IProgress<string> progress, CancellationToken token) {
      if (!Environment.Is64BitOperatingSystem) throw new Exception("此版本需要 64 位 Windows 10 或更新系统。");
      Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
      var stage = Package.Child(root, "stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
      try {
        progress.Report("正在准备 Babagan 组件…");
        using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) Package.Extract(payload, stage);
        progress.Report("正在检查已安装的运行依赖…");
        var paths = await Task.Run(() => new RuntimePaths { node = RuntimeDependencies.Find(root, true, token), ffmpeg = RuntimeDependencies.Find(root, false, token) }, token);
        bool reuseNode = paths.node != null, reuseFfmpeg = paths.ffmpeg != null;
        progress.Report("Node.js：" + (reuseNode ? "复用已安装版本" : "需要安装") + "；FFmpeg：" + (reuseFfmpeg ? "复用已安装版本" : "需要安装"));
        var node = reuseNode ? null : await Download(Package.NodeUrl, Package.NodeHash, cache, "Node.js 24", progress, token);
        var ffmpeg = reuseFfmpeg ? null : await Download(Package.FfmpegUrl, Package.FfmpegHash, cache, "FFmpeg 9.0.2", progress, token);
        progress.Report("正在准备所需组件，兼容的依赖直接复用…");
        await Task.Run(() => {
          token.ThrowIfCancellationRequested();
          if (!reuseNode) using (var stream = File.OpenRead(node)) Package.Extract(stream, Path.Combine(stage, "runtime"), name =>
            name == "node-v24.15.0-win-x64/node.exe" || name == "node-v24.15.0-win-x64/LICENSE" || name == "node-v24.15.0-win-x64/README.md");
          token.ThrowIfCancellationRequested();
          if (!reuseFfmpeg) using (var stream = File.OpenRead(ffmpeg)) Package.Extract(stream, Path.Combine(stage, "runtime"), name =>
            name == "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe" || name == "ffmpeg-9.0.2-essentials_build/LICENSE" || name == "ffmpeg-9.0.2-essentials_build/README.txt");
        }, token);
        paths.node = paths.node ?? Path.Combine(stage, Package.NodeRelative);
        paths.ffmpeg = paths.ffmpeg ?? Path.Combine(stage, Package.FfmpegRelative);
        RuntimeDependencies.Save(stage, paths);
        // Check the installed helper with the real runtime before making the
        // new version available. This never opens Edge or captures the desktop.
        progress.Report("正在检查本机组件…");
        var report = Path.Combine(stage, "startup-check.json");
        using (var check = Process.Start(new ProcessStartInfo(Path.Combine(stage, "BabaganLauncher.exe"), "--smoke-test " + Package.Quote(report)) {
          UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
        })) {
          bool ended = await Task.Run(() => check.WaitForExit(30000));
          if (!ended) { check.Kill(); throw new Exception("组件检查超时，请关闭安装器后重试。"); }
          if (check.ExitCode != 0 || !File.Exists(report) || !File.ReadAllText(report).Contains("\"ready\":true"))
            throw new Exception("组件检查失败。请检查下载是否完整，以及系统是否为 Windows 10 / 11。");
        }
        File.Delete(report); token.ThrowIfCancellationRequested();
        if (!reuseNode) paths.node = RuntimeDependencies.Promote(stage, root, true);
        if (!reuseFfmpeg) paths.ffmpeg = RuntimeDependencies.Promote(stage, root, false);
        RuntimeDependencies.Save(stage, paths);
        File.WriteAllText(Path.Combine(stage, "install-receipt.json"), new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new {
          version = Package.Version, nodeReused = reuseNode, ffmpegReused = reuseFfmpeg
        }));
        var versions = Package.Child(root, "versions"); Directory.CreateDirectory(versions);
        var destination = Package.Child(versions, Package.Version + "-" + Guid.NewGuid().ToString("N").Substring(0,8));
        Directory.Move(stage, destination); // Only a new owned stage, under the same verified root.
        return Path.Combine(destination, "BabaganLauncher.exe");
      } finally { Package.RemoveStage(stage, root); }
    }
    static async Task<string> Download(string url, string hash, string cache, string label, IProgress<string> progress, CancellationToken token) {
      var target = Package.Child(cache, hash + ".zip");
      if (File.Exists(target)) {
        try { Package.Verify(target, hash); return target; }
        catch (InvalidDataException) { File.Delete(target); }
      }
      var part = Package.Child(cache, hash + "." + Guid.NewGuid().ToString("N") + ".part");
      try {
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
        using (var client = new HttpClient { Timeout = TimeSpan.FromMinutes(20) }) {
          timeout.CancelAfter(TimeSpan.FromMinutes(20)); var downloadToken = timeout.Token;
          client.DefaultRequestHeaders.UserAgent.ParseAdd("BabaganSetup/" + Package.Version);
          using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, downloadToken)) {
            using (downloadToken.Register(() => response.Dispose())) {
            response.EnsureSuccessStatusCode();
            if (response.RequestMessage.RequestUri.Scheme != "https" || response.RequestMessage.RequestUri.Host != "meet.babagan.cloud")
              throw new Exception("组件必须从 Babagan 的 HTTPS 下载服务获取。");
            long total = response.Content.Headers.ContentLength ?? 0, received = 0;
            if (total > 300000000) throw new Exception("下载文件超过预期大小。");
            using (var input = await response.Content.ReadAsStreamAsync()) using (var output = new FileStream(part, FileMode.CreateNew, FileAccess.Write)) {
              var buffer = new byte[65536]; int count; var lastReport = DateTime.MinValue;
              while (true) {
                var read = input.ReadAsync(buffer, 0, buffer.Length, downloadToken);
                if (await Task.WhenAny(read, Task.Delay(30000, downloadToken)) != read) {
                  response.Dispose();
                  try { await read; } catch { /* Observe the aborted pending read. */ }
                  downloadToken.ThrowIfCancellationRequested();
                  throw new IOException("下载超过 30 秒没有进展。");
                }
                count = await read; if(count == 0) break;
                received += count; if(received > 300000000) throw new Exception("下载文件超过预期大小。");
                await output.WriteAsync(buffer, 0, count, downloadToken);
                if ((DateTime.UtcNow - lastReport).TotalMilliseconds > 200) {
                  progress.Report("正在从 Babagan 下载 " + label + "  ·  " + (received / 1048576) + (total > 0 ? " / " + (total / 1048576) : "") + " MB");
                  lastReport = DateTime.UtcNow;
                }
              }
            }
            }
          }
        }
        progress.Report("正在校验 " + label + "…");
        await Task.Run(() => Package.Verify(part, hash), token);
        File.Move(part, target); return target;
      } catch(ObjectDisposedException error) {
        token.ThrowIfCancellationRequested();
        throw new IOException("下载连接已中断，请重试。", error);
      } finally { if (File.Exists(part)) File.Delete(part); }
    }
    internal static void Shortcut(string executable, string folder) {
      Directory.CreateDirectory(folder);
      dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, "Babagan 高质量共享.lnk"));
      shortcut.TargetPath = executable; shortcut.WorkingDirectory = Path.GetDirectoryName(executable);
      shortcut.Description = "打开 Babagan 高质量屏幕共享；接收端无需安装";
      shortcut.IconLocation = executable + ",0"; shortcut.Save();
      System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
      System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
    }
  }
  internal sealed class SetupForm : Form {
    readonly Button install; readonly Label status; readonly CancellationTokenSource cancel = new CancellationTokenSource();
    string executable; bool busy;
    internal SetupForm() {
      Text = "安装 Babagan 高质量共享"; ClientSize = new Size(540,330); StartPosition = FormStartPosition.CenterScreen;
      Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); BackColor = ColorTranslator.FromHtml("#faf9f6");
      Font = new Font("Microsoft YaHei UI", 10); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
      var heading = new Label { Text = "把高质量共享放到桌面", Location = new Point(28,25), Size = new Size(480,42), Font = new Font(Font.FontFamily,18,FontStyle.Bold) };
      var detail = new Label { Text = "仅发送画面的 Windows 电脑需要安装。\n观看者直接打开普通网页即可。\n\n安装器从 Babagan 下载并校验所需组件，\n安装到当前用户目录并创建桌面快捷方式。\n无需管理员权限；需要已安装 Microsoft Edge。", Location = new Point(30,80), Size = new Size(480,145) };
      status = new Label { Text = "缺少全部依赖时约下载 145 MB；兼容的依赖直接复用。", Location = new Point(30,230), Size = new Size(480,40) };
      install = new Button { Text = "安装并创建快捷方式", Location = new Point(280,280), Size = new Size(230,35) };
      install.BackColor = ColorTranslator.FromHtml("#617a50"); install.ForeColor = Color.White;
      install.FlatStyle = FlatStyle.Flat; install.FlatAppearance.BorderSize = 0;
      install.Click += async (_, e) => {
        if(executable != null) { Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true }); Close(); return; }
        bool acquired;
        using (var gate = new Mutex(true, Package.MutexName + ".install", out acquired)) {
          if(!acquired) { MessageBox.Show("另一个安装器正在运行，请先完成安装。", "Babagan"); return; }
          busy = true; install.Enabled = false;
          try {
            var installed = await Installer.Install(Package.Root, Path.Combine(Package.Root, "downloads"), new Progress<string>(text => { if(!IsDisposed) status.Text = text; }), cancel.Token);
            Installer.Shortcut(installed, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
            Installer.Shortcut(installed, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Babagan"));
            executable = installed;
            status.Text = "安装完成，兼容的依赖已复用。双击桌面快捷方式即可。"; install.Text = "打开 Babagan";
          } catch(OperationCanceledException) { status.Text = "下载已取消或超时，可以重试。"; }
          catch(Exception error) { status.Text = "安装未完成，可重试。"; MessageBox.Show(error.Message, "Babagan 安装", MessageBoxButtons.OK, MessageBoxIcon.Error); }
          finally { busy = false; install.Enabled = true; gate.ReleaseMutex(); if(cancel.IsCancellationRequested) Close(); }
        }
      };
      FormClosing += (_, e) => {
        if (busy) { e.Cancel = true; cancel.Cancel(); status.Text = "正在取消并清理临时文件…"; }
      };
      Controls.AddRange(new Control[] { heading, detail, status, install });
    }
  }
}
