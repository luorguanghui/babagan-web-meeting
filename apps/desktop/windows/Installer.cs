using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Babagan {
  internal static class DesktopInstaller {
    [STAThread] static int Main(string[] args) {
      if (args.Length == 3 && args[0] == "--verify-package") {
        try { Task.Run(() => Install(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), new Progress<string>(), CancellationToken.None)).GetAwaiter().GetResult(); return 0; }
        catch (Exception error) { Directory.CreateDirectory(args[1]); File.WriteAllText(Path.Combine(args[1], "verify-error.txt"), error.ToString()); return 1; }
      }
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new SetupWindow()); return 0;
    }
    internal static bool Running() { try { using (var running = Mutex.OpenExisting(Package.MutexName)) return true; } catch (WaitHandleCannotBeOpenedException) { return false; } }
    internal static async Task<string> Install(string root, string cache, IProgress<string> progress, CancellationToken token) {
      if (!Environment.Is64BitOperatingSystem) throw new IOException("需要64位 Windows 10 或更新系统。");
      if (Running()) throw new IOException("请先关闭 Babagan 客户端，再运行安装器。当前会议不会被关闭。");
      Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
      var stage = Package.Child(root, "stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
      try {
        progress.Report("正在准备 Babagan 桌面客户端…");
        using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("client.zip")) Package.Extract(payload, stage);
        ClientUpdater.ValidatePayload(stage);
        var receipt = Package.Json().Deserialize<InstalledReceipt>(File.ReadAllText(Package.Child(stage, "release.json")));
        if (receipt == null || receipt.version != Package.Version || receipt.sequence < 1) throw new InvalidDataException("安装包版本无效。");
        var old = VersionStore.Read(root);
        if (old != null && System.Version.Parse(old.version) > System.Version.Parse(Package.Version)) throw new InvalidOperationException("已安装更新版本；请使用新版安装器。");
        await InstallRuntime.Ensure(stage, root, cache, progress, token);
        progress.Report("正在检查客户端与原生共享组件…"); await ClientUpdater.Smoke(stage, Package.Version, token);
        token.ThrowIfCancellationRequested(); if (Running()) throw new IOException("客户端正在运行，更新将在关闭后继续。");
        var relative = "versions/" + Package.Version + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        Directory.CreateDirectory(Package.Child(root, "versions")); Directory.Move(stage, Package.Child(root, relative));
        var launcher = Package.Child(root, "Babagan.exe");
        if (!File.Exists(launcher)) File.Copy(Package.Child(root, relative + "/Babagan.exe"), launcher);
        Package.AtomicJson(Package.Child(root, "current.json"), new InstalledVersion { current = relative, previous = old == null ? null : old.current, version = Package.Version, sequence = Math.Max(receipt.sequence, old == null ? 0 : old.sequence), pendingHealth = true });
        return launcher;
      } finally { Package.RemoveStage(stage, root); }
    }
    internal static void Shortcut(string executable, string folder) {
      Directory.CreateDirectory(folder); dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, "Babagan 客户端.lnk")); shortcut.TargetPath = executable; shortcut.WorkingDirectory = Path.GetDirectoryName(executable); shortcut.Description = "Babagan Windows 会议客户端"; shortcut.IconLocation = executable + ",0"; shortcut.Save();
      System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut); System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
    }
  }
  internal sealed class SetupWindow : Form {
    readonly Label status; readonly Button install; readonly CancellationTokenSource cancel = new CancellationTokenSource(); bool busy; string executable;
    internal SetupWindow() {
      Text = "安装 Babagan 客户端"; ClientSize = new Size(560, 350); StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
      BackColor = ColorTranslator.FromHtml("#fff7ed"); ForeColor = ColorTranslator.FromHtml("#4b2d1e"); Font = new Font("Microsoft YaHei UI", 10); Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
      var title = new Label { Text = "在桌面相聚", Location = new Point(30, 28), Size = new Size(480, 45), Font = new Font(Font.FontFamily, 22, FontStyle.Bold) };
      var detail = new Label { Text = "独立会议窗口 · 原生高质量共享 · 自动更新\n\n安装在当前用户目录，无需管理员权限。\n兼容的 Node.js、FFmpeg 和 WebView2 会直接复用。\n缺少的组件只从 Babagan 服务下载并校验。", Location = new Point(32, 90), Size = new Size(490, 135) };
      status = new Label { Text = "已安装运行依赖的电脑通常只需下载客户端。", Location = new Point(32, 232), Size = new Size(490, 50) };
      install = new Button { Text = "安装客户端", Location = new Point(310, 290), Size = new Size(215, 38), BackColor = ColorTranslator.FromHtml("#f4ad6b"), ForeColor = ColorTranslator.FromHtml("#3d2417"), FlatStyle = FlatStyle.Flat };
      install.Click += async (_, e) => {
        if (executable != null) { Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true }); Close(); return; }
        bool first;
        using (var gate = new Mutex(true, Package.MutexName + ".install", out first)) {
          if (!first) { MessageBox.Show("另一个客户端安装器正在运行。", "Babagan"); return; }
          busy = true; install.Enabled = false;
          try {
            var installed = await DesktopInstaller.Install(Package.Root, Package.Child(Package.Root, "downloads"), new Progress<string>(text => { if (!IsDisposed) status.Text = text; }), cancel.Token);
            DesktopInstaller.Shortcut(installed, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
            DesktopInstaller.Shortcut(installed, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Babagan"));
            executable = installed;
            status.Text = "安装完成。更新会在会议结束后准备，下次打开客户端生效。"; install.Text = "打开 Babagan";
          } catch (OperationCanceledException) { status.Text = "安装已取消。"; }
          catch (Exception error) { status.Text = "安装未完成，可以重试。"; MessageBox.Show(error.Message, "Babagan", MessageBoxButtons.OK, MessageBoxIcon.Error); }
          finally { busy = false; install.Enabled = true; gate.ReleaseMutex(); if (cancel.IsCancellationRequested) Close(); }
        }
      };
      FormClosing += (_, e) => { if (busy) { e.Cancel = true; cancel.Cancel(); status.Text = "正在取消下载并清理…"; } };
      Controls.AddRange(new Control[] { title, detail, status, install });
    }
  }
}
