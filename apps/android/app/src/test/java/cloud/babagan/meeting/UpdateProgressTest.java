package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateProgressTest {
    @Test public void reportsRealBytesAtMostEveryTwoHundredMilliseconds() {
        UpdateProgress progress = new UpdateProgress();
        UpdateProgress.Snapshot start = progress.start(1000, 1000);
        assertEquals(0, start.downloadedBytes()); assertEquals(1000, start.totalBytes());
        assertNull(progress.downloaded(start.generation(), 50, 1100));
        UpdateProgress.Snapshot update = progress.downloaded(start.generation(), 250, 1200);
        assertEquals(250, update.downloadedBytes()); assertEquals("downloading", update.phase());
        assertNull(progress.downloaded(start.generation(), 500, 1250));
        UpdateProgress.Snapshot verifiedNext = progress.downloaded(start.generation(), 1000, 1300);
        assertEquals("verifying", verifiedNext.phase()); assertEquals(1000, verifiedNext.downloadedBytes());
    }
    @Test public void deferralSuppressesQueuedProgressAndCompletionEvenAfterIdle() {
        UpdateProgress progress = new UpdateProgress(); UpdateProgress.Snapshot old = progress.start(100, 0);
        UpdateProgress.Snapshot queued = progress.downloaded(old.generation(), 50, 200);
        progress.invalidate();
        assertFalse(progress.isCurrent(queued)); assertFalse(progress.isActive(old.generation()));
        assertNull(progress.downloaded(old.generation(), 90, 400));
        UpdateProgress.Snapshot retry = progress.start(100, 400);
        assertEquals(0, retry.downloadedBytes()); assertFalse(progress.isCurrent(queued));
        assertNull(progress.verifying(old.generation())); assertTrue(progress.isCurrent(retry));
    }
    @Test public void closeSuppressesEveryQueuedCallbackAndDisallowsRetry() {
        UpdateProgress progress = new UpdateProgress(); UpdateProgress.Snapshot old = progress.start(100, 0);
        progress.close(); assertFalse(progress.isCurrent(old)); assertFalse(progress.isActive(old.generation()));
        assertNull(progress.downloaded(old.generation(), 10, 200));
        try { progress.start(100, 400); fail("Closed progress restarted"); } catch (IllegalStateException expected) { }
    }
    @Test public void rejectsOverflowAndImpossibleByteCounts() {
        UpdateProgress progress = new UpdateProgress();
        for (long total : new long[] {0, -1, Long.MAX_VALUE}) {
            try { progress.start(total, 0); fail("Invalid total accepted"); } catch (IllegalArgumentException expected) { }
        }
        UpdateProgress.Snapshot run = progress.start(100, 0);
        for (long bytes : new long[] {-1, 101, Long.MAX_VALUE}) {
            try { progress.downloaded(run.generation(), bytes, 200); fail("Invalid byte count accepted"); } catch (IllegalArgumentException expected) { }
        }
        progress.downloaded(run.generation(), 50, 200);
        try { progress.downloaded(run.generation(), 49, 400); fail("Progress went backwards"); } catch (IllegalArgumentException expected) { }
    }
    @Test public void cachedPackageVerificationCanRestartARealDownload() {
        UpdateProgress progress = new UpdateProgress(); UpdateProgress.Snapshot start = progress.start(100, 0);
        UpdateProgress.Snapshot verifying = progress.verifying(start.generation());
        assertEquals("verifying", verifying.phase());
        UpdateProgress.Snapshot retry = progress.restart(start.generation(), 100);
        assertEquals("downloading", retry.phase()); assertEquals(0, retry.downloadedBytes());
        assertFalse(progress.isCurrent(verifying)); assertTrue(progress.isCurrent(retry));
    }
}
