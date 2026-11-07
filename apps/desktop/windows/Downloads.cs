using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

// This pinned runtime descriptor is deserialized from an embedded build resource.
#pragma warning disable 0649

namespace Babagan {
  internal sealed class RuntimeArtifact { public string url; public string sha256; public long bytes; public string sourceUrl; }
  internal static class Downloads {
    internal static async Task<string> Get(string url, string hash, long expectedBytes, string cache, IProgress<string> progress, CancellationToken token) {
      if (!Package.TrustedUrl(url) || hash == null || !System.Text.RegularExpressions.Regex.IsMatch(hash, "^[a-f0-9]{64}$")) throw new InvalidDataException("下载地址或校验值无效。");
      Directory.CreateDirectory(cache); var target = Package.Child(cache, hash + ".bin");
      if (File.Exists(target)) { try { Package.Verify(target, hash); if (expectedBytes > 0 && new FileInfo(target).Length != expectedBytes) throw new InvalidDataException(); return target; } catch (InvalidDataException) { File.Delete(target); } }
      var part = Package.Child(cache, hash + "." + Guid.NewGuid().ToString("N") + ".part");
      try {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false })
        using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(20) })
        using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token)) {
          response.EnsureSuccessStatusCode();
          if (response.Content.Headers.ContentLength > 400000000 || (expectedBytes > 0 && response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != expectedBytes)) throw new InvalidDataException("下载文件大小不匹配。");
          long received = 0; var last = DateTime.MinValue;
          using (var input = await response.Content.ReadAsStreamAsync()) using (var output = new FileStream(part, FileMode.CreateNew, FileAccess.Write)) {
            var buffer = new byte[65536];
            while (true) {
              var pending = input.ReadAsync(buffer, 0, buffer.Length, token);
              if (await Task.WhenAny(pending, Task.Delay(30000, token)) != pending) { response.Dispose(); try { await pending; } catch {} token.ThrowIfCancellationRequested(); throw new IOException("下载超过30秒没有进展。"); }
              var count = await pending; if (count == 0) break; received += count;
              if (received > 400000000 || (expectedBytes > 0 && received > expectedBytes)) throw new InvalidDataException("下载文件超过预期大小。");
              await output.WriteAsync(buffer, 0, count, token);
              if ((DateTime.UtcNow - last).TotalMilliseconds > 250) { progress.Report("正在下载并校验组件 · " + received / 1048576 + " MB"); last = DateTime.UtcNow; }
            }
          }
          if (expectedBytes > 0 && received != expectedBytes) throw new InvalidDataException("下载文件不完整。");
        }
        await Task.Run(() => Package.Verify(part, hash), token); File.Move(part, target); return target;
      } finally { if (File.Exists(part)) File.Delete(part); }
    }
    internal static async Task<string> Manifest(string url, CancellationToken token) {
      if (!Package.TrustedUrl(url)) throw new InvalidDataException("更新地址无效。");
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      using (var handler = new HttpClientHandler { AllowAutoRedirect = false })
      using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20), MaxResponseContentBufferSize = 131072 }) {
        client.DefaultRequestHeaders.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
        using (var response = await client.GetAsync(url, token)) { response.EnsureSuccessStatusCode(); return await response.Content.ReadAsStringAsync(); }
      }
    }
  }
  internal static class InstallRuntime {
    internal static bool WebViewPresent() {
      const string key = @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
      foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine }) foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 }) {
        using (var root = RegistryKey.OpenBaseKey(hive, view)) using (var child = root.OpenSubKey(key)) {
          if (child != null && Package.SupportedWebView(Convert.ToString(child.GetValue("pv")))) return true;
        }
      }
      return false;
    }
    internal static async Task EnsureWebView(string cache, IProgress<string> progress, CancellationToken token) {
      if (WebViewPresent()) { progress.Report("已复用 Microsoft WebView2 运行时。"); return; }
      RuntimeArtifact artifact;
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("webview-runtime.json")) using (var reader = new StreamReader(stream)) artifact = Package.Json().Deserialize<RuntimeArtifact>(reader.ReadToEnd());
      progress.Report("正在准备 Microsoft WebView2 运行时…");
      var downloaded = await Downloads.Get(artifact.url, artifact.sha256, artifact.bytes, cache, progress, token);
      var executable = Package.Child(cache, artifact.sha256 + ".exe"); if (!File.Exists(executable)) File.Copy(downloaded, executable); Package.Verify(executable, artifact.sha256);
      using (var process = Process.Start(new ProcessStartInfo(executable, "/silent /install") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden })) {
        var done = await Task.Run(() => process.WaitForExit(300000));
        if (!done) { process.Kill(); throw new IOException("WebView2 安装超时，请重试。"); }
        if (process.ExitCode != 0 || !WebViewPresent()) throw new IOException("需要 Microsoft WebView2 156 或更新版本；安装未完成或受到设备策略限制。");
      }
      token.ThrowIfCancellationRequested();
    }
    internal static async Task<RuntimePaths> Ensure(string stage, string root, string cache, IProgress<string> progress, CancellationToken token) {
      progress.Report("正在检查可复用的 Node.js 和 FFmpeg…");
      var runtime = await Task.Run(() => new RuntimePaths { node = RuntimeDependencies.Find(root, true, token) ?? RuntimeDependencies.Find(Package.LegacyRoot, true, token), ffmpeg = RuntimeDependencies.Find(root, false, token) ?? RuntimeDependencies.Find(Package.LegacyRoot, false, token) }, token);
      if (runtime.node == null) {
        var file = await Downloads.Get(Package.NodeUrl, Package.NodeHash, 36465163, cache, progress, token);
        using (var stream = File.OpenRead(file)) Package.Extract(stream, Path.Combine(stage, "runtime"), name => name == "node-v24.15.0-win-x64/node.exe" || name == "node-v24.15.0-win-x64/LICENSE" || name == "node-v24.15.0-win-x64/README.md");
        runtime.node = RuntimeDependencies.Promote(stage, root, true);
      }
      if (runtime.ffmpeg == null) {
        var file = await Downloads.Get(Package.FfmpegUrl, Package.FfmpegHash, 114768076, cache, progress, token);
        using (var stream = File.OpenRead(file)) Package.Extract(stream, Path.Combine(stage, "runtime"), name => name == "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe" || name == "ffmpeg-9.0.2-essentials_build/LICENSE" || name == "ffmpeg-9.0.2-essentials_build/README.txt");
        runtime.ffmpeg = RuntimeDependencies.Promote(stage, root, false);
      }
      RuntimeDependencies.Save(stage, runtime); await EnsureWebView(cache, progress, token); return runtime;
    }
  }
}
