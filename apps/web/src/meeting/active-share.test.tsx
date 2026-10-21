import { describe, expect, it } from 'vitest';
import { resolveActiveSharer } from './active-share.js';
const base = { localIdentity: 'me', localName: '我', localSharing: false, peerViewing: true,
  participants: [{ identity: 'peer', name: '林悦' }], peers: [{ identity: 'signal-only', nickname: '周可' }] };
describe('active screen-share identity', () => {
  it('resolves P2P and TURN senders from the participant roster, not stale SFU metadata', () => {
    expect(resolveActiveSharer({ ...base, peerIdentity: 'peer', livekit: { sharerIdentity: 'old', sharerName: '旧成员' } })).toEqual({ identity: 'peer', name: '林悦' });
  });
  it('uses signaling nicknames before the audio roster arrives', () => {
    expect(resolveActiveSharer({ ...base, peerIdentity: 'signal-only' })).toEqual({ identity: 'signal-only', name: '周可' });
  });
  it('resolves local, Cloudflare and explicit LiveKit viewing', () => {
    expect(resolveActiveSharer({ ...base, localSharing: true }).name).toBe('我');
    expect(resolveActiveSharer({ ...base, cloudflare: { sharerIdentity: 'cf', sharerName: '陈晨' } }).name).toBe('陈晨');
    expect(resolveActiveSharer({ ...base, peerViewing: false, livekit: { sharerIdentity: 'sfu', sharerName: 'LiveKit 分享者' } }).name).toBe('LiveKit 分享者');
  });
  it('does not invent a sender name when the identity is unavailable', () => {
    expect(resolveActiveSharer(base)).toEqual({ identity: undefined, name: undefined });
  });
});
