// A separate console acceptance executable. It compiles the production updater,
// uses the unchanged production HTTPS feed, and owns only a fresh output directory.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Babagan {
  internal static class UpdateIntegration {
    static readonly List<object> states = new List<object>();
    static bool ownsFreshRoot;
    static int Main(string[] args) {
      Console.OutputEncoding = new UTF8Encoding(false);
      if (args.Length != 4 && args.Length != 5) { Console.Error.WriteLine("Usage: UpdateIntegration.exe <fresh-output-root> <installed-baseline-payload> <target-version> <target-sequence> [baseline-sequence]"); return 2; }
      string root = null;
      try {
        root = OwnedPath(args[0]); var baseline = OwnedPath(args[1]);
        if (root.StartsWith(baseline.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
          || baseline.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Test and baseline directories must not contain each other.");
        if (Directory.Exists(root)) throw new InvalidDataException("Use a fresh test root; existing installations are never overwritten.");
        long baselineSequence = 1;
        if (args.Length == 5 && (!Int64.TryParse(args[4], out baselineSequence) || baselineSequence < 1)) throw new InvalidDataException("Invalid baseline sequence.");
        long sequence; if (!Int64.TryParse(args[3], out sequence) || sequence <= baselineSequence || System.Version.Parse(args[2]) <= System.Version.Parse(Package.Version)) throw new InvalidDataException("Expected target must be newer than the baseline.");
        Task.Run(() => Run(root, baseline, args[2], sequence, baselineSequence)).GetAwaiter().GetResult(); return 0;
      } catch (Exception error) {
        // Never write an error artifact into an existing/unvalidated user directory.
        if (ownsFreshRoot && root != null && Directory.Exists(root)) {
          try { Package.AtomicJson(Path.Combine(root, "result.json"), new { passed = false, error = error.GetType().Name, message = error.Message, states = states }); } catch {}
        }
        Console.Error.WriteLine("Automatic update acceptance failed: " + error.GetType().Name + ": " + error.Message); return 1;
      }
    }
    static string OwnedPath(string value) {
      var allowed = Path.GetFullPath(DiagnosticPaths.OutputRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      var path = Path.GetFullPath(value);
      if (!path.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || String.Equals(path.TrimEnd(Path.DirectorySeparatorChar), Package.Root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Diagnostic paths must be under this workspace output directory.");
      return Package.Child(allowed, path.Substring(allowed.Length));
    }
    static void CopyPayload(string source, string destination) {
      Directory.CreateDirectory(destination);
      foreach (var entry in Directory.EnumerateFileSystemEntries(source)) {
        if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Diagnostic payload must not contain links.");
        var target = Package.Child(destination, Path.GetFileName(entry));
        if (Directory.Exists(entry)) CopyPayload(entry, target); else File.Copy(entry, target, false);
      }
    }
    static int DownloadFiles(string root) {
      var directory = Package.Child(root, "downloads"); return Directory.Exists(directory) ? Directory.GetFiles(directory, "*", SearchOption.AllDirectories).Length : 0;
    }
    static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static async Task Run(string root, string baseline, string targetVersion, long targetSequence, long baselineSequence) {
      ClientUpdater.ValidatePayload(baseline); ClientUpdater.ValidateReceipt(baseline, Package.Version, baselineSequence);
      // The runtime paths must come from a genuinely installed baseline, not a build directory.
      RuntimeDependencies.Load(baseline);
      Directory.CreateDirectory(root); ownsFreshRoot = true;
      Package.AtomicJson(Path.Combine(root, "diagnostic-owned.json"), new { kind = "automatic-update-integration", baselineVersion = Package.Version, baselineSequence = baselineSequence });
      var previous = "versions/" + Package.Version + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
      var installed = Package.Child(root, previous); CopyPayload(baseline, installed);
      File.Copy(Package.Child(installed, "Babagan.exe"), Package.Child(root, "Babagan.exe"));
      VersionStore.Activate(root, previous, Package.Version, baselineSequence, false, false); VersionStore.Healthy(root, VersionStore.Read(root));
      using (var token = new CancellationTokenSource(TimeSpan.FromMinutes(3))) {
        await ClientUpdater.Smoke(installed, Package.Version, token.Token);
        UpdateKey key;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("update-key.json")) using (var reader = new StreamReader(stream)) key = Package.Json().Deserialize<UpdateKey>(reader.ReadToEnd());
        var envelope = await Downloads.Manifest(Package.FeedUrl, token.Token);
        var release = ReleaseVerifier.Verify(envelope, key);
        Require(release.version == targetVersion && release.sequence == targetSequence, "The expected signed release is not live; no update test was attempted.");
        bool busy = true; string phase = "busy", last = null; bool busyDownloaded = false;
        var updater = new ClientUpdater(root, installed, () => busy, (state, message) => {
          last = state; if (phase == "busy" && state == "downloading") busyDownloaded = true;
          states.Add(new { phase = phase, state = state, utc = DateTime.UtcNow.ToString("o") });
          Console.WriteLine(phase + ": " + state);
        });
        await updater.Check(token.Token);
        var held = VersionStore.Read(root);
        Require(last == "available" && !busyDownloaded && DownloadFiles(root) == 0, "Busy check started a payload download or failed to defer it.");
        Require(held.current == previous && held.version == Package.Version && held.sequence == baselineSequence, "Busy check changed the active version.");
        Require(Directory.GetDirectories(Package.Child(root, "versions")).Length == 1 && !File.Exists(Package.Child(root, "pending.json")), "Busy check staged an update.");
        var busyPassedAt = DateTime.UtcNow.ToString("o");
        phase = "idle"; busy = false; await updater.Check(token.Token);
        var after = VersionStore.Read(root);
        Require(last == "ready" && after.version == targetVersion && after.sequence == targetSequence && after.previous == previous && after.current != previous, "Idle check did not activate the expected newer release.");
        ClientUpdater.ValidateReceipt(Package.Child(root, after.current), targetVersion, targetSequence);
        Require(after.pendingHealth, "The next full application launch must still perform its bootstrap health check.");
        var artifact = Package.Child(root, "downloads/" + release.artifact.sha256 + ".bin");
        Require(File.Exists(artifact) && new FileInfo(artifact).Length == release.artifact.bytes && Package.Hash(artifact) == release.artifact.sha256, "Downloaded artifact does not match the signed release.");
        Require(!File.Exists(Package.Child(root, "pending.json")) && Directory.GetDirectories(root, "stage-*").Length == 0, "Update left uncommitted staging state.");
        Package.AtomicJson(Path.Combine(root, "result.json"), new {
          passed = true, completedAt = DateTime.UtcNow.ToString("o"), feed = Package.FeedUrl, publicKeyId = key.keyId,
          baselineVersion = Package.Version, baselineSequence = baselineSequence, targetVersion = targetVersion, targetSequence = targetSequence,
          busyCheck = new { passed = true, completedAt = busyPassedAt, downloadedPayloadFiles = 0, activeVersionUnchanged = true },
          idleCheck = new { downloadedFrom = release.artifact.url, sha256 = release.artifact.sha256, bytes = release.artifact.bytes, signatureVerified = true, receiptVerified = true, actualExecutableVersionVerified = true, helperSmokePassed = true, pointerActivated = true, previousRetained = true },
          fullUiHealthPending = after.pendingHealth, desktopCaptured = false, defaultInstallationChanged = false, current = after, states = states
        });
        Console.WriteLine("PASS: real signed-feed busy deferral, artifact verification, actual-version smoke, and idle activation.");
        Console.WriteLine("Evidence: " + Path.Combine(root, "result.json"));
      }
    }
  }
}
