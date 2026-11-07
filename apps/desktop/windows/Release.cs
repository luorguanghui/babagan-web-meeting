using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

// DTO fields are populated by JavaScriptSerializer after authenticated parsing.
#pragma warning disable 0649

namespace Babagan {
  internal sealed class UpdateEnvelope { public int schema; public string keyId; public string payloadBase64; public string signatureBase64; }
  internal sealed class UpdateKey { public int schema; public string keyId; public string algorithm; public string modulusBase64; public string exponentBase64; }
  internal sealed class UpdateArtifact { public string url; public string sha256; public long bytes; }
  internal sealed class ClientRelease { public int schema; public string product; public string platform; public string channel; public long sequence; public string version; public string releasedAt; public int minHostProtocol; public UpdateArtifact artifact; }
  internal static class ReleaseVerifier {
    internal static ClientRelease Verify(string envelopeJson, UpdateKey key) {
      if (envelopeJson == null || envelopeJson.Length > 131072 || key == null || key.schema != 1 || key.algorithm != "RS256") throw new InvalidDataException("更新签名配置无效。");
      var envelope = Package.Json().Deserialize<UpdateEnvelope>(envelopeJson);
      if (envelope == null || envelope.schema != 1 || envelope.keyId != key.keyId || String.IsNullOrEmpty(envelope.payloadBase64) || String.IsNullOrEmpty(envelope.signatureBase64)) throw new InvalidDataException("更新签名无效。");
      byte[] payload, signature;
      try { payload = Convert.FromBase64String(envelope.payloadBase64); signature = Convert.FromBase64String(envelope.signatureBase64); }
      catch (FormatException) { throw new InvalidDataException("更新签名编码无效。"); }
      if (payload.Length > 32768) throw new InvalidDataException("更新清单过大。");
      using (var rsa = new RSACryptoServiceProvider()) {
        rsa.PersistKeyInCsp = false;
        rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(key.modulusBase64), Exponent = Convert.FromBase64String(key.exponentBase64) });
        if (!rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), signature)) throw new InvalidDataException("更新签名验证失败。");
      }
      var release = Package.Json().Deserialize<ClientRelease>(new UTF8Encoding(false, true).GetString(payload));
      Validate(release); return release;
    }
    internal static void Validate(ClientRelease release) {
      DateTimeOffset time;
      if (release == null || release.schema != 1 || release.product != "babagan-client" || release.platform != "windows" || release.channel != "stable" || release.sequence < 1 || release.sequence > 9007199254740991L || release.minHostProtocol != 1
        || release.version == null || !Regex.IsMatch(release.version, @"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
        || !DateTimeOffset.TryParse(release.releasedAt, out time) || release.artifact == null || release.artifact.bytes < 1 || release.artifact.bytes > 400000000
        || release.artifact.sha256 == null || !Regex.IsMatch(release.artifact.sha256, "^[a-f0-9]{64}$")
        || release.artifact.url != Package.Origin + "/downloads/clients/windows/" + release.version + "/client.zip") throw new InvalidDataException("更新清单不兼容或无效。");
    }
  }
  internal sealed class InstalledVersion { public string current; public string previous; public string version; public long sequence; public bool pendingHealth; }
  internal static class VersionStore {
    internal static InstalledVersion Read(string root) {
      var path = Package.Child(root, "current.json"); if (!File.Exists(path)) return null;
      var value = Package.Json().Deserialize<InstalledVersion>(File.ReadAllText(path));
      Validate(root, value); return value;
    }
    internal static void Validate(string root, InstalledVersion value) {
      if (value == null || value.current == null || !Regex.IsMatch(value.current, @"^versions/[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{8}$") || !File.Exists(Package.Child(root, value.current + "/Babagan.Client.exe"))) throw new InvalidDataException("客户端版本指针无效。");
      if (value.previous != null && (!Regex.IsMatch(value.previous, @"^versions/[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{8}$") || value.previous == value.current)) throw new InvalidDataException("客户端恢复指针无效。");
    }
    internal static bool CanActivate(bool joined, bool capturing) { return !joined && !capturing; }
    internal static void Activate(string root, string relative, string version, long sequence, bool joined, bool capturing) {
      if (!CanActivate(joined, capturing)) throw new InvalidOperationException("会议结束后才可安装更新。");
      var old = Read(root); if (old != null && sequence <= old.sequence) throw new InvalidDataException("拒绝过期或重复的更新。");
      var next = new InstalledVersion { current = relative, previous = old == null ? null : old.current, version = version, sequence = sequence, pendingHealth = true };
      Validate(root, next); Package.AtomicJson(Package.Child(root, "current.json"), next);
    }
    internal static void Healthy(string root, InstalledVersion record) { var current = Read(root); if (current.current != record.current || current.sequence != record.sequence) return; record.pendingHealth = false; Package.AtomicJson(Package.Child(root, "current.json"), record); }
    internal static bool Rollback(string root, InstalledVersion failed) {
      if (failed == null || String.IsNullOrEmpty(failed.previous)) return false;
      // A different bootstrap may already have marked this version healthy or
      // switched to a later one. Never apply a stale failure snapshot.
      var current = Read(root);
      if (current == null || !current.pendingHealth || current.current != failed.current || current.sequence != failed.sequence || current.previous != failed.previous) return false;
      var prior = Package.Child(root, failed.previous + "/release.json");
      if (!File.Exists(prior) || !File.Exists(Package.Child(root, failed.previous + "/Babagan.Client.exe"))) return false;
      var release = Package.Json().Deserialize<InstalledReceipt>(File.ReadAllText(prior));
      if (release == null || release.version == null || !Regex.IsMatch(release.version, @"^[0-9]+\.[0-9]+\.[0-9]+$")) return false;
      Package.AtomicJson(Package.Child(root, "failed-update.json"), new { sequence = failed.sequence, version = failed.version });
      // Keep the monotonic sequence to reject replay of the failed release.
      Package.AtomicJson(Package.Child(root, "current.json"), new InstalledVersion { current = failed.previous, version = release.version, sequence = failed.sequence, pendingHealth = false }); return true;
    }
  }
  internal sealed class InstalledReceipt { public string version; public long sequence; }
}
