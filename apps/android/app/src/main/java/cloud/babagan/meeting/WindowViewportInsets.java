package cloud.babagan.meeting;

/** Bounds the normal WebView itself; CSS viewport units must exclude system UI. */
final class WindowViewportInsets {
    static int[] resolve(boolean pictureInPicture, boolean fullscreen,
            int left, int top, int right, int bottom,
            int cutoutLeft, int cutoutTop, int cutoutRight, int cutoutBottom, int keyboardBottom) {
        if (pictureInPicture || fullscreen) return new int[]{0,0,0,0};
        return new int[]{Math.max(0,Math.max(left,cutoutLeft)),Math.max(0,Math.max(top,cutoutTop)),
            Math.max(0,Math.max(right,cutoutRight)),Math.max(0,Math.max(keyboardBottom,Math.max(bottom,cutoutBottom)))};
    }
}
