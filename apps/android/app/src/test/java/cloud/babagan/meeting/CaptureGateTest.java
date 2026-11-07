package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class CaptureGateTest {
    private static final String A = "5be9f4d9-d3f4-483c-8c5c-0f129674f566", B = "e52175a1-3c01-4bfc-a837-aa7c102befd8";
    @Test public void cancelledConsentCannotStartTheNextSession() {
        CaptureGate gate = new CaptureGate();
        gate.request(A); assertTrue(gate.stop(A)); gate.request(B);
        assertFalse(gate.accept(A)); assertTrue(gate.accept(B)); assertFalse(gate.accept(B));
    }
    @Test public void staleStopDoesNotStopCurrentSession() {
        CaptureGate gate = new CaptureGate(); gate.request(B);
        assertFalse(gate.stop(A)); assertTrue(gate.owns(B));
    }
    @Test(expected = IllegalStateException.class) public void concurrentStartCannotReplaceConsent() { CaptureGate gate = new CaptureGate(); gate.request(A); gate.request(B); }
    @Test(expected = IllegalArgumentException.class) public void invalidSessionRejected() { new CaptureGate().request("not-a-uuid"); }
}
