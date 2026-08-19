import type { JoinMeetingResponse, RefreshParticipantTokenResponse } from '@meeting/contracts';
import { useEffect, useRef, useState } from 'react';

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
  refresh: () => Promise<RefreshParticipantTokenResponse>
) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string>();
  const [reconnectState, setReconnectState] = useState<ReconnectState>({ kind: 'connected' });
  const [reconnectRateLimited, setReconnectRateLimited] = useState(false);
  const priorConnection = useRef<MeetingRoomState['connection']>('disconnected');

  useEffect(() => {
    let active = true;
    const reconnect = createReconnectController({
      refresh,
      reconnect: async (token) => controller.connect({
        participantIdentity: token.participantIdentity,
        participantName: token.participantName,
        livekitUrl: token.livekitUrl,
        token: token.token,
        meetingExpiresAt: token.meetingExpiresAt,
        permissions: 'publishSources' in token.permissions
          ? token.permissions
          : { publishSources: token.permissions.canShareScreen
            ? ['microphone', 'screen_share', 'screen_share_audio']
            : ['microphone'] }
      })
    });
    const unsubscribeReconnect = reconnect.subscribe((next) => {
      if (!active) return;
      setReconnectState(next);
      setReconnectRateLimited(reconnect.isRateLimited());
    });
    const unsubscribe = controller.subscribe((nextState) => {
      if (!active) return;
      setState(nextState);
      if (nextState.connection === 'reconnecting' && priorConnection.current !== 'reconnecting') void reconnect.reconnect();
      priorConnection.current = nextState.connection;
    });
    void controller.connect(join).catch(() => { if (active) setError('The meeting connection could not be established.'); });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeReconnect();
      reconnect.dispose();
      void controller.disconnect();
    };
  }, [controller, join, refresh]);

  return { state, error, reconnectState, reconnectRateLimited };
}
