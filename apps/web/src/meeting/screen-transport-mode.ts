import type { ViewerSessionState } from './p2p-share-controller.js';
import type { ViewerP2pState } from './p2p-viewer-controller.js';
import type { P2pTurnProvider } from '@meeting/contracts';

export type ScreenTransportMode = 'negotiating' | 'p2p' | 'turn' | 'sfu' | 'mixed' | 'waiting';
export type ScreenTurnProvider = P2pTurnProvider | 'mixed';

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

export function deriveViewerTurnProvider(
  state: ViewerP2pState,
  provider?: P2pTurnProvider
): P2pTurnProvider | undefined {
  return state === 'turn' ? provider : undefined;
}

export function deriveSharerTurnProvider(
  states: ReadonlyMap<string, ViewerSessionState>,
  providers: ReadonlyMap<string, P2pTurnProvider>
): ScreenTurnProvider | undefined {
  const turnProviders = new Set<P2pTurnProvider>();
  for (const [identity, state] of states) {
    if (state === 'turn') {
      const provider = providers.get(identity);
      if (provider !== undefined) turnProviders.add(provider);
    }
  }
  if (turnProviders.size === 0) return undefined;
  if (turnProviders.size === 1) return [...turnProviders][0];
  return 'mixed';
}
