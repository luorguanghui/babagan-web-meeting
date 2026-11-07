using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace Babagan {
  internal sealed class DesktopHelper : IDisposable {
    Process process; readonly TaskCompletionSource<string> ready = new TaskCompletionSource<string>();
    readonly object activityLock = new object(); bool exited, captureActive;
    internal bool CaptureActive { get { lock(activityLock) return captureActive; } set { lock(activityLock) captureActive = value; } }
    internal event Action ActivityChanged;
    internal event Action Failed;
    internal async Task<string> Start(string directory) {
      var runtime = RuntimeDependencies.Load(directory);
      var info = new ProcessStartInfo(runtime.node) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = directory, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        Arguments = Package.Quote(Path.Combine(directory, "apps/native-capture/dist/desktop-host.js")) + " --origin " + Package.Quote(Package.Origin) + " --ffmpeg " + Package.Quote(runtime.ffmpeg) };
      info.EnvironmentVariables.Remove("NODE_OPTIONS"); info.EnvironmentVariables.Remove("NODE_PATH");
      process = new Process { StartInfo = info, EnableRaisingEvents = true };
      process.OutputDataReceived += OnMessage;
      // Never put the capability-bearing stdout pipe in a file or diagnostic log.
      process.ErrorDataReceived += (_, e) => { /* Parent-owned helper sanitizes diagnostics; no content is persisted here. */ };
      process.Exited += (_, e) => {
        lock(activityLock) { exited = true; captureActive = false; }
        var activity = ActivityChanged; if (activity != null) activity();
        ready.TrySetException(new IOException("本机采集组件提前退出。")); var handler = Failed; if (handler != null) handler();
      };
      process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
      if (await Task.WhenAny(ready.Task, Task.Delay(20000)) != ready.Task) throw new IOException("本机采集组件启动超时。");
      return await ready.Task;
    }
    void OnMessage(object sender, DataReceivedEventArgs e) {
      if (e.Data == null) return;
      try {
        if (e.Data.Length > 8192) throw new InvalidDataException();
        var message = Package.Json().Deserialize<Dictionary<string, object>>(e.Data);
        if (message == null || !message.ContainsKey("v") || Convert.ToInt32(message["v"]) != 1) throw new InvalidDataException();
        var type = Convert.ToString(message["type"]);
        if (type == "ready") {
          var url = Convert.ToString(message["launchUrl"]);
          if (!Package.TrustedUrl(url) || String.IsNullOrEmpty(new Uri(url).Fragment)) throw new InvalidDataException();
          ready.TrySetResult(url);
        } else if (type == "activity") {
          if (!(message["captureActive"] is bool)) throw new InvalidDataException();
          lock(activityLock) { if (exited) return; captureActive = (bool)message["captureActive"]; }
          var handler = ActivityChanged; if (handler != null) handler();
        } else if (type == "error") { ready.TrySetException(new IOException("本机采集组件初始化失败。")); }
      } catch { ready.TrySetException(new InvalidDataException("本机采集组件响应无效。")); }
    }
    internal bool Stop(bool eofOnly = false) {
      if (process == null) return true;
      var child = process; process = null;
      try {
        if (!child.HasExited) {
          if (!eofOnly) child.StandardInput.WriteLine("{\"v\":1,\"type\":\"stop\"}");
          child.StandardInput.Close();
          if (!child.WaitForExit(5000)) { child.Kill(); child.WaitForExit(2000); return false; }
        }
        return child.ExitCode == 0;
      } catch (InvalidOperationException) { return false; }
      catch (IOException) { try { if (!child.HasExited) child.Kill(); } catch {} return false; }
      finally { child.Dispose(); }
    }
    public void Dispose() { Stop(); }
  }
}
