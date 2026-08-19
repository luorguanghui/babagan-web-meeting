# WebRTC Path and Quality Recovery Design

## Problem

The hybrid screen-share implementation creates one P2P `RTCPeerConnection` per viewer while also keeping the LiveKit safety publication alive. The current release gives every direct viewer the full selected bitrate and then raises it by 1.5x. With two viewers at the default setting this can request 24 Mbps for P2P, in addition to the SFU simulcast encodes. Independent browser congestion controllers then compete on the same uplink, so one receiver can remain healthy while another starves.

The default capture profile is also 1080p60 with `maintain-framerate`. Under encoder or network pressure the browser is therefore allowed to preserve frame rate by reducing spatial resolution, which explains non-standard outputs such as 576x360. Finally, codec preference filtering removes RTX/RED/ULPFEC capabilities, path state is latched from an early ICE sample, and viewer ICE messages can be lost before ICE configuration becomes available.

## Goals

- Treat the selected P2P bitrate as a total upload budget and divide it fairly among active viewer sessions.
- Prefer stable 1080p text clarity over 60 fps for the default profile.
- Preserve browser retransmission and forward-error-correction codecs.
- Keep the displayed transport mode synchronized with the currently selected ICE pair.
- Recover from early or temporarily disconnected signaling without losing the viable direct candidates.
- Move only a persistently poor viewer to the already-published SFU safety path.
- Keep TURN usable as a legitimate P2P transport without assuming it improves a lossy last mile.

## Design

### Aggregate sender budget

`P2pShareController` owns the selected P2P upload budget. Every live session (negotiating, direct, or relay) receives an equal share of that budget, with a small floor only when the selected budget permits it. The controller rebalances after join, leave, establishment, path migration, retry, and fallback. There is no direct-path multiplier and an unknown path never receives speculative extra bitrate.

The LiveKit safety publication remains available for immediate per-viewer fallback, but P2P allocations no longer grow linearly as if the uplink were unlimited.

### Capture profiles

- Flow: 1280x720 at 30 fps, `maintain-resolution`.
- Standard (default): 1920x1080 at 30 fps, `maintain-resolution`.
- Motion: 1920x1080 at 60 fps, `maintain-resolution`, selected explicitly.

The sender may still adapt when the link cannot carry the profile, but the default priority prevents preserving 60 fps at the cost of an arbitrary low spatial resolution.

### Codec ordering

Codec selection is a stable ordering operation, not a filter. The preferred primary video codec is moved first; every remaining capability is retained in browser order, including RTX, RED, ULPFEC and implementation-specific auxiliary codecs. This lets the browser negotiate repair streams and feedback mechanisms on lossy links.

### ICE and signaling recovery

Viewer offers and candidates received before ICE configuration are queued in arrival order and flushed serially after configuration succeeds. The signaling client also keeps a bounded queue while its socket is temporarily unavailable and flushes it on reconnect.

When a reconnect must re-drive a still-negotiating sharer session, the old peer connection is replaced and a fresh offer/ICE generation is created. This avoids reusing incomplete trickle state. ICE credentials are refreshed before retry when possible.

### Dynamic path classification

Both viewer and sharer sample `transport.selectedCandidatePairId` (with nominated/selected fallback) throughout the session. A confirmed relay pair maps to `turn`; a confirmed non-relay pair maps to `p2p`; an unknown sample retains the prior state. Relay-to-direct and direct-to-relay migration therefore update both UI and policy.

### Persistent poor-quality fallback

Viewer health samples include packet counters and freezes in addition to byte/frame progress. A single transient loss spike does nothing. If a minimum packet population shows at least 15% interval loss, or freezes continue, for eight consecutive samples, that viewer switches to the SFU safety publication. Healthy viewers remain P2P. Complete stalls and failed/disconnected ICE retain the existing faster fallback rules.

## Verification

Unit tests cover aggregate budget invariants, auxiliary codec retention, path migration in both directions, ordered early ICE delivery, fresh ICE after reconnect, and sustained-loss hysteresis. Existing web/API tests, type checks, builds, and production smoke tests must all pass. Deployment updates only the existing web/API services, after checking there is no active meeting, and retains the existing LiveKit/coturn services.

