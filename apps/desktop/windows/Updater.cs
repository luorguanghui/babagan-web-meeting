using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

namespace Babagan {
  internal sealed class PendingUpdate { public string relative; public string version; public long sequence; }
  internal sealed class ClientUpdater {
    readonly string root, currentDirectory; readonly Func<bool> busy; readonly Action<string, string> changed; bool checking; CancellationTokenSource downloading;
    internal ClientUpdater(string installationRoot, string directory, Func<bool> isBusy, Action<string, string> stateChanged) { root = installationRoot; currentDirectory = directory; busy = isBusy; changed = stateChanged; }
    internal async Task Check(CancellationToken token) {
      if (checking) return; checking = true;
      try {
        changed("checking", "正在检查更新…"); UpdateKey key;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("update-key.json")) using (var reader = new StreamReader(stream)) key = Package.Json().Deserialize<UpdateKey>(reader.ReadToEnd());
        var release = ReleaseVerifier.Verify(await Downloads.Manifest(Package.FeedUrl, token), key);
        var installed = VersionStore.Read(root); long sequence = installed == null ? 1 : installed.sequence;
        if (release.sequence <= sequence || System.Version.Parse(release.version) <= System.Version.Parse(Package.Version)) { changed("current", "已是最新版本"); return; }
        if (busy()) { changed("available", "新版本可用，将在会议结束后下载。"); return; }
        changed("downloading", "发现新版本，正在后台下载…");
        downloading = CancellationTokenSource.CreateLinkedTokenSource(token); var downloadToken = downloading.Token;
        var zip = await Downloads.Get(release.artifact.url, release.artifact.sha256, release.artifact.bytes, Package.Child(root, "downloads"), new Progress<string>(_ => {}), downloadToken);
        var stage = Package.Child(root, "stage-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(stage);
        try {
          using (var stream = File.OpenRead(zip)) Package.Extract(stream, stage);
          ValidatePayload(stage); ValidateReceipt(stage, release.version, release.sequence);
          RuntimeDependencies.Save(stage, RuntimeDependencies.Load(currentDirectory));
          // A helper-only smoke check cannot steal the WebView profile or start capture.
          await Smoke(stage, release.version, downloadToken); downloadToken.ThrowIfCancellationRequested();
          var relative = "versions/" + release.version + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
          Directory.CreateDirectory(Package.Child(root, "versions")); Directory.Move(stage, Package.Child(root, relative));
          Package.AtomicJson(Package.Child(root, "pending.json"), new PendingUpdate { relative = relative, version = release.version, sequence = release.sequence });
          TryActivate();
        } finally { Package.RemoveStage(stage, root); }
      } catch (OperationCanceledException) { if (!token.IsCancellationRequested) changed("available", "新版本可用，将在会议结束后下载。"); }
      catch { changed("error", "暂时无法更新，稍后会自动重试。"); }
      finally { if (downloading != null) { downloading.Dispose(); downloading = null; } checking = false; }
    }
    internal void ActivityChanged() { if (busy() && downloading != null) downloading.Cancel(); TryActivate(); }
    internal void TryActivate() {
      var path = Package.Child(root, "pending.json"); if (!File.Exists(path)) return;
      if (busy()) { changed("ready", "更新已准备好，将在会议结束后安装。"); return; }
      try {
        var pending = Package.Json().Deserialize<PendingUpdate>(File.ReadAllText(path));
        // Re-check authoritative host activity immediately before switching the pointer.
        if (busy()) return;
        var current = VersionStore.Read(root);
        if (current == null || pending.sequence > current.sequence) VersionStore.Activate(root, pending.relative, pending.version, pending.sequence, false, false);
        File.Delete(path); changed("ready", "更新已安装，下次打开客户端生效。");
      } catch { changed("error", "更新准备失败，当前会议不受影响。"); }
    }
    internal static void ValidatePayload(string stage) {
      foreach (var file in new[] { "Babagan.Client.exe", "Babagan.exe", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "apps/native-capture/dist/desktop-host.js" })
        if (!File.Exists(Package.Child(stage, file))) throw new InvalidDataException("客户端安装包不完整。");
    }
    internal static void ValidateReceipt(string stage, string expectedVersion, long expectedSequence) {
      var path = Package.Child(stage, "release.json");
      if (!File.Exists(path) || new FileInfo(path).Length > 4096) throw new InvalidDataException("客户端版本回执缺失或无效。");
      var receipt = Package.Json().Deserialize<InstalledReceipt>(File.ReadAllText(path));
      if (receipt == null || receipt.version != expectedVersion || receipt.sequence != expectedSequence) throw new InvalidDataException("客户端安装包版本与签名发布清单不一致。");
    }
    internal static void ValidateSmokeReport(string report, string expectedVersion) {
      if (report == null || report.Length > 4096) throw new InvalidDataException("客户端启动检查报告无效。");
      var value = Package.Json().Deserialize<System.Collections.Generic.Dictionary<string, object>>(report);
      object ready, version, captureStarted;
      if (value == null || !value.TryGetValue("ready", out ready) || !(ready is bool) || !(bool)ready
        || !value.TryGetValue("version", out version) || !(version is string) || (string)version != expectedVersion
        || !value.TryGetValue("captureStarted", out captureStarted) || !(captureStarted is bool) || (bool)captureStarted)
        throw new InvalidDataException("客户端实际版本或启动检查结果不符合预期。");
    }
    internal static async Task Smoke(string stage, string expectedVersion, CancellationToken token) {
      var report = Package.Child(stage, "smoke-" + Guid.NewGuid().ToString("N") + ".json");
      try {
        using (var process = Process.Start(new ProcessStartInfo(Package.Child(stage, "Babagan.Client.exe"), "--smoke-test " + Package.Quote(report)) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = stage })) {
          using (token.Register(() => { try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) {} })) {
            bool ended = await Task.Run(() => process.WaitForExit(30000));
            if (!ended) { process.Kill(); throw new IOException("客户端启动检查超时。"); }
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0 || !File.Exists(report) || new FileInfo(report).Length > 4096) throw new IOException("客户端启动检查失败。");
            ValidateSmokeReport(File.ReadAllText(report), expectedVersion);
          }
        }
      } finally { if (File.Exists(report)) File.Delete(report); }
    }
  }
}
