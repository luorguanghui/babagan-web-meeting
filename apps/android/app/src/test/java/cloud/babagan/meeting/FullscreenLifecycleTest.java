package cloud.babagan.meeting;

import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class FullscreenLifecycleTest {
    private static final class Host implements FullscreenLifecycle.Host<Object> {
        int attachments, restorations; Object shown;
        public void show(Object view) { attachments++; shown=view; }
        public void hide(Object view) { assertSame(shown,view); restorations++; shown=null; }
    }
    @Test public void genericElementFullscreenExitsBeforeMeetingBackAction() {
        Host host=new Host(); FullscreenLifecycle<Object> fullscreen=new FullscreenLifecycle<>(host);
        AtomicInteger callback=new AtomicInteger(),meetingBack=new AtomicInteger();
        fullscreen.enter(new Object(),callback::incrementAndGet);
        if(!fullscreen.exit())meetingBack.incrementAndGet();
        assertEquals(0,meetingBack.get());assertEquals(1,callback.get());assertEquals(1,host.restorations);
        assertFalse(fullscreen.isActive());assertFalse(fullscreen.exit());assertEquals(1,callback.get());
    }
    @Test public void callbackReentryAndRepeatedWebHideRestoreOnlyOnce() {
        Host host=new Host(); FullscreenLifecycle<Object> fullscreen=new FullscreenLifecycle<>(host);AtomicInteger callback=new AtomicInteger();
        fullscreen.enter(new Object(),()->{callback.incrementAndGet();fullscreen.exit();});
        fullscreen.exit();fullscreen.exit();fullscreen.destroy();
        assertEquals(1,callback.get());assertEquals(1,host.restorations);
    }
    @Test public void secondRequestCannotReplaceActiveView() {
        Host host=new Host();FullscreenLifecycle<Object> fullscreen=new FullscreenLifecycle<>(host);
        Object first=new Object();AtomicInteger rejected=new AtomicInteger();
        fullscreen.enter(first,()->{});assertFalse(fullscreen.enter(new Object(),rejected::incrementAndGet));
        assertSame(first,host.shown);assertEquals(1,rejected.get());assertEquals(1,host.attachments);fullscreen.exit();
    }
    @Test public void navigationAllowsAnotherSessionButDestroyRejectsLateViews() {
        Host host=new Host();FullscreenLifecycle<Object> fullscreen=new FullscreenLifecycle<>(host);AtomicInteger callbacks=new AtomicInteger();
        fullscreen.enter(new Object(),callbacks::incrementAndGet);fullscreen.exit();
        fullscreen.enter(new Object(),callbacks::incrementAndGet);fullscreen.destroy();
        assertFalse(fullscreen.enter(new Object(),callbacks::incrementAndGet));
        assertEquals(3,callbacks.get());assertEquals(2,host.attachments);assertEquals(2,host.restorations);
    }
    @Test public void failedAttachReleasesCallbackAndClearsOwnership() {
        AtomicInteger restored=new AtomicInteger(),callback=new AtomicInteger();
        FullscreenLifecycle<Object> fullscreen=new FullscreenLifecycle<>(new FullscreenLifecycle.Host<>() {
            public void show(Object view){throw new IllegalStateException("attach failed");}
            public void hide(Object view){restored.incrementAndGet();}
        });
        try{fullscreen.enter(new Object(),callback::incrementAndGet);fail("Expected attach failure");}catch(IllegalStateException expected){}
        assertFalse(fullscreen.isActive());assertEquals(1,restored.get());assertEquals(1,callback.get());fullscreen.destroy();assertEquals(1,callback.get());
    }
}
