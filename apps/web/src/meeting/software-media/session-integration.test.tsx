import { expect, it, vi } from 'vitest';
import { createP2pShareController } from '../p2p-share-controller.js';
import { emptyStats } from './encoder.js';
it('creates independent project media per viewer, emits no video RTP and closes each on stop', async () => {
  let nativeVideo = 0, stops = 0;
  const publishers: unknown[] = [];
  const controller = createP2pShareController({ slug: 'test',
    signaling: { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() },
    fetchIceServers: async () => [],
    createPeerConnection: () => ({ iceConnectionState: 'new', getStats: async () => new Map(),
      addTransceiver() { nativeVideo++; return {}; }, addTrack() { nativeVideo++; },
      createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }),
      setLocalDescription: async () => undefined, close() {} } as unknown as RTCPeerConnection),
    createProjectSender: () => {
      const publisher = { setBudget() {}, getStats: () => emptyStats(), async close() { stops++; } };
      publishers.push(publisher); return publisher;
    }
  });
  const stream = { getVideoTracks: () => [{ kind: 'video' }], getAudioTracks: () => [] } as unknown as MediaStream;
  await controller.start(stream, { codec: 'h264', frameRate: 60, maxBitrate: 8000000, degradationPreference: 'maintain-framerate', encodingEngine: 'project' },
    [1, 2, 3, 4].map(id => ({ identity: String(id), nickname: 'viewer' })));
  expect(publishers.length).toBe(4);
  expect(new Set(publishers).size).toBe(4);
  expect(nativeVideo).toBe(0);
  await controller.stop();
  expect(stops).toBe(4);
});

it('does not apply native RTP repair repeatedly to a healthy project connection', async () => {
  let polls: (() => Promise<void>) | undefined, budgetWrites = 0;
  const report = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: 'host' }], ['remote', { type: 'remote-candidate', candidateType: 'host' }]
  ]);
  const pc = { iceConnectionState: 'new', oniceconnectionstatechange: null as (() => void) | null,
    getStats: async () => report, createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }),
    setLocalDescription: async () => undefined, close() {} };
  const controller = createP2pShareController({ slug: 'test', signaling: { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() },
    fetchIceServers: async () => [], createPeerConnection: () => pc as unknown as RTCPeerConnection,
    scheduleTransportChecks: check => { polls = check; return () => {}; },
    createProjectSender: () => ({ setBudget() { budgetWrites++; }, getStats: () => emptyStats('vp8'), async close() {} })
  });
  await controller.start({ getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream,
    { codec: 'vp8', frameRate: 60, maxBitrate: 8000000, degradationPreference: 'maintain-framerate', encodingEngine: 'project' }, [{ identity: '1', nickname: 'viewer' }]);
  pc.iceConnectionState = 'connected'; pc.oniceconnectionstatechange?.(); controller.handleMediaReady('1');
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = budgetWrites;
  for (let index = 0; index < 3; index++) await polls?.();
  expect(budgetWrites).toBe(before);
  await controller.stop();
});

it('preserves a permanent project capability failure instead of silently retrying a blank share', async () => {
  let fail: ((message: string) => void) | undefined;
  const controller = createP2pShareController({ slug: 'test', signaling: { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() }, fetchIceServers: async () => [],
    createPeerConnection: () => ({ iceConnectionState: 'new', createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\n' }), setLocalDescription: async () => undefined, close() {} } as unknown as RTCPeerConnection),
    createProjectSender: settings => { fail = settings.onError; return { setBudget() {}, getStats: () => emptyStats(), async close() {} }; }
  });
  await controller.start({ getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream,
    { codec: 'h264', frameRate: 60, maxBitrate: 8000000, degradationPreference: 'maintain-framerate', encodingEngine: 'project' }, [{ identity: '1', nickname: 'viewer' }]);
  fail?.('Raw frame capture unavailable; choose compatibility encoding');
  expect(controller.getProjectMediaErrors?.().get('1')).toContain('compatibility');
  expect(controller.getViewerStates().get('1')).toBe('closed');
  await controller.stop();
});
