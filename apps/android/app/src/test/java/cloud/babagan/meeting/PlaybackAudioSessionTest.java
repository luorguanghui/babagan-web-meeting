package cloud.babagan.meeting;

import org.junit.Test;
import java.nio.ByteBuffer;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;
import org.webrtc.audio.JavaAudioDeviceModule;

public class PlaybackAudioSessionTest {
    private static class Recorder implements PlaybackAudioSession.Recorder {
        int starts, stops, releases, reads;
        boolean rejectStart;
        int readResult = 1920;
        CountDownLatch entered, unblock;
        public void start() { starts++; if(rejectStart) throw new SecurityException("revoked"); }
        public int read(ByteBuffer buffer, int size) {
            reads++;
            if(entered!=null) { entered.countDown(); try { assertTrue(unblock.await(2,TimeUnit.SECONDS)); } catch(InterruptedException e) { throw new AssertionError(e); } }
            if(readResult<0)return readResult;
            int count=Math.min(size,readResult); for(int i=0;i<count;i++)buffer.put(i,(byte)42); return count;
        }
        public void stop() { stops++; }
        public void release() { releases++; }
    }
    private PlaybackAudioSession start(Recorder recorder, AtomicInteger errors, AtomicInteger paced) {
        return new PlaybackAudioSession(true,29,true,()->recorder,errors::incrementAndGet,paced::incrementAndGet);
    }
    private ByteBuffer frame() { ByteBuffer buffer=ByteBuffer.allocateDirect(1920); for(int i=0;i<1920;i++)buffer.put(i,(byte)99);return buffer; }
    private void read(PlaybackAudioSession session,ByteBuffer buffer) {
        JavaAudioDeviceModule.AudioBufferCallback callback=session::onBuffer;
        callback.onBuffer(buffer,2,2,48000,0,0);
    }
    private void silent(ByteBuffer buffer) { for(int i=0;i<buffer.capacity();i++)assertEquals(0,buffer.get(i)); }

    @Test public void requiresExplicitChoiceSupportedOsAndPermissionBeforeOpeningRecorder() {
        AtomicInteger opens=new AtomicInteger();
        Object[][] cases={{false,29,true,null},{true,28,true,"unsupported"},{true,29,false,"permission-denied"}};
        for(Object[] value:cases) {
            PlaybackAudioSession session=new PlaybackAudioSession((boolean)value[0],(int)value[1],(boolean)value[2],()->{opens.incrementAndGet();return new Recorder();},()->{},()->{});
            assertFalse(session.isActive());assertEquals(value[3],session.unavailableReason()); session.close();
        }
        assertEquals(0,opens.get());
    }
    @Test public void fillsSdkBufferWithPlaybackPcmIncludingPartialReads() {
        Recorder recorder=new Recorder();recorder.readResult=960;AtomicInteger paced=new AtomicInteger();
        PlaybackAudioSession session=start(recorder,new AtomicInteger(),paced);ByteBuffer buffer=frame();buffer.position(buffer.capacity());
        read(session,buffer);
        for(int i=0;i<1920;i++)assertEquals(42,buffer.get(i));
        assertEquals(2,recorder.reads);assertEquals(1,paced.get());assertTrue(session.isActive());session.close();
    }
    @Test public void silenceRemainsAValidSourceAndDoesNotImplyPermissionFailure() {
        Recorder recorder=new Recorder(){public int read(ByteBuffer buffer,int size){for(int i=0;i<size;i++)buffer.put(i,(byte)0);return size;}};
        AtomicInteger errors=new AtomicInteger();PlaybackAudioSession session=start(recorder,errors,new AtomicInteger());ByteBuffer buffer=frame();
        read(session,buffer);silent(buffer);assertTrue(session.isActive());assertEquals(0,errors.get());session.close();
    }
    @Test public void stoppedSessionNeverReadsAgainAndCannotAffectSuccessor() {
        Recorder first=new Recorder(),second=new Recorder();AtomicInteger paced=new AtomicInteger();
        PlaybackAudioSession old=start(first,new AtomicInteger(),paced);old.close();old.close();
        PlaybackAudioSession current=start(second,new AtomicInteger(),new AtomicInteger());ByteBuffer buffer=frame();
        read(old,buffer);silent(buffer);assertEquals(1,paced.get());assertEquals(0,first.reads);assertEquals(1,first.stops);assertEquals(1,first.releases);
        read(current,buffer);assertEquals(42,buffer.get(0));assertEquals(0,second.stops);current.close();
    }
    @Test public void startFailureReleasesRecorderAndFallsBackToVideo() {
        Recorder recorder=new Recorder();recorder.rejectStart=true;PlaybackAudioSession session=start(recorder,new AtomicInteger(),new AtomicInteger());
        assertFalse(session.isActive());assertEquals("unavailable",session.unavailableReason());assertEquals(1,recorder.releases);session.close();assertEquals(1,recorder.releases);
    }
    @Test public void runtimeReadFailureClearsAllBytesAndReportsExactlyOnce() {
        Recorder recorder=new Recorder();recorder.readResult=-6;AtomicInteger errors=new AtomicInteger();PlaybackAudioSession session=start(recorder,errors,new AtomicInteger());ByteBuffer buffer=frame();
        read(session,buffer);read(session,buffer);silent(buffer);assertFalse(session.isActive());assertEquals(1,errors.get());assertEquals(1,recorder.releases);
    }
    @Test public void incompatibleSdkFormatFailsClosed() {
        Recorder recorder=new Recorder();AtomicInteger errors=new AtomicInteger();PlaybackAudioSession session=start(recorder,errors,new AtomicInteger());ByteBuffer buffer=frame();
        session.onBuffer(buffer,2,1,48000,0,0);silent(buffer);assertEquals(0,recorder.reads);assertEquals(1,errors.get());assertFalse(session.isActive());
    }
    @Test public void closeUnblocksOutsideLockAndDefersReleaseUntilReaderReturns() throws Exception {
        Recorder recorder=new Recorder();recorder.entered=new CountDownLatch(1);recorder.unblock=new CountDownLatch(1);
        PlaybackAudioSession session=start(recorder,new AtomicInteger(),new AtomicInteger());ByteBuffer buffer=frame();
        ExecutorService executor=Executors.newSingleThreadExecutor();
        try {
            Future<?> reading=executor.submit(()->read(session,buffer));assertTrue(recorder.entered.await(2,TimeUnit.SECONDS));
            session.close();assertEquals(1,recorder.stops);assertEquals(0,recorder.releases);
            recorder.unblock.countDown();reading.get(2,TimeUnit.SECONDS);silent(buffer);assertEquals(1,recorder.releases);
        } finally { recorder.unblock.countDown();executor.shutdownNow();session.close(); }
    }
}
