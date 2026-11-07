using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Babagan {
  internal static class Bootstrap {
    [STAThread] static int Main() {
      try {
        using (var launchLock = new Mutex(false, Package.MutexName + ".bootstrap")) {
        bool locked = false;
        try {
          try { locked = launchLock.WaitOne(45000); } catch (AbandonedMutexException) { locked = true; }
          if (!locked) throw new IOException("另一个启动请求尚未结束。");
        try { using (var existing = Mutex.OpenExisting(Package.MutexName)) using (var signal = EventWaitHandle.OpenExisting(Package.MutexName + ".open")) { signal.Set(); return 0; } } catch (WaitHandleCannotBeOpenedException) {}
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var record = VersionStore.Read(root); if (record == null) throw new IOException();
        if (Launch(root, record)) return 0;
        if (record.pendingHealth && VersionStore.Rollback(root, record) && Launch(root, VersionStore.Read(root))) return 0;
        throw new IOException();
        } finally { if (locked) launchLock.ReleaseMutex(); }
        }
      } catch { MessageBox.Show("客户端未能启动，已保留原版本。请重新运行安装器修复。", "Babagan", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
    static bool Launch(string root, InstalledVersion record) {
      var health = Package.Child(root, "health-" + Guid.NewGuid().ToString("N") + ".txt");
      try {
        var executable = Package.Child(root, record.current + "/Babagan.Client.exe");
        using (var process = Process.Start(new ProcessStartInfo(executable, "--health-file " + Package.Quote(health)) { UseShellExecute = false, CreateNoWindow = false, WindowStyle = ProcessWindowStyle.Normal, WorkingDirectory = Path.GetDirectoryName(executable) })) {
          var until = DateTime.UtcNow.AddSeconds(35);
          while (DateTime.UtcNow < until) {
            if (File.Exists(health) && File.ReadAllText(health) == "ready") { VersionStore.Healthy(root, record); return true; }
            if (process.HasExited) return false; Thread.Sleep(100);
          }
          // Startup health precedes navigation and capture, so only a failed owned child is stopped.
          if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } return false;
        }
      } finally { if (File.Exists(health)) File.Delete(health); }
    }
  }
}
