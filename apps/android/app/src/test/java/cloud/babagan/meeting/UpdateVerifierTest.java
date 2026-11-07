package cloud.babagan.meeting;

import org.json.JSONObject;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;
import static org.junit.Assert.*;

public class UpdateVerifierTest {
    private final KeyPair pair;
    public UpdateVerifierTest() throws Exception { KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); pair = generator.generateKeyPair(); }
    private String key() { return Json.object("keyId", "test-key", "spkiBase64", Base64.getEncoder().encodeToString(pair.getPublic().getEncoded())).toString(); }
    private JSONObject payload() { return Json.object("schema",1,"product","babagan-client","platform","android","channel","stable","sequence",2,"version","0.2.0","minHostProtocol",1,"artifact",Json.object("url",UpdateVerifier.ORIGIN + "/downloads/clients/android/0.2.0/Babagan.apk","sha256","ab".repeat(32),"bytes",100)); }
    private String sign(JSONObject payload) throws Exception {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        Signature signature = Signature.getInstance("SHA256withRSA"); signature.initSign(pair.getPrivate()); signature.update(bytes);
        return Json.object("schema",1,"keyId","test-key","payloadBase64",Base64.getEncoder().encodeToString(bytes),"signatureBase64",Base64.getEncoder().encodeToString(signature.sign())).toString();
    }
    @Test public void authenticReleaseAccepted() throws Exception { assertEquals("0.2.0", UpdateVerifier.verify(sign(payload()), key(), 1).version()); }
    @Test(expected = SecurityException.class) public void replayRejected() throws Exception { UpdateVerifier.verify(sign(payload()), key(), 3); }
    @Test(expected = SecurityException.class) public void otherHostRejectedEvenWithSignature() throws Exception { JSONObject data=payload(); data.getJSONObject("artifact").put("url","https://evil.example/Babagan.apk"); UpdateVerifier.verify(sign(data), key(), 1); }
    @Test(expected = SecurityException.class) public void alteredPayloadRejected() throws Exception { JSONObject env=new JSONObject(sign(payload())); JSONObject changed=payload(); changed.put("version","0.3.0"); env.put("payloadBase64",Base64.getEncoder().encodeToString(changed.toString().getBytes(StandardCharsets.UTF_8))); UpdateVerifier.verify(env.toString(),key(),1); }
    @Test(expected = SecurityException.class) public void otherPlatformRejected() throws Exception { JSONObject data=payload(); data.put("platform","windows"); UpdateVerifier.verify(sign(data),key(),1); }
    @Test public void versionOrderingIsNumeric() { assertTrue(UpdateVerifier.compareVersions("0.10.0","0.2.0")>0); }
}
