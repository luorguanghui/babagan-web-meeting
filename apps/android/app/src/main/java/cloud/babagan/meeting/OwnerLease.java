package cloud.babagan.meeting;

/** A second Activity cannot replace or clear the current service's event owner. */
final class OwnerLease<T> {
    private T owner;
    synchronized boolean attach(T candidate) {
        if (owner != null && owner != candidate) return false;
        owner = candidate;
        return true;
    }
    synchronized void detach(T candidate) { if (owner == candidate) owner = null; }
    synchronized boolean owns(T candidate) { return owner != null && owner == candidate; }
    synchronized T get() { return owner; }
}
