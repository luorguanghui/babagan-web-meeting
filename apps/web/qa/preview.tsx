/**
 * TEST-ONLY Vite entry. Open /qa/preview.html?scene=receiver (also settings,
 * host, idle, create, lobby). This file is not imported by the production app.
 *
 * All visible UI below is the real App / MeetingRoomPage. Only their service,
 * signaling, device and media boundaries are replaced. No participant, token,
 * media, API response, or meeting in this fixture is real. Unknown application
 * fetches fail closed; native capture, WebRTC and sockets are blocked as a
 * second safety boundary. Vite's own local module/HMR requests are unaffected.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { JoinMeetingResponse } from '@meeting/contracts';

import { App } from '../src/app.js';
import { ApiRequestError } from '../src/api/client.js';
import { AppShell } from '../src/components/app-shell.js';
import { LanguageProvider } from '../src/i18n/i18n.js';
import { createP2pSignalingClient, type P2pSignalingEvents, type P2pWebSocket } from '../src/meeting/p2p-signaling.js';
import { createP2pStatsCollector } from '../src/meeting/p2p-stats.js';
import type { LiveKitTrackAdapter, MeetingParticipant, MeetingRoomController, MeetingRoomState } from '../src/meeting/room-controller.js';
import { MeetingRoomPage, type MeetingRoomApi } from '../src/pages/meeting-room-page.js';
import '../src/styles.css';

type Scene = 'receiver' | 'settings' | 'host' | 'idle' | 'create' | 'lobby';
const scenes: Scene[] = ['receiver', 'settings', 'host', 'idle', 'create', 'lobby'];
const requestedScene = new URLSearchParams(location.search).get('scene');
const initialScene = scenes.includes(requestedScene as Scene) ? requestedScene as Scene : 'receiver';
const slug = 'illustrative-workshop-qa-only';
const meetingName = 'Design workshop · demo';
const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
const join: JoinMeetingResponse = {
  participantIdentity: 'demo-jamie',
  participantName: 'Jamie Chen',
  livekitUrl: 'wss://preview.invalid',
  token: 'inert-qa-token-not-a-credential',
  meetingExpiresAt: expiresAt,
  permissions: { publishSources: ['microphone'] }
};
const initialParticipants: MeetingParticipant[] = [
  { identity: 'demo-jamie', name: 'Jamie Chen', isLocal: true, microphoneEnabled: false, isSharing: false },
  { identity: 'demo-maya', name: 'Maya Patel', isLocal: false, microphoneEnabled: true, isSharing: true },
  { identity: 'demo-oliver', name: 'Oliver Brooks', isLocal: false, microphoneEnabled: false, isSharing: false },
  { identity: 'demo-sofia', name: 'Sofia Rivera', isLocal: false, microphoneEnabled: true, isSharing: false }
];

// Observable QA-only state lets browser checks prove requests stayed fake.
const diagnostics = {
  requests: [] as string[],
  actions: [] as string[],
  blocked: [] as string[],
  callAudioVolume: 1,
  scene: initialScene as Scene
};
Object.defineProperty(window, '__BABAGAN_QA__', { value: diagnostics, configurable: true });

// Read-only DOM evidence for motion QA; not included in the production entry.
const motionEvents: { name: string; elapsed: number; phase: string; width?: number }[] = [];
for (const phase of ['animationstart', 'animationend'] as const) {
  document.addEventListener(phase, event => {
    motionEvents.push({ name: event.animationName, elapsed: event.elapsedTime, phase });
    document.documentElement.dataset.qaMotion = JSON.stringify(motionEvents.slice(-24));
  });
}
for (const phase of ['transitionstart', 'transitionend', 'transitioncancel'] as const) {
  document.addEventListener(phase, event => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches('.meeting-drawer, .meeting-volume-popover, .system-audio-warning')) return;
    motionEvents.push({ name: `${target.className}:${event.propertyName}:${target.getAttribute('data-state')}`, elapsed: event.elapsedTime, phase, width: target.getBoundingClientRect().width });
    document.documentElement.dataset.qaMotion = JSON.stringify(motionEvents.slice(-24));
  });
}

// Keep production preference writes inside this disposable preview document.
// The production settings still use their normal read/write API and state.
const preferences = new Map<string, string>([
  ['babagan.viewer-transport', 'sfu'],
  ['babagan.locale', new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN']
]);
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => { preferences.set(key, String(value)); },
    removeItem: (key: string) => { preferences.delete(key); },
    clear: () => preferences.clear(),
    key: (index: number) => [...preferences.keys()][index] ?? null,
    get length() { return preferences.size; }
  } satisfies Storage
});

function block(operation: string): never {
  diagnostics.blocked.push(operation);
  throw new Error(`Isolated QA preview blocked ${operation}.`);
}
Object.defineProperty(window, 'RTCPeerConnection', {
  configurable: true,
  value: class { constructor() { block('native WebRTC'); } }
});
Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  value: class { constructor() { block('application WebSocket'); } }
});
Object.defineProperty(window, 'EventSource', {
  configurable: true,
  value: class { constructor() { block('EventSource'); } }
});
XMLHttpRequest.prototype.open = function () { block('XMLHttpRequest'); };
Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });

const devices = [
  ['audioinput', 'demo-mic-built-in', 'Built-in microphone · demo'],
  ['audioinput', 'demo-mic-usb', 'USB microphone · demo'],
  ['audiooutput', 'demo-speaker', 'Built-in speakers · demo'],
  ['audiooutput', 'demo-headphones', 'Headphones · demo']
].map(([kind, deviceId, label]) => ({
  kind: kind as MediaDeviceKind, deviceId, label, groupId: 'demo-devices',
  toJSON() { return { kind, deviceId, label, groupId: 'demo-devices' }; }
}));
const listDevices = async () => devices;
const noCapture = async (): Promise<MediaStream> => {
  diagnostics.actions.push('screen-capture-cancelled-locally');
  throw new DOMException('Screen capture is disabled in this isolated preview.', 'NotAllowedError');
};
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    enumerateDevices: listDevices,
    getUserMedia: async () => {
      diagnostics.actions.push('fake-microphone-check');
      return new MediaStream();
    },
    getDisplayMedia: noCapture
  }
});
// The lobby has a Windows/Chromium support check. Model a supported browser;
// this is test data, not a claim that the actual browser supports production.
Object.defineProperty(navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
});
// Device-check callbacks remain interactive but produce neither real audio nor
// microphone input. The analyser reports silence and the oscillator is inert.
class SilentAudioContext {
  currentTime = 0;
  destination = {};
  async close() {}
  createAnalyser() {
    return { fftSize: 256, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128) };
  }
  createMediaStreamSource() { return { connect: () => undefined }; }
  createGain() {
    return { gain: { setValueAtTime: () => undefined }, connect: () => undefined };
  }
  createOscillator() {
    const listeners = new Set<() => void>();
    return {
      frequency: { setValueAtTime: () => undefined },
      connect: (node: unknown) => node,
      start: () => undefined,
      stop: () => { setTimeout(() => listeners.forEach(listener => listener()), 180); },
      addEventListener: (_event: string, listener: () => void) => { listeners.add(listener); }
    };
  }
}
Object.defineProperty(window, 'AudioContext', { configurable: true, value: SilentAudioContext });
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async () => { diagnostics.actions.push('copy-link-local-no-clipboard-write'); } }
});

let createdMeeting = false;
let createdMeetingName = meetingName;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function selectScene(scene: Scene) {
  window.dispatchEvent(new CustomEvent('babagan-qa-scene', { detail: scene }));
}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  diagnostics.requests.push(`${method} ${url.pathname}`);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) block(`fetch ${url.origin}${url.pathname}`);
  if (url.pathname.endsWith('/screen-sfu')) return json({ available: false, publication: null });
  if (url.pathname.endsWith('/ice-servers')) return json({ iceServers: [], turnProvider: 'coturn', availableTurnProviders: ['coturn'] });
  if (url.pathname.endsWith('/token')) return json({ ...join, permissions: { canPublishMicrophone: true, canShareScreen: diagnostics.scene === 'host' } });
  if (url.pathname === '/api/v1/meetings/current') return json({ meeting: createdMeeting ? {
    slug, name: createdMeetingName, status: 'created',
    joinUrl: `${location.origin}/qa/preview.html?scene=lobby`, requiresPassword: false, isFull: false
  } : null });
  if (url.pathname === '/api/v1/meetings' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    createdMeeting = true;
    createdMeetingName = body.name || meetingName;
    return json({ slug, joinUrl: `${location.origin}/qa/preview.html?scene=lobby` });
  }
  if (url.pathname.endsWith('/admin-end')) { createdMeeting = false; return new Response(null, { status: 204 }); }
  if (url.pathname.endsWith('/join')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { nickname?: string };
    join.participantName = body.nickname || join.participantName;
    // Unmount the real lobby before its successful response can mount its
    // non-injected room. The next room is the same production page with seams.
    selectScene('receiver');
    await new Promise(resolve => setTimeout(resolve, 0));
    return json(join);
  }
  if (url.pathname === `/api/v1/meetings/${slug}`) return json({
    name: createdMeetingName, status: 'active', requiresPassword: false, isFull: false
  });
  return block(`unhandled fetch ${method} ${url.pathname}`);
};

const poster = new URL('./illustrative-screen.svg', import.meta.url).href;
const posterTrack: LiveKitTrackAdapter = {
  kind: 'video',
  attach(element = document.createElement('video')) {
    document.documentElement.dataset.qaStageAttaches = String(Number(document.documentElement.dataset.qaStageAttaches ?? 0) + 1);
    if (element instanceof HTMLVideoElement) element.poster = poster;
    queueMicrotask(() => element.dispatchEvent(new Event('loadedmetadata')));
    return element;
  },
  detach(element = document.createElement('video')) {
    document.documentElement.dataset.qaStageDetaches = String(Number(document.documentElement.dataset.qaStageDetaches ?? 0) + 1);
    if (element instanceof HTMLVideoElement) element.removeAttribute('poster');
    return element;
  }
};

function createFixtureController(scene: Scene) {
  const listeners = new Set<(state: MeetingRoomState) => void>();
  let state: MeetingRoomState = {
    connection: 'connected',
    participants: initialParticipants.map(participant => ({
      ...participant,
      name: participant.isLocal ? join.participantName : participant.name,
      isSharing: scene === 'idle' ? false : participant.isSharing
    })),
    microphoneEnabled: false,
    audioPlaybackBlocked: false,
    screenShareAuthorized: scene === 'host',
    ...(scene !== 'idle' ? { remoteScreenShare: {
      track: posterTrack, sharerIdentity: 'demo-maya', sharerName: 'Maya Patel'
    } } : {})
  };
  function update(patch: Partial<MeetingRoomState>) {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener(state));
  }
  const controller: MeetingRoomController = {
    async connect() { update({ connection: 'connected' }); },
    async disconnect() { update({ connection: 'disconnected' }); },
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    async setMicrophoneEnabled(enabled, deviceId) {
      diagnostics.actions.push(`fake-microphone:${enabled}:${deviceId ?? 'default'}`);
      update({ microphoneEnabled: enabled, participants: state.participants.map(participant => participant.isLocal ? { ...participant, microphoneEnabled: enabled } : participant) });
    },
    async switchAudioOutput(deviceId) { diagnostics.actions.push(`fake-speaker:${deviceId}`); return 'changed'; },
    setCallAudioVolume(volume) { diagnostics.callAudioVolume = volume; },
    async publishScreenShare() { block('screen publication'); },
    async releaseScreenShare() {},
    async setRemoteScreenShareSubscribed() {},
    async getScreenShareStatsReports() { return []; },
    async resumeAudioPlayback() { update({ audioPlaybackBlocked: false }); }
  };
  const api: MeetingRoomApi = {
    async authorizeHost() { if (scene !== 'host') throw new ApiRequestError('Demo participant is not the host.', 403); },
    async verifyParticipantShare() { if (!state.screenShareAuthorized) throw new ApiRequestError('No demo share grant.', 403); },
    async grantShare(_slug, identity) {
      diagnostics.actions.push(`fake-grant:${identity}`);
      const participant = state.participants.find(candidate => candidate.identity === identity);
      update({
        screenShareAuthorized: identity === join.participantIdentity,
        participants: state.participants.map(candidate => ({ ...candidate, isSharing: candidate.identity === identity })),
        remoteScreenShare: participant && !participant.isLocal ? { track: posterTrack, sharerIdentity: identity, sharerName: participant.name } : undefined
      });
    },
    async releaseOwnShare() {
      update({ screenShareAuthorized: false,
        participants: state.participants.map(participant => participant.isLocal ? { ...participant, isSharing: false } : participant) });
    },
    async revokeShare() {
      diagnostics.actions.push('fake-revoke');
      update({ screenShareAuthorized: false, participants: state.participants.map(participant => ({ ...participant, isSharing: false })), remoteScreenShare: undefined });
    },
    async kick(_slug, identity) {
      diagnostics.actions.push(`fake-kick:${identity}`);
      if (identity === join.participantIdentity) { selectScene('lobby'); return; }
      update({ participants: state.participants.filter(participant => participant.identity !== identity),
        ...(state.remoteScreenShare?.sharerIdentity === identity ? { remoteScreenShare: undefined } : {}) });
    },
    async end() { diagnostics.actions.push('fake-end'); },
    async adminEnd() { diagnostics.actions.push('fake-admin-end'); }
  };
  return { controller, api };
}

// Use the real signaling client with an in-memory socket, including its normal
// welcome/retry/close behavior. It never emits offers or connects any peers.
function fakeSignaling(meetingSlug: string, identity: string, events: P2pSignalingEvents) {
  return createP2pSignalingClient(meetingSlug, identity, events, {
    createWebSocket: () => {
      const socket: P2pWebSocket = {
        onmessage: null, onopen: null, onclose: null, onerror: null,
        send(data) {
          const message = JSON.parse(data) as { type: string };
          if (message.type === 'hello') queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({
            type: 'welcome', peers: initialParticipants.filter(participant => !participant.isLocal)
              .map(participant => ({ identity: participant.identity, nickname: participant.name })),
            screenSfu: null
          }) }));
        },
        close() { socket.onclose?.({ code: 1000 }); }
      };
      queueMicrotask(() => socket.onopen?.());
      return socket;
    }
  });
}
const fakeStats = () => createP2pStatsCollector({ slug, sessionId: 'isolated-qa', sendReport: async () => undefined });

function RoomScene({ scene }: { scene: Scene }) {
  const [fixture] = useState(() => createFixtureController(scene));
  useEffect(() => {
    if (scene !== 'settings' && scene !== 'host') return;
    // Open via the real navigation event, not by altering component state.
    const timer = window.setTimeout(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.meeting-topbar-actions button')];
      buttons[scene === 'host' ? 0 : 1]?.click();
      if (scene === 'host') window.setTimeout(() => {
        const management = document.querySelector<HTMLDetailsElement>('.meeting-management');
        if (management) management.open = true;
      }, 0);
    }, 50);
    return () => clearTimeout(timer);
  }, [scene]);
  return <LanguageProvider><AppShell><MeetingRoomPage
    slug={slug}
    meetingName={createdMeetingName}
    join={join}
    controller={fixture.controller}
    meetingApi={fixture.api}
    listDevices={listDevices}
    getDisplayMedia={noCapture}
    supportsOwnAudioRestriction={() => true}
    createSignalingClient={fakeSignaling}
    createStatsCollector={fakeStats}
    leaveMeeting={async () => { diagnostics.actions.push('fake-leave'); }}
    onLeft={() => selectScene('lobby')}
    onTerminal={() => selectScene('create')}
  /></AppShell></LanguageProvider>;
}

function Preview() {
  const [scene, setScene] = useState<Scene>(initialScene);
  useEffect(() => {
    const change = (event: Event) => {
      const next = (event as CustomEvent<Scene>).detail;
      diagnostics.scene = next;
      preferences.set('babagan.viewer-transport', 'sfu');
      setScene(next);
      const url = new URL(location.href);
      url.searchParams.set('scene', next);
      history.replaceState(null, '', url);
    };
    // Production brand / created-room anchors must remain in the QA entry.
    const keepLocal = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      const url = new URL(anchor.href, location.href);
      event.preventDefault();
      if (url.pathname === '/create') selectScene('create');
      else if (url.searchParams.get('scene') === 'lobby' || url.pathname.startsWith('/m/')) selectScene('lobby');
    };
    window.addEventListener('babagan-qa-scene', change);
    document.addEventListener('click', keepLocal);
    return () => {
      window.removeEventListener('babagan-qa-scene', change);
      document.removeEventListener('click', keepLocal);
    };
  }, []);
  return scene === 'create' || scene === 'lobby'
    ? <MemoryRouter key={scene} initialEntries={[scene === 'create' ? '/create' : `/m/${slug}`]}><App /></MemoryRouter>
    : <RoomScene key={scene} scene={scene} />;
}

const previewRoot = createRoot(document.getElementById('root')!);
previewRoot.render(<Preview />);
import.meta.hot?.dispose(() => previewRoot.unmount());
