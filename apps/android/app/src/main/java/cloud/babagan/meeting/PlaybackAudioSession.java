package cloud.babagan.meeting;

import java.nio.ByteBuffer;
import java.util.concurrent.locks.LockSupport;

/** Session-owned PCM source, separate from Android and WebRTC for lifecycle tests. */
final class PlaybackAudioSession implements AutoCloseable {
    interface Recorder { void start(); int read(ByteBuffer buffer,int size); void stop(); void release(); }
    interface RecorderFactory { Recorder open(); }
    interface Pacer { void awaitFrame(); }
    static final int SAMPLE_RATE=48000, CHANNELS=2, FRAME_BYTES=1920;
    private final Runnable failed;
    private final Pacer pacer;
    private Recorder recorder;
    private int readers;
    private boolean closed, stopComplete, released, failureReported;
    private String unavailableReason;

    PlaybackAudioSession(boolean requested,int sdk,boolean permitted,RecorderFactory factory,Runnable failed,Pacer pacer) {
        this.failed=failed;this.pacer=pacer;
        if(!requested||sdk<29||!permitted) {
            unavailableReason=!requested?null:sdk<29?"unsupported":"permission-denied";
            closed=true;stopComplete=true;return;
        }
        try { recorder=factory.open();recorder.start(); }
        catch(RuntimeException error) { unavailableReason="unavailable";close(); }
    }
    synchronized boolean isActive() { return !closed&&recorder!=null; }
    synchronized String unavailableReason() { return unavailableReason; }

    /** The SDK's mutable buffer callback runs with its microphone AudioRecord disabled. */
    long onBuffer(ByteBuffer buffer,int format,int channels,int sampleRate,int bytesRead,long timestamp) {
        // 144's callback-only mode does not pace itself, including after stop or silence.
        pacer.awaitFrame();
        Recorder input;
        synchronized(this) { input=closed?null:recorder;if(input!=null)readers++; }
        try {
            clear(buffer);
            if(input==null)return 0;
            if(format!=2||channels!=CHANNELS||sampleRate!=SAMPLE_RATE||buffer.capacity()!=FRAME_BYTES) {
                fail();return 0;
            }
            int offset=0;
            while(offset<buffer.capacity()&&isActive()) {
                ByteBuffer part=buffer.duplicate();part.position(offset);part=part.slice();
                int count=input.read(part,part.capacity());
                if(count<=0||count>part.capacity()||(count&3)!=0) { fail();clear(buffer);return 0; }
                offset+=count;
            }
            // A concurrent stop owns this session. Do not publish the read that it interrupted.
            if(!isActive())clear(buffer);
        } catch(RuntimeException error) { fail();clear(buffer); }
        finally {
            if(input!=null) { synchronized(this) { readers--;releaseIfIdle(); } }
            buffer.position(0);
        }
        return 0; // AudioRecord timestamps are optional; never invent a capture timestamp.
    }
    private static void clear(ByteBuffer buffer) { buffer.clear();for(int i=0;i<buffer.capacity();i++)buffer.put(i,(byte)0); }
    private void fail() {
        synchronized(this) { if(closed||failureReported)return;failureReported=true;unavailableReason="unavailable"; }
        close();failed.run();
    }
    public void close() {
        Recorder input;
        synchronized(this) { if(closed)return;closed=true;input=recorder; }
        // Never hold our monitor over stop(): it must unblock an in-flight platform read.
        try { if(input!=null)input.stop(); } catch(RuntimeException ignored) { /* Already revoked/stopped. */ }
        finally { synchronized(this) { stopComplete=true;releaseIfIdle(); } }
    }
    private void releaseIfIdle() {
        if(!closed||!stopComplete||readers!=0||released||recorder==null)return;
        released=true;recorder.release();
    }
    static Pacer realtimePacer() {
        return new Pacer() {
            private long next;
            public void awaitFrame() {
                long now=System.nanoTime();
                if(next==0||now-next>100_000_000L)next=now;
                long remaining;
                while((remaining=next-System.nanoTime())>0&&!Thread.currentThread().isInterrupted())LockSupport.parkNanos(remaining);
                next=Math.max(next,System.nanoTime())+10_000_000L;
            }
        };
    }
}
