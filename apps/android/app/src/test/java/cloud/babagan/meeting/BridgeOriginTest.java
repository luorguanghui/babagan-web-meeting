package cloud.babagan.meeting;

import org.junit.Test;
import static org.junit.Assert.*;

public class BridgeOriginTest {
    @Test public void onlyExactProductionHttpsOriginAccepted(){assertTrue(MainActivity.trusted("https://meet.babagan.cloud/room/abc"));assertTrue(MainActivity.trusted("https://meet.babagan.cloud:443/"));assertFalse(MainActivity.trusted("http://meet.babagan.cloud/"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud.evil.example/"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud@evil.example/"));assertFalse(MainActivity.trusted("https://evil@meet.babagan.cloud/"));assertFalse(MainActivity.trusted("file:///android_asset/test.html"));assertFalse(MainActivity.trusted("https://meet.babagan.cloud:444/"));}
}
