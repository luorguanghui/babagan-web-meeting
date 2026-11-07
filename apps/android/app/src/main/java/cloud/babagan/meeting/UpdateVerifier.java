package cloud.babagan.meeting;

import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

/** The network manifest never supplies its own trust anchor. */
final class UpdateVerifier {
    static final String ORIGIN = "https://meet.babagan.cloud";
    record Release(long sequence, String version, String url, String sha256, long bytes) {}

    static Release verify(String envelopeText, String keyText, long minimumSequence) throws Exception {
        if (envelopeText.length() > 65_536) throw new SecurityException("Update manifest is too large");
        JSONObject envelope = new JSONObject(envelopeText), key = new JSONObject(keyText);
        if (envelope.getInt("schema") != 1 || !envelope.getString("keyId").equals(key.getString("keyId"))) throw new SecurityException("Unknown update signing key");
        byte[] payload = Base64.getDecoder().decode(envelope.getString("payloadBase64"));
        if (payload.length > 32_768) throw new SecurityException("Update payload is too large");
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(key.getString("spkiBase64")))));
        signature.update(payload);
        if (!signature.verify(Base64.getDecoder().decode(envelope.getString("signatureBase64")))) throw new SecurityException("Update signature did not match");
        JSONObject data = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        if (data.getInt("schema") != 1 || !data.getString("product").equals("babagan-client") || !data.getString("platform").equals("android")
            || !data.getString("channel").equals("stable") || data.getInt("minHostProtocol") > 1) throw new SecurityException("Incompatible update manifest");
        long sequence = data.getLong("sequence");
        if (sequence < minimumSequence || sequence < 1) throw new SecurityException("Older update manifest refused");
        String version = data.getString("version");
        if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) throw new SecurityException("Invalid release version");
        JSONObject artifact = data.getJSONObject("artifact");
        String url = artifact.getString("url"), hash = artifact.getString("sha256");
        URI uri = URI.create(url);
        if (!url.equals(ORIGIN + "/downloads/clients/android/" + version + "/Babagan.apk") || uri.getRawUserInfo() != null
            || uri.getRawQuery() != null || uri.getRawFragment() != null || !hash.matches("[a-fA-F0-9]{64}")) throw new SecurityException("Invalid update artifact");
        long bytes = artifact.getLong("bytes");
        if (bytes < 1 || bytes > 300_000_000) throw new SecurityException("Invalid APK size");
        return new Release(sequence, version, url, hash.toLowerCase(java.util.Locale.ROOT), bytes);
    }
    static int compareVersions(String left, String right) {
        String[] a = left.split("\\."), b = right.split("\\.");
        for (int i = 0; i < 3; i++) { int cmp = new java.math.BigInteger(a[i]).compareTo(new java.math.BigInteger(b[i])); if (cmp != 0) return cmp; }
        return 0;
    }
}
