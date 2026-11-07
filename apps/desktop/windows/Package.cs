using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Babagan {
  internal static class Package {
    internal const string Version = "0.1.0";
    internal const int MinimumWebViewMajor = 156;
    internal static bool SupportedWebView(string value) {
      System.Version version;
      return !String.IsNullOrWhiteSpace(value) && System.Version.TryParse(value.Split(' ')[0], out version) && version.Major >= MinimumWebViewMajor;
    }
    internal const string Origin = "https://meet.babagan.cloud";
    internal const string FeedUrl = Origin + "/downloads/clients/windows/stable.json";
    internal const string NodeUrl = Origin + "/downloads/runtime/node-v24.15.0-win-x64.zip";
    internal const string NodeHash = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62";
    internal const string FfmpegUrl = Origin + "/downloads/runtime/ffmpeg-9.0.2-essentials_build.zip";
    internal const string FfmpegHash = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
    internal const string NodeRelative = "runtime/node-v24.15.0-win-x64/node.exe";
    internal const string FfmpegRelative = "runtime/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe";
    internal static string Root { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Babagan", "DesktopClient"); } }
    internal static string LegacyRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Babagan", "NativeShare"); } }
    internal static string LogRoot { get { return Path.Combine(Root, "logs"); } }
    internal static string MutexName { get { return @"Local\Babagan.DesktopClient." + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value; } }
    internal static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 16 }; }
    internal static string Quote(string arg) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in arg) { if (c == '\\') { slashes++; continue; } result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c); }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static string Hash(string path) { using (var sha = SHA256.Create()) using (var input = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant(); }
    internal static void Verify(string path, string hash) { if (Hash(path) != hash) throw new InvalidDataException("下载文件校验失败。"); }
    internal static string Child(string root, string relative) {
      var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (String.IsNullOrEmpty(relative) || relative.Contains(":") || Path.IsPathRooted(relative)) throw new InvalidDataException("无效安装路径。");
      var path = Path.GetFullPath(Path.Combine(prefix, relative.Replace('/', Path.DirectorySeparatorChar)));
      if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装路径越界。");
      for (var p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p))
        if ((File.Exists(p) || Directory.Exists(p)) && (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("安装目录不能经过目录链接。");
      return path;
    }
    internal static void Extract(Stream input, string root, Func<string, bool> include = null) {
      using (var zip = new ZipArchive(input, ZipArchiveMode.Read, true)) {
        long total = 0; if (zip.Entries.Count > 12000) throw new InvalidDataException("安装包文件数量无效。");
        foreach (var entry in zip.Entries) {
          total += entry.Length;
          if (total > 1500000000 || entry.Length > 400000000 || (entry.ExternalAttributes >> 16 & 0xF000) == 0xA000) throw new InvalidDataException("安装包大小或类型无效。");
          if (include != null && !include(entry.FullName)) continue;
          var path = Child(root, entry.FullName); if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
          Directory.CreateDirectory(Path.GetDirectoryName(path));
          using (var source = entry.Open()) using (var target = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) source.CopyTo(target);
        }
      }
    }
    internal static void RemoveStage(string stage, string root) {
      var expected = Child(root, Path.GetFileName(stage));
      if (!String.Equals(expected, Path.GetFullPath(stage), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(stage).StartsWith("stage-")) throw new InvalidDataException("无效临时目录。");
      if (Directory.Exists(stage)) Directory.Delete(stage, true);
    }
    internal static bool TrustedUrl(string value) { Uri uri; return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "meet.babagan.cloud" && uri.Port == 443 && uri.UserInfo.Length == 0; }
    internal static void AtomicJson(string path, object value) {
      Directory.CreateDirectory(Path.GetDirectoryName(path)); var part = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
      try { File.WriteAllText(part, Json().Serialize(value), new UTF8Encoding(false)); if (File.Exists(path)) File.Replace(part, path, null); else File.Move(part, path); }
      finally { if (File.Exists(part)) File.Delete(part); }
    }
  }
}
