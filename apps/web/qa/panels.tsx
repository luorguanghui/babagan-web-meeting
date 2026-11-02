/** Isolated layout fixture: the production controls/drawers with a TURN retry row. No network or media. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingControls, MeetingSettings } from '../src/components/meeting-controls.js';
import { MeetingDrawer } from '../src/components/meeting-drawer.js';
import '../src/styles.css';
import '../src/pages/meeting-room-layout.css';

function Preview() {
  const [panel, setPanel] = useState<'More' | 'Settings' | null>(null);
  const props = {
    connection: 'connected' as const, microphoneEnabled: false, audioPlaybackBlocked: false,
    devices: [], leaving: false, includeSettings: false, p2pRetryVisible: true,
    onP2pRetry() {}, onMicrophoneToggle() {}, onMicrophoneDeviceChange() {},
    onSpeakerDeviceChange() {}, onResumeAudio() {}, onLeave() {},
    viewerTransportPreferenceVisible: true, viewerTransportPreference: 'turn' as const,
    onViewerTransportPreferenceChange() {}
  };
  return <main className="meeting-room meeting-room-sharing">
    <header className="meeting-topbar"><h1>TURN receiver</h1><button onClick={() => setPanel('Settings')}>Settings</button></header>
    <div className="meeting-notices" />
    <div className="meeting-workspace">
      <div className="meeting-stage-column"><div className="meeting-stage-shell">
        <div className="screen-stage"><div className="screen-stage-media">Shared screen</div></div>
        {panel && <MeetingDrawer title={panel} modal={false} closeLabel="Close panel" onClose={() => setPanel(null)}>
          {panel === 'Settings' ? <MeetingSettings {...props} section="general" /> : <div className="meeting-settings-grid"><button onClick={() => setPanel('Settings')}>Open settings</button><button onClick={() => setPanel(null)}>Done</button></div>}
        </MeetingDrawer>}
      </div></div>
      <aside className="meeting-members-sidebar">Participants</aside>
      <MeetingControls {...props} className="meeting-control-dock" onMore={() => setPanel('More')} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
