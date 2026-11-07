package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class BridgeOriginTest {
    @Test public void launchesWorkspaceAndPreservesTrustedMeetingDeepLinks(){
        String workspace="https://meet.babagan.cloud/client?clientVersion=0.1.2";
        assertEquals(workspace,MainActivity.entryUrl(null));
        assertEquals(workspace,MainActivity.entryUrl("https://evil.example/m/room"));
        assertEquals(workspace,MainActivity.entryUrl("https://meet.babagan.cloud@evil.example/m/room"));
        String meeting="https://meet.babagan.cloud/m/abc?join=yes#invite";
        assertEquals(meeting,MainActivity.entryUrl(meeting));
    }
    @Test public void onlyExactProductionHttpsOriginAccepted(){assertTrue(MainActivity.trusted("https://meet.babagan.cloud/room/abc"));assertTrue(MainActivity.trusted("https://meet.babagan.cloud:443/"));assertFalse(MainActivity.trusted("http://meet.babagan.cloud/"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud.evil.example/"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud@evil.example/"));assertFalse(MainActivity.trusted("https://evil@meet.babagan.cloud/"));assertFalse(MainActivity.trusted("file:///android_asset/test.html"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud:444/"));}
}
