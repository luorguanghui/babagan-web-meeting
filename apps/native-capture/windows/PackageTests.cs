using System;
using System.IO;
using System.IO.Compression;
using System.Text;
namespace Babagan {
  internal static class PackageTests {
    static void Assert(bool valid, string message) { if (!valid) throw new Exception(message); }
    static int Main(string[] args) {
      var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
      foreach (string path in new [] { "../escape", "C:/escape", "file:stream", "..\\escape" }) {
        bool rejected = false; try { Package.Child(root, path); } catch (InvalidDataException) { rejected = true; }
        Assert(rejected, "Accepted unsafe path " + path);
      }
      using (var memory = new MemoryStream()) {
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) {
          using (var writer = new StreamWriter(zip.CreateEntry("nested/中文 space.txt").Open(), Encoding.UTF8)) writer.Write("payload");
        }
        memory.Position = 0; Package.Extract(memory, root);
      }
      Assert(File.ReadAllText(Path.Combine(root, "nested/中文 space.txt")) == "payload", "Unicode extraction failed");
      using (var memory = new MemoryStream()) {
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true)) zip.CreateEntry("../escape.txt");
        memory.Position = 0; bool rejected = false;
        try { Package.Extract(memory, root); } catch (InvalidDataException) { rejected = true; }
        Assert(rejected, "Zip traversal allowed");
      }
      Assert(Package.Quote("C:\\中文 space\\") == "\"C:\\中文 space\\\\\"", "Trailing slash quoting failed");
      var file = Path.Combine(root, "nested/中文 space.txt");
      Package.Verify(file, Package.Hash(file)); bool badHash = false;
      try { Package.Verify(file, new string('0',64)); } catch(InvalidDataException) { badHash = true; }
      Assert(badHash, "Corrupt payload accepted");
      Console.WriteLine("PASS: safe paths, ZIP traversal, Unicode extraction, argument quoting, SHA-256 rejection"); return 0;
    }
  }
}
