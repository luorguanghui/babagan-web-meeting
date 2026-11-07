package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class ClientOwnershipTest {
    @Test public void secondActivityCannotReplaceOrDetachServiceOwner() {
        OwnerLease<Object> lease = new OwnerLease<>(); Object first = new Object(), second = new Object();
        assertTrue(lease.attach(first)); assertFalse(lease.attach(second)); lease.detach(second);
        assertTrue(lease.owns(first)); assertSame(first, lease.get());
        lease.detach(first); assertTrue(lease.attach(second));
    }
    @Test public void actualServiceCaptureBlocksAnOtherwiseIdleActivity() {
        assertTrue(ClientActivityPolicy.busy(false, false, true));
        assertTrue(ClientActivityPolicy.busy(false, true, false));
        assertFalse(ClientActivityPolicy.busy(false, false, false));
    }
    @Test public void microphoneRequiresActualUnmutePermissionAndForegroundStart() {
        assertFalse(ClientActivityPolicy.canStartMicrophone(false, true, true, true, false));
        assertFalse(ClientActivityPolicy.canStartMicrophone(true, true, false, true, false));
        assertFalse(ClientActivityPolicy.canStartMicrophone(true, true, true, false, false));
        assertFalse(ClientActivityPolicy.canStartMicrophone(true, false, true, true, true));
        assertTrue(ClientActivityPolicy.canStartMicrophone(true, true, true, true, false));
        assertTrue(ClientActivityPolicy.canStartMicrophone(true, true, true, false, true));
    }
}
