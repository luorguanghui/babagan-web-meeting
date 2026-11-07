package cloud.babagan.meeting;

import android.content.*;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

public final class UpdateInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        int status=intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
        if(status==PackageInstaller.STATUS_PENDING_USER_ACTION){
            Intent confirmation=Build.VERSION.SDK_INT>=33?intent.getParcelableExtra(Intent.EXTRA_INTENT,Intent.class):intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if(confirmation!=null&&!MainActivity.receiveInstallResult(confirmation))Toast.makeText(context,"Open Babagan to check and finish the update.",Toast.LENGTH_LONG).show();
        }else {MainActivity.receiveInstallResult(null);if(status!=PackageInstaller.STATUS_SUCCESS)Toast.makeText(context,"Babagan update was not installed. You can try again from the client.",Toast.LENGTH_LONG).show();}
    }
}
