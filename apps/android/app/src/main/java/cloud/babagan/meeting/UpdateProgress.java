package cloud.babagan.meeting;

/** Immutable byte reports; invalidation also rejects callbacks already queued on the UI thread. */
final class UpdateProgress {
    record Snapshot(long generation, long revision, String phase, long downloadedBytes, long totalBytes) { }
    private long generation, revision, totalBytes, downloadedBytes, lastReport;
    private boolean active, closed;

    synchronized Snapshot start(long total, long now) {
        if (closed) throw new IllegalStateException("Update progress is closed");
        if (total < 1 || total > 9_007_199_254_740_991L) throw new IllegalArgumentException("Invalid update total");
        generation++; active = true; totalBytes = total;
        return restart(generation, now);
    }
    synchronized Snapshot restart(long run, long now) {
        if (!isActive(run)) return null;
        downloadedBytes = 0; lastReport = now;
        return report("downloading");
    }
    synchronized Snapshot downloaded(long run, long bytes, long now) {
        if (!isActive(run)) return null;
        if (bytes < downloadedBytes || bytes > totalBytes) throw new IllegalArgumentException("Invalid downloaded byte count");
        downloadedBytes = bytes;
        if (bytes == totalBytes) return report("verifying");
        if (now - lastReport < 200) return null;
        lastReport = now;
        return report("downloading");
    }
    synchronized Snapshot verifying(long run) {
        if (!isActive(run)) return null;
        downloadedBytes = totalBytes;
        return report("verifying");
    }
    private Snapshot report(String phase) { return new Snapshot(generation, ++revision, phase, downloadedBytes, totalBytes); }
    synchronized boolean isActive(long run) { return active && !closed && generation == run; }
    synchronized boolean isCurrent(Snapshot value) { return value != null && isActive(value.generation()) && value.revision() == revision; }
    synchronized void invalidate() { active = false; }
    synchronized void close() { closed = true; invalidate(); }
}
