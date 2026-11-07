package cloud.babagan.meeting;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import androidx.annotation.RequiresApi;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Process;
import java.nio.ByteBuffer;

/** Official playback capture only. Never constructs a microphone AudioRecord. */
@RequiresApi(29)
final class AndroidPlaybackRecorder implements PlaybackAudioSession.Recorder {
    private final AudioRecord record;

    AndroidPlaybackRecorder(Context context,MediaProjection projection) {
        if(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Playback audio permission is missing");
        if(projection==null)throw new IllegalArgumentException("Screen projection is unavailable");
        AudioPlaybackCaptureConfiguration capture=new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(Process.myUid()).build();
        int minimum=AudioRecord.getMinBufferSize(PlaybackAudioSession.SAMPLE_RATE,AudioFormat.CHANNEL_IN_STEREO,AudioFormat.ENCODING_PCM_16BIT);
        if(minimum<=0)throw new IllegalStateException("Playback audio format is unavailable");
        record=new AudioRecord.Builder().setAudioPlaybackCaptureConfig(capture)
            .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(PlaybackAudioSession.SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build())
            .setBufferSizeInBytes(Math.max(minimum*2,PlaybackAudioSession.FRAME_BYTES*4)).build();
        if(record.getState()!=AudioRecord.STATE_INITIALIZED) { record.release();throw new IllegalStateException("Playback audio could not initialize"); }
    }
    public void start() { record.startRecording();if(record.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException("Playback audio could not start"); }
    public int read(ByteBuffer buffer,int size) { return record.read(buffer,size,AudioRecord.READ_BLOCKING); }
    public void stop() { record.stop(); }
    public void release() { record.release(); }
}
