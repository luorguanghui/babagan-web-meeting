import type { JoinMeetingResponse, RefreshParticipantTokenResponse } from '@meeting/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createReconnectController, type ReconnectState } from './reconnect-controller.js';
import type { MeetingRoomController, MeetingRoomState } from './room-controller.js';

const initialState: MeetingRoomState = {
  connection: 'disconnected',
  participants: [],
  microphoneEnabled: false,
  audioPlaybackBlocked: false,
  screenShareAuthorized: false
};

export function useMeetingRoom(
  join: JoinMeetingResponse,
  controller: MeetingRoomController,
  refresh: (signal?: AbortSignal) => Promise<RefreshParticipantTokenResponse>
) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string>();
  const [reconnectState, setReconnectState] = useState<ReconnectState>({ kind: 'connected' });
  const [reconnectRateLimited, setReconnectRateLimited] = useState(false);
  const stopRef = useRef<() => void>(() => {});
  const stopRecovery = useCallback(() => stopRef.current(), []);

  useEffect(() => {
    let active = true;
    let enabled = true;
    let everConnected = false;
    let initialPending = true;
    let applicationRecovery = false;
    let connection: MeetingRoomState['connection'] = 'disconnected';
    let sdkTimer: ReturnType<typeof setTimeout> | undefined;
    const clearSdkTimer = () => { clearTimeout(sdkTimer); sdkTimer = undefined; };
    const reconnect = createReconnectController({
      refresh,
      reconnect: async (token, signal) => {
        applicationRecovery = true;
        try {
          await controller.connect({
            participantIdentity: token.participantIdentity, participantName: token.participantName,
            livekitUrl: token.livekitUrl, token: token.token, meetingExpiresAt: token.meetingExpiresAt,
            permissions: 'publishSources' in token.permissions ? token.permissions : {
              publishSources: token.permissions.canShareScreen ? ['microphone', 'screen_share', 'screen_share_audio'] : ['microphone']
            }
          }, signal);
        } finally { applicationRecovery = false; }
      }
    });
    const recover = () => {
      if (!active || !enabled) return;
      clearSdkTimer();
      void reconnect.reconnect();
    };
    stopRef.current = () => { enabled = false; clearSdkTimer(); reconnect.dispose(); };
    const unsubscribeReconnect = reconnect.subscribe(next => {
      if (!active || !enabled) return;
      setReconnectState(next);
      setReconnectRateLimited(reconnect.isRateLimited());
    });
    const unsubscribe = controller.subscribe(next => {
      if (!active) return;
      connection = next.connection;
      setState(next);
      if (connection === 'connected') {
        everConnected = true;
        setError(undefined);
        clearSdkTimer();
        if (!applicationRecovery) reconnect.connected();
      }
      if (!enabled || applicationRecovery || initialPending) return;
      if (connection === 'reconnecting' && sdkTimer === undefined) {
        // Preserve the SDK's ICE/signaling recovery and existing audio first.
        sdkTimer = setTimeout(recover, 30_000);
      }
      if (connection === 'disconnected' && everConnected) queueMicrotask(recover);
    });
    const resume = () => {
      if (!active || !enabled) return;
      void controller.resumeAudioPlayback().catch(() => undefined);
      if (connection === 'disconnected' || connection === 'reconnecting') recover();
    };
    const visible = () => { if (document.visibilityState === 'visible') resume(); };
    // Hiding alone must never disconnect, pause, or unpublish meeting audio.
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('resume', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    window.addEventListener('babagan-resume-media', resume);
    void controller.connect(join).catch(() => {
      if (active) setError('The meeting connection could not be established.');
    }).finally(() => { initialPending = false; });
    return () => {
      active = false;
      stopRef.current();
      unsubscribe(); unsubscribeReconnect();
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('resume', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('babagan-resume-media', resume);
      void controller.disconnect();
    };
  }, [controller, join, refresh]);

  return { state, error, reconnectState, reconnectRateLimited, stopRecovery };
}
