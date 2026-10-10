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
