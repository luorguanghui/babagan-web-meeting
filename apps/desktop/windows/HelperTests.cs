using System;
using System.IO;
using System.Threading;

namespace Babagan {
  internal static class HelperTests {
    static int Main(string[] args) {
      var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
      var entry = Package.Child(root, "apps/native-capture/dist/desktop-host.js"); Directory.CreateDirectory(Path.GetDirectoryName(entry));
      File.WriteAllText(entry, "process.stdout.write(JSON.stringify({v:1,type:'ready',launchUrl:'https://meet.babagan.cloud/#nativeCapture=fixture',port:12345})+'\\n'+JSON.stringify({v:1,type:'activity',captureActive:true})+'\\n');");
      RuntimeDependencies.Save(root, new RuntimePaths { node = args[1], ffmpeg = args[1] });
      for (int i = 0; i < 12; i++) {
        using (var helper = new DesktopHelper()) using (var ended = new ManualResetEvent(false)) {
          helper.Failed += () => ended.Set();
          try { helper.Start(root).GetAwaiter().GetResult(); } catch (IOException) { /* Exit can win readiness. */ }
          if (!ended.WaitOne(3000)) throw new Exception("Owned helper did not exit");
          Thread.Sleep(60);
          if (helper.CaptureActive) throw new Exception("Late activity revived a dead helper");
        }
      }
      Console.WriteLine("PASS: 12 real-process exit/stdout races leave capture inactive"); return 0;
    }
  }
}
