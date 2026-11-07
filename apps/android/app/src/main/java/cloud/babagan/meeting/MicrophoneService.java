package cloud.babagan.meeting;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.*;

/** Keeps an actually enabled WebView microphone eligible while the meeting app is backgrounded. */
public final class MicrophoneService extends Service {
    private static volatile boolean requested, active;
    static boolean isActive() { return active; }
    static boolean isRequestedActive() { return requested && active; }
    static void enable(Context context) {
        requested = true;
        try { context.startForegroundService(new Intent(context, MicrophoneService.class)); }
        catch (RuntimeException error) { requested = false; throw error; }
    }
    static void disable(Context context) {
        requested = false;
        context.stopService(new Intent(context, MicrophoneService.class));
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!requested || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("microphone", "Meeting microphone", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "microphone").setSmallIcon(R.drawable.ic_babagan)
            .setContentTitle("Babagan microphone is active").setContentText("Open the meeting to mute your microphone")
            .setContentIntent(open).setOngoing(true).build();
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(11, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(11, notification);
            active = true;
            MainActivity.servicesChanged();
        } catch (RuntimeException error) { requested = false; stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() { active = false; stopForeground(STOP_FOREGROUND_REMOVE);MainActivity.servicesChanged();super.onDestroy(); }
}
