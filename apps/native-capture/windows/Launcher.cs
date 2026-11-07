using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;

namespace Babagan {
  internal static class Launcher {
    [STAThread] static int Main(string[] args) {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      try {
        if (args.Length == 1 && args[0] == "--shutdown") {
          using (var signal = EventWaitHandle.OpenExisting(Package.MutexName + ".stop")) signal.Set();
          return 0;
        }
        if (args.Length == 2 && args[0] == "--smoke-test") {
          using (var helper = new Helper(AppDomain.CurrentDomain.BaseDirectory)) {
            Task.Run(() => helper.Start(true)).GetAwaiter().GetResult();
            File.WriteAllText(args[1], "{\"ready\":true,\"captureStarted\":false,\"version\":\"" + Package.Version + "\"}");
          }
          return 0;
        }
        bool first;
        using (var mutex = new Mutex(true, Package.MutexName, out first)) {
          if (!first) {
            using (var signal = EventWaitHandle.OpenExisting(Package.MutexName + ".open")) signal.Set();
            return 0;
          }
          using (var context = new MeetingContext()) Application.Run(context);
          mutex.ReleaseMutex();
        }
        return 0;
      } catch (Exception error) {
        if (args.Length == 2 && args[0] == "--smoke-test") { File.WriteAllText(args[1], error.ToString()); return 1; }
        MessageBox.Show("无法启动高质量共享。\n" + error.Message + "\n\n请重新安装，或从普通网页使用浏览器共享。", "Babagan", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
      }
    }
  }
  internal sealed class Helper : IDisposable {
    Process process; readonly string root; string status; StreamWriter log;
    readonly object logLock = new object();
    internal Helper(string directory) { root = directory; }
    internal bool Exited { get { return process != null && process.HasExited; } }
    internal int ExitCode { get { return process.ExitCode; } }
    internal async Task Start(bool noOpen) {
      var runtime = RuntimeDependencies.Load(root);
      Directory.CreateDirectory(Package.LogRoot);
      log = new StreamWriter(Path.Combine(Package.LogRoot, "native-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0,8) + ".log")) { AutoFlush = true };
      var temp = Path.Combine(Path.GetTempPath(), "BabaganNativeCapture"); Directory.CreateDirectory(temp);
      status = Path.Combine(temp, Guid.NewGuid().ToString("N") + ".json");
      var info = new ProcessStartInfo(runtime.node) {
        UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
        WorkingDirectory = root, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        Arguments = Package.Quote(Path.Combine(root, "apps/native-capture/dist/cli.js")) + " --managed --status-file " + Package.Quote(status)
          + " --ffmpeg " + Package.Quote(runtime.ffmpeg) + (noOpen ? " --no-open" : "")
      };
      // Never inherit user Node preload hooks in the standalone runtime.
      info.EnvironmentVariables.Remove("NODE_OPTIONS"); info.EnvironmentVariables.Remove("NODE_PATH");
      process = new Process { StartInfo = info };
      process.OutputDataReceived += (_, e) => Log(e.Data); process.ErrorDataReceived += (_, e) => Log(e.Data);
      process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
      var until = DateTime.UtcNow.AddSeconds(20);
      try {
        while (DateTime.UtcNow < until) {
          if (File.Exists(status)) {
            if (new FileInfo(status).Length > 4096) throw new Exception("启动状态无效。");
            Dictionary<string, object> result = null;
            try { result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(status)); }
            catch (ArgumentException) {} catch (IOException) {}
            if (result != null) {
              if (Convert.ToInt32(result["pid"]) != process.Id || Convert.ToInt32(result["version"]) != 1) throw new Exception("启动状态不匹配。");
              if (Convert.ToString(result["state"]) != "ready") throw new Exception(Convert.ToString(result["message"]));
              if (process.HasExited) throw new Exception("本机组件提前退出。");
              return;
            }
          }
          if (process.HasExited) throw new Exception("本机组件未能启动。请查看日志。");
          await Task.Delay(50).ConfigureAwait(false);
        }
        throw new Exception("启动超过 20 秒，请重新安装后重试。");
      } finally { if (File.Exists(status)) File.Delete(status); }
    }
    void Log(string line) {
      if (line == null) return;
      // No raw URL capabilities, meeting content, or frame pixels in logs.
      if (line.Contains("nativeCapture=") || line.Contains("Bearer ")) return;
      lock(logLock) { if (log != null) log.WriteLine(line.Length <= 4096 ? line : "[oversized diagnostic omitted]"); }
    }
    internal void Open() {
      try { if (process != null && !process.HasExited) { process.StandardInput.WriteLine("open"); process.StandardInput.Flush(); } }
      catch (IOException) { /* The idle timer may have closed the helper. Poll observes exit. */ }
      catch (InvalidOperationException) { /* Process exited between checking and writing. */ }
    }
    public void Dispose() {
      if (process != null) {
        try { if (!process.HasExited) { process.StandardInput.WriteLine("stop"); process.StandardInput.Close(); if (!process.WaitForExit(4000)) process.Kill(); } }
        catch (InvalidOperationException) {} catch (IOException) {}
        process.Dispose(); process = null;
      }
      lock(logLock) { if(log != null) { log.Dispose(); log = null; } }
    }
  }
  internal sealed class MeetingContext : ApplicationContext {
    readonly NotifyIcon tray; readonly Helper helper; readonly EventWaitHandle signal, stopSignal;
    readonly System.Windows.Forms.Timer poll; readonly Form progress; bool ready, closing;
    internal MeetingContext() {
      helper = new Helper(AppDomain.CurrentDomain.BaseDirectory);
      signal = new EventWaitHandle(false, EventResetMode.AutoReset, Package.MutexName + ".open");
      stopSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Package.MutexName + ".stop");
      tray = new NotifyIcon { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = "Babagan · 正在启动", Visible = true };
      var menu = new ContextMenuStrip(); menu.Items.Add("打开会议", null, (_, e) => { if(ready) helper.Open(); });
      menu.Items.Add("查看诊断日志", null, (_, e) => Process.Start(new ProcessStartInfo(Package.LogRoot) { UseShellExecute = true }));
      menu.Items.Add("退出本机组件", null, (_, e) => {
        if (MessageBox.Show("退出会停止这台电脑的高质量共享。是否继续？", "Babagan", MessageBoxButtons.YesNo) == DialogResult.Yes) ExitThread();
      });
      tray.ContextMenuStrip = menu; tray.DoubleClick += (_, e) => { if (ready) helper.Open(); };
      progress = new Form { Text = "Babagan 高质量共享", ClientSize = new Size(420,120), StartPosition = FormStartPosition.CenterScreen,
        FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath), BackColor = ColorTranslator.FromHtml("#faf9f6") };
      progress.Controls.Add(new Label { Text = "正在检查本机组件并打开会议…", AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter });
      progress.FormClosed += (_, e) => { if(!ready && !closing) ExitThread(); };
      progress.Shown += async (_, e) => {
        try {
          await helper.Start(false);
          if (closing) return;
          ready = true; tray.Text = "Babagan · 本机组件已就绪"; progress.Close();
        } catch (Exception error) {
          if (!closing) MessageBox.Show("启动失败：" + error.Message + "\n诊断日志：" + Package.LogRoot, "Babagan");
          ExitThread();
        }
      };
      poll = new System.Windows.Forms.Timer { Interval = 500 };
      poll.Tick += (_, e) => {
        if (closing) return;
        if (stopSignal.WaitOne(0)) { ExitThread(); return; }
        if (ready && signal.WaitOne(0)) helper.Open();
        if (ready && helper.Exited) {
          if (helper.ExitCode != 0) MessageBox.Show("本机组件意外退出。请重新打开桌面启动器；日志中已保留诊断。", "Babagan");
          ExitThread();
        }
      };
      poll.Start(); progress.Show();
    }
    protected override void ExitThreadCore() {
      if (closing) return;
      closing = true; poll.Stop(); helper.Dispose(); tray.Visible = false; progress.Close(); base.ExitThreadCore();
    }
    protected override void Dispose(bool disposing) {
      if (disposing) { helper.Dispose(); var icon = tray.Icon; tray.Dispose(); if(icon != null) icon.Dispose(); poll.Dispose(); signal.Dispose(); stopSignal.Dispose(); progress.Dispose(); }
      base.Dispose(disposing);
    }
  }
}
