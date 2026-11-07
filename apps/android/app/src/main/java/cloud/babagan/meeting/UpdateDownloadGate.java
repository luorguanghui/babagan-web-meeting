package cloud.babagan.meeting;

import java.io.IOException;

/** Cancels a download generation when meeting/capture activity begins. */
final class UpdateDownloadGate {
    static final class Deferred extends IOException { Deferred() { super("Update download deferred until the meeting is idle"); } }
    interface Work<T> { T run(Ticket ticket) throws Exception; }
    final class Ticket {
        private volatile boolean cancelled;
        private volatile Runnable cancelRequest;
        void check() throws Deferred { if (cancelled || busy || closed) throw new Deferred(); }
        void onCancel(Runnable cancel) {
            cancelRequest = cancel;
            if (cancelled || busy || closed) cancel.run();
        }
        private void cancel() { cancelled = true; Runnable current = cancelRequest; if (current != null) current.run(); }
    }
    private volatile boolean busy = true, closed;
    private Ticket active;
    void setBusy(boolean value) {
        Ticket cancel = null;
        synchronized (this) { busy = value; if (value) cancel = active; }
        if (cancel != null) cancel.cancel();
    }
    <T> T run(Work<T> work) throws Exception {
        Ticket ticket;
        synchronized (this) {
            if (busy || closed || active != null) throw new Deferred();
            active = ticket = new Ticket();
        }
        try { ticket.check(); return work.run(ticket); }
        finally { synchronized (this) { if (active == ticket) active = null; } }
    }
    void close() { closed = true; setBusy(true); }
}
