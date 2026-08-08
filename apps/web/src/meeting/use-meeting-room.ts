import type { JoinMeetingResponse } from '@meeting/contracts';
import { useEffect, useState } from 'react';

import type { MeetingRoomController, MeetingRoomState } from './room-controller.js';

const initialState: MeetingRoomState = {
  connection: 'disconnected',
  participants: [],
  microphoneEnabled: false,
  audioPlaybackBlocked: false
};

export function useMeetingRoom(join: JoinMeetingResponse, controller: MeetingRoomController) {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const unsubscribe = controller.subscribe((nextState) => { if (active) setState(nextState); });
    void controller.connect(join).catch(() => { if (active) setError('The meeting connection could not be established.'); });
    return () => {
      active = false;
      unsubscribe();
      void controller.disconnect();
    };
  }, [controller, join]);

  return { state, error };
}
