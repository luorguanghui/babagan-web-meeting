import { Value } from '@sinclair/typebox/value';
import { expect, it } from 'vitest';
import { CloudflareSfuPublishRequestSchema, CloudflareSfuSessionResponseSchema, CloudflareSfuStatusResponseSchema } from './cloudflare-sfu.js';
it('bounds endpoint offers and local media declarations', () => {
  const offer = { sessionDescription: { type: 'offer', sdp: 'v=0\r\n' }, tracks: [{ kind: 'video', mid: '0' }] };
  expect(Value.Check(CloudflareSfuPublishRequestSchema, offer)).toBe(true);
  for (const invalid of [
    { ...offer, url: 'https://elsewhere.test' },
    { ...offer, sessionDescription: { type: 'answer', sdp: 'v=0' } },
    { ...offer, sessionDescription: { type: 'offer', sdp: 'x'.repeat(65537) } },
    { ...offer, tracks: [] },
    { ...offer, tracks: [...offer.tracks, ...offer.tracks, ...offer.tracks] },
    { ...offer, tracks: [{ kind: 'video', mid: '../foreign' }] }
  ]) expect(Value.Check(CloudflareSfuPublishRequestSchema, invalid)).toBe(false);
});
it('exposes only scoped publication metadata and session SDP, never secrets', () => {
  const publication = { shareId: 'share-one', sessionId: 'cf-session', sharerIdentity: 'member', sharerName: 'Ada', tracks: [{ kind: 'video', trackName: 'screen-video' }] };
  expect(Value.Check(CloudflareSfuStatusResponseSchema, { available: true, publication })).toBe(true);
  expect(Value.Check(CloudflareSfuStatusResponseSchema, { available: false, publication: null })).toBe(true);
  expect(Value.Check(CloudflareSfuStatusResponseSchema, { available: true, publication, appSecret: 'private' })).toBe(false);
  const session = { sessionId: 'cf-session', shareId: 'share-one', sessionDescription: { type: 'answer', sdp: 'v=0' }, tracks: [{ kind: 'video', mid: '0', trackName: 'screen-video' }] };
  expect(Value.Check(CloudflareSfuSessionResponseSchema, session)).toBe(true);
  expect(Value.Check(CloudflareSfuSessionResponseSchema, { ...session, appSecret: 'private' })).toBe(false);
});
