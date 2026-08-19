import type { ViewerSessionState } from './p2p-share-controller.js';
import type { ViewerP2pState } from './p2p-viewer-controller.js';

export type ScreenTransportMode = 'negotiating' | 'p2p' | 'turn' | 'sfu' | 'mixed' | 'waiting';

export function deriveViewerScreenTransportMode(state: ViewerP2pState): ScreenTransportMode {
  if (state === 'negotiating') return 'negotiating';
  if (state === 'p2p' || state === 'turn') return state;
  return 'sfu';
}

export function deriveSharerScreenTransportMode(
  states: ReadonlyMap<string, ViewerSessionState>
): ScreenTransportMode {
  const modes = new Set<ScreenTransportMode>();
  for (const state of states.values()) {
    if (state === 'closed') continue;
    if (state === 'livekit-fallback') modes.add('sfu');
    else modes.add(state);
  }
  if (modes.size === 0) return 'waiting';
  if (modes.size === 1) return [...modes][0];
  return 'mixed';
}
