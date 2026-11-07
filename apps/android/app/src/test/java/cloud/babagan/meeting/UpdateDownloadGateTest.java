package cloud.babagan.meeting;

import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class UpdateDownloadGateTest {
    @Test public void busyClientMakesNoApkRequest() throws Exception {
        UpdateDownloadGate gate = new UpdateDownloadGate(); AtomicInteger requests = new AtomicInteger();
        try { gate.run(ticket -> requests.incrementAndGet()); fail("Expected deferral"); }
        catch (UpdateDownloadGate.Deferred expected) { assertEquals(0, requests.get()); }
        gate.setBusy(false); assertEquals(Integer.valueOf(1), gate.run(ticket -> requests.incrementAndGet()));
    }
    @Test public void joiningCancelsConnectionAndOldGenerationCannotResume() throws Exception {
        UpdateDownloadGate gate = new UpdateDownloadGate(); AtomicInteger requests = new AtomicInteger(), disconnects = new AtomicInteger();
        gate.setBusy(false);
        gate.run(ticket -> {
            requests.incrementAndGet(); ticket.onCancel(disconnects::incrementAndGet);
            gate.setBusy(true); gate.setBusy(false);
            assertEquals(1, disconnects.get());
            try { ticket.check(); fail("Cancelled transfer must not resume"); } catch (UpdateDownloadGate.Deferred expected) { /* expected */ }
            return null;
        });
        gate.run(ticket -> requests.incrementAndGet()); assertEquals(2, requests.get());
    }
    @Test public void cancellationBeforeConnectionRegistrationClosesItImmediately() throws Exception {
        UpdateDownloadGate gate = new UpdateDownloadGate(); AtomicInteger disconnects = new AtomicInteger(); gate.setBusy(false);
        gate.run(ticket -> { gate.setBusy(true); ticket.onCancel(disconnects::incrementAndGet); assertEquals(1,disconnects.get()); return null; });
    }
    @Test public void closePreventsAnyLaterApkRequest() throws Exception {
        UpdateDownloadGate gate = new UpdateDownloadGate(); gate.close(); gate.setBusy(false);
        try { gate.run(ticket -> { fail("Closed gate issued APK request"); return null; }); fail("Expected closed gate"); }
        catch (UpdateDownloadGate.Deferred expected) { /* expected */ }
    }
}
