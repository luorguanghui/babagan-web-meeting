package cloud.babagan.meeting;

import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public class AudioRouteLeaseTest {
    @Test public void pendingSelectionKeepsThePreviouslyConfirmedChoiceUntilReadback(){
        AudioRouteLease lease=new AudioRouteLease();lease.meeting(true);
        long first=lease.begin("speaker");assertEquals("default",lease.selected());assertEquals("speaker",lease.pending());
        assertTrue(lease.confirm(first,"speaker"));long second=lease.begin("bluetooth");
        assertEquals("speaker",lease.selected());assertTrue(lease.fail(second,"bluetooth"));assertEquals("speaker",lease.selected());
    }
    @Test public void deviceRemovalFallsBackToSystemAndNeverPretendsTheOldDeviceIsApplied(){
        AudioRouteLease lease=new AudioRouteLease();lease.meeting(true);lease.confirm(lease.begin("bluetooth"),"bluetooth");
        lease.reconcile("speaker",Set.of("default","speaker"));assertEquals("default",lease.selected());
    }
    @Test public void systemOrWebViewRouteChangesInvalidateAnOutdatedSelection(){
        AudioRouteLease lease=new AudioRouteLease();lease.meeting(true);lease.confirm(lease.begin("speaker"),"speaker");
        lease.reconcile("earpiece",Set.of("default","speaker","earpiece"));assertEquals("earpiece",lease.selected());assertEquals("speaker",lease.requested());
        lease.reconcile("speaker",Set.of("default","speaker","earpiece"));assertEquals("speaker",lease.selected());
    }
    @Test public void lateSelectionAndBluetoothPermissionGenerationCannotApplyAfterLeaveAndRejoin(){
        AudioRouteLease lease=new AudioRouteLease();lease.meeting(true);long permissionGeneration=lease.generation();long selection=lease.begin("bluetooth");
        lease.meeting(false);lease.meeting(true);assertNotEquals(permissionGeneration,lease.generation());
        assertFalse(lease.confirm(selection,"bluetooth"));assertEquals("default",lease.selected());assertNull(lease.pending());
    }
    @Test public void strictModeEquivalentJoinedNotificationDoesNotResetTheChoice(){
        AudioRouteLease lease=new AudioRouteLease();lease.meeting(true);long choice=lease.begin("speaker");lease.meeting(true);
        assertTrue(lease.confirm(choice,"speaker"));assertEquals("speaker",lease.selected());
    }
    @Test(expected=IllegalStateException.class) public void outsideMeetingSelectionIsRefused(){new AudioRouteLease().begin("speaker");}
    @Test public void phoneRingingCallsAndScreeningAreNotOverwritten(){
        assertFalse(AudioRouteLease.systemCall(0));assertFalse(AudioRouteLease.systemCall(3));
        assertTrue(AudioRouteLease.systemCall(1));assertTrue(AudioRouteLease.systemCall(2));assertTrue(AudioRouteLease.systemCall(4));
    }
}
