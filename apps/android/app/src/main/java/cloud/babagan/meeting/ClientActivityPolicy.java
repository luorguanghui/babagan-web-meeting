package cloud.babagan.meeting;

final class ClientActivityPolicy {
    static boolean busy(boolean joined, boolean pendingCapture, boolean serviceCapture) {
        return joined || pendingCapture || serviceCapture;
    }
    static boolean canStartMicrophone(boolean enabled, boolean joined, boolean permission, boolean foreground, boolean alreadyActive) {
        return enabled && joined && permission && (foreground || alreadyActive);
    }
}
