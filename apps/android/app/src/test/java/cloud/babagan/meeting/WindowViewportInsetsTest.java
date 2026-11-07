package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class WindowViewportInsetsTest {
    @Test public void separatesWebViewportFromStatusNavigationAndCutout() {
        assertArrayEquals(new int[]{0,32,0,24}, WindowViewportInsets.resolve(false, false, 0,24,0,24,0,32,0,0,0));
    }
    @Test public void keyboardReplacesRatherThanAddsNavigationInset() {
        assertArrayEquals(new int[]{0,24,0,320}, WindowViewportInsets.resolve(false,false,0,24,0,24,0,0,0,0,320));
    }
    @Test public void fullscreenAndPictureInPictureUseWholeMediaWindow() {
        assertArrayEquals(new int[]{0,0,0,0}, WindowViewportInsets.resolve(true,false,20,30,10,24,40,0,0,0,320));
        assertArrayEquals(new int[]{0,0,0,0}, WindowViewportInsets.resolve(false,true,20,30,10,24,40,0,0,0,320));
    }
    @Test public void landscapeCutoutCannotCoverControls() {
        assertArrayEquals(new int[]{40,0,24,0}, WindowViewportInsets.resolve(false,false,0,0,24,0,40,0,0,0,0));
    }
}
