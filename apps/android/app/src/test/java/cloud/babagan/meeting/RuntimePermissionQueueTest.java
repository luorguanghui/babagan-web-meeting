package cloud.babagan.meeting;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class RuntimePermissionQueueTest {
    private static final String AUDIO="android.permission.RECORD_AUDIO",NOTIFICATIONS="android.permission.POST_NOTIFICATIONS",BLUETOOTH="android.permission.BLUETOOTH_CONNECT";
    private static class Prompt { final String permission;final int code;Prompt(String permission,int code){this.permission=permission;this.code=code;} }
    private static class Harness {
        final List<Prompt> prompts=new ArrayList<>();
        int idleCalls;
        final RuntimePermissionQueue queue=new RuntimePermissionQueue((permission,code)->prompts.add(new Prompt(permission,code)),()->idleCalls++);
        void finish(int index,int result){Prompt p=prompts.get(index);assertTrue(queue.complete(p.code,new String[]{p.permission},new int[]{result}));}
    }
    @Test public void microphoneAndCaptureShareOneActiveAudioDialogAndFanOut() {
        Harness h=new Harness();List<RuntimePermissionQueue.Result> microphone=new ArrayList<>(),capture=new ArrayList<>();
        h.queue.request(AUDIO,new Object(),microphone::add);h.queue.request(AUDIO,new Object(),capture::add);
        assertEquals(1,h.prompts.size());assertFalse(h.queue.isIdle());h.finish(0,0);
        assertEquals(Arrays.asList(RuntimePermissionQueue.Result.GRANTED),microphone);assertEquals(microphone,capture);assertTrue(h.queue.isIdle());
    }
    @Test public void notificationAudioAndBluetoothDialogsNeverOverlap() {
        Harness h=new Harness();
        h.queue.request(NOTIFICATIONS,new Object(),r->{});h.queue.request(AUDIO,new Object(),r->{});h.queue.request(BLUETOOTH,new Object(),r->{});
        assertEquals(1,h.prompts.size());h.finish(0,-1);assertEquals(AUDIO,h.prompts.get(1).permission);assertEquals(2,h.prompts.size());
        assertFalse(h.queue.complete(h.prompts.get(0).code,new String[]{NOTIFICATIONS},new int[]{0}));assertEquals(2,h.prompts.size());
        h.finish(1,0);assertEquals(BLUETOOTH,h.prompts.get(2).permission);h.finish(2,0);assertTrue(h.queue.isIdle());
    }
    @Test public void cancellingWebRequestDoesNotReleaseTheStillVisibleSystemDialog() {
        Harness h=new Harness();Object old=new Object();List<RuntimePermissionQueue.Result> oldResults=new ArrayList<>(),current=new ArrayList<>();
        h.queue.request(AUDIO,old,oldResults::add);h.queue.cancel(old);h.queue.request(BLUETOOTH,new Object(),r->{});
        assertEquals(1,h.prompts.size());assertFalse(h.queue.isIdle());
        h.queue.request(AUDIO,new Object(),current::add);assertEquals(1,h.prompts.size());h.finish(0,0);
        assertTrue(oldResults.isEmpty());assertEquals(Arrays.asList(RuntimePermissionQueue.Result.GRANTED),current);assertEquals(2,h.prompts.size());
    }
    @Test public void navigationRemovesQueuedCaptureWithoutStartingItsDialog() {
        Harness h=new Harness();Object capture=new Object();List<RuntimePermissionQueue.Result> results=new ArrayList<>();
        h.queue.request(NOTIFICATIONS,new Object(),r->{});h.queue.request(AUDIO,capture,results::add);h.queue.cancel(capture);h.finish(0,0);
        assertEquals(1,h.prompts.size());assertTrue(results.isEmpty());assertTrue(h.queue.isIdle());
    }
    @Test public void emptyOrMismatchedSystemResultsAreCancellationRatherThanDenial() {
        String[][] names={new String[0],new String[]{NOTIFICATIONS},new String[]{AUDIO}};
        int[][] values={new int[0],new int[]{0},new int[0]};
        for(int i=0;i<names.length;i++) {
            Harness h=new Harness();List<RuntimePermissionQueue.Result> results=new ArrayList<>();h.queue.request(AUDIO,new Object(),results::add);
            h.queue.complete(h.prompts.get(0).code,names[i],values[i]);assertEquals(Arrays.asList(RuntimePermissionQueue.Result.CANCELLED),results);
        }
    }
    @Test public void explicitDenialIsAvailableToVideoFallbackWithoutBecomingGrant() {
        Harness h=new Harness();List<RuntimePermissionQueue.Result> results=new ArrayList<>();h.queue.request(AUDIO,new Object(),results::add);h.finish(0,-1);
        assertEquals(Arrays.asList(RuntimePermissionQueue.Result.DENIED),results);
    }
    @Test public void projectionCanPauseDispatchFromCompletionUntilItsRealResult() {
        Harness h=new Harness();h.queue.request(AUDIO,new Object(),r->h.queue.pause(true));h.queue.request(BLUETOOTH,new Object(),r->{});
        h.finish(0,0);assertEquals(1,h.prompts.size());assertFalse(h.queue.isIdle());h.queue.pause(false);assertEquals(2,h.prompts.size());
    }
    @Test public void cancellingAnotherWaiterDuringCompletionSuppressesItsCallback() {
        Harness h=new Harness();Object capture=new Object();List<RuntimePermissionQueue.Result> results=new ArrayList<>();
        h.queue.request(AUDIO,new Object(),r->h.queue.cancel(capture));h.queue.request(AUDIO,capture,results::add);h.finish(0,0);assertTrue(results.isEmpty());
    }
    @Test public void invalidatedConsumerCannotPreventOtherOwnersReceivingResult() {
        Harness h=new Harness();List<RuntimePermissionQueue.Result> results=new ArrayList<>();
        h.queue.request(AUDIO,new Object(),r->{throw new IllegalStateException("web request disappeared");});h.queue.request(AUDIO,new Object(),results::add);
        h.finish(0,0);assertEquals(Arrays.asList(RuntimePermissionQueue.Result.GRANTED),results);assertTrue(h.queue.isIdle());
    }
    @Test public void closedActivityDropsResultsAndCannotLaunchQueuedRequests() {
        Harness h=new Harness();List<RuntimePermissionQueue.Result> results=new ArrayList<>();h.queue.request(AUDIO,new Object(),results::add);h.queue.request(BLUETOOTH,new Object(),results::add);
        h.queue.close();assertFalse(h.queue.complete(h.prompts.get(0).code,new String[]{AUDIO},new int[]{0}));h.queue.pause(false);
        h.queue.request(NOTIFICATIONS,new Object(),results::add);assertEquals(1,h.prompts.size());assertTrue(results.isEmpty());
    }
    @Test public void synchronousLaunchFailureCancelsWaitersAndAllowsLaterRequest() {
        List<RuntimePermissionQueue.Result> results=new ArrayList<>();List<String> prompts=new ArrayList<>();
        RuntimePermissionQueue queue=new RuntimePermissionQueue((permission,code)->{prompts.add(permission);if(AUDIO.equals(permission))throw new IllegalStateException("activity unavailable");},()->{});
        queue.request(AUDIO,new Object(),results::add);queue.request(BLUETOOTH,new Object(),r->{});
        assertEquals(Arrays.asList(RuntimePermissionQueue.Result.CANCELLED),results);assertEquals(Arrays.asList(AUDIO,BLUETOOTH),prompts);
    }
}
