import { MAX_OPEN_MEETINGS, OpenMeetingsResponseSchema, type OpenMeeting, type OpenMeetingsResponse } from '@meeting/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import { parseClientMeetingInput } from './client-meeting-input.js';

interface OpenMeetingsState { meetings: OpenMeeting[]; loading: boolean; loaded: boolean; failed: boolean; }

/** Shared admission-list state; in-flight snapshots cannot undo a completed create/end. */
export function useOpenMeetings() {
  const [state, setState] = useState<OpenMeetingsState>({ meetings: [], loading: true, loaded: false, failed: false });
  const request = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; request.current?.abort(); }, []);
  const refresh = useCallback(async () => {
    invalidate();
    const current = generation.current;
    const abort = new AbortController(); request.current = abort;
    setState(previous => ({ ...previous, loading: true, failed: false }));
    try {
      const response = await apiRequest<OpenMeetingsResponse>('/meetings/open', OpenMeetingsResponseSchema, { signal: abort.signal });
      if (abort.signal.aborted || current !== generation.current) return;
      if (new Set(response.meetings.map(meeting => meeting.slug)).size !== response.meetings.length
        || response.meetings.some(meeting => !parseClientMeetingInput(meeting.slug, window.location.origin))) throw new Error('Invalid open meeting list');
      setState({ meetings: response.meetings, loading: false, loaded: true, failed: false });
    } catch {
      if (!abort.signal.aborted && current === generation.current) setState(previous => ({ ...previous, loading: false, failed: true }));
    }
  }, [invalidate]);
  useEffect(() => {
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visible, 15_000);
    document.addEventListener('visibilitychange', visible);
    return () => { invalidate(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [invalidate, refresh]);
  const add = useCallback((meeting: OpenMeeting) => {
    invalidate();
    setState(previous => {
      const meetings = [...previous.meetings.filter(value => value.slug !== meeting.slug), meeting];
      // A cached room may have ended elsewhere while this create succeeded.
      // Keep the bounded snapshot until its immediate authoritative refresh.
      return meetings.length > MAX_OPEN_MEETINGS ? { ...previous, loading: true }
        : { meetings, loading: false, loaded: true, failed: false };
    });
  }, [invalidate]);
  const remove = useCallback((slug: string) => {
    invalidate();
    setState(previous => ({ ...previous, meetings: previous.meetings.filter(meeting => meeting.slug !== slug), loading: false }));
  }, [invalidate]);
  return { ...state, maxOpenMeetings: MAX_OPEN_MEETINGS, atCapacity: state.meetings.length >= MAX_OPEN_MEETINGS, refresh, add, remove };
}
