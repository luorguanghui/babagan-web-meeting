package cloud.babagan.meeting;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;

/** Main-thread ownership of the Activity's one runtime permission dialog. */
final class RuntimePermissionQueue implements AutoCloseable {
    enum Result { GRANTED, DENIED, CANCELLED }
    interface Launcher { void launch(String permission,int requestCode); }
    interface Completion { void completed(Result result); }
    private static final class Batch {
        final String permission;
        final LinkedHashMap<Object,Completion> waiters=new LinkedHashMap<>();
        int requestCode;
        Batch(String permission){this.permission=permission;}
    }
    private final Launcher launcher;
    private final Runnable idle;
    private final ArrayDeque<Batch> pending=new ArrayDeque<>();
    private Batch active,completing;
    private boolean paused,closed;
    private int nextCode=100;
    RuntimePermissionQueue(Launcher launcher,Runnable idle) { this.launcher=launcher;this.idle=idle; }

    void request(String permission,Object owner,Completion completion) {
        if(closed)return;
        removeOwner(owner);
        Batch batch=active!=null&&active.permission.equals(permission)?active:null;
        if(batch==null)for(Batch queued:pending)if(queued.permission.equals(permission)){batch=queued;break;}
        if(batch==null){batch=new Batch(permission);pending.add(batch);}
        batch.waiters.put(owner,completion);
        pump();
    }
    void cancel(Object owner) { removeOwner(owner);pump(); }
    private void removeOwner(Object owner) {
        // Cancelling a waiter cannot dismiss Android's dialog or free its occupied slot.
        if(active!=null)active.waiters.remove(owner);
        if(completing!=null)completing.waiters.remove(owner);
        for(Batch batch:pending)batch.waiters.remove(owner);
        pending.removeIf(batch->batch.waiters.isEmpty());
    }
    boolean complete(int requestCode,String[] permissions,int[] results) {
        if(closed||active==null||active.requestCode!=requestCode)return false;
        Result result=Result.CANCELLED;
        if(permissions!=null&&results!=null&&permissions.length==1&&results.length==1&&active.permission.equals(permissions[0])) {
            if(results[0]==0)result=Result.GRANTED;
            else if(results[0]==-1)result=Result.DENIED;
        }
        finish(result);return true;
    }
    private void finish(Result result) {
        Batch batch=active;active=null;completing=batch;
        try {
            for(Object owner:new ArrayList<>(batch.waiters.keySet())) {
                Completion completion=batch.waiters.remove(owner);
                if(completion!=null)try{completion.completed(result);}catch(RuntimeException ignored){/* An invalidated consumer cannot starve the remaining owners. */}
            }
        } finally { completing=null;pump(); }
    }
    private void pump() {
        if(closed||paused||active!=null||completing!=null)return;
        if(pending.isEmpty()){idle.run();return;}
        active=pending.remove();active.requestCode=nextCode++;
        if(nextCode>65535)nextCode=100;
        int code=active.requestCode;
        try { launcher.launch(active.permission,code); }
        catch(RuntimeException error) { if(active!=null&&active.requestCode==code)finish(Result.CANCELLED); }
    }
    void pause(boolean value) { paused=value;if(!value)pump(); }
    boolean isIdle() { return !closed&&!paused&&active==null&&completing==null&&pending.isEmpty(); }
    public void close() {
        closed=true;pending.clear();if(active!=null)active.waiters.clear();if(completing!=null)completing.waiters.clear();active=null;
    }
}
