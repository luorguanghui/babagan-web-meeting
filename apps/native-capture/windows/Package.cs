using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;

namespace Babagan {
  internal static class Package {
    internal const string Version = "0.2.5";
    internal const string NodeUrl = "https://meet.babagan.cloud/downloads/runtime/node-v24.15.0-win-x64.zip";
    internal const string NodeHash = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62";
    internal const string FfmpegUrl = "https://meet.babagan.cloud/downloads/runtime/ffmpeg-9.0.2-essentials_build.zip";
    internal const string FfmpegHash = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
    internal const string NodeRelative = "runtime/node-v24.15.0-win-x64/node.exe";
    internal const string FfmpegRelative = "runtime/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe";
    internal static string Root { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Babagan", "NativeShare"); } }
    internal static string LogRoot { get { return Path.Combine(Root, "logs"); } }
    internal static string MutexName { get { return @"Local\Babagan.NativeShare." + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value; } }
    internal static string Quote(string arg) {
      // CommandLineToArgvW quoting (including trailing slashes and literal quotes).
      var result = new System.Text.StringBuilder("\""); int slashes = 0;
      foreach (char c in arg) {
        if (c == '\\') { slashes++; continue; }
        result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c);
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal static string Hash(string path) {
      using (var sha = SHA256.Create()) using (var stream = File.OpenRead(path))
        return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    internal static void Verify(string path, string hash) {
      if (Hash(path) != hash) throw new InvalidDataException("下载文件校验失败，请重新下载后安装。");
    }
    internal static string Child(string root, string relative) {
      var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (String.IsNullOrEmpty(relative) || relative.Contains(":") || Path.IsPathRooted(relative)) throw new InvalidDataException("无效安装路径。");
      var path = Path.GetFullPath(Path.Combine(prefix, relative.Replace('/', Path.DirectorySeparatorChar)));
      if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装路径越界。");
      // Reject junctions/symlinks in existing parents, even inside our own root.
      for (var p = Path.GetDirectoryName(path); !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p)) {
        if (Directory.Exists(p) && (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
          throw new InvalidDataException("安装目录不能经过目录链接。");
      }
      return path;
    }
    internal static void Extract(Stream data, string root, Func<string, bool> include = null) {
      using (var archive = new ZipArchive(data, ZipArchiveMode.Read, true)) {
        long total = 0;
        if (archive.Entries.Count > 12000) throw new InvalidDataException("安装包包含过多文件。");
        foreach (var entry in archive.Entries) {
          total += entry.Length;
          if (total > 1500000000 || entry.Length > 400000000 || (entry.ExternalAttributes >> 16 & 0xF000) == 0xA000)
            throw new InvalidDataException("安装包大小或文件类型无效。");
          if (include != null && !include(entry.FullName)) continue;
          var path = Child(root, entry.FullName);
          if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
          Directory.CreateDirectory(Path.GetDirectoryName(path));
          using (var input = entry.Open()) using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) input.CopyTo(output);
        }
      }
    }
    internal static void RemoveStage(string stage, string parent) {
      // Only our newly-created staging directory, never a computed ancestor.
      string expected = Child(parent, Path.GetFileName(stage));
      if (!String.Equals(expected, Path.GetFullPath(stage), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(stage).StartsWith("stage-"))
        throw new InvalidDataException("无效临时目录。");
      if (Directory.Exists(stage)) Directory.Delete(stage, true);
    }
  }
}
