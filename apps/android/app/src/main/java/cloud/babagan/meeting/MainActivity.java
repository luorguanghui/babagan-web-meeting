package cloud.babagan.meeting;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.*;
import android.webkit.*;
import android.widget.Toast;
import androidx.webkit.*;
import org.json.JSONObject;
import java.util.*;

public final class MainActivity extends Activity implements ScreenCaptureService.Listener {
    static final String ORIGIN=UpdateVerifier.ORIGIN;
    private WebView web;
    private WebViewFullscreen fullscreen;
    private WebViewPictureInPicture pictureInPicture;
    private CommunicationAudioRouter audioRoutes;
    private JavaScriptReplyProxy reply;
    private ScreenCaptureService capture;
    private boolean bound,ownsActivity;
    private volatile boolean joined,visible;
    private boolean microphoneEnabled;
    private final CaptureGate gate=new CaptureGate();
    private String pendingId,pendingSession;
    private JSONObject pendingParams;
    private String consentSession;
    private PermissionRequest microphoneRequest;
    private String bluetoothPermissionRequest;
    private long bluetoothPermissionGeneration;
    private boolean bluetoothPermissionInFlight;
    private UpdateManager updater;
    private final Handler updateTimer=new Handler(Looper.getMainLooper());
    private final Runnable periodicUpdate=new Runnable(){public void run(){if(!visible||updater==null)return;updater.check(null);updateTimer.postDelayed(this,30*60*1000L);}};
    private android.window.OnBackInvokedCallback backCallback;
    private static java.lang.ref.WeakReference<MainActivity> active=new java.lang.ref.WeakReference<>(null);
    static void servicesChanged(){MainActivity activity=active.get();if(activity!=null)activity.runOnUiThread(activity::updateBusyState);}
    static boolean receiveInstallResult(Intent confirmation){MainActivity activity=active.get();if(activity==null||activity.updater==null)return false;if(confirmation!=null)activity.updater.confirmation(confirmation);else activity.updater.installFinished();return true;}
    private final ServiceConnection connection=new ServiceConnection(){
        public void onServiceConnected(ComponentName name,IBinder binder){
            ScreenCaptureService service=((ScreenCaptureService.LocalBinder)binder).service();
            if(service.attachListener(MainActivity.this))capture=service;
            else {Toast.makeText(MainActivity.this,"Another meeting already owns screen sharing",Toast.LENGTH_LONG).show();finish();}
        }
        public void onServiceDisconnected(ComponentName name){capture=null;cancelCapture("service-disconnected");}
    };

    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        MainActivity previous=active.get();
        if(previous!=null&&!previous.isFinishing()&&!previous.isDestroyed()){previous.handleIncoming(getIntent());finish();return;}
        ownsActivity=true;
        active=new java.lang.ref.WeakReference<>(this);
        if(Build.VERSION.SDK_INT>=33){backCallback=this::handleBack;getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,backCallback);}
        web=new WebView(this);
        web.setBackgroundColor(0xfffaf9f6);
        android.widget.FrameLayout content=new android.widget.FrameLayout(this);
        content.addView(web,new android.widget.FrameLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT,android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(content);
        fullscreen=new WebViewFullscreen(this,content);
        pictureInPicture=new WebViewPictureInPicture(this,content,this::send);
        audioRoutes=new CommunicationAudioRouter(this,()->visible,this::send);
        web.setOnApplyWindowInsetsListener((view,insets)->{if(pictureInPicture.occupiesWindow())view.setPadding(0,0,0,0);else view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets;});
        WebSettings settings=web.getSettings();
        settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString()+" BabaganAndroid/"+BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)){
            new AlertDialog.Builder(this).setTitle("Update Android System WebView").setMessage("Babagan needs a current Android System WebView to connect its secure native screen sharing bridge.").setPositiveButton("Close",(dialog,which)->finish()).setCancelable(false).show();return;
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))WebViewCompat.addWebMessageListener(web,"BabaganAndroid",Collections.singleton(ORIGIN),(view,message,sourceOrigin,isMainFrame,proxy)->{
            if(!isMainFrame||!ORIGIN.equals(sourceOrigin.toString())||!trusted(web.getUrl()))return;
            reply=proxy;handleMessage(message.getData());
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                if(BuildConfig.DEBUG&&getIntent().getBooleanExtra("bridge-test",false)&&trusted(request.getUrl().toString())&&"/__android_bridge_test__".equals(request.getUrl().getPath())){
                    try{return new WebResourceResponse("text/html","UTF-8",getAssets().open("native-bridge-test.html"));}catch(java.io.IOException ignored){}
                }
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(!request.isForMainFrame())return false;
                if(trusted(request.getUrl().toString()))return false;
                String scheme=request.getUrl().getScheme();
                if(request.hasGesture()&&("https".equals(scheme)||"mailto".equals(scheme)))try{startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(ActivityNotFoundException ignored){}
                return true;
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){if(pictureInPicture!=null)pictureInPicture.release("navigation");if(fullscreen!=null)fullscreen.exit();cancelCapture("navigation");joined=false;releaseAudioRouting();microphoneState(false);reply=null;updateBusyState();}
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onShowCustomView(android.view.View view,CustomViewCallback callback){
                if(fullscreen==null||web==null||!trusted(web.getUrl())||isFinishing()||isDestroyed()||(pictureInPicture!=null&&pictureInPicture.occupiesWindow())){WebViewFullscreen.reject(callback);return;}
                try{fullscreen.show(view,callback);}catch(RuntimeException error){android.util.Log.w("Babagan","Could not attach fullscreen view");}
            }
            @Override public void onHideCustomView(){if(fullscreen!=null)fullscreen.exit();}
            @Override public boolean onConsoleMessage(ConsoleMessage message){if(BuildConfig.DEBUG&&message.message().startsWith("BABAGAN_TEST ")){android.util.Log.i("BabaganTest",message.message());return true;}return super.onConsoleMessage(message);}
            @Override public void onPermissionRequest(PermissionRequest request){
                runOnUiThread(()->{
                    if(!ORIGIN.equals(request.getOrigin().toString().replaceAll("/$",""))||!trusted(web.getUrl())){request.deny();return;}
                    boolean audio=Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
                    if(!audio){request.deny();return;}
                    if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});return;}
                    if(microphoneRequest!=null)microphoneRequest.deny();microphoneRequest=request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},30);
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request){if(microphoneRequest==request)microphoneRequest=null;}
        });
        bound=bindService(new Intent(this,ScreenCaptureService.class),connection,BIND_AUTO_CREATE);
        updater=new UpdateManager(this,()->!visible||meetingBusy(),this::send);
        updater.check(null);
        String target=getIntent().getDataString();
        if(BuildConfig.DEBUG&&getIntent().getBooleanExtra("bridge-test",false))target=ORIGIN+"/__android_bridge_test__?mode="+(getIntent().getBooleanExtra("projection-test",false)?"projection":"synthetic");
        web.loadUrl(entryUrl(target));
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},31);
    }

    static boolean trusted(String value){
        if(value==null)return false;
        try{java.net.URI uri=java.net.URI.create(value);return "https".equals(uri.getScheme())&&"meet.babagan.cloud".equals(uri.getHost())&&uri.getRawUserInfo()==null&&(uri.getPort()==-1||uri.getPort()==443);}catch(IllegalArgumentException e){return false;}
    }
    static String entryUrl(String target){return trusted(target)?target:ORIGIN+"/client?clientVersion="+BuildConfig.VERSION_NAME;}
    private boolean meetingBusy(){return ClientActivityPolicy.busy(joined,gate.current()!=null,ScreenCaptureService.hasActiveCapture())||MicrophoneService.isActive()||(pictureInPicture!=null&&pictureInPicture.occupiesWindow());}
    private void updateBusyState(){if(updater!=null)updater.busyChanged();}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);handleIncoming(intent);}
    private void handleIncoming(Intent intent){
        if(pictureInPicture!=null&&pictureInPicture.handleReturn(intent))return;
        String target=intent.getDataString();
        if(!trusted(target)||web==null||target.equals(web.getUrl()))return;
        if(meetingBusy()){Toast.makeText(this,"Leave the current meeting before opening another room",Toast.LENGTH_LONG).show();return;}
        setIntent(intent);web.loadUrl(target);
    }
    private void microphoneState(boolean enabled){
        microphoneEnabled=enabled;
        if(!enabled){MicrophoneService.disable(this);updateBusyState();return;}
        boolean permission=checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED;
        if(!ClientActivityPolicy.canStartMicrophone(true,joined,permission,visible,MicrophoneService.isRequestedActive()))throw new IllegalStateException("Enable the microphone from the foreground meeting after granting audio permission");
        if(!MicrophoneService.isRequestedActive())MicrophoneService.enable(this);
        updateBusyState();
    }

    private void handleMessage(String text){
        String id=null;
        try{
            if(text==null||text.length()>100_000)throw new IllegalArgumentException("Invalid request size");
            JSONObject message=new JSONObject(text);id=message.getString("id");
            if(message.getInt("v")!=1||id.isEmpty()||id.length()>128)throw new IllegalArgumentException("Unsupported bridge request");
            JSONObject params=message.optJSONObject("params");if(params==null)params=new JSONObject();
            switch(message.getString("method")){
                case "client.info":success(id,Json.object("platform","android","appVersion",BuildConfig.VERSION_NAME,"protocol",1,"screenCapture",true,"systemAudio",false,"maxScreenFrameRate",60,"pictureInPicture",pictureInPicture!=null&&pictureInPicture.supported(),"audioRouting",audioRoutes!=null&&audioRoutes.supported()));break;
                case "meeting.state":joined=params.getBoolean("joined");if(audioRoutes!=null)audioRoutes.meeting(joined);if(!joined){releaseAudioRouting();if(pictureInPicture!=null)pictureInPicture.release("meeting-left");microphoneState(false);cancelCapture("meeting-left");}updateBusyState();success(id,Json.object("joined",joined));break;
                case "audio.routes":success(id,audioRoutes.snapshot());break;
                case "audio.select":{
                    final String requestId=id;audioRoutes.select(params.getString("deviceId"),new CommunicationAudioRouter.Completion(){public void success(JSONObject state){MainActivity.this.success(requestId,state);}public void failure(String code,String message){error(requestId,code,message);}});break;
                }
                case "audio.bluetoothPermission":requestBluetoothPermission(id);break;
                case "pictureInPicture.enter":{
                    if(!joined||!visible)throw new WebViewPictureInPicture.Failure("denied","Open picture in picture from the foreground meeting");
                    if(fullscreen!=null)fullscreen.exit();
                    success(id,pictureInPicture.enter(params.getString("sessionId"),pipDimension(params,"width"),pipDimension(params,"height")));break;
                }
                case "pictureInPicture.update":success(id,pictureInPicture.update(params.getString("sessionId"),pipDimension(params,"width"),pipDimension(params,"height")));break;
                case "pictureInPicture.exit":success(id,pictureInPicture.exit(params.getString("sessionId"),params.optBoolean("returnToMeeting",false)));break;
                case "microphone.state":boolean enabled=params.getBoolean("enabled");microphoneState(enabled);success(id,Json.object("enabled",enabled));break;
                case "update.check":final String requestId=id;updater.check(result->success(requestId,result));break;
                case "capture.start":startCapture(id,params,false);break;
                case "capture.test":if(!BuildConfig.DEBUG)throw new IllegalArgumentException("Unknown method");startCapture(id,params,true);break;
                case "capture.signal":{
                    String session=params.getString("sessionId");if(!gate.owns(session)||capture==null)throw new IllegalStateException("Stale capture session");
                    capture.signal(session,params);success(id,Json.object());break;
                }
                case "capture.stop":{
                    String session=params.getString("sessionId");
                    if(gate.owns(session))cancelCapture("stopped");
                    success(id,Json.object("sessionId",session));break;
                }
                default:error(id,"unsupported","Unknown client method");
            }
        }catch(Exception e){if(id!=null)error(id,e instanceof WebViewPictureInPicture.Failure?((WebViewPictureInPicture.Failure)e).code:e instanceof CommunicationAudioRouter.Failure?((CommunicationAudioRouter.Failure)e).code:"invalid-request",e.getMessage()==null?"Invalid request":e.getMessage());if(e instanceof CommunicationAudioRouter.Failure&&audioRoutes!=null)audioRoutes.foregroundChanged();}
    }

    private void requestBluetoothPermission(String id){
        if(!joined||!visible)throw new CommunicationAudioRouter.Failure("denied","Request Bluetooth access from the foreground meeting");
        if(audioRoutes.bluetoothGranted()){success(id,audioRoutes.snapshot());return;}
        if(bluetoothPermissionInFlight)throw new CommunicationAudioRouter.Failure("busy","A Bluetooth permission dialog is already open");
        bluetoothPermissionRequest=id;bluetoothPermissionGeneration=audioRoutes.generation();bluetoothPermissionInFlight=true;
        try{requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT},32);}catch(RuntimeException failure){bluetoothPermissionRequest=null;bluetoothPermissionInFlight=false;throw failure;}
    }
    private void releaseAudioRouting(){
        if(bluetoothPermissionRequest!=null){error(bluetoothPermissionRequest,"cancelled","The meeting ended before Bluetooth permission completed");bluetoothPermissionRequest=null;}
        if(audioRoutes!=null)audioRoutes.meeting(false);
    }

    private static int pipDimension(JSONObject params,String name)throws Exception{Object value=params.get(name);if(!(value instanceof Number))throw new IllegalArgumentException("Invalid PiP dimensions");Number number=(Number)value;int result=number.intValue();if(number.doubleValue()!=result||result<1||result>16384)throw new IllegalArgumentException("Invalid PiP dimensions");return result;}

    private void startCapture(String requestId,JSONObject params,boolean test)throws Exception{
        if(!joined&&!test)throw new IllegalStateException("Join a meeting before sharing");
        if(capture==null||!capture.ownedBy(this))throw new IllegalStateException("The capture service is starting; try again");
        if(consentSession!=null)throw new IllegalStateException("Close the previous screen permission dialog before trying again");
        String session=params.getString("sessionId");
        int rate=params.optInt("frameRate",30),width=params.optInt("width",1920),height=params.optInt("height",1080);
        if((rate!=30&&rate!=60)||width<2||height<2||width>4096||height>4096)throw new IllegalArgumentException("Invalid capture dimensions or frame rate");
        gate.request(session);pendingId=requestId;pendingSession=session;pendingParams=params;
        updateBusyState();
        if(test){gate.accept(session);capture.beginSynthetic(session);return;}
        consentSession=session;
        try{startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(),40);}
        catch(Exception e){consentSession=null;cancelCapture("permission-error");throw e;}
    }

    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request!=40)return;
        String session=consentSession;consentSession=null;
        if(session==null||!gate.owns(session))return;
        if(result!=RESULT_OK||data==null){cancelCapture("permission-denied");return;}
        if(!gate.accept(session)||capture==null){cancelCapture("service-unavailable");return;}
        capture.prepare(session);
        Intent service=new Intent(this,ScreenCaptureService.class).setAction("capture").putExtra("sessionId",session).putExtra("permission",data)
            .putExtra("width",pendingParams.optInt("width",1920)).putExtra("height",pendingParams.optInt("height",1080)).putExtra("frameRate",pendingParams.optInt("frameRate",30));
        try{startForegroundService(service);}catch(Exception e){cancelCapture("service-start-failed");}
    }

    private void cancelCapture(String reason){
        String session=gate.current();if(session==null)return;
        gate.stop(session);
        if(pendingId!=null&&session.equals(pendingSession)){error(pendingId,"capture-ended",reason);pendingId=null;pendingSession=null;pendingParams=null;}
        if(capture!=null&&capture.ownedBy(this))capture.stop(session,reason);
        send(Json.object("v",1,"event","capture.ended","sessionId",session,"reason",reason));
        updateBusyState();
    }
    @Override public void started(String session,JSONObject result){
        if(!gate.owns(session)){if(capture!=null&&capture.ownedBy(this))capture.stop(session,"cancelled");return;}
        if(pendingId!=null&&session.equals(pendingSession)){success(pendingId,result);pendingId=null;pendingSession=null;pendingParams=null;}
    }
    @Override public void failed(String session,String message){if(gate.owns(session)){if(pendingId!=null)error(pendingId,"capture-failed",message);pendingId=null;pendingSession=null;pendingParams=null;gate.stop(session);}}
    @Override public void event(JSONObject message){
        String session=message.optString("sessionId");
        if("capture.ended".equals(message.optString("event"))){if(gate.owns(session)){gate.stop(session);if(pendingId!=null)error(pendingId,"capture-ended",message.optString("reason"));pendingId=null;pendingSession=null;pendingParams=null;}updateBusyState();}
        send(message);
    }
    private void success(String id,JSONObject result){send(Json.object("v",1,"id",id,"ok",true,"result",result));}
    private void error(String id,String code,String message){send(Json.object("v",1,"id",id,"ok",false,"error",Json.object("code",code,"message",message)));}
    private void send(JSONObject message){if(reply!=null&&web!=null&&trusted(web.getUrl())&&WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))try{reply.postMessage(message.toString());}catch(IllegalStateException ignored){/* The owning document was destroyed during navigation. */}}

    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==30&&microphoneRequest!=null){PermissionRequest pending=microphoneRequest;microphoneRequest=null;if(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED&&trusted(web.getUrl()))pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});else pending.deny();}if(request==32){String id=bluetoothPermissionRequest;bluetoothPermissionRequest=null;bluetoothPermissionInFlight=false;if(audioRoutes!=null){audioRoutes.permissionResult(audioRoutes.bluetoothGranted());if(id!=null){if(joined&&bluetoothPermissionGeneration==audioRoutes.generation()&&web!=null&&trusted(web.getUrl()))success(id,audioRoutes.snapshot());else error(id,"cancelled","The permission request no longer belongs to this meeting");}}}}
    @Override protected void onResume(){super.onResume();visible=true;if(audioRoutes!=null)audioRoutes.foregroundChanged();if(pictureInPicture!=null)pictureInPicture.resumed();if(microphoneEnabled&&joined&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED)try{microphoneState(true);}catch(RuntimeException error){Toast.makeText(this,"The microphone could not stay active in the background",Toast.LENGTH_LONG).show();}updateBusyState();updateTimer.removeCallbacks(periodicUpdate);updateTimer.post(periodicUpdate);}
    @Override protected void onPause(){visible=false;if(audioRoutes!=null)audioRoutes.foregroundChanged();updateTimer.removeCallbacks(periodicUpdate);updateBusyState();super.onPause();}
    @Override protected void onStop(){if(pictureInPicture!=null)pictureInPicture.stopped();super.onStop();}
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration){super.onConfigurationChanged(configuration);if(fullscreen!=null)fullscreen.reapply();}
    @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(focused&&fullscreen!=null)fullscreen.reapply();}
    @Override public void onPictureInPictureModeChanged(boolean active,android.content.res.Configuration configuration){super.onPictureInPictureModeChanged(active,configuration);if(pictureInPicture!=null)pictureInPicture.modeChanged(active);updateBusyState();}
    private void handleBack(){if(fullscreen!=null&&fullscreen.exit())return;if(web!=null&&web.canGoBack())web.goBack();else if(joined)new AlertDialog.Builder(this).setMessage("Leave the meeting and close Babagan?").setPositiveButton("Leave",(dialog,which)->finish()).setNegativeButton("Stay",null).show();else finish();}
    // API 33+ uses the registered predictive-back callback above; retain this only for API 26–32.
    @android.annotation.SuppressLint("GestureBackNavigation") @Override public void onBackPressed(){handleBack();}
    @Override protected void onDestroy(){updateTimer.removeCallbacks(periodicUpdate);if(!ownsActivity){super.onDestroy();return;}releaseAudioRouting();if(audioRoutes!=null)audioRoutes.close();if(pictureInPicture!=null)pictureInPicture.destroy();if(fullscreen!=null)fullscreen.destroy();if(Build.VERSION.SDK_INT>=33&&backCallback!=null)getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);if(active.get()==this)active.clear();MicrophoneService.disable(this);cancelCapture("app-closed");if(capture!=null)capture.detachListener(this);if(bound)unbindService(connection);if(microphoneRequest!=null)microphoneRequest.deny();if(updater!=null)updater.close();if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
