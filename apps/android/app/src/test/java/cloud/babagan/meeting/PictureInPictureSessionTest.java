package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class PictureInPictureSessionTest {
    private static final String ONE="11111111-1111-4111-8111-111111111111",TWO="22222222-2222-4222-8222-222222222222";
    @Test public void releaseDuringAcceptedEntrySurvivesTheLaterAndroidModeCallback(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);
        assertTrue(session.release(ONE));assertTrue(session.released());assertFalse(session.entered());
        session.enteredMode();assertTrue(session.entered());assertTrue(session.released());assertEquals(ONE,session.current());
    }
    @Test public void staleReleaseCannotCoverOrClearTheCurrentPlayback(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);session.enteredMode();
        assertFalse(session.release(TWO));assertFalse(session.released());assertEquals(ONE,session.current());
    }
    @Test public void secondEntryCannotReplaceAnExistingOrReleasedWindow(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);session.release(ONE);
        try{session.begin(TWO);fail("Old Android window was replaced");}catch(IllegalStateException expected){}
        assertEquals(ONE,session.current());assertEquals(ONE,session.clear());session.begin(TWO);assertTrue(session.owns(TWO));
    }
    @Test public void exitAndRepeatedLifecycleCleanupAreIdempotent(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);session.enteredMode();session.release(ONE);
        assertEquals(ONE,session.clear());assertNull(session.clear());assertFalse(session.entered());assertFalse(session.released());
    }
    @Test public void ordinaryStopBeforeTheModeCallbackDoesNotDiscardPendingOwnership(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);session.release(ONE);
        assertFalse(session.stopConfirmsExit(false,false));assertTrue(session.owns(ONE));
        session.enteredMode();assertTrue(session.released());assertFalse(session.stopConfirmsExit(true,false));
        assertTrue(session.stopConfirmsExit(false,false));
    }
    @Test public void finishingConfirmsEvenAPendingSessionWasClosed(){
        PictureInPictureSession session=new PictureInPictureSession();session.begin(ONE);
        assertTrue(session.stopConfirmsExit(false,true));assertTrue(session.stopConfirmsExit(true,true));
    }
    @Test(expected=IllegalArgumentException.class) public void invalidSessionIsRefused(){new PictureInPictureSession().begin("not-a-session");}
    @Test public void preservesOrdinaryAspectAndClampsOnlyWindowRatioAtExactPlatformBounds(){
        assertArrayEquals(new int[]{1920,1080},PictureInPictureSession.aspect(1920,1080));
        assertArrayEquals(new int[]{239,100},PictureInPictureSession.aspect(7680,1080));
        assertArrayEquals(new int[]{100,239},PictureInPictureSession.aspect(1080,7680));
    }
    @Test(expected=IllegalArgumentException.class) public void zeroDimensionsAreRefused(){PictureInPictureSession.aspect(0,1080);}
    @Test(expected=IllegalArgumentException.class) public void OversizedDimensionsAreRefused(){PictureInPictureSession.aspect(16385,1080);}
}
