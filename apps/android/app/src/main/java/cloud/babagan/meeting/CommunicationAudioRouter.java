package cloud.babagan.meeting;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Selects a communication output; Android selects the corresponding microphone. */
final class CommunicationAudioRouter {
    interface Completion {void success(JSONObject state);void failure(String code,String message);}
    static final class Failure extends RuntimeException {final String code;Failure(String code,String message){super(message);this.code=code;}}
    private static final class Route {
        final String id,label,type;final AudioDeviceInfo device;
        Route(String id,String label,String type,AudioDeviceInfo device){this.id=id;this.label=label;this.type=type;this.device=device;}
    }
    private static final class Pending {
        final long generation;final String id,previous;final boolean priorModeOwned;final Completion done;
        boolean restoring;String originalCode,originalMessage;
        Pending(long g,String id,String previous,boolean priorModeOwned,Completion done){generation=g;this.id=id;this.previous=previous;this.priorModeOwned=priorModeOwned;this.done=done;}
    }
    private final Activity activity;
    private final AudioManager audio;
    private final BooleanSupplier visible;
    private final Consumer<JSONObject> events;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final AudioRouteLease lease=new AudioRouteLease();
    private Pending pending;
    private boolean closed,permissionDenied,modeChanged,speakerChanged,scoStarted,scoFlagChanged,communicationRequested;
    private int priorMode;
    private boolean priorSpeaker,priorSco,ourSpeaker,ourSco;
    private int scoState=AudioManager.SCO_AUDIO_STATE_DISCONNECTED;
    private long revision;
    private String lastBody;
    private String legacyRoute;
    private final Runnable poll=this::checkPending;
    private final Runnable timeout=()->finishPending(false,"route-not-applied","Android did not apply the selected communication device");
    private final AudioDeviceCallback devices=new AudioDeviceCallback(){
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added){changed();}
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed){changed();}
    };
    private AudioManager.OnCommunicationDeviceChangedListener communicationListener;
    private AudioManager.OnModeChangedListener modeListener;
    private final BroadcastReceiver sco=new BroadcastReceiver(){@Override public void onReceive(Context context,Intent intent){scoState=intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE,AudioManager.SCO_AUDIO_STATE_DISCONNECTED);changed();}};
    CommunicationAudioRouter(Activity activity,BooleanSupplier visible,Consumer<JSONObject> events){
        this.activity=activity;this.visible=visible;this.events=events;audio=activity.getSystemService(AudioManager.class);
        if(audio==null)return;
        audio.registerAudioDeviceCallback(devices,main);
        if(Build.VERSION.SDK_INT>=31){communicationListener=device->changed();modeListener=mode->changed();audio.addOnCommunicationDeviceChangedListener(activity.getMainExecutor(),communicationListener);audio.addOnModeChangedListener(activity.getMainExecutor(),modeListener);}
        else {Intent sticky=activity.registerReceiver(sco,new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED));if(sticky!=null)scoState=sticky.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE,AudioManager.SCO_AUDIO_STATE_DISCONNECTED);}
    }
    boolean supported(){return audio!=null;}
    long generation(){return lease.generation();}
    boolean joined(){return lease.joined();}
    boolean bluetoothGranted(){return Build.VERSION.SDK_INT<31||activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)==PackageManager.PERMISSION_GRANTED;}
    void permissionResult(boolean granted){permissionDenied=!granted;changed();}
    void meeting(boolean joined){
        if(lease.joined()==joined){changed();return;}
        if(!joined){cancelPending();restoreOwnedSettings();}
        lease.meeting(joined);changed();
    }
    void foregroundChanged(){changed();}
    JSONObject snapshot(){return state(false);}
    void select(String id,Completion done){
        if(closed||audio==null)throw new Failure("unsupported","Native communication audio routing is unavailable");
        if(!lease.joined()||!visible.getAsBoolean())throw new Failure("denied","Choose audio devices from the foreground meeting");
        if(AudioRouteLease.systemCall(mode()))throw new Failure("busy","Another system call controls audio routing");
        if(id==null||id.length()>64)throw new IllegalArgumentException("Invalid audio device");
        Map<String,Route> available=routes();Route route=available.get(id);
        if(route==null)throw new Failure("unavailable","This communication audio device is no longer available");
        if("bluetooth".equals(route.type)&&!bluetoothGranted())throw new Failure("permission-required","Allow Bluetooth access before selecting a headset");
        lease.reconcile(actual(available),available.keySet());String previous=lease.selected();
        long ticket=lease.begin(id);pending=new Pending(ticket,id,previous,modeChanged,done);
        try {
            ensureMode();
            applyRoute(route);
            state(true);
            if("default".equals(id)){finishPending(true,null,null);return;}
            main.postDelayed(timeout,5500);checkPending();
        }catch(RuntimeException error){finishPending(false,error instanceof Failure?((Failure)error).code:error instanceof SecurityException?"permission-required":"failed",error.getMessage()==null?"Could not change communication audio device":error.getMessage());}
    }
    private void ensureMode(){
        if(mode()==AudioManager.MODE_NORMAL){priorMode=AudioManager.MODE_NORMAL;audio.setMode(AudioManager.MODE_IN_COMMUNICATION);modeChanged=true;}
        if(AudioRouteLease.systemCall(mode()))throw new Failure("busy","A system call took over audio routing");
    }
    private void applyRoute(Route route){
        if(Build.VERSION.SDK_INT>=31){
            if("default".equals(route.id)){audio.clearCommunicationDevice();communicationRequested=false;}
            else {if(!audio.setCommunicationDevice(route.device))throw new Failure("unavailable","Android rejected the selected audio device");communicationRequested=true;}
        }else {selectLegacy(route);legacyRoute="default".equals(route.id)?null:route.id;}
    }
    private void selectLegacy(Route route){
        if("bluetooth".equals(route.type)){
            setSpeaker(false);
            if(!audio.isBluetoothScoOn()){
                if(!audio.isBluetoothScoAvailableOffCall())throw new Failure("unsupported","Bluetooth call audio is unavailable on this device");
                audio.startBluetoothSco();scoStarted=true;setSco(true);
            }
        }else if("default".equals(route.id)){
            stopOwnedSco();
            if(speakerChanged&&audio.isSpeakerphoneOn()==ourSpeaker){audio.setSpeakerphoneOn(priorSpeaker);speakerChanged=false;}
        }else {
            stopOwnedSco();
            if(audio.isBluetoothScoOn()&&!scoFlagChanged)throw new Failure("busy","A pre-existing Bluetooth call owns audio routing");
            setSpeaker("speaker".equals(route.type));
        }
    }
    private void setSpeaker(boolean value){if(audio.isSpeakerphoneOn()!=value){if(!speakerChanged)priorSpeaker=audio.isSpeakerphoneOn();audio.setSpeakerphoneOn(value);speakerChanged=true;ourSpeaker=value;}}
    private void setSco(boolean value){if(audio.isBluetoothScoOn()!=value){if(!scoFlagChanged)priorSco=audio.isBluetoothScoOn();audio.setBluetoothScoOn(value);scoFlagChanged=true;ourSco=value;}}
    private void stopOwnedSco(){
        if(scoStarted){audio.stopBluetoothSco();scoStarted=false;}
        if(scoFlagChanged&&audio.isBluetoothScoOn()==ourSco){audio.setBluetoothScoOn(priorSco);scoFlagChanged=false;}
    }
    private void restoreOwnedSettings(){restoreOwnedSettings(false);}
    private void restoreOwnedSettings(boolean preserveMode){
        if(audio==null)return;
        // clearCommunicationDevice releases this process's request, not another app's request.
        if(Build.VERSION.SDK_INT>=31&&communicationRequested){try{audio.clearCommunicationDevice();}catch(RuntimeException ignored){}communicationRequested=false;}
        boolean systemCall=AudioRouteLease.systemCall(mode());
        if(scoStarted){try{audio.stopBluetoothSco();}catch(RuntimeException ignored){}scoStarted=false;}
        if(!systemCall){
            try{if(scoFlagChanged&&audio.isBluetoothScoOn()==ourSco)audio.setBluetoothScoOn(priorSco);}catch(RuntimeException ignored){}
            try{if(speakerChanged&&audio.isSpeakerphoneOn()==ourSpeaker)audio.setSpeakerphoneOn(priorSpeaker);}catch(RuntimeException ignored){}
        }
        // MODE_NORMAL removes this process's mode request; a different system-call owner retains priority.
        if(modeChanged&&!preserveMode){try{audio.setMode(priorMode);}catch(RuntimeException ignored){}modeChanged=false;}
        scoFlagChanged=false;speakerChanged=false;
        legacyRoute=null;
    }
    private void checkPending(){
        if(pending==null||closed)return;
        Map<String,Route> available=routes();
        if(!lease.owns(pending.generation,pending.id)||!available.containsKey(pending.id)){finishPending(false,"unavailable","The selected audio device disconnected");return;}
        if(AudioRouteLease.systemCall(mode())){finishPending(false,"busy","A system call took over audio routing");return;}
        if(pending.id.equals(actual(available))){finishPending(true,null,null);return;}
        state(true);main.removeCallbacks(poll);main.postDelayed(poll,150);
    }
    private void finishPending(boolean applied,String code,String message){
        Pending request=pending;if(request==null)return;pending=null;main.removeCallbacks(poll);main.removeCallbacks(timeout);
        if(applied&&lease.confirm(request.generation,request.id)){JSONObject state=state(true);if(request.restoring)request.done.failure(request.originalCode,request.originalMessage);else request.done.success(state);return;}
        lease.fail(request.generation,request.id);
        String failureCode=request.restoring?request.originalCode:code==null?"cancelled":code;
        String failureMessage=request.restoring?request.originalMessage:message==null?"Audio routing request was cancelled":message;
        Route previous=routes().get(request.previous);
        boolean sameGeneration=lease.joined()&&lease.generation()==request.generation;
        boolean sameMeeting=sameGeneration&&!AudioRouteLease.systemCall(mode());
        if(!request.restoring&&sameMeeting&&previous!=null&&!"default".equals(previous.id)){
            long ticket=lease.begin(previous.id);Pending restore=new Pending(ticket,previous.id,"default",request.priorModeOwned,request.done);
            restore.restoring=true;restore.originalCode=failureCode;restore.originalMessage=failureMessage;pending=restore;
            try{ensureMode();applyRoute(previous);state(true);main.postDelayed(timeout,2500);checkPending();return;}
            catch(RuntimeException ignored){pending=null;lease.fail(ticket,previous.id);}
        }
        restoreOwnedSettings(sameGeneration&&request.priorModeOwned);lease.resetPreference();state(true);request.done.failure(failureCode,failureMessage);
    }
    private void cancelPending(){Pending request=pending;if(request==null)return;pending=null;main.removeCallbacks(poll);main.removeCallbacks(timeout);lease.fail(request.generation,request.id);request.done.failure("cancelled","The meeting ended before audio routing completed");}
    private void changed(){
        if(closed)return;
        if(pending!=null){checkPending();return;}
        // Legacy SCO requests and forced flags do not have the modern API's automatic removal guarantee.
        if(Build.VERSION.SDK_INT<31&&legacyRoute!=null&&!routes().containsKey(legacyRoute)){
            restoreOwnedSettings(lease.joined()&&modeChanged);lease.resetPreference();
        }
        state(true);
    }
    private JSONObject state(boolean notify){
        Map<String,Route> available=routes();String actual=actual(available);lease.reconcile(actual,available.keySet());
        JSONArray list=new JSONArray();for(Route route:available.values())list.put(Json.object("id",route.id,"label",route.label,"type",route.type));
        String permission=Build.VERSION.SDK_INT<31?"not-required":bluetoothGranted()?"granted":permissionDenied?"denied":"required";
        JSONObject state=Json.object("devices",list,"selectedId",lease.selected(),"requestedId",lease.requested(),"actualDeviceId",actual,"pendingId",lease.pending(),"bluetoothPermission",permission,"microphoneFollowsOutput",true,"canSelect",!closed&&audio!=null&&lease.joined()&&visible.getAsBoolean()&&!AudioRouteLease.systemCall(mode()));
        String body=state.toString();boolean changed=!body.equals(lastBody);if(changed){lastBody=body;revision++;}
        try{state.put("revision",revision);}catch(org.json.JSONException impossible){throw new IllegalStateException(impossible);}
        if(notify&&changed)events.accept(Json.object("v",1,"event","audio.routesChanged","state",state));
        return state;
    }
    private Map<String,Route> routes(){
        LinkedHashMap<String,Route> result=new LinkedHashMap<>();result.put("default",new Route("default","跟随系统","default",null));if(audio==null)return result;
        try {
            if(Build.VERSION.SDK_INT>=31){
                List<Route> found=new ArrayList<>();for(AudioDeviceInfo device:audio.getAvailableCommunicationDevices()){
                    String type=type(device.getType());if(type==null||("bluetooth".equals(type)&&!bluetoothGranted()))continue;
                    String label=label(type);if("bluetooth".equals(type)||"wired".equals(type)||"usb".equals(type)){CharSequence name=device.getProductName();String product=name==null?"":name.toString().replaceAll("[\\p{Cntrl}]"," ").trim();if(!product.isEmpty())label+=" · "+product.substring(0,Math.min(product.length(),80));}
                    found.add(new Route("device:"+device.getId(),label,type,device));
                }
                found.sort(Comparator.comparing((Route route)->route.type).thenComparing(route->route.id));for(Route route:found)result.put(route.id,route);
            }else {
                boolean speaker=false,earpiece=false,wired=false,usb=false;
                for(AudioDeviceInfo device:audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS))switch(device.getType()){
                    case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE:speaker=true;break;
                    case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:earpiece=true;break;
                    case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:case AudioDeviceInfo.TYPE_WIRED_HEADSET:wired=true;break;
                    case AudioDeviceInfo.TYPE_USB_DEVICE:case AudioDeviceInfo.TYPE_USB_HEADSET:usb=true;break;
                    default:break;
                }
                if(speaker)result.put("legacy:speaker",new Route("legacy:speaker",label("speaker"),"speaker",null));
                if(wired||usb)result.put("legacy:wired",new Route("legacy:wired",wired?"有线耳机（系统路由）":"USB设备（系统路由）",wired?"wired":"usb",null));
                else if(earpiece)result.put("legacy:earpiece",new Route("legacy:earpiece",label("earpiece"),"earpiece",null));
                BluetoothManager manager=activity.getSystemService(BluetoothManager.class);BluetoothAdapter adapter=manager==null?null:manager.getAdapter();
                if(adapter!=null&&adapter.getProfileConnectionState(BluetoothProfile.HEADSET)==BluetoothAdapter.STATE_CONNECTED)result.put("legacy:bluetooth",new Route("legacy:bluetooth","蓝牙通话耳机","bluetooth",null));
            }
        }catch(SecurityException ignored){/* Bluetooth permission can change during enumeration. */}
        catch(RuntimeException ignored){/* Device/audio-server changes can race enumeration. */}
        return result;
    }
    private String actual(Map<String,Route> available){
        if(audio==null)return null;
        try{
            if(Build.VERSION.SDK_INT>=31){AudioDeviceInfo device=audio.getCommunicationDevice();String id=device==null?null:"device:"+device.getId();return available.containsKey(id)?id:null;}
            if(mode()!=AudioManager.MODE_IN_COMMUNICATION)return null;
            if(scoState==AudioManager.SCO_AUDIO_STATE_CONNECTED&&audio.isBluetoothScoOn())return available.containsKey("legacy:bluetooth")?"legacy:bluetooth":null;
            if(audio.isSpeakerphoneOn())return available.containsKey("legacy:speaker")?"legacy:speaker":null;
            if(available.containsKey("legacy:wired"))return "legacy:wired";
            return available.containsKey("legacy:earpiece")?"legacy:earpiece":null;
        }catch(RuntimeException ignored){return null;}
    }
    private int mode(){try{return audio==null?AudioManager.MODE_INVALID:audio.getMode();}catch(RuntimeException ignored){return AudioManager.MODE_INVALID;}}
    private static String type(int value){switch(value){
        case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE:return "speaker";
        case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:return "earpiece";
        case AudioDeviceInfo.TYPE_WIRED_HEADSET:case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:return "wired";
        case AudioDeviceInfo.TYPE_USB_HEADSET:case AudioDeviceInfo.TYPE_USB_DEVICE:return "usb";
        case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:case AudioDeviceInfo.TYPE_BLE_HEADSET:case AudioDeviceInfo.TYPE_BLE_SPEAKER:case AudioDeviceInfo.TYPE_HEARING_AID:return "bluetooth";
        default:return null;
    }}
    private static String label(String type){switch(type){case "speaker":return "手机扬声器";case "earpiece":return "手机听筒";case "bluetooth":return "蓝牙通话设备";case "usb":return "USB音频设备";default:return "有线耳机";}}
    void close(){
        if(closed)return;cancelPending();restoreOwnedSettings();lease.meeting(false);closed=true;main.removeCallbacksAndMessages(null);
        if(audio==null)return;
        try{audio.unregisterAudioDeviceCallback(devices);}catch(RuntimeException ignored){}
        if(Build.VERSION.SDK_INT>=31){
            try{if(communicationListener!=null)audio.removeOnCommunicationDeviceChangedListener(communicationListener);}catch(RuntimeException ignored){}
            try{if(modeListener!=null)audio.removeOnModeChangedListener(modeListener);}catch(RuntimeException ignored){}
        }else try{activity.unregisterReceiver(sco);}catch(RuntimeException ignored){}
    }
}
