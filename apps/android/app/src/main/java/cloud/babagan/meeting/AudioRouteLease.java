package cloud.babagan.meeting;

import java.util.Set;

/** A meeting-scoped selection, independently testable from Android's device APIs. */
final class AudioRouteLease {
    private boolean joined;
    private long generation;
    private String selected="default",requested="default",pending;
    long generation(){return generation;}
    boolean joined(){return joined;}
    String selected(){return selected;}
    String requested(){return requested;}
    String pending(){return pending;}
    void meeting(boolean active){if(joined==active)return;joined=active;generation++;pending=null;selected=requested="default";}
    long begin(String id){if(!joined)throw new IllegalStateException("Join a meeting before changing audio devices");if(pending!=null)throw new IllegalStateException("An audio-device change is already pending");pending=id;return generation;}
    boolean owns(long ticket,String id){return joined&&generation==ticket&&id.equals(pending);}
    boolean confirm(long ticket,String id){if(!owns(ticket,id))return false;selected=requested=id;pending=null;return true;}
    boolean fail(long ticket,String id){if(!owns(ticket,id))return false;pending=null;return true;}
    void resetPreference(){selected=requested="default";}
    void reconcile(String actual,Set<String> available){
        if(pending!=null||"default".equals(requested))return;
        if(!available.contains(requested)){resetPreference();return;}
        selected=actual!=null&&available.contains(actual)?actual:"default";
    }
    static boolean systemCall(int mode){return mode!=0&&mode!=3;}
}
