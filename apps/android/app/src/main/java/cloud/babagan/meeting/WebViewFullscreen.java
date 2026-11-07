package cloud.babagan.meeting;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

/** Hosts WebView's generic fullscreen rendering surface without replacing or pausing the WebView. */
final class WebViewFullscreen {
    private final Activity activity;
    private final FrameLayout root;
    private final FullscreenLifecycle<View> lifecycle;
    private FrameLayout overlay;
    private int previousSystemUi, previousBarBehavior;
    private boolean previousFullscreenFlag, statusVisible, navigationVisible;
    private boolean saved;
    WebViewFullscreen(Activity activity, FrameLayout root) {
        this.activity = activity; this.root = root;
        lifecycle = new FullscreenLifecycle<>(new FullscreenLifecycle.Host<>() {
            public void show(View view) { attach(view); }
            public void hide(View view) { detach(view); }
        });
    }
    void show(View view, WebChromeClient.CustomViewCallback callback) {
        lifecycle.enter(view, () -> reject(callback));
    }
    static void reject(WebChromeClient.CustomViewCallback callback) { try { callback.onCustomViewHidden(); } catch (RuntimeException ignored) { /* The WebView document may already be destroyed. */ } }
    boolean exit() { return lifecycle.exit(); }
    void destroy() { lifecycle.destroy(); }
    void reapply() { if (lifecycle.isActive()) hideBars(); }

    private void attach(View view) {
        if (view.getParent() != null) throw new IllegalStateException("Fullscreen view is already attached");
        Window window = activity.getWindow(); View decor = window.getDecorView();
        previousSystemUi = decor.getSystemUiVisibility();
        previousFullscreenFlag = (window.getAttributes().flags & WindowManager.LayoutParams.FLAG_FULLSCREEN) != 0;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = decor.getRootWindowInsets();
            statusVisible = insets == null ? !previousFullscreenFlag : insets.isVisible(WindowInsets.Type.statusBars());
            navigationVisible = insets == null || insets.isVisible(WindowInsets.Type.navigationBars());
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) previousBarBehavior = controller.getSystemBarsBehavior();
        }
        saved = true;
        overlay = new FrameLayout(activity); overlay.setBackgroundColor(Color.BLACK);
        overlay.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        hideBars(); view.requestFocus();
    }
    private void hideBars() {
        Window window = activity.getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        } else {
            window.getDecorView().setSystemUiVisibility(previousSystemUi | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
        root.requestApplyInsets();
    }
    private void detach(View view) {
        if (overlay != null) { overlay.removeView(view); root.removeView(overlay); overlay = null; }
        if (!saved) return;
        saved = false;
        Window window = activity.getWindow();
        if (previousFullscreenFlag) window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        else window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        window.getDecorView().setSystemUiVisibility(previousSystemUi);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(previousBarBehavior);
                restoreBar(controller, WindowInsets.Type.statusBars(), statusVisible);
                restoreBar(controller, WindowInsets.Type.navigationBars(), navigationVisible);
            }
        }
        root.requestApplyInsets();
    }
    @android.annotation.TargetApi(30)
    private static void restoreBar(WindowInsetsController controller, int type, boolean visible) {
        if (visible) controller.show(type); else controller.hide(type);
    }
}
