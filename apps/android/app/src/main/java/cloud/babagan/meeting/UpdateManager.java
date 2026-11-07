package cloud.babagan.meeting;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import org.json.JSONObject;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;
import javax.net.ssl.HttpsURLConnection;

final class UpdateManager {
    private final Activity activity;
    private final BooleanSupplier busy;
    private final Consumer<JSONObject> events;
    private final UpdateDownloadGate downloads = new UpdateDownloadGate();
    private final UpdateProgress progress = new UpdateProgress();
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler main=new Handler(Looper.getMainLooper());
    private final android.content.SharedPreferences preferences;
    private volatile boolean closed,checking,installing,downloading;
    private UpdateVerifier.Release deferredRelease;
    private JSONObject state = Json.object("state","idle","status","idle","updateRevision",0);
    private long updateRevision;
    private boolean permissionPrompt;
    private UpdateVerifier.Release pending;
    private File pendingApk;
    private Intent installConfirmation;
    UpdateManager(Activity activity,BooleanSupplier busy,Consumer<JSONObject> events){this.activity=activity;this.busy=busy;this.events=events;preferences=activity.getSharedPreferences("updates",Context.MODE_PRIVATE);downloads.setBusy(busy.getAsBoolean());}

    private JSONObject updateState(String value, String version, String message) {
        if(!value.equals("downloading"))progress.invalidate();
        state = Json.object("state",value,"status",value);
        try { if(version!=null)state.put("version",version);if(message!=null)state.put("message",message); }
        catch(org.json.JSONException ignored) { }
        if(value.equals("installing")&&pending!=null)putProgress(state,"installing",pending.bytes(),pending.bytes());
        publishState();
        return state;
    }
    JSONObject currentState(){return state;}
    private static void putProgress(JSONObject target,String phase,long downloadedBytes,long totalBytes){
        try{target.put("phase",phase);target.put("downloadedBytes",downloadedBytes);target.put("totalBytes",totalBytes);}catch(org.json.JSONException ignored){}
    }
    private void publishState(){
        try{
            state.put("updateRevision",++updateRevision);
            JSONObject event=new JSONObject(state.toString());event.put("v",1);event.put("event","update.state");events.accept(event);
        }catch(org.json.JSONException ignored){}
    }
    private void postProgress(UpdateProgress.Snapshot value,String version){
        if(value==null)return;
        main.post(()->{
            if(closed||busy.getAsBoolean()||!progress.isCurrent(value))return;
            state=Json.object("state","downloading","status","downloading","version",version);
            putProgress(state,value.phase(),value.downloadedBytes(),value.totalBytes());publishState();
        });
    }
    void busyChanged() {
        if(closed)return;
        boolean hold=busy.getAsBoolean();if(hold)progress.invalidate();downloads.setBusy(hold);
        if(hold){if(downloading||pending!=null||deferredRelease!=null)updateState("deferred",pending!=null?pending.version():deferredRelease!=null?deferredRelease.version():null,null);return;}
        if(deferredRelease!=null&&!downloading&&!checking)startDownload(deferredRelease);
        installWhenIdle();
    }

    void check(Consumer<JSONObject> callback){
        if(checking||downloading){if(callback!=null)callback.accept(state);return;}
        checking=true;
        updateState("checking",null,null);
        worker.execute(()->{
            try{
                String key;
                try(InputStream input=activity.getAssets().open("client-update-public-key.json")){key=new String(readBounded(input,8192),StandardCharsets.UTF_8);}
                byte[] manifest=downloadSmall(UpdateVerifier.ORIGIN+"/downloads/clients/android/stable.json",65536);
                UpdateVerifier.Release release=UpdateVerifier.verify(new String(manifest,StandardCharsets.UTF_8),key,preferences.getLong("sequence",0));
                preferences.edit().putLong("sequence",release.sequence()).apply();
                main.post(()->{
                    checking=false;if(closed)return;
                    if(UpdateVerifier.compareVersions(release.version(),BuildConfig.VERSION_NAME)<=0)updateState("current",BuildConfig.VERSION_NAME,null);
                    else { deferredRelease=release; if(busy.getAsBoolean())updateState("deferred",release.version(),null);else startDownload(release); }
                    if(callback!=null)callback.accept(state);
                });
            }catch(Exception error){main.post(()->{checking=false;if(closed)return;JSONObject result=updateState("error",null,error.getMessage()==null?"Update check failed":error.getMessage());if(callback!=null)callback.accept(result);});}
        });
    }

    private void startDownload(UpdateVerifier.Release release) {
        if(closed||downloading||busy.getAsBoolean())return;
        downloading=true;downloads.setBusy(false);updateState("downloading",release.version(),null);
        UpdateProgress.Snapshot run=progress.start(release.bytes(),SystemClock.elapsedRealtime());postProgress(run,release.version());
        worker.execute(()->{
            try {
                File file=downloads.run(ticket->{
                    File directory=new File(activity.getFilesDir(),"updates");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Cannot create update directory");
                    File destination=new File(directory,"Babagan-"+release.version()+".apk");ticket.check();
                    boolean cached=destination.isFile()&&destination.length()==release.bytes();
                    if(cached)postProgress(progress.verifying(run.generation()),release.version());
                    if(!cached||!verifyBytes(destination,release,ticket)){
                        if(cached)postProgress(progress.restart(run.generation(),SystemClock.elapsedRealtime()),release.version());
                        downloadApk(destination,release,ticket,run.generation());
                    }
                    ticket.check();verifyPackage(destination,release);ticket.check();return destination;
                });
                main.post(()->{
                    downloading=false;if(closed)return;
                    if(busy.getAsBoolean()||!progress.isActive(run.generation())){
                        updateState("deferred",release.version(),null);if(!busy.getAsBoolean())startDownload(release);return;
                    }
                    deferredRelease=null;pending=release;pendingApk=file;updateState("downloaded",release.version(),null);installWhenIdle();
                });
            } catch(Exception error) {
                main.post(()->{
                    downloading=false;if(closed)return;
                    boolean deferred=error instanceof UpdateDownloadGate.Deferred||!progress.isActive(run.generation());
                    updateState(deferred?"deferred":"error",release.version(),deferred?null:error.getMessage());
                    if(deferred&&!busy.getAsBoolean())startDownload(release);
                });
            }
        });
    }

    void installWhenIdle(){
        if(closed||busy.getAsBoolean())return;
        if(installConfirmation!=null){Intent confirmation=installConfirmation;installConfirmation=null;activity.startActivity(confirmation);return;}
        if(pending==null||pendingApk==null||installing)return;
        if(!activity.getPackageManager().canRequestPackageInstalls()){
            if(permissionPrompt)return;permissionPrompt=true;
            new AlertDialog.Builder(activity).setTitle("Babagan update ready").setMessage("Allow Babagan to install its signed updates from meet.babagan.cloud. Android may ask you to confirm the installation.")
                .setPositiveButton("Allow updates",(dialog,which)->activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName()))))
                .setNegativeButton("Later",(dialog,which)->{}).show();return;
        }
        installing=true;
        updateState("installing",pending.version(),null);
        UpdateVerifier.Release release=pending;File file=pendingApk;
        worker.execute(()->{
            try{
                if(!verifyBytes(file,release))throw new SecurityException("Downloaded APK checksum changed");verifyPackage(file,release);
                main.post(()->{
                    if(closed||busy.getAsBoolean()){installing=false;return;}
                    worker.execute(()->commitInstall(file));
                });
            }catch(Exception error){main.post(()->{installing=false;if(!closed)android.widget.Toast.makeText(activity,"Update verification failed",android.widget.Toast.LENGTH_LONG).show();});}
        });
    }

    private void commitInstall(File file){
        PackageInstaller installer=activity.getPackageManager().getPackageInstaller();int sessionId=-1;
        try{
            PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(activity.getPackageName());params.setSize(file.length());
            if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            sessionId=installer.createSession(params);
            PackageInstaller.Session session=installer.openSession(sessionId);
            try(InputStream input=new FileInputStream(file);OutputStream output=session.openWrite("Babagan.apk",0,file.length())){
                byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);session.fsync(output);
            }catch(Exception error){session.close();throw error;}
            final int preparedId=sessionId;
            main.post(()->{
                try{
                    if(closed||busy.getAsBoolean()){installer.abandonSession(preparedId);installing=false;return;}
                Intent result=new Intent(activity,UpdateInstallReceiver.class).setAction("cloud.babagan.meeting.UPDATE_RESULT");
                int flags=PendingIntent.FLAG_UPDATE_CURRENT|(Build.VERSION.SDK_INT>=31?PendingIntent.FLAG_MUTABLE:0);
                PendingIntent callback=PendingIntent.getBroadcast(activity,preparedId,result,flags);
                session.commit(callback.getIntentSender());
                }catch(Exception error){installer.abandonSession(preparedId);installing=false;}
                finally{session.close();}
            });
        }catch(Exception error){if(sessionId>=0)installer.abandonSession(sessionId);main.post(()->{installing=false;if(!closed)android.widget.Toast.makeText(activity,"Could not install the update",android.widget.Toast.LENGTH_LONG).show();});}
    }
    void confirmation(Intent intent){installConfirmation=intent;if(busy.getAsBoolean())updateState("deferred",pending!=null?pending.version():null,null);installWhenIdle();}
    void installFinished(){installing=false;pending=null;pendingApk=null;updateState("idle",null,null);}

    private void verifyPackage(File apk,UpdateVerifier.Release release)throws Exception{
        PackageManager pm=activity.getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo incoming=pm.getPackageArchiveInfo(apk.getAbsolutePath(),flags),current=pm.getPackageInfo(activity.getPackageName(),flags);
        if(incoming==null||!activity.getPackageName().equals(incoming.packageName)||!release.version().equals(incoming.versionName))throw new SecurityException("Wrong Android package");
        long incomingCode=Build.VERSION.SDK_INT>=28?incoming.getLongVersionCode():incoming.versionCode,currentCode=Build.VERSION.SDK_INT>=28?current.getLongVersionCode():current.versionCode;
        if(incomingCode<=currentCode)throw new SecurityException("Android update version did not increase");
        android.content.pm.Signature[] a=Build.VERSION.SDK_INT>=28?incoming.signingInfo.getApkContentsSigners():incoming.signatures,b=Build.VERSION.SDK_INT>=28?current.signingInfo.getApkContentsSigners():current.signatures;
        if(a==null||b==null||!new HashSet<>(Arrays.asList(a)).equals(new HashSet<>(Arrays.asList(b))))throw new SecurityException("Android update signer does not match this installation");
    }
    private static HttpsURLConnection connect(String url)throws Exception{
        HttpsURLConnection connection=(HttpsURLConnection)new URL(url).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setRequestProperty("Accept-Encoding","identity");
        if(connection.getResponseCode()!=200){int status=connection.getResponseCode();connection.disconnect();throw new IOException("Update server returned HTTP "+status);}return connection;
    }
    private static byte[] downloadSmall(String url,int maximum)throws Exception{HttpsURLConnection connection=connect(url);try(InputStream input=connection.getInputStream()){return readBounded(input,maximum);}finally{connection.disconnect();}}
    private static byte[] readBounded(InputStream input,int maximum)throws IOException{ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>maximum)throw new IOException("Response is too large");output.write(buffer,0,count);}return output.toByteArray();}
    private void downloadApk(File file,UpdateVerifier.Release release,UpdateDownloadGate.Ticket ticket,long generation)throws Exception{
        ticket.check();
        HttpsURLConnection connection=(HttpsURLConnection)new URL(release.url()).openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setRequestProperty("Accept-Encoding","identity");
        ticket.onCancel(connection::disconnect);File part=new File(file.getParentFile(),file.getName()+".part");
        try{
            ticket.check();
            if(connection.getResponseCode()!=200)throw new IOException("Update server returned HTTP "+connection.getResponseCode());
            ticket.check();
            try(InputStream input=connection.getInputStream();OutputStream output=new FileOutputStream(part)){
                byte[] buffer=new byte[65536];long total=0;int count;
                while((count=input.read(buffer))!=-1){
                    ticket.check();if(Thread.currentThread().isInterrupted())throw new InterruptedIOException();
                    if(count>release.bytes()-total)throw new IOException("APK is larger than the signed manifest");
                    output.write(buffer,0,count);total+=count;
                    postProgress(progress.downloaded(generation,total,SystemClock.elapsedRealtime()),release.version());
                }
            }
        }catch(Exception error){part.delete();ticket.check();throw error;}
        finally{connection.disconnect();}
        try{
            ticket.check();
            if(part.length()==release.bytes())postProgress(progress.verifying(generation),release.version());
            if(!verifyBytes(part,release,ticket))throw new SecurityException("APK download checksum did not match");
            ticket.check();
            if(file.exists()&&!file.delete())throw new IOException("Cannot replace cached update");if(!part.renameTo(file))throw new IOException("Cannot save verified update");
        }finally{if(part.exists())part.delete();}
    }
    private static boolean verifyBytes(File file,UpdateVerifier.Release release)throws Exception{
        return verifyBytes(file,release,null);
    }
    private static boolean verifyBytes(File file,UpdateVerifier.Release release,UpdateDownloadGate.Ticket ticket)throws Exception{
        if(!file.isFile()||file.length()!=release.bytes())return false;
        MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1){if(ticket!=null)ticket.check();hash.update(buffer,0,count);}}
        StringBuilder value=new StringBuilder();for(byte part:hash.digest())value.append(String.format(java.util.Locale.ROOT,"%02x",part&255));return value.toString().equals(release.sha256());
    }
    void close(){closed=true;progress.close();downloads.close();worker.shutdownNow();}
}
