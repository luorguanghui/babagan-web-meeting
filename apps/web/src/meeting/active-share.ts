import type { MeetingParticipant } from './room-controller.js';

/** Resolve transport identities before their display names so stale SFU metadata
 * cannot label a new P2P share as the previous sender. */
export function resolveActiveSharer({ localIdentity, localName, localSharing, cloudflare, peerIdentity, livekit, peerViewing, participants, peers }: {
  localIdentity: string;
  localName: string;
  localSharing: boolean;
  cloudflare?: { sharerIdentity: string; sharerName: string } | null;
  peerIdentity?: string;
  livekit?: { sharerIdentity: string; sharerName: string };
  peerViewing: boolean;
  participants: ReadonlyArray<Pick<MeetingParticipant, 'identity' | 'name'>>;
  peers: ReadonlyArray<{ identity: string; nickname: string }>;
}): { identity?: string; name?: string } {
  if (localSharing) return { identity: localIdentity, name: localName };
  const source = cloudflare ?? (peerViewing ? undefined : livekit);
  const identity = source?.sharerIdentity ?? (peerViewing ? peerIdentity : undefined);
  const name = participants.find(person => person.identity === identity)?.name
    || peers.find(person => person.identity === identity)?.nickname
    || source?.sharerName;
  return { identity, name };
}
