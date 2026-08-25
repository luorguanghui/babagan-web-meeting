import {
  RefreshParticipantTokenResponseSchema,
  type P2pTurnProvider,
  type JoinMeetingResponse,
  type ParticipantSummary,
  type RefreshParticipantTokenResponse,
  type ScreenShareCodec,
  type ScreenShareQuality
} from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MonitorUp } from 'lucide-react';

import { apiNoContent, apiRequest } from '../api/client.js';
import { AdminEndMeetingForm } from '../components/admin-end-meeting-form.js';
import { HostMenu } from '../components/host-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { MeetingControls, MeetingSettings, type MeetingControlsProps } from '../components/meeting-controls.js';
import { MeetingDrawer, type MeetingPanel } from '../components/meeting-drawer.js';
import { MeetingMenu, type MeetingMenuAction } from '../components/meeting-menu.js';
import { MeetingTopBar } from '../components/meeting-top-bar.js';
import { ParticipantList } from '../components/participant-list.js';
import { ScreenStage } from '../components/screen-stage.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { type MessageKey, type Translate, useI18n } from '../i18n/i18n.js';
import { createP2pSignalingClient, type Peer, type P2pSignalingClient, type P2pSignalingEvents } from '../meeting/p2p-signaling.js';
import {
  createP2pShareController,
  IceServersResponseSchema,
  type P2pShareController,
  type ViewerSessionState
} from '../meeting/p2p-share-controller.js';
import { P2pViewerController, type ViewerP2pState } from '../meeting/p2p-viewer-controller.js';
import { iceConfigurationExpiresSoon, type P2pIceServerConfiguration } from '../meeting/p2p-ice.js';
import { createRoomController, type MeetingRoomController } from '../meeting/room-controller.js';
import {
  createScreenShareController,
  HybridScreenSharePublisher,
  recommendP2pBitrate,
  screenShareDefaultBitrate,
  screenShareDefaultQuality,
  type ScreenShareBitrate,
  type ScreenShareState,
  type UnrestrictedSystemAudioChoice
} from '../meeting/screen-share.js';
import { createP2pStatsCollector, type P2pStatsCollector } from '../meeting/p2p-stats.js';
import {
  deriveSharerScreenTransportMode,
  deriveSharerTurnProvider,
  deriveViewerTurnProvider,
  deriveViewerScreenTransportMode,
  type ScreenTransportMode,
  type ScreenTurnProvider
} from '../meeting/screen-transport-mode.js';
import { useMeetingRoom } from '../meeting/use-meeting-room.js';
import { summarizeWebRtcStats, type WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';
import {
  readViewerTransportPreference,
  saveViewerTransportPreference,
  viewerTransportPreferenceToIcePolicy,
  type ViewerTransportPreference
} from '../meeting/viewer-transport-preference.js';

export interface MeetingRoomPageProps {
  slug: string;
  meetingName?: string;
  join: JoinMeetingResponse;
  controller?: MeetingRoomController;
  controllerFactory?: () => MeetingRoomController;
  leaveMeeting?: (slug: string) => Promise<void>;
  listDevices?: () => Promise<MediaDeviceInfo[]>;
  meetingApi?: MeetingRoomApi;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  supportsOwnAudioRestriction?: () => boolean;
  /** Test seam: signaling client factory, defaults to `createP2pSignalingClient`. */
  createSignalingClient?: (slug: string, identity: string, events: P2pSignalingEvents) => P2pSignalingClient;
  /** Test seam: sharer-side P2P controller factory, defaults to `createP2pShareController`. */
  shareControllerFactory?: (deps: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }) => P2pShareController;
  /** Test seam: anonymous quality-stats collector factory, defaults to `createP2pStatsCollector({ slug })`. */
  createStatsCollector?: () => P2pStatsCollector;
  onLeft?: () => void;
  onTerminal?: (reason: 'ended' | 'expired' | 'rejoin-required') => void;
}

export interface MeetingRoomApi {
  authorizeHost(slug: string): Promise<void>;
  verifyParticipantShare(slug: string): Promise<void>;
  grantShare(slug: string, identity: string): Promise<void>;
  releaseOwnShare(slug: string): Promise<void>;
  revokeShare(slug: string): Promise<void>;
  kick(slug: string, identity: string): Promise<void>;
  end(slug: string): Promise<void>;
  adminEnd?(slug: string, adminPassword: string): Promise<void>;
}

type HostAuthorizationState = 'unknown' | 'authorized' | 'unauthorized';
const transportModeKeys: Record<ScreenTransportMode, MessageKey> = {
  p2p: 'screenTransport.p2p', turn: 'screenTransport.turn', sfu: 'screenTransport.sfu', mixed: 'screenTransport.mixed',
  negotiating: 'screenTransport.negotiating', waiting: 'screenTransport.waiting'
};
const turnProviderKeys: Record<ScreenTurnProvider, MessageKey> = {
  cloudflare: 'screenTransport.turnCloudflare',
  coturn: 'screenTransport.turnCoturn',
  mixed: 'screenTransport.turnMixed'
};

async function defaultLeaveMeeting(slug: string): Promise<void> {
  const response = await fetch(`/api/v1/meetings/${encodeURIComponent(slug)}/leave`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('The meeting could not be left cleanly.');
}

async function defaultListDevices(): Promise<MediaDeviceInfo[]> {
  return navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : [];
}

const defaultMeetingApi: MeetingRoomApi = {
  authorizeHost: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/host-session`, 'GET'),
  async verifyParticipantShare(slug) {
    const response = await apiRequest<RefreshParticipantTokenResponse>(
      `/meetings/${encodeURIComponent(slug)}/token`,
      RefreshParticipantTokenResponseSchema,
      { method: 'POST' }
    );
    if (!response.permissions.canShareScreen) throw new Error('Screen sharing is not authorized.');
  },
  grantShare: (slug, identity) => noContent(
    `/meetings/${encodeURIComponent(slug)}/share-grant`,
    'PUT',
    { participantIdentity: identity }
  ),
  releaseOwnShare: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/share`, 'DELETE'),
  revokeShare: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/share-grant`, 'DELETE'),
  kick: (slug, identity) => noContent(
    `/meetings/${encodeURIComponent(slug)}/kick`,
    'POST',
    { participantIdentity: identity }
  ),
  end: (slug) => noContent(
    `/meetings/${encodeURIComponent(slug)}/end`,
    'POST',
    undefined,
    requestTimeoutSignal()
  ),
  adminEnd: (slug, adminPassword) => apiNoContent(
    `/meetings/${encodeURIComponent(slug)}/admin-end`,
    { method: 'POST', body: JSON.stringify({ adminPassword }), signal: requestTimeoutSignal() }
  )
};

/** Host actions must surface a clear error instead of hanging forever on a slow server. */
const HOST_ACTION_TIMEOUT_MS = 15_000;

function requestTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(HOST_ACTION_TIMEOUT_MS)
    : undefined;
}

async function noContent(
  path: string,
  method: string,
  body?: object,
  signal?: AbortSignal
): Promise<void> {
  await apiNoContent(path, {
    method,
    ...(signal ? { signal } : {}),
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

export function MeetingRoomPage({
  slug,
  meetingName,
  join,
  controller: providedController,
  controllerFactory = createRoomController,
  leaveMeeting = defaultLeaveMeeting,
  listDevices = defaultListDevices,
  meetingApi = defaultMeetingApi,
  getDisplayMedia,
  supportsOwnAudioRestriction,
  createSignalingClient,
  shareControllerFactory,
  createStatsCollector,
  onLeft,
  onTerminal
}: MeetingRoomPageProps) {
  const { t } = useI18n();
  const [controller] = useState(() => providedController ?? controllerFactory());
  const [p2pStats] = useState(() => (createStatsCollector ?? (() => createP2pStatsCollector({ slug })))());
  const refresh = useCallback(() => apiRequest<RefreshParticipantTokenResponse>(
    `/meetings/${encodeURIComponent(slug)}/token`,
    RefreshParticipantTokenResponseSchema,
    { method: 'POST' }
  ), [slug]);
  const { state, error: connectionError, reconnectState, reconnectRateLimited } = useMeetingRoom(join, controller, refresh);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [callAudioVolume, setCallAudioVolume] = useState(100);
  const [sharedAudioVolume, setSharedAudioVolume] = useState(100);
  const [meetingPanel, setMeetingPanel] = useState<MeetingPanel>(null);
  const [meetingPanelParent, setMeetingPanelParent] = useState<'more' | null>(null);
  const participantButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState<string>();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [leaving, setLeaving] = useState(false);
  const [hostAuthorized, setHostAuthorized] = useState(false);
  const [hostAuthorization, setHostAuthorization] = useState<HostAuthorizationState>('unknown');
  const hostAuthorizedRef = useRef(false);
  const [screenCodec, setScreenCodec] = useState<ScreenShareCodec>('h264');
  const [screenBitrate, setScreenBitrate] = useState<ScreenShareBitrate>(screenShareDefaultBitrate);
  const screenBitrateTouchedRef = useRef(false);
  const [screenQuality, setScreenQuality] = useState<ScreenShareQuality>(screenShareDefaultQuality);
  const [screenState, setScreenState] = useState<ScreenShareState>({ status: 'idle' });
  const screenShareRef = useRef<ReturnType<typeof createScreenShareController> | undefined>(undefined);
  const [viewerCount, setViewerCount] = useState(0);
  const [viewerTransportPreference, setViewerTransportPreference] = useState<ViewerTransportPreference>(() =>
    readViewerTransportPreference()
  );
  const viewerTransportPreferenceRef = useRef(viewerTransportPreference);
  const viewerSharerIdentityRef = useRef<string | undefined>(undefined);
  const signalingRef = useRef<P2pSignalingClient | undefined>(undefined);
  const viewerRosterRef = useRef<Peer[]>([]);
  const p2pShareRef = useRef<P2pShareController | undefined>(undefined);
  const p2pShareUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const [shareViewerStates, setShareViewerStates] = useState<ReadonlyMap<string, ViewerSessionState>>(() => new Map());
  const [shareViewerTurnProviders, setShareViewerTurnProviders] = useState<ReadonlyMap<string, P2pTurnProvider>>(() => new Map());
  const hybridShareRef = useRef<HybridScreenSharePublisher | undefined>(undefined);
  const sfuStreamRef = useRef<MediaStream | undefined>(undefined);
  const [screenStats, setScreenStats] = useState<WebRtcStatsSnapshot>();
  const [systemAudioDecision, setSystemAudioDecision] = useState<{ displaySurface: string }>();
  const systemAudioDecisionResolver = useRef<((choice: UnrestrictedSystemAudioChoice) => void) | undefined>(undefined);
  const authorizeHost = useCallback(() => meetingApi.authorizeHost(slug), [meetingApi, slug]);
  const authorizationChanged = useCallback((authorized: boolean) => {
    hostAuthorizedRef.current = authorized;
    setHostAuthorized(authorized);
    setHostAuthorization(authorized ? 'authorized' : 'unauthorized');
  }, []);
  useEffect(() => {
    let active = true;
    setHostAuthorization('unknown');
    void authorizeHost().then(
      () => { if (active) authorizationChanged(true); },
      () => { if (active) authorizationChanged(false); }
    );
    return () => { active = false; };
  }, [authorizationChanged, authorizeHost]);
  const chooseUnrestrictedSystemAudio = useCallback((context: { displaySurface: string }) => new Promise<UnrestrictedSystemAudioChoice>((resolve) => {
    systemAudioDecisionResolver.current = resolve;
    setSystemAudioDecision(context);
  }), []);
  const resolveSystemAudioDecision = useCallback((choice: UnrestrictedSystemAudioChoice) => {
    const resolve = systemAudioDecisionResolver.current;
    systemAudioDecisionResolver.current = undefined;
    setSystemAudioDecision(undefined);
    resolve?.(choice);
  }, []);
  const createShareController = useCallback((deps: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }): P2pShareController => {
    let share: P2pShareController;
    if (shareControllerFactory) {
      share = shareControllerFactory(deps);
    } else {
      const signaling = signalingRef.current;
      if (!signaling) throw new Error('P2P signaling is not connected.');
      share = createP2pShareController({ slug, signaling, ...deps });
    }
    p2pShareUnsubscribeRef.current?.();
    p2pShareUnsubscribeRef.current = share.subscribe((states) => {
      setShareViewerStates(new Map(states));
      setShareViewerTurnProviders(new Map(share.getViewerTurnProviders?.() ?? []));
      p2pStats.observeShareStates(states);
    });
    return share;
  }, [p2pStats, shareControllerFactory, slug]);
  const screenShare = useMemo(() => createScreenShareController({
    requestGrant: () => hostAuthorizedRef.current
      ? meetingApi.grantShare(slug, join.participantIdentity)
      : meetingApi.verifyParticipantShare(slug),
    releaseGrant: () => meetingApi.releaseOwnShare(slug),
    ...(getDisplayMedia ? { getDisplayMedia } : {}),
    ...(supportsOwnAudioRestriction ? { supportsOwnAudioRestriction } : {}),
    chooseUnrestrictedSystemAudio,
    publisher: {
      publish: async (stream, options) => {
        const hybrid = new HybridScreenSharePublisher({
          sfuPublisher: {
            // LiveKit stops tracks on unpublish; publish clones so cancelling
            // the fallback track mid-share can never end the P2P source.
            publish: async (s, o) => {
              const cloned = cloneShareStream(s);
              sfuStreamRef.current = cloned;
              await controller.publishScreenShare(cloned, o);
            },
            release: async () => {
              const cloned = sfuStreamRef.current;
              sfuStreamRef.current = undefined;
              if (cloned) await controller.releaseScreenShare(cloned);
            }
          },
          getViewers: () => viewerRosterRef.current,
          createShareController,
          onControllerCreated: (share) => { p2pShareRef.current = share; }
        });
        hybridShareRef.current = hybrid;
        await hybrid.publish(stream, options);
      },
      release: async (stream) => {
        const hybrid = hybridShareRef.current;
        hybridShareRef.current = undefined;
        p2pShareUnsubscribeRef.current?.();
        p2pShareUnsubscribeRef.current = undefined;
        setShareViewerStates(new Map());
        setShareViewerTurnProviders(new Map());
        p2pShareRef.current = undefined;
        if (hybrid) await hybrid.release(stream);
      }
    }
  }), [chooseUnrestrictedSystemAudio, controller, createShareController, getDisplayMedia, join.participantIdentity, meetingApi, slug, supportsOwnAudioRestriction]);

  useEffect(() => { screenShareRef.current = screenShare; }, [screenShare]);
  // Bitrate guidance: while idle and the user has not chosen manually, the
  // P2P bitrate follows the current online viewer count (1–3 → 8 Mbps, 4+ → 5).
  useEffect(() => {
    if (screenBitrateTouchedRef.current) return;
    if (screenState.status !== 'idle') return;
    setScreenBitrate(recommendP2pBitrate(viewerCount));
  }, [screenState.status, viewerCount]);
  useEffect(() => {
    // After a share ends the suggestion is re-applied for the next share.
    if (screenState.status === 'idle') screenBitrateTouchedRef.current = false;
  }, [screenState.status]);

  const [viewerP2pState, setViewerP2pState] = useState<ViewerP2pState>('idle');
  const [viewerTurnProvider, setViewerTurnProvider] = useState<P2pTurnProvider>();
  const viewerP2pRef = useRef<P2pViewerController | undefined>(undefined);
  const pendingFallbackCompletionRef = useRef<(() => void) | undefined>(undefined);
  const [fallbackP2pStream, setFallbackP2pStream] = useState<MediaStream>();

  useEffect(() => {
    let cancelled = false;
    let iceConfiguration: P2pIceServerConfiguration | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let iceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    type ViewerSignal =
      | { type: 'offer'; from: string; sdp: string; generation?: string }
      | { type: 'ice'; from: string; candidate: string | null; generation?: string };
    /** Viewer signaling received while ICE credentials are in flight. */
    const pendingViewerSignals: ViewerSignal[] = [];
    let viewerSignalTail = Promise.resolve();
    let iceServersFetch: Promise<P2pIceServerConfiguration> | undefined;
    const fetchIceServersOnce = (): Promise<P2pIceServerConfiguration> => {
      if (iceServersFetch === undefined) {
        iceServersFetch = apiRequest<P2pIceServerConfiguration>(
          `/meetings/${encodeURIComponent(slug)}/ice-servers`,
          IceServersResponseSchema
        ).then((response) => ({
          iceServers: response.iceServers,
          turnProvider: response.turnProvider ?? 'coturn',
          turnCredentialsExpiresAt: response.turnCredentialsExpiresAt
        })).finally(() => {
          iceServersFetch = undefined;
        });
      }
      return iceServersFetch;
    };
    const refreshViewerIceServers = (): void => {
      void fetchIceServersOnce().then((fresh) => {
        if (cancelled) return;
        iceConfiguration = fresh;
        viewerP2pRef.current?.updateIceServers(fresh.iceServers, fresh.turnProvider);
        scheduleIceRefresh(fresh);
      }).catch(() => {
        if (cancelled) return;
        iceRefreshTimer = setTimeout(() => {
          iceRefreshTimer = undefined;
          refreshViewerIceServers();
        }, 2_000);
      });
    };
    const scheduleIceRefresh = (configuration: P2pIceServerConfiguration): void => {
      if (iceRefreshTimer !== undefined) clearTimeout(iceRefreshTimer);
      iceRefreshTimer = undefined;
      if (configuration.turnCredentialsExpiresAt === undefined) return;
      const delay = Math.max(1_000, (configuration.turnCredentialsExpiresAt - Date.now() / 1_000 - 60) * 1_000);
      iceRefreshTimer = setTimeout(() => {
        iceRefreshTimer = undefined;
        refreshViewerIceServers();
      }, delay);
    };
    const ensureController = (): P2pViewerController | undefined => {
      if (iceConfiguration === undefined) return undefined;
      if (viewerP2pRef.current === undefined) {
        const viewerController = new P2pViewerController(signaling, iceConfiguration.iceServers, {
          iceTransportPolicy: viewerTransportPreferenceToIcePolicy(viewerTransportPreferenceRef.current),
          turnProvider: iceConfiguration.turnProvider,
          onFallbackRequested: (complete) => {
            pendingFallbackCompletionRef.current = complete;
            setFallbackP2pStream(viewerP2pRef.current?.getStream() ?? undefined);
            // Keep the P2P PC alive until ScreenStage confirms that the
            // re-subscribed LiveKit source has rendered its first frame.
            void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
          }
        });
        viewerP2pRef.current = viewerController;
        viewerController.subscribe((state) => {
          if (!cancelled) {
            setViewerP2pState(state);
            setViewerTurnProvider(viewerController.getTurnProvider());
          }
          p2pStats.observeViewerState(state);
        });
      }
      return viewerP2pRef.current;
    };
    const dispatchViewerSignal = (signal: ViewerSignal): void => {
      if (cancelled) return;
      viewerSignalTail = viewerSignalTail.then(async () => {
        if (cancelled) return;
        if (signal.type === 'offer' && viewerTransportPreferenceRef.current === 'sfu') return;
        if (signal.type === 'offer') {
          viewerSharerIdentityRef.current = signal.from;
          // A fresh offer may arrive long after page load. Refresh ICE
          // credentials when the cached TURN ones are about to expire:
          // gathering with expired credentials silently yields no relay
          // candidates, which strands asymmetric NAT pairs on the SFU even
          // though the sharer's fresh session could relay. A refresh failure
          // keeps the cached servers; the sharer's automatic re-drive covers
          // a failed negotiation.
          if (iceConfiguration !== undefined && iceConfigurationExpiresSoon(iceConfiguration)) {
            try {
              const fresh = await fetchIceServersOnce();
              if (!cancelled) {
                iceConfiguration = fresh;
                viewerP2pRef.current?.updateIceServers(fresh.iceServers, fresh.turnProvider);
                scheduleIceRefresh(fresh);
              }
            } catch {
              // Keep the cached (possibly stale) servers for this attempt.
            }
          }
          if (cancelled) return;
        }
        if (iceConfiguration === undefined) {
          pendingViewerSignals.push(signal);
          return;
        }
        const viewerController = ensureController();
        if (viewerController === undefined) return;
        if (signal.type === 'offer') {
          await viewerController.acceptOffer(signal.from, signal.sdp, signal.generation);
        } else {
          await viewerController.handleIce(signal.from, signal.candidate, signal.generation);
        }
      }).catch(() => undefined);
    };
    // The credentials fetch gates P2P acceptance: without ICE servers the
    // viewer can never complete a peer connection and would silently drop
    // offers. Fetch with a bounded retry instead of once at page load — a
    // single transient failure must not permanently disable P2P for this
    // viewer, which is exactly what made "when I share, the others cannot
    // P2P" while their own shares worked (the sharer fetches credentials
    // fresh at share time).
    const fetchIceServersWithRetry = (): void => {
      void fetchIceServersOnce().then((configuration) => {
        if (cancelled) return;
        iceConfiguration = configuration;
        viewerP2pRef.current?.updateIceServers(configuration.iceServers, configuration.turnProvider);
        scheduleIceRefresh(configuration);
        ensureController();
        const queued = pendingViewerSignals.splice(0);
        for (const signal of queued) dispatchViewerSignal(signal);
      }).catch(() => {
        if (cancelled) return;
        retryTimer = setTimeout(fetchIceServersWithRetry, 2_000);
      });
    };
    fetchIceServersWithRetry();
    const signaling = (createSignalingClient ?? createP2pSignalingClient)(slug, join.participantIdentity, {
      onOffer: (from, sdp, generation) => {
        dispatchViewerSignal({ type: 'offer', from, sdp, generation });
      },
      // While we are the sharer, answers/ice/bye belong to the share session.
      onAnswer: (from, sdp, generation) => { void p2pShareRef.current?.handleAnswer(from, sdp, generation); },
      onIce: (from, candidate, generation) => {
        const share = p2pShareRef.current;
        if (share) {
          void share.handleIce(from, candidate, generation);
          return;
        }
        dispatchViewerSignal({ type: 'ice', from, candidate, generation });
      },
      onMediaReady: (from, generation) => {
        p2pShareRef.current?.handleMediaReady(from, generation);
      },
      onRetry: (from) => {
        // While we are the sharer, a retry request belongs to the share
        // session; as a viewer the request would be our own button's echo
        // (which the server forwards only to the sharer anyway).
        p2pShareRef.current?.handleRetry(from);
      },
      onBye: (from, reason) => {
        const share = p2pShareRef.current;
        if (share) {
          hybridShareRef.current?.handleViewerBye(from, reason);
          return;
        }
        viewerP2pRef.current?.close();
        viewerP2pRef.current = undefined;
        setViewerTurnProvider(undefined);
        pendingFallbackCompletionRef.current = undefined;
        setFallbackP2pStream(undefined);
        void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
      },
      onShareGone: () => {
        viewerSharerIdentityRef.current = undefined;
        viewerP2pRef.current?.close();
        viewerP2pRef.current = undefined;
        setViewerTurnProvider(undefined);
        pendingFallbackCompletionRef.current = undefined;
        setFallbackP2pStream(undefined);
        void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
        // The host revoked (or the server ended) our share: tear it down fully.
        if (screenShareRef.current?.getState().status !== 'idle') {
          void screenShareRef.current?.stop();
        }
      },
      onWelcome: (peers) => {
        const previous = viewerRosterRef.current;
        viewerRosterRef.current = peers;
        setViewerCount(peers.length);
        // A welcome replaces the roster wholesale; identities missing from the
        // fresh list are no longer in the room (server restart / disconnect
        // window). Prune their share sessions and, if the P2P sharer vanished,
        // the viewer session too — no ghost P2P sessions, no SFU published for
        // viewers that are gone.
        for (const gone of previous) {
          if (!peers.some((peer) => peer.identity === gone.identity)) {
            hybridShareRef.current?.viewerLeft(gone.identity);
            if (viewerP2pRef.current?.getSharerIdentity() === gone.identity) {
              viewerSharerIdentityRef.current = undefined;
              viewerP2pRef.current?.close();
              viewerP2pRef.current = undefined;
              setViewerTurnProvider(undefined);
              pendingFallbackCompletionRef.current = undefined;
              setFallbackP2pStream(undefined);
              void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
            }
          }
        }
        hybridShareRef.current?.viewerRosterChanged(true);
      },
      onPeerJoined: (peer) => {
        const roster = viewerRosterRef.current;
        if (!roster.some((existing) => existing.identity === peer.identity)) {
          viewerRosterRef.current = [...roster, peer];
          setViewerCount(roster.length + 1);
        }
        hybridShareRef.current?.viewerRosterChanged();
      },
      onPeerLeft: ({ identity }) => {
        viewerRosterRef.current = viewerRosterRef.current.filter((peer) => peer.identity !== identity);
        setViewerCount(viewerRosterRef.current.length);
        hybridShareRef.current?.viewerLeft(identity);
        // The P2P sharer left: the session is dead — tear it down so the
        // LiveKit screen track takes over instead of freezing on a dead stream.
        if (viewerP2pRef.current?.getSharerIdentity() === identity) {
          viewerSharerIdentityRef.current = undefined;
          viewerP2pRef.current?.close();
          viewerP2pRef.current = undefined;
          setViewerTurnProvider(undefined);
          pendingFallbackCompletionRef.current = undefined;
          setFallbackP2pStream(undefined);
          void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
        }
      },
      onError: () => undefined
    });
    signalingRef.current = signaling;
    // Connect the signaling channel immediately, in parallel with the
    // credentials fetch: being in the sharer's roster early matters more than
    // waiting for the fetch, and offers are queued until credentials arrive.
    void signaling.connect().catch(() => undefined);
    return () => {
      cancelled = true;
      pendingViewerSignals.length = 0;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (iceRefreshTimer !== undefined) clearTimeout(iceRefreshTimer);
      signalingRef.current = undefined;
      viewerSharerIdentityRef.current = undefined;
      pendingFallbackCompletionRef.current?.();
      pendingFallbackCompletionRef.current = undefined;
      viewerP2pRef.current?.close();
      viewerP2pRef.current = undefined;
      setViewerTurnProvider(undefined);
      p2pShareUnsubscribeRef.current?.();
      p2pShareUnsubscribeRef.current = undefined;
      signaling.close();
    };
  }, [controller, createSignalingClient, join.participantIdentity, p2pStats, slug]);

  useEffect(() => {
    if (viewerP2pState === 'p2p' || viewerP2pState === 'turn') return;
    // A renegotiation may replace an established P2P session. Restore the
    // safety net while it negotiates so the stage never drops to an empty source.
    if (viewerP2pState === 'negotiating') {
      void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
    }
  }, [controller, viewerP2pState]);

  useEffect(() => { void listDevices().then(setDevices).catch(() => setNotice(t('room.devicesFailed'))); }, [listDevices, t]);
  useEffect(() => {
    const unsubscribe = screenShare.subscribe(setScreenState);
    return () => {
      unsubscribe();
      void screenShare.stop();
    };
  }, [screenShare]);
  useEffect(() => () => {
    systemAudioDecisionResolver.current?.('cancel');
    systemAudioDecisionResolver.current = undefined;
  }, []);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => {
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
    };
  }, []);
  useEffect(() => {
    if (reconnectState.kind === 'terminal') onTerminal?.(reconnectState.reason);
    if (reconnectState.kind === 'rejoin-required') onTerminal?.('rejoin-required');
  }, [onTerminal, reconnectState]);

  async function leave() {
    setLeaving(true);
    try {
      await leaveMeeting(slug);
    } catch {
      setNotice(t('room.leaveUnconfirmed'));
    } finally {
      await controller.disconnect();
      setLeaving(false);
      onLeft?.();
    }
  }

  async function changeSpeaker(deviceId: string) {
    const result = await controller.switchAudioOutput(deviceId);
    setNotice(result === 'unsupported' ? t('room.speakerUnsupported') : undefined);
  }

  async function toggleScreenShare() {
    setNotice(undefined);
    try {
      if (screenState.status === 'sharing') await screenShare.stop();
      else await screenShare.start(screenCodec, screenBitrate, screenQuality);
    } catch {
      setNotice(t('room.shareFailed'));
    }
  }

  const handleViewerTransportPreferenceChange = useCallback((preference: ViewerTransportPreference) => {
    viewerTransportPreferenceRef.current = preference;
    setViewerTransportPreference(preference);
    try {
      saveViewerTransportPreference(window.localStorage, preference);
    } catch {
      // Keep the in-session selection when browser storage is unavailable.
    }

    const viewerController = viewerP2pRef.current;
    if (preference === 'sfu') {
      if (viewerController) viewerController.requestSfu();
      else void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
      return;
    }

    viewerController?.setIceTransportPolicy(viewerTransportPreferenceToIcePolicy(preference));
    if (viewerController) viewerController.requestRetry();
    else if (viewerSharerIdentityRef.current) {
      signalingRef.current?.sendRetry(viewerSharerIdentityRef.current);
    }
  }, [controller]);

  const hostParticipants: ParticipantSummary[] = state.participants.map((participant) => ({
    identity: participant.identity,
    name: participant.name,
    isSharing: participant.isSharing
  }));
  // P2P first: the remote P2P stream renders while the viewer state is `p2p`;
  // during `negotiating` and on `livekit` the stage falls back to the LiveKit
  // screen track (the hybrid controller switches sources with first-frame
  // retention, so no black screen while the swap is in flight).
  const livekitViewerTrack = state.remoteScreenShare?.track;
  const p2pViewerStream = viewerP2pState === 'p2p' || viewerP2pState === 'turn'
    ? viewerP2pRef.current?.getStream() ?? undefined
    : viewerP2pState === 'livekit' && livekitViewerTrack === undefined
      ? fallbackP2pStream
      : undefined;
  const stageStream = screenState.stream ?? p2pViewerStream;
  const stageTrack = stageStream ? undefined : state.remoteScreenShare?.track;
  const stageAudioTrack = stageStream ? undefined : state.remoteScreenShare?.audioTrack;
  const stageMuted = Boolean(screenState.stream) || (p2pViewerStream === undefined && stageAudioTrack === undefined);
  const hasActiveScreenShare = Boolean(stageStream || stageTrack);
  const screenTransportMode = screenState.stream
    ? deriveSharerScreenTransportMode(shareViewerStates)
    : deriveViewerScreenTransportMode(viewerP2pState);
  const screenTurnProvider = screenState.stream
    ? deriveSharerTurnProvider(shareViewerStates, shareViewerTurnProviders)
    : deriveViewerTurnProvider(viewerP2pState, viewerTurnProvider);
  const screenTransportLabel = hasActiveScreenShare && screenTransportMode === 'turn' && screenTurnProvider
    ? t(turnProviderKeys[screenTurnProvider])
    : hasActiveScreenShare
      ? t(transportModeKeys[screenTransportMode])
      : t('connection.connected');
  const sharerName = screenState.stream
    ? join.participantName
    : state.remoteScreenShare?.sharerName;
  const handleStageSourceReady = useCallback(() => {
    if (screenState.stream) return;
    if ((viewerP2pState === 'p2p' || viewerP2pState === 'turn') && p2pViewerStream) {
      void controller.setRemoteScreenShareSubscribed(false).catch(() => undefined);
      return;
    }
    if (viewerP2pState === 'livekit' && livekitViewerTrack) {
      const complete = pendingFallbackCompletionRef.current;
      pendingFallbackCompletionRef.current = undefined;
      setFallbackP2pStream(undefined);
      complete?.();
    }
  }, [controller, livekitViewerTrack, p2pViewerStream, screenState.stream, viewerP2pState]);

  useEffect(() => {
    if (!hasActiveScreenShare) {
      setScreenStats(undefined);
      return;
    }
    let cancelled = false;
    let previous: WebRtcStatsSnapshot | undefined;
    const activeReports = async (): Promise<RTCStatsReport[]> => {
      if (screenState.status === 'sharing') {
        const reports = await p2pShareRef.current?.getStatsReports();
        if (reports && reports.length > 0) return reports;
      } else if (viewerP2pState === 'negotiating'
        || viewerP2pState === 'p2p'
        || viewerP2pState === 'turn') {
        const report = await viewerP2pRef.current?.getStatsReport();
        if (report) return [report];
      }
      return controller.getScreenShareStatsReports
        ? controller.getScreenShareStatsReports()
        : [];
    };
    const sample = async () => {
      try {
        const reports = await activeReports();
        if (cancelled) return;
        previous = summarizeWebRtcStats(reports, previous);
        setScreenStats(previous);
        p2pStats.observeQuality(previous);
      } catch {
        // Statistics are diagnostic only and must never interrupt the meeting.
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [controller, hasActiveScreenShare, screenState.status, viewerP2pState]);

  const meetingControlsProps: MeetingControlsProps = {
    connection: state.connection,
    microphoneEnabled: state.microphoneEnabled,
    audioPlaybackBlocked: state.audioPlaybackBlocked,
    callAudioVolume,
    sharedAudioVolume,
    sharedAudioVolumeVisible: Boolean(!screenState.stream && hasActiveScreenShare),
    devices,
    leaving,
    screenShareAuthorized: hostAuthorized || Boolean(state.screenShareAuthorized),
    screenShareActive: screenState.status === 'sharing',
    screenShareBusy: screenState.status === 'starting',
    screenCodec,
    screenBitrate,
    screenQuality,
    onMicrophoneToggle: () => void controller.setMicrophoneEnabled(!state.microphoneEnabled),
    onMicrophoneDeviceChange: (deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId),
    onSpeakerDeviceChange: (deviceId) => void changeSpeaker(deviceId),
    onResumeAudio: () => void controller.resumeAudioPlayback(),
    onCallAudioVolumeChange: (volume) => {
      setCallAudioVolume(volume);
      controller.setCallAudioVolume(volume / 100);
    },
    onSharedAudioVolumeChange: setSharedAudioVolume,
    onScreenCodecChange: setScreenCodec,
    onScreenBitrateChange: (bitrate) => {
      screenBitrateTouchedRef.current = true;
      setScreenBitrate(bitrate);
    },
    onScreenQualityChange: setScreenQuality,
    viewerTransportPreferenceVisible: Boolean(!screenState.stream && hasActiveScreenShare),
    viewerTransportPreference,
    onViewerTransportPreferenceChange: handleViewerTransportPreferenceChange,
    screenViewerCount: viewerCount,
    p2pRetryVisible: Boolean(
      (screenState.status === 'sharing' && viewerCount > 0)
      || (hasActiveScreenShare && (viewerP2pState === 'livekit' || viewerP2pState === 'negotiating'))
    ),
    onP2pRetry: () => {
      if (screenState.status === 'sharing') void p2pShareRef.current?.retryAll(viewerRosterRef.current);
      else viewerP2pRef.current?.requestRetry();
    },
    onScreenShareToggle: () => void toggleScreenShare(),
    onLeave: () => void leave()
  };

  const handleMeetingMenuAction = (action: MeetingMenuAction) => {
    if (action === 'participants') { setMeetingPanelParent('more'); setMeetingPanel('participants'); }
    else if (action === 'audio-devices' || action === 'screen-settings') { setMeetingPanelParent('more'); setMeetingPanel('settings'); }
    else if (action === 'webrtc-stats') { setMeetingPanelParent('more'); setMeetingPanel('stats'); }
    else void leave();
  };
  const closeMeetingPanel = () => { setMeetingPanel(null); setMeetingPanelParent(null); };
  const backToMore = () => { setMeetingPanelParent(null); setMeetingPanel('more'); };

  return <main className={`meeting-room${hasActiveScreenShare ? ' meeting-room-sharing' : ''}`}>
    <MeetingTopBar
      title={meetingName || t('room.heading', { name: join.participantName })}
      connection={<ConnectionBanner state={reconnectState} online={online} rateLimited={reconnectRateLimited} />}
      transportLabel={screenTransportLabel}
      participantCount={state.participants.length}
      navigationLabel={t('controls.navigation')}
      participantLabel={t('participants.label')}
      settingsLabel={t('controls.settingsShort')}
      onParticipants={() => { setMeetingPanelParent(null); setMeetingPanel('participants'); }}
      onSettings={() => { setMeetingPanelParent(null); setMeetingPanel('settings'); }}
      participantButtonRef={participantButtonRef}
      settingsButtonRef={settingsButtonRef}
    />
    <section className="meeting-notices" aria-live="polite">
      {(connectionError || notice) && <p role={connectionError ? 'alert' : 'status'}>{connectionError ?? notice}</p>}
      {screenState.audioGuidance && <p role="status">{localizedScreenGuidance(screenState.audioGuidance, t)}</p>}
      {systemAudioDecision && <section
        className="system-audio-warning"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-audio-warning-title"
      >
        <h2 id="system-audio-warning-title">{t('audioWarning.heading')}</h2>
        <p>{t('audioWarning.description', { surface: systemAudioDecision.displaySurface })}</p>
        <button type="button" onClick={() => resolveSystemAudioDecision('video-only')}>{t('audioWarning.videoOnly')}</button>
        <button type="button" onClick={() => resolveSystemAudioDecision('share-audio')}>{t('audioWarning.continue')}</button>
        <button type="button" onClick={() => resolveSystemAudioDecision('cancel')}>{t('audioWarning.cancel')}</button>
      </section>}
    </section>
    <div className="meeting-workspace">
      <div className="meeting-stage-column">
        {hasActiveScreenShare && <p className="meeting-sharing-label">
          <MonitorUp aria-hidden="true" size={18} />{t('room.sharingBy', { name: sharerName ?? t('screen.participant') })}
        </p>}
        <section className="meeting-stage-shell">
          <ScreenStage
            stream={stageStream}
            track={stageTrack}
            audioTrack={stageAudioTrack}
            muted={stageMuted}
            sharerName={sharerName}
            onSourceReady={handleStageSourceReady}
            sharedAudioVolume={sharedAudioVolume / 100}
          >
          </ScreenStage>
        </section>
        <MeetingControls
          {...meetingControlsProps}
          className="meeting-control-dock"
          includeSettings={false}
          onMore={() => { setMeetingPanelParent(null); setMeetingPanel('more'); }}
          moreButtonRef={moreButtonRef}
        />
      </div>
    </div>
    {meetingPanel === 'participants' && <MeetingDrawer
      title={t('participants.label')}
      closeLabel={t('controls.closePanel')}
      backLabel={meetingPanelParent === 'more' ? t('controls.backToMore') : undefined}
      onBack={meetingPanelParent === 'more' ? backToMore : undefined}
      onClose={closeMeetingPanel}
      returnFocusRef={meetingPanelParent === 'more' ? moreButtonRef : participantButtonRef}
    >
      <ParticipantList participants={state.participants} />
      <details className="meeting-management">
        <summary>{t('room.management')}</summary>
        <HostMenu
          participants={hostParticipants}
          authorizeHost={authorizeHost}
          authorized={hostAuthorized}
          onGrantShare={(identity) => meetingApi.grantShare(slug, identity)}
          onRevokeShare={() => meetingApi.revokeShare(slug)}
          onKick={(identity) => meetingApi.kick(slug, identity)}
          onEndMeeting={() => meetingApi.end(slug)}
          onEnded={() => onTerminal?.('ended')}
        />
        {hostAuthorization === 'unauthorized' && meetingApi.adminEnd && <section className="participant-admin-end">
          <h2>{t('adminEnd.heading')}</h2>
          <AdminEndMeetingForm
            compact
            onEnd={(password) => meetingApi.adminEnd!(slug, password)}
            onEnded={() => onTerminal?.('ended')}
          />
        </section>}
      </details>
    </MeetingDrawer>}
    {meetingPanel === 'settings' && <MeetingDrawer
      title={t('controls.settings')}
      closeLabel={t('controls.closePanel')}
      backLabel={meetingPanelParent === 'more' ? t('controls.backToMore') : undefined}
      onBack={meetingPanelParent === 'more' ? backToMore : undefined}
      onClose={closeMeetingPanel}
      returnFocusRef={meetingPanelParent === 'more' ? moreButtonRef : settingsButtonRef}
    ><MeetingSettings {...meetingControlsProps} /></MeetingDrawer>}
    {meetingPanel === 'more' && <MeetingDrawer
      title={t('controls.more')}
      closeLabel={t('controls.closePanel')}
      onClose={closeMeetingPanel}
      returnFocusRef={moreButtonRef}
    ><MeetingMenu items={[
      { action: 'participants', label: t('participants.label') },
      { action: 'audio-devices', label: t('controls.audioDevices') },
      { action: 'screen-settings', label: t('controls.screenSettings') },
      { action: 'webrtc-stats', label: t('controls.webrtcData') },
      { action: 'leave', label: t('controls.leave') }
    ]} label={t('controls.more')} onAction={handleMeetingMenuAction} /></MeetingDrawer>}
    {meetingPanel === 'stats' && <MeetingDrawer
      title={t('controls.webrtcData')}
      closeLabel={t('controls.closePanel')}
      backLabel={meetingPanelParent === 'more' ? t('controls.backToMore') : undefined}
      onBack={meetingPanelParent === 'more' ? backToMore : undefined}
      onClose={closeMeetingPanel}
      returnFocusRef={moreButtonRef}
    ><WebRtcStatsPanel
      embedded
      active={hasActiveScreenShare}
      snapshot={screenStats}
      requestedCodec={screenCodec}
      mode={screenTransportMode}
      turnProvider={screenTurnProvider}
    /></MeetingDrawer>}
  </main>;
}

/**
 * Clones every track of the captured share so the LiveKit fallback publication
 * can be stopped (unpublish stops tracks) without ending the source that the
 * P2P sessions are sending.
 */
function cloneShareStream(stream: MediaStream): MediaStream {
  const tracks = stream.getTracks().map((track) => track.clone());
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio')
  } as unknown as MediaStream;
}

function localizedScreenGuidance(message: string, t: Translate): string {
  const key: MessageKey = message.startsWith('No computer audio')
    ? 'screen.noAudio'
    : message.startsWith('The screen is being shared without')
      ? 'screen.videoOnly'
      : message.startsWith('The browser could not isolate')
        ? 'screen.echoRisk'
        : message.startsWith('Screen sharing was cancelled')
          ? 'screen.chooseTab'
          : 'error.generic';
  return t(key);
}
