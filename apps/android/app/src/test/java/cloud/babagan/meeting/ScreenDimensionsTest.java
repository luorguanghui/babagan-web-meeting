package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class ScreenDimensionsTest {
    @Test public void portraitPreservesAspectRatioWithin1080pBudget(){assertArrayEquals(new int[]{864,1920},ScreenCaptureService.boundSize(1080,2400,1920,1080));}
    @Test public void smallScreenIsNotUpscaled(){assertArrayEquals(new int[]{720,1280},ScreenCaptureService.boundSize(720,1280,1920,1080));}
    @Test public void landscapeRemainsEven(){int[] size=ScreenCaptureService.boundSize(2561,1441,1920,1080);assertTrue(size[0]<=1920&&size[1]<=1080);assertEquals(0,size[0]%2);assertEquals(0,size[1]%2);}
}
