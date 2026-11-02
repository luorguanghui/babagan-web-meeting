import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { JoinMeetingResponse, RefreshParticipantTokenResponse } from '@meeting/contracts';
import { useMeetingRoom } from './use-meeting-room.js';
import type { MeetingRoomController, MeetingRoomState } from './room-controller.js';
import { useMeetingMediaSession } from './use-meeting-media-session.js';

const join: JoinMeetingResponse = { participantIdentity:'a',participantName:'Ada',livekitUrl:'wss://rtc.test',token:'test',meetingExpiresAt:9999999999999,permissions:{publishSources:['microphone']} };
const refreshed: RefreshParticipantTokenResponse = {...join, permissions:{canPublishMicrophone:true,canShareScreen:false}};
afterEach(() => {cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

function fixture() {
  let state: MeetingRoomState = { connection:'disconnected',participants:[],microphoneEnabled:false,audioPlaybackBlocked:false,screenShareAuthorized:false };
  const listeners = new Set<(s:MeetingRoomState)=>void>();
  const emit = (connection:MeetingRoomState['connection']) => {state={...state,connection};listeners.forEach(l=>l(state));};
  const controller: MeetingRoomController = {
    connect:vi.fn(async()=>emit('connected')),disconnect:vi.fn(async()=>emit('disconnected')),
    subscribe(l){listeners.add(l);l(state);return()=>{listeners.delete(l);};},
    setMicrophoneEnabled:vi.fn(),switchAudioOutput:vi.fn(),setCallAudioVolume:vi.fn(),
    publishScreenShare:vi.fn(),releaseScreenShare:vi.fn(),setRemoteScreenShareSubscribed:vi.fn(),resumeAudioPlayback:vi.fn(async()=>{})
  };
  return {controller,emit};
}

it('retains the live SDK audio transport while the SDK performs its own reconnection', async()=>{
  const f=fixture(),refresh=vi.fn(async()=>refreshed);
  renderHook(()=>useMeetingRoom(join,f.controller,refresh));
  await act(async()=>{});
  await act(async()=>f.emit('reconnecting'));
  expect(refresh).not.toHaveBeenCalled();
  expect(f.controller.disconnect).not.toHaveBeenCalled();
  await act(async()=>f.emit('connected'));
  expect(f.controller.connect).toHaveBeenCalledTimes(1);
});

it('recovers a background disconnect even after two minutes without ejecting the participant', async()=>{
  vi.useFakeTimers();
  const f=fixture();let offline=true;
  const refresh=vi.fn(async()=>{if(offline)throw new Error('network suspended');return refreshed;});
  const {result}=renderHook(()=>useMeetingRoom(join,f.controller,refresh));
  await act(async()=>{});
  await act(async()=>f.emit('disconnected'));
  await act(async()=>vi.advanceTimersByTimeAsync(120000));
  expect(result.current.reconnectState.kind).not.toBe('rejoin-required');
  offline=false;
  await act(async()=>window.dispatchEvent(new Event('online')));
  await act(async()=>vi.advanceTimersByTimeAsync(10000));
  expect(refresh).toHaveBeenCalled();
  expect(f.controller.connect).toHaveBeenCalledTimes(2);
  expect(result.current.state.connection).toBe('connected');
});

it('does not disconnect on hiding and cancels recovery before an explicit leave', async()=>{
  const f=fixture(),refresh=vi.fn(async()=>refreshed);
  const {result}=renderHook(()=>useMeetingRoom(join,f.controller,refresh));
  await act(async()=>{});
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
  expect(f.controller.disconnect).not.toHaveBeenCalled();
  act(()=>result.current.stopRecovery());
  await act(async()=>f.emit('disconnected'));
  await act(async()=>window.dispatchEvent(new Event('online')));
  expect(refresh).not.toHaveBeenCalled();
  visibility.mockRestore();
});

it('cancels fallback token refresh when the SDK recovers before it completes', async()=>{
  const f=fixture();let finish!: (value:RefreshParticipantTokenResponse)=>void;
  const refresh=vi.fn(()=>new Promise<RefreshParticipantTokenResponse>(resolve=>{finish=resolve;}));
  const {result}=renderHook(()=>useMeetingRoom(join,f.controller,refresh));
  await act(async()=>{});
  await act(async()=>f.emit('reconnecting'));
  await act(async()=>window.dispatchEvent(new Event('online')));
  expect(refresh).toHaveBeenCalledOnce();
  await act(async()=>f.emit('connected'));
  await act(async()=>finish(refreshed));
  expect(f.controller.connect).toHaveBeenCalledTimes(1);
  expect(result.current.reconnectState.kind).toBe('connected');
});

it('registers real meeting media controls and releases them after leaving',()=>{
  const handlers=new Map<string,(()=>void)|null>();
  const session={metadata:null,setActionHandler:vi.fn((name:string,handler:(()=>void)|null)=>handlers.set(name,handler))};
  vi.stubGlobal('navigator',{mediaSession:session});
  vi.stubGlobal('MediaMetadata',class { constructor(public data:unknown){} });
  const leave=vi.fn(),resume=vi.fn();window.addEventListener('babagan-resume-media',resume);
  const view=renderHook(({active})=>useMeetingMediaSession(active,'Daily meeting',leave),{initialProps:{active:true}});
  handlers.get('play')!();expect(resume).toHaveBeenCalledOnce();
  handlers.get('hangup')!();expect(leave).toHaveBeenCalledOnce();
  view.rerender({active:false});
  expect(session.metadata).toBeNull();expect(handlers.get('play')).toBeNull();
  window.removeEventListener('babagan-resume-media',resume);
});
