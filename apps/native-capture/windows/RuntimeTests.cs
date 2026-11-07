using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
namespace Babagan {
  internal static class RuntimeTests {
    static int Main(string[] args) {
      if (args[0] == "--version") {
        if(Environment.GetEnvironmentVariable("BABAGAN_TEST_RUNTIME_HANG") == "1") Thread.Sleep(30000);
        Console.WriteLine("v24.15.0"); return 0;
      }
      if (args[0] == "-hide_banner") { Console.WriteLine("Filter ddagrab\n  dup_frames <boolean> disable duplicates"); return 0; }
      var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
      var version = Path.Combine(root, "versions", "old"); Directory.CreateDirectory(version);
      var executable = Assembly.GetExecutingAssembly().Location;
      Environment.SetEnvironmentVariable("PATH", ""); Environment.SetEnvironmentVariable("BABAGAN_FFMPEG", null);
      RuntimeDependencies.Save(version, new RuntimePaths { node = Path.Combine(root, "missing.exe"), ffmpeg = executable });
      if (RuntimeDependencies.Find(root, false) != executable) throw new Exception("Existing FFmpeg was discarded when Node is missing");
      RuntimeDependencies.Save(version, new RuntimePaths { node = executable, ffmpeg = Path.Combine(root, "missing.exe") });
      if (RuntimeDependencies.Find(root, true) != executable) throw new Exception("Existing Node was discarded when FFmpeg is missing");
      Environment.SetEnvironmentVariable("BABAGAN_TEST_RUNTIME_HANG", "1");
      var timer = Stopwatch.StartNew(); bool canceled = false;
      using (var stop = new CancellationTokenSource(100)) {
        try { RuntimeDependencies.Find(root, true, stop.Token); } catch(OperationCanceledException) { canceled = true; }
      }
      if (!canceled || timer.ElapsedMilliseconds > 2000) throw new Exception("Cancel did not promptly stop the active dependency check");
      Console.WriteLine("PASS: independent installed-dependency reuse, unavailable sibling, cancellation kills only the owned probe"); return 0;
    }
  }
}
