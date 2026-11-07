package cloud.babagan.meeting;

import android.app.Activity;
import android.app.AppOpsManager;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Process;
import android.util.Rational;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.function.Consumer;

/** Android's Activity PiP, deliberately separate from WebView video/document PiP APIs. */
final class WebViewPictureInPicture {
    static final String RETURN_ACTION="cloud.babagan.meeting.RETURN_FROM_PIP";
    static final String SESSION_EXTRA="pictureInPictureSession";
    static final class Failure extends RuntimeException {
        final String code;
        Failure(String code,String message){super(message);this.code=code;}
    }
    private final Activity activity;
    private final FrameLayout root;
    private final Consumer<JSONObject> events;
    private final PictureInPictureSession session=new PictureInPictureSession();
    private TextView endedView;
    private boolean destroyed, stopped;
    WebViewPictureInPicture(Activity activity,FrameLayout root,Consumer<JSONObject> events){this.activity=activity;this.root=root;this.events=events;}
    boolean supported(){return activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);}
    boolean occupiesWindow(){return session.current()!=null || activity.isInPictureInPictureMode();}
    private PictureInPictureParams parameters(int width,int height){
        int[] aspect=PictureInPictureSession.aspect(width,height);
        PictureInPictureParams.Builder builder=new PictureInPictureParams.Builder().setAspectRatio(new Rational(aspect[0],aspect[1]));
        if(Build.VERSION.SDK_INT>=31)builder.setAutoEnterEnabled(false).setSeamlessResizeEnabled(true);
        return builder.build();
    }
    JSONObject enter(String id,int width,int height){
        if(destroyed || activity.isFinishing() || activity.isDestroyed())throw new Failure("failed","The meeting window is closing");
        if(!supported())throw new Failure("unsupported","This device does not support picture in picture");
        if(occupiesWindow())throw new Failure("busy","Another picture-in-picture session is active");
        AppOpsManager ops=activity.getSystemService(AppOpsManager.class);
        if(ops!=null){int mode=ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE,Process.myUid(),activity.getPackageName());
            if(mode!=AppOpsManager.MODE_ALLOWED && mode!=AppOpsManager.MODE_DEFAULT)throw new Failure("denied","Picture in picture is disabled for Babagan in Android settings");}
        PictureInPictureParams params=parameters(width,height);
        session.begin(id);
        stopped=false;
        root.requestApplyInsets();
        try {
            if(!activity.enterPictureInPictureMode(params))throw new Failure("denied","Android did not allow picture in picture");
            if(!session.owns(id))throw new Failure("failed","Picture in picture ended before entry completed");
            if(activity.isInPictureInPictureMode())session.enteredMode();
            // The boolean result means accepted; actual mode changes are separately reported below.
            return Json.object("sessionId",id,"active",true);
        }catch(RuntimeException error){
            clear("enter-failed");
            if(error instanceof Failure)throw error;
            throw new Failure(error instanceof SecurityException?"denied":"failed","Could not enter Android picture in picture");
        }
    }
    JSONObject update(String id,int width,int height){
        requireOwner(id);
        if(session.released())throw new Failure("stale","Picture-in-picture media was released");
        try {activity.setPictureInPictureParams(parameters(width,height));}
        catch(RuntimeException error){throw new Failure("failed","Could not update picture-in-picture dimensions");}
        return Json.object("sessionId",id,"active",activity.isInPictureInPictureMode());
    }
    JSONObject exit(String id,boolean returnToMeeting){
        if(!session.owns(id))return Json.object("sessionId",id,"active",false,"released",true);
        if(returnToMeeting){
            if(!activity.isInPictureInPictureMode() && session.entered()){clear("returned");return Json.object("sessionId",id,"active",false,"released",false);}
            // Only an explicit user return asks Android to foreground the existing singleTask.
            try { activity.startActivity(new Intent(activity,MainActivity.class).setAction(RETURN_ACTION)
                .putExtra(SESSION_EXTRA,id).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT|Intent.FLAG_ACTIVITY_SINGLE_TOP)); }
            catch(RuntimeException error){throw new Failure("failed","Use Android's expand control to return to the meeting");}
        }else release("released");
        return Json.object("sessionId",id,"active",activity.isInPictureInPictureMode(),"released",session.released());
    }
    void release(String reason){
        String id=session.current();if(id==null)return;
        session.release(id);
        // Cover even a pending transition, so React/navigation cleanup cannot expose the room UI.
        showEnded();
        // An initial false during an accepted enter is not an exit notification.
        if(activity.isInPictureInPictureMode())emit(id,true,reason);
    }
    boolean handleReturn(Intent intent){
        if(!RETURN_ACTION.equals(intent.getAction()))return false;
        String id=intent.getStringExtra(SESSION_EXTRA);
        if(session.owns(id) && !activity.isInPictureInPictureMode())clear("returned");
        return true; // Internal return never navigates or reloads the owning WebView.
    }
    void modeChanged(boolean active){
        String id=session.current();if(id==null)return;
        if(active){session.enteredMode();if(session.released())showEnded();emit(id,true,session.released()?"released":"entered");}
        else clear("system-exit");
        root.requestApplyInsets();
    }
    void stopped(){stopped=true;if(session.current()!=null && session.stopConfirmsExit(activity.isInPictureInPictureMode(),activity.isFinishing()))clear("system-close");}
    void resumed(){if(session.current()!=null && (session.entered()||stopped) && !activity.isInPictureInPictureMode())clear("returned");stopped=false;}
    void destroy(){destroyed=true;clear("destroyed");}
    private void requireOwner(String id){if(!session.owns(id))throw new Failure("stale","Stale picture-in-picture session");}
    private void clear(String reason){String previous=session.clear();if(endedView!=null){root.removeView(endedView);endedView=null;}root.requestApplyInsets();if(previous!=null)emit(previous,false,reason);}
    private void emit(String id,boolean active,String reason){events.accept(Json.object("v",1,"event","pictureInPicture.state","sessionId",id,"active",active,"released",session.released(),"reason",reason));}
    private void showEnded(){
        if(endedView!=null)return;
        endedView=new TextView(activity);endedView.setBackgroundColor(Color.BLACK);endedView.setTextColor(Color.WHITE);
        endedView.setGravity(Gravity.CENTER);endedView.setTextSize(14);int padding=(int)(12*activity.getResources().getDisplayMetrics().density);endedView.setPadding(padding,padding,padding,padding);
        endedView.setText("共享已结束\n展开返回会议");
        root.addView(endedView,new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT));
    }
}
