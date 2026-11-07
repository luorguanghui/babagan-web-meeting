package cloud.babagan.meeting;

import java.util.UUID;

/** Serializes consent and prevents a cancelled Android permission result starting capture. */
final class CaptureGate {
    private String session;
    private boolean consentPending;
    synchronized void request(String id) {
        if (!UUID.fromString(id).toString().equalsIgnoreCase(id)) throw new IllegalArgumentException("Invalid session ID");
        if (session != null) throw new IllegalStateException("A screen sharing session already exists");
        session = id;
        consentPending = true;
    }
    synchronized boolean accept(String id) {
        if (!consentPending || !owns(id)) return false;
        consentPending = false;
        return true;
    }
    synchronized boolean owns(String id) { return session != null && session.equals(id); }
    synchronized boolean stop(String id) {
        if (!owns(id)) return false;
        session = null;
        consentPending = false;
        return true;
    }
    synchronized String current() { return session; }
}
