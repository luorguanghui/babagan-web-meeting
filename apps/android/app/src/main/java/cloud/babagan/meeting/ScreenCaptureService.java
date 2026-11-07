package cloud.babagan.meeting;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Point;
import android.media.projection.MediaProjection;
import android.os.*;
import android.view.WindowManager;
import org.json.JSONObject;
import org.webrtc.*;
import java.util.*;
import java.util.concurrent.*;

/** Owns capture beyond Activity backgrounding; never captures before an explicit consent result. */
public final class ScreenCaptureService extends Service {
    interface Listener {
        void started(String sessionId, JSONObject result);
        void failed(String sessionId, String message);
        void event(JSONObject event);
    }
    final class LocalBinder extends Binder { ScreenCaptureService service() { return ScreenCaptureService.this; } }
    private final ExecutorService rtc = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LocalBinder binder = new LocalBinder();
    private final OwnerLease<Listener> listeners = new OwnerLease<>();
    private static final java.util.concurrent.atomic.AtomicInteger ACTIVE_CAPTURE_SERVICES = new java.util.concurrent.atomic.AtomicInteger();
    private boolean resourcesActive;
    private volatile String sessionId;
    private PeerConnectionFactory factory;
    private EglBase egl;
    private PeerConnection peer;
    private VideoSource source;
    private VideoTrack track;
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper texture;
    private ScheduledExecutorService synthetic;
    private int frameRate, captureWidth, captureHeight;
    private boolean descriptionSet, foreground;
    private final ArrayList<IceCandidate> earlyIce = new ArrayList<>();

    @Override public IBinder onBind(Intent intent) { return binder; }
    boolean attachListener(Listener value) { return listeners.attach(value); }
    void detachListener(Listener value) { listeners.detach(value); }
    boolean ownedBy(Listener value) { return listeners.owns(value); }
    static boolean hasActiveCapture() { return ACTIVE_CAPTURE_SERVICES.get() > 0; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stop(sessionId, "notification"); return START_NOT_STICKY; }
        if (intent == null || !"capture".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        String id = intent.getStringExtra("sessionId");
        if (id == null || !id.equals(sessionId)) { stopSelf(); return START_NOT_STICKY; }
        createNotification();
        Intent permission = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra("permission", Intent.class) : intent.getParcelableExtra("permission");
        int width = intent.getIntExtra("width", 1920), height = intent.getIntExtra("height", 1080);
        int rate = intent.getIntExtra("frameRate", 30);
        rtc.execute(() -> begin(id, permission, width, height, rate, false));
        return START_NOT_STICKY;
    }

    synchronized void prepare(String id) { sessionId = id; if(!resourcesActive){resourcesActive=true;ACTIVE_CAPTURE_SERVICES.incrementAndGet();} }
    void beginSynthetic(String id) { prepare(id); rtc.execute(() -> begin(id, null, 640, 360, 15, true)); }

    private void createNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("sharing", "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ScreenCaptureService.class).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "sharing").setSmallIcon(R.drawable.ic_babagan)
            .setContentTitle("Babagan is sharing your screen").setContentText("Tap Stop to end screen sharing")
            .setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null, "Stop", stop).build()).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(10, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(10, notification);
        foreground = true;
    }

    private boolean owns(String id) { return id != null && id.equals(sessionId); }

    private void begin(String id, Intent permission, int maxWidth, int maxHeight, int rate, boolean test) {
        if (!owns(id)) return;
        try {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions());
            egl = EglBase.create();
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
            source = factory.createVideoSource(true);
            frameRate = Math.min(rate, 30); // Initial mobile profile; source cadence is never fabricated.
            int[] size = test ? new int[]{640,360} : displaySize(maxWidth, maxHeight);
            captureWidth = size[0]; captureHeight = size[1];
            source.adaptOutputFormat(captureWidth, captureHeight, frameRate);
            track = factory.createVideoTrack("babagan-screen", source);
            PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
            config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
            peer = factory.createPeerConnection(config, new Observer(id));
            if (peer == null) throw new IllegalStateException("Could not create the local media connection");
            RtpSender sender = peer.addTrack(track, Collections.singletonList("babagan-screen"));
            RtpParameters parameters = sender.getParameters();
            for (RtpParameters.Encoding encoding : parameters.encodings) { encoding.maxBitrateBps = 12_000_000; encoding.maxFramerate = frameRate; }
            sender.setParameters(parameters);
            if (test) startSynthetic(id);
            else {
                if (permission == null) throw new SecurityException("Screen sharing permission is missing");
                texture = SurfaceTextureHelper.create("BabaganScreen", egl.getEglBaseContext());
                capturer = new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
                    @Override public void onStop() { stop(id, "permission-revoked"); }
                    @Override public void onCapturedContentResize(int width, int height) { rtc.execute(() -> resize(id,width,height)); }
                });
                capturer.initialize(texture, ScreenCaptureService.this, source.getCapturerObserver());
                if (!owns(id)) { cleanup(); return; }
                capturer.startCapture(captureWidth, captureHeight, frameRate);
            }
            if (!owns(id)) { cleanup(); return; }
            PeerConnection current = peer;
            current.createOffer(new SimpleSdpObserver() {
                @Override public void onCreateSuccess(SessionDescription offer) {
                    if (!owns(id)) return;
                    current.setLocalDescription(new SimpleSdpObserver() {
                        @Override public void onSetSuccess() {
                            if (!owns(id)) return;
                            main.post(() -> { Listener sink = listeners.get(); if (sink != null && owns(id)) sink.started(id, Json.object("sessionId",id,"offer",Json.object("type","offer","sdp",offer.description),"width",captureWidth,"height",captureHeight,"frameRate",frameRate,"systemAudio",false)); });
                        }
                        @Override public void onSetFailure(String error) { fail(id, error); }
                    }, offer);
                }
                @Override public void onCreateFailure(String error) { fail(id,error); }
            }, new MediaConstraints());
        } catch (Exception error) { fail(id, error.getMessage() == null ? "Screen capture failed" : error.getMessage()); }
    }

    private void resize(String id, int width, int height) {
        if (!owns(id) || capturer == null || width < 2 || height < 2) return;
        int[] size = boundSize(width,height,1920,1080);
        if (captureWidth == size[0] && captureHeight == size[1]) return;
        captureWidth=size[0]; captureHeight=size[1];
        capturer.changeCaptureFormat(captureWidth,captureHeight,frameRate);
        source.adaptOutputFormat(captureWidth,captureHeight,frameRate);
        emit(Json.object("v",1,"event","capture.resized","sessionId",id,"width",captureWidth,"height",captureHeight));
    }

    private int[] displaySize(int maxWidth, int maxHeight) {
        WindowManager manager = getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30) { android.graphics.Rect bounds=manager.getMaximumWindowMetrics().getBounds(); return boundSize(bounds.width(),bounds.height(),maxWidth,maxHeight); }
        Point point = new Point(); manager.getDefaultDisplay().getRealSize(point);
        return boundSize(point.x,point.y,maxWidth,maxHeight);
    }
    static int[] boundSize(int width,int height,int maxWidth,int maxHeight) {
        int shortLimit=Math.min(Math.min(maxWidth,maxHeight),1080), longLimit=Math.min(Math.max(maxWidth,maxHeight),1920);
        double scale=Math.min(1.0,Math.min((double)shortLimit/Math.min(width,height),(double)longLimit/Math.max(width,height)));
        return new int[]{Math.max(2,((int)(width*scale)/2)*2),Math.max(2,((int)(height*scale)/2)*2)};
    }

    void signal(String id, JSONObject params) {
        rtc.execute(() -> {
            if (!owns(id) || peer == null) return;
            try {
                if (params.has("description")) {
                    JSONObject description=params.getJSONObject("description");
                    if (!"answer".equals(description.getString("type"))) throw new IllegalArgumentException("Expected an answer");
                    peer.setRemoteDescription(new SimpleSdpObserver() {
                        @Override public void onSetSuccess() { rtc.execute(() -> { if(!owns(id)||peer==null)return; descriptionSet=true; for(IceCandidate ice:earlyIce)peer.addIceCandidate(ice); earlyIce.clear(); }); }
                        @Override public void onSetFailure(String error) { fail(id,error); }
                    },new SessionDescription(SessionDescription.Type.ANSWER,description.getString("sdp")));
                } else if (!params.isNull("candidate")) {
                    JSONObject candidate=params.getJSONObject("candidate");
                    IceCandidate ice=new IceCandidate(candidate.optString("sdpMid","0"),candidate.optInt("sdpMLineIndex",0),candidate.getString("candidate"));
                    if(descriptionSet)peer.addIceCandidate(ice); else if(earlyIce.size()<128)earlyIce.add(ice);
                }
            } catch(Exception error) { fail(id,"Invalid local media signal"); }
        });
    }

    void stop(String id,String reason) {
        if(!owns(id))return;
        sessionId=null;
        rtc.execute(this::cleanup);
        emit(Json.object("v",1,"event","capture.ended","sessionId",id,"reason",reason));
        main.post(() -> { if(sessionId==null){if(foreground){stopForeground(STOP_FOREGROUND_REMOVE);foreground=false;}stopSelf();} });
    }
    private void fail(String id,String message) {
        if(!owns(id))return;
        main.post(() -> { Listener sink=listeners.get(); if(sink!=null)sink.failed(id,message); });
        stop(id,"error");
    }
    private void emit(JSONObject message) { main.post(() -> { Listener sink=listeners.get();if(sink!=null)sink.event(message); }); }

    private void cleanup() {
        if(synthetic!=null){synthetic.shutdownNow();synthetic=null;}
        if(capturer!=null){try{capturer.stopCapture();}catch(Exception ignored){}capturer.dispose();capturer=null;}
        if(peer!=null){peer.close();peer.dispose();peer=null;}
        if(track!=null){track.dispose();track=null;}
        if(source!=null){source.dispose();source=null;}
        if(texture!=null){texture.dispose();texture=null;}
        if(factory!=null){factory.dispose();factory=null;}
        if(egl!=null){egl.release();egl=null;}
        descriptionSet=false;earlyIce.clear();
        synchronized(this){if(sessionId==null&&resourcesActive){resourcesActive=false;ACTIVE_CAPTURE_SERVICES.decrementAndGet();}}
        MainActivity.servicesChanged();
    }

    private void startSynthetic(String id) {
        if(!BuildConfig.DEBUG)throw new SecurityException("Synthetic source is only available in debug builds");
        source.getCapturerObserver().onCapturerStarted(true);
        synthetic=Executors.newSingleThreadScheduledExecutor();
        final int[] count={0};
        synthetic.scheduleWithFixedDelay(() -> rtc.execute(() -> {
            if(!owns(id)||source==null)return;
            JavaI420Buffer buffer=JavaI420Buffer.allocate(640,360);
            int index=count[0]++;
            for(int y=0;y<360;y++)for(int x=0;x<640;x++)buffer.getDataY().put(y*buffer.getStrideY()+x,(byte)(16+((x+y+index*5)%220)));
            for(int y=0;y<180;y++)for(int x=0;x<320;x++){buffer.getDataU().put(y*buffer.getStrideU()+x,(byte)96);buffer.getDataV().put(y*buffer.getStrideV()+x,(byte)160);}
            VideoFrame frame=new VideoFrame(buffer,0,System.nanoTime());source.getCapturerObserver().onFrameCaptured(frame);frame.release();
        }),0,67,TimeUnit.MILLISECONDS);
    }

    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); String id=sessionId;if(id!=null)rtc.execute(() -> { int[] size=displaySize(1920,1080);resize(id,size[0],size[1]); }); }
    @Override public void onDestroy() { String id=sessionId;if(id!=null)stop(id,"service-destroyed");rtc.shutdown();super.onDestroy(); }

    private final class Observer implements PeerConnection.Observer {
        private final String id; Observer(String id){this.id=id;}
        public void onSignalingChange(PeerConnection.SignalingState state){}
        public void onIceConnectionChange(PeerConnection.IceConnectionState state){if(state==PeerConnection.IceConnectionState.FAILED)fail(id,"Local media connection failed");}
        public void onIceConnectionReceivingChange(boolean receiving){}
        public void onIceGatheringChange(PeerConnection.IceGatheringState state){if(state==PeerConnection.IceGatheringState.COMPLETE&&owns(id))emit(Json.object("v",1,"event","capture.signal","sessionId",id,"candidate",null));}
        public void onIceCandidate(IceCandidate candidate){if(owns(id))emit(Json.object("v",1,"event","capture.signal","sessionId",id,"candidate",Json.object("candidate",candidate.sdp,"sdpMid",candidate.sdpMid,"sdpMLineIndex",candidate.sdpMLineIndex)));}
        public void onIceCandidatesRemoved(IceCandidate[] candidates){}
        public void onAddStream(MediaStream stream){}
        public void onRemoveStream(MediaStream stream){}
        public void onDataChannel(DataChannel channel){}
        public void onRenegotiationNeeded(){}
        public void onAddTrack(RtpReceiver receiver,MediaStream[] streams){}
    }
    private static class SimpleSdpObserver implements SdpObserver {
        public void onCreateSuccess(SessionDescription sdp){}public void onSetSuccess(){}public void onCreateFailure(String error){}public void onSetFailure(String error){}
    }
}
