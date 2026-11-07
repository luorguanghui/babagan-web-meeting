package cloud.babagan.meeting;

/** Owns one generic custom view. Exit clears ownership before callbacks can re-enter. */
final class FullscreenLifecycle<T> {
    interface Host<T> { void show(T view); void hide(T view); }
    private final Host<T> host;
    private T current;
    private Runnable hidden;
    private boolean destroyed;
    FullscreenLifecycle(Host<T> host) { this.host = host; }
    boolean isActive() { return current != null; }
    boolean enter(T view, Runnable onHidden) {
        if (current == view && current != null) return true;
        if (destroyed || current != null) { onHidden.run(); return false; }
        current = view; hidden = onHidden;
        try { host.show(view); return true; }
        catch (RuntimeException failure) { exit(); throw failure; }
    }
    boolean exit() {
        if (current == null) return false;
        T view = current; Runnable callback = hidden;
        current = null; hidden = null;
        try { host.hide(view); }
        finally { callback.run(); }
        return true;
    }
    void destroy() { destroyed = true; exit(); }
}
