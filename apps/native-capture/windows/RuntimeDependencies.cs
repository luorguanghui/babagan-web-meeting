using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Babagan {
  internal sealed class RuntimePaths {
    public string node { get; set; }
    public string ffmpeg { get; set; }
  }
  internal static class RuntimeDependencies {
    internal static RuntimePaths Load(string directory) {
      var config = Path.Combine(directory, "runtime.json");
      var paths = File.Exists(config)
        ? new JavaScriptSerializer().Deserialize<RuntimePaths>(File.ReadAllText(config))
        : new RuntimePaths { node = Path.Combine(directory, Package.NodeRelative), ffmpeg = Path.Combine(directory, Package.FfmpegRelative) };
      if (paths == null || !ValidPath(paths.node) || !ValidPath(paths.ffmpeg)) throw new InvalidDataException("运行依赖路径无效，请重新运行安装器。");
      return paths;
    }
    internal static void Save(string directory, RuntimePaths paths) {
      File.WriteAllText(Path.Combine(directory, "runtime.json"), new JavaScriptSerializer().Serialize(paths));
    }
    static bool ValidPath(string path) {
      return !String.IsNullOrWhiteSpace(path) && Path.IsPathRooted(path) && !path.Any(c => Char.IsControl(c)) && File.Exists(path);
    }
    internal static bool Compatible(string executable, bool node, CancellationToken token = default(CancellationToken)) {
      token.ThrowIfCancellationRequested();
      if (!ValidPath(executable)) return false;
      try {
        var info = new ProcessStartInfo(executable, node ? "--version" : "-hide_banner -h filter=ddagrab") {
          UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
          RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.EnvironmentVariables.Remove("NODE_OPTIONS"); info.EnvironmentVariables.Remove("NODE_PATH");
        using (var process = Process.Start(info)) {
          using (token.Register(() => { try { if(!process.HasExited) process.Kill(); } catch (InvalidOperationException) {} })) {
          var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
          if (!process.WaitForExit(5000)) { process.Kill(); process.WaitForExit(2000); return false; }
          token.ThrowIfCancellationRequested();
          if (process.ExitCode != 0 || !output.Wait(1000) || !errors.Wait(1000) || output.Result.Length > 256000) return false;
          return node ? Regex.IsMatch(output.Result.Trim(), @"^v24\.\d+\.\d+$")
            : Regex.IsMatch(output.Result, @"^Filter ddagrab\s*$", RegexOptions.Multiline)
              && Regex.IsMatch(output.Result, @"^\s+dup_frames\s+<boolean>\s", RegexOptions.Multiline);
          }
        }
      } catch (OperationCanceledException) { throw; }
      catch { token.ThrowIfCancellationRequested(); return false; }
    }
    internal static string Find(string root, bool node, CancellationToken token = default(CancellationToken)) {
      token.ThrowIfCancellationRequested();
      var relative = node ? Package.NodeRelative : Package.FfmpegRelative;
      var candidates = new List<string> { Path.Combine(root, relative) };
      // Reuse the previously installed sender's compatible dependencies too.
      var versions = Path.Combine(root, "versions");
      if (Directory.Exists(versions)) foreach (var version in Directory.GetDirectories(versions).OrderByDescending(v => v)) {
        token.ThrowIfCancellationRequested();
        try {
          // Each dependency is independently reusable, including during repair
          // when the other manifest path has been removed or upgraded.
          var paths = new JavaScriptSerializer().Deserialize<RuntimePaths>(File.ReadAllText(Path.Combine(version, "runtime.json")));
          if (paths != null) candidates.Add(node ? paths.node : paths.ffmpeg);
        }
        catch { candidates.Add(Path.Combine(version, relative)); }
      }
      if (!node) candidates.Add(Environment.GetEnvironmentVariable("BABAGAN_FFMPEG"));
      foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
        token.ThrowIfCancellationRequested();
        var path = Environment.ExpandEnvironmentVariables(folder.Trim().Trim('"'));
        if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) continue;
        candidates.Add(Path.Combine(path, node ? "node.exe" : "ffmpeg.exe"));
      }
      return candidates.Distinct(StringComparer.OrdinalIgnoreCase).FirstOrDefault(path => Compatible(path, node, token));
    }
    internal static string Promote(string stage, string root, bool node) {
      var relative = node ? Package.NodeRelative : Package.FfmpegRelative;
      var folder = relative.Split('/')[1];
      var source = Package.Child(stage, "runtime/" + folder);
      var destination = Package.Child(root, "runtime/" + folder);
      Directory.CreateDirectory(Path.GetDirectoryName(destination));
      if (Directory.Exists(destination)) {
        // Preserve an incompatible old runtime rather than deleting it.
        Directory.Move(destination, Package.Child(root, "runtime/previous-" + folder + "-" + Guid.NewGuid().ToString("N")));
      }
      Directory.Move(source, destination);
      return Package.Child(root, relative);
    }
  }
}
