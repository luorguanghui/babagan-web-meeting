using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Babagan {
  internal static class UpdaterTests {
    sealed class CancelOnWrite : MemoryStream {
      readonly CancellationTokenSource cancellation;
      internal CancelOnWrite(CancellationTokenSource source) { cancellation = source; }
      public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) {
        Write(buffer, offset, count); cancellation.Cancel(); return Task.FromResult(0);
      }
    }
    static int count;
    static void Check(bool valid, string name) { if (!valid) throw new Exception(name); count++; }
    static void Reject(Action action, string name) { bool rejected = false; try { action(); } catch (Exception) { rejected = true; } Check(rejected, name); }
    static string Envelope(ClientRelease release, RSACryptoServiceProvider rsa, string keyId) {
      var bytes = Encoding.UTF8.GetBytes(Package.Json().Serialize(release));
      return Package.Json().Serialize(new UpdateEnvelope { schema = 1, keyId = keyId, payloadBase64 = Convert.ToBase64String(bytes), signatureBase64 = Convert.ToBase64String(rsa.SignData(bytes, CryptoConfig.MapNameToOID("SHA256"))) });
    }
    static int Main(string[] args) {
      var root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
      var reports = new List<DownloadProgress>();
      var progress = new DownloadProgressReporter(100, reports.Add, CancellationToken.None);
      progress.Report(0, "downloading", 0); progress.Report(10, "downloading", 100); progress.Report(25, "downloading", 200);
      Check(reports.Count == 2 && reports[1].downloadedBytes == 25 && reports[1].totalBytes == 100, "Real byte progress missing or not throttled");
      progress.Report(100, "verifying", 210);
      Check(reports.Count == 3 && reports[2].phase == "verifying", "Verification was hidden by download throttle");
      Reject(() => progress.Report(101, "downloading", 400), "Oversized progress accepted");
      Reject(() => new DownloadProgressReporter(long.MaxValue, reports.Add, CancellationToken.None), "Unsafe byte total accepted");
      using (var cancelled = new CancellationTokenSource()) {
        var stale = new DownloadProgressReporter(100, reports.Add, cancelled.Token); int before = reports.Count;
        cancelled.Cancel(); Reject(() => stale.Report(50, "downloading", 500), "Cancelled download emitted progress");
        Check(reports.Count == before, "Late progress escaped cancellation");
      }
      using (var input = new MemoryStream(new byte[123])) using (var output = new MemoryStream()) {
        var transfer = new List<DownloadProgress>();
        Downloads.Copy(input, output, 123, CancellationToken.None, transfer.Add).GetAwaiter().GetResult();
        Check(output.Length == 123 && transfer[transfer.Count - 1].downloadedBytes == 123 && transfer[transfer.Count - 1].phase == "verifying", "Downloaded byte count was not reported before verification");
      }
      using (var input = new MemoryStream(new byte[124])) using (var output = new MemoryStream())
        Reject(() => Downloads.Copy(input, output, 123, CancellationToken.None, reports.Add).GetAwaiter().GetResult(), "Copy exceeded signed byte total");
      using (var input = new MemoryStream(new byte[122])) using (var output = new MemoryStream())
        Reject(() => Downloads.Copy(input, output, 123, CancellationToken.None, reports.Add).GetAwaiter().GetResult(), "Copy accepted truncated artifact");
      using (var cancelled = new CancellationTokenSource()) using (var input = new MemoryStream(new byte[123])) using (var output = new CancelOnWrite(cancelled)) {
        var transfer = new List<DownloadProgress>();
        Reject(() => Downloads.Copy(input, output, 123, cancelled.Token, transfer.Add).GetAwaiter().GetResult(), "Cancellation during final write returned a complete download");
        Check(transfer.Count == 1 && transfer[0].downloadedBytes == 0, "Cancellation during final write emitted late verification");
      }
      using (var rsa = new RSACryptoServiceProvider(2048)) {
        rsa.PersistKeyInCsp = false; var publicKey = rsa.ExportParameters(false);
        var key = new UpdateKey { schema = 1, keyId = "test", algorithm = "RS256", modulusBase64 = Convert.ToBase64String(publicKey.Modulus), exponentBase64 = Convert.ToBase64String(publicKey.Exponent) };
        var release = new ClientRelease { schema = 1, product = "babagan-client", platform = "windows", channel = "stable", sequence = 2, version = "0.2.0", releasedAt = "2026-11-07T00:00:00Z", minHostProtocol = 1,
          artifact = new UpdateArtifact { url = Package.Origin + "/downloads/clients/windows/0.2.0/client.zip", sha256 = new string('a', 64), bytes = 500 } };
        var signed = Envelope(release, rsa, key.keyId); Check(ReleaseVerifier.Verify(signed, key).version == "0.2.0", "Valid signed update");
        var envelope = Package.Json().Deserialize<UpdateEnvelope>(signed); var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(envelope.payloadBase64));
        envelope.payloadBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(decoded.Replace("0.2.0", "0.3.0")));
        Reject(() => ReleaseVerifier.Verify(Package.Json().Serialize(envelope), key), "Tampered manifest accepted");
        envelope = Package.Json().Deserialize<UpdateEnvelope>(signed); envelope.keyId = "unknown"; Reject(() => ReleaseVerifier.Verify(Package.Json().Serialize(envelope), key), "Unknown signing key accepted");
        release.artifact.url = "https://example.com/client.zip"; Reject(() => ReleaseVerifier.Verify(Envelope(release, rsa, key.keyId), key), "Foreign artifact accepted");
        release.artifact.url = Package.Origin + "/downloads/clients/windows/0.2.0/client.zip"; release.minHostProtocol = 2; Reject(() => ReleaseVerifier.Verify(Envelope(release, rsa, key.keyId), key), "Future protocol accepted");
        release.minHostProtocol = 1; release.sequence = 0; Reject(() => ReleaseVerifier.Verify(Envelope(release, rsa, key.keyId), key), "Invalid sequence accepted");
      }
      Check(!Package.TrustedUrl("https://meet.babagan.cloud.evil.test/"), "Host suffix accepted");
      Check(!Package.TrustedUrl("https://user@meet.babagan.cloud/"), "Credentials accepted");
      Check(!Package.TrustedUrl("https://meet.babagan.cloud:8443/"), "Alternative port accepted");
      Check(!Package.TrustedUrl("http://meet.babagan.cloud/"), "Plain HTTP accepted");
      var startFragment = "#nativeCapture=1.12345." + new string('a', 43);
      var start = new Uri(Package.ClientStartUrl(Package.Origin + "/" + startFragment));
      Check(start.AbsolutePath == "/client" && start.Query == "?clientVersion=" + Package.Version, "Client opened marketing page or stale document URL");
      Check(start.Fragment == startFragment, "Client startup lost native capture capability");
      Reject(() => Package.ClientStartUrl("https://example.com/" + startFragment), "Untrusted client startup origin accepted");
      Reject(() => Package.ClientStartUrl(Package.Origin + "/"), "Missing native launch capability accepted");
      Check(!Package.SupportedWebView("119.0.0.0"), "Old runtime accepted");
      Check(Package.SupportedWebView("156.0.4314.58"), "Validated runtime refused");
      Check(!Package.SupportedWebView("not-a-version"), "Invalid runtime accepted");
      Reject(() => Package.Child(root, "../outside"), "Zip traversal accepted");
      Reject(() => Package.Child(root, "file:stream"), "Alternate stream accepted");
      var receiptRoot = Package.Child(root, "receipt-check"); Directory.CreateDirectory(receiptRoot);
      Package.AtomicJson(Path.Combine(receiptRoot, "release.json"), new InstalledReceipt { version = "0.1.1", sequence = 2 });
      ClientUpdater.ValidateReceipt(receiptRoot, "0.1.1", 2); count++;
      Reject(() => ClientUpdater.ValidateReceipt(receiptRoot, "0.1.2", 2), "Old code receipt accepted as a new version");
      Reject(() => ClientUpdater.ValidateReceipt(receiptRoot, "0.1.1", 3), "Wrong release sequence accepted");
      ClientUpdater.ValidateSmokeReport("{\"ready\":true,\"captureStarted\":false,\"version\":\"0.1.1\"}", "0.1.1"); count++;
      Reject(() => ClientUpdater.ValidateSmokeReport("{\"ready\":true,\"captureStarted\":false,\"version\":\"0.1.0\"}", "0.1.1"), "Wrong executable version accepted");
      Reject(() => ClientUpdater.ValidateSmokeReport("{\"ready\":true,\"captureStarted\":false}", "0.1.1"), "Missing executable version accepted");
      Reject(() => ClientUpdater.ValidateSmokeReport("{\"ready\":false,\"captureStarted\":false,\"version\":\"0.1.1\",\"details\":{\"ready\":true}}", "0.1.1"), "Nested ready marker bypassed smoke check");
      Reject(() => ClientUpdater.ValidateSmokeReport("{\"ready\":true,\"captureStarted\":true,\"version\":\"0.1.1\"}", "0.1.1"), "Unexpected capture accepted in smoke check");
      var first = "versions/0.1.0-aaaaaaaa"; var second = "versions/0.2.0-bbbbbbbb";
      foreach (var path in new[] { first, second }) { Directory.CreateDirectory(Package.Child(root, path)); File.WriteAllText(Package.Child(root, path + "/Babagan.Client.exe"), "test"); }
      Package.AtomicJson(Package.Child(root, first + "/release.json"), new InstalledReceipt { version = "0.1.0", sequence = 1 });
      VersionStore.Activate(root, first, "0.1.0", 1, false, false);
      Reject(() => VersionStore.Activate(root, second, "0.2.0", 2, true, false), "Joined meeting allowed activation");
      Reject(() => VersionStore.Activate(root, second, "0.2.0", 2, false, true), "Active capture allowed activation");
      Check(VersionStore.Read(root).current == first, "Busy update changed pointer");
      VersionStore.Activate(root, second, "0.2.0", 2, false, false);
      Check(VersionStore.Read(root).previous == first, "Previous version not retained");
      var pending = VersionStore.Read(root);
      VersionStore.Healthy(root, pending);
      Check(!VersionStore.Rollback(root, new InstalledVersion { current = pending.current, previous = pending.previous, version = pending.version, sequence = pending.sequence, pendingHealth = true }), "Stale bootstrap rolled back a healthy version");
      // Separate fresh-failure scenario for the normal rollback assertions.
      pending.pendingHealth = true; Package.AtomicJson(Package.Child(root, "current.json"), pending);
      Reject(() => VersionStore.Activate(root, first, "0.1.0", 1, false, false), "Replay accepted");
      Check(VersionStore.Rollback(root, VersionStore.Read(root)), "Rollback failed");
      Check(VersionStore.Read(root).current == first && VersionStore.Read(root).sequence == 2, "Rollback lost monotonic sequence");
      Reject(() => VersionStore.Activate(root, second, "0.2.0", 2, false, false), "Failed release retried");
      Reject(() => VersionStore.Validate(root, new InstalledVersion { current = "versions/../other" }), "Malformed pointer accepted");
      Console.WriteLine("PASS: " + count + " update signature, origin, path, activity, replay and rollback checks"); return 0;
    }
  }
}
