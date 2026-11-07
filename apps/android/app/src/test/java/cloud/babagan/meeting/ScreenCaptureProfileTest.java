package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class ScreenCaptureProfileTest {
    @Test public void preNegotiationParameterUnavailabilityDoesNotPreventOfferCreation() {
        ScreenCaptureProfile.applySenderConfiguration(false, () -> { throw new IllegalStateException("Encodings not available before SDP"); });
    }
    @Test public void negotiatedParameterFailuresAlwaysPropagate() {
        IllegalStateException rejected = new IllegalStateException("setParameters rejected");
        try { ScreenCaptureProfile.applySenderConfiguration(true, () -> { throw rejected; }); fail("Negotiated sender failure was swallowed"); }
        catch (IllegalStateException actual) { assertSame(rejected, actual); }
    }
    @Test public void preservesBothSupportedSelections() {
        assertEquals(30,ScreenCaptureProfile.frameRate(30));
        assertEquals(60,ScreenCaptureProfile.frameRate(60));
    }
    @Test(expected=IllegalArgumentException.class) public void refusesUnsupportedCaptureCadence() { ScreenCaptureProfile.frameRate(45); }
    @Test public void sdpOnlyChangesActiveVideoFrameRateAndPreservesCodecAndBitrate() {
        String header="v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
        String active="m=video 9 UDP/TLS/RTP/SAVPF 96\r\nb=AS:10000\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e01f;packetization-mode=1\r\na=framerate:30\r\n";
        String rest="m=video 0 UDP/TLS/RTP/SAVPF 97\r\na=framerate:15\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n";
        String updated=ScreenCaptureProfile.withFrameRate(header+active+rest,60);
        assertEquals(header+active.replace("a=framerate:30","a=framerate:60")+rest,updated);
        assertEquals(updated,ScreenCaptureProfile.withFrameRate(updated,60));
        assertEquals(header+active+rest,ScreenCaptureProfile.withFrameRate(updated,30));
    }
    @Test public void addsHintToEveryActiveVideoSectionWithoutChangingLineEndings() {
        String sdp="v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=sendonly\nm=video 9 UDP/TLS/RTP/SAVPF 97\na=sendonly\n";
        assertEquals("v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=sendonly\na=framerate:60\nm=video 9 UDP/TLS/RTP/SAVPF 97\na=sendonly\na=framerate:60\n",ScreenCaptureProfile.withFrameRate(sdp,60));
    }
}
