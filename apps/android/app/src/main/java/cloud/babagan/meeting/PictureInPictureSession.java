package cloud.babagan.meeting;

import java.util.UUID;

/** One accepted PiP request survives release until Android confirms its window exited. */
final class PictureInPictureSession {
    private String current;
    private boolean entered, released;
    void begin(String id) {
        if(id==null || !UUID.fromString(id).toString().equalsIgnoreCase(id)) throw new IllegalArgumentException("Invalid PiP session ID");
        if(current!=null) throw new IllegalStateException("A picture-in-picture session already exists");
        current=id; entered=false; released=false;
    }
    boolean owns(String id) { return current!=null && current.equals(id); }
    String current() { return current; }
    boolean entered() { return entered; }
    boolean released() { return released; }
    boolean stopConfirmsExit(boolean actualPip,boolean finishing) { return finishing || (entered && !actualPip); }
    void enteredMode() { if(current!=null) entered=true; }
    boolean release(String id) { if(!owns(id))return false; released=true; return true; }
    String clear() { String previous=current; current=null; entered=false; released=false; return previous; }
    static int[] aspect(int width,int height) {
        if(width<1 || height<1 || width>16384 || height>16384)throw new IllegalArgumentException("Invalid PiP dimensions");
        if((long)width*100>(long)height*239)return new int[]{239,100};
        if((long)width*239<(long)height*100)return new int[]{100,239};
        return new int[]{width,height};
    }
}
