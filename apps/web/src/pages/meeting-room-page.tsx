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

import { ApiRequestError, apiNoContent, apiRequest } from '../api/client.js';
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
  type P2pEncodingDiagnostics,
  type ViewerSessionState
} from '../meeting/p2p-share-controller.js';
import { P2pViewerController, type ViewerP2pState } from '../meeting/p2p-viewer-controller.js';
import {
  iceConfigurationExpiresSoon,
  normalizeP2pIceServerConfiguration,
  type P2pIceServerConfiguration
} from '../meeting/p2p-ice.js';
import { createRoomController, type MeetingRoomController } from '../meeting/room-controller.js';
import {
  readScreenShareTurnProviderPreference,
  saveScreenShareTurnProviderPreference,
  type ScreenShareTurnProviderPreference
} from '../meeting/screen-turn-provider-preference.js';
import {
  createScreenShareController,
  HybridScreenSharePublisher,
  recommendP2pBitrate,
  screenShareDefaultBitrate,
  screenShareDefaultQuality,
  screenShareQualityPresets,
  type ScreenShareBitrate,
  type ScreenShareState,
  type UnrestrictedSystemAudioChoice
} from '../meeting/screen-share.js';
import { createP2pStatsCollector, type P2pStatsCollector } from '../meeting/p2p-stats.js';
import { useCloudflareScreen } from '../meeting/use-cloudflare-screen.js';
import type { CloudflareScreenSession } from '../meeting/cloudflare-sfu.js';
import {
  canRetryViewerScreenTransport,
  deriveSharerScreenTransportMode,
  deriveSharerTurnProvider,
  deriveViewerTurnProvider,
  deriveViewerScreenTransportMode,
  type ScreenTransportMode,
  type ScreenTurnProvider
} from '../meeting/screen-transport-mode.js';
import { useMeetingRoom } from '../meeting/use-meeting-room.js';
import { summarizeWebRtcStats, type WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';
import type { ProjectStats } from '../meeting/software-media/encoder.js';
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
type RequestedIceTurnProvider = 'auto' | P2pTurnProvider;
const transportModeKeys: Record<ScreenTransportMode, MessageKey> = {
  'cloudflare-sfu': 'screenTransport.cloudflareSfu', p2p: 'screenTransport.p2p', turn: 'screenTransport.turn', sfu: 'screenTransport.sfu', mixed: 'screenTransport.mixed',
  negotiating: 'screenTransport.negotiating', waiting: 'screenTransport.waiting'
};
const turnProviderKeys: Record<ScreenTurnProvider, MessageKey> = {
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
  const [screenSourceTransport, setScreenSourceTransport] = useState<'p2p' | 'cloudflare-sfu'>('p2p');
  const screenSourceTransportRef = useRef<'p2p' | 'cloudflare-sfu'>('p2p');
  const cfPublisherRef = useRef<CloudflareScreenSession | undefined>(undefined);
  const [screenEncodingEngine, setScreenEncodingEngine] = useState<'project' | 'browser'>('browser');
  const [projectMediaError, setProjectMediaError] = useState<string>();
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
  const [screenShareTurnProvider, setScreenShareTurnProvider] = useState<ScreenShareTurnProviderPreference>(() =>
    readScreenShareTurnProviderPreference()
  );
  const screenTurnProviderPreferenceRef = useRef(screenShareTurnProvider);
  const [availableScreenTurnProviders, setAvailableScreenTurnProviders] = useState<readonly P2pTurnProvider[]>(['coturn']);
  const availableScreenTurnProvidersRef = useRef<readonly P2pTurnProvider[]>(availableScreenTurnProviders);
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
  const [projectReceiverStats, setProjectReceiverStats] = useState<ProjectStats>();
  const [encodingDiagnostics, setEncodingDiagnostics] = useState<ReadonlyMap<string, P2pEncodingDiagnostics>>(() => new Map());
  const [systemAudioDecision, setSystemAudioDecision] = useState<{ displaySurface: string }>();
  const systemAudioDecisionResolver = useRef<((choice: UnrestrictedSystemAudioChoice) => void) | undefined>(undefined);
  const authorizeHost = useCallback(() => meetingApi.authorizeHost(slug), [meetingApi, slug]);
  const requestMeetingIceServers = useCallback(async (
    requestedProvider: RequestedIceTurnProvider = 'auto'
  ): Promise<P2pIceServerConfiguration> => {
    const path = requestedProvider === 'auto'
      ? `/meetings/${encodeURIComponent(slug)}/ice-servers`
      : `/meetings/${encodeURIComponent(slug)}/ice-servers?turnProvider=${encodeURIComponent(requestedProvider)}`;
    const configuration = normalizeP2pIceServerConfiguration(await apiRequest<P2pIceServerConfiguration>(
      path,
      IceServersResponseSchema,
      { signal: AbortSignal.timeout(15000) }
    ));
    const availableTurnProviders = configuration.availableTurnProviders ?? [configuration.turnProvider];
    availableScreenTurnProvidersRef.current = availableTurnProviders;
    setAvailableScreenTurnProviders(availableTurnProviders);
    return configuration;
  }, [slug]);
  const fetchCfIce = useCallback(async () => (await requestMeetingIceServers('coturn')).iceServers, [requestMeetingIceServers]);
  const cf = useCloudflareScreen(slug, join.participantIdentity, fetchCfIce);
  const [cfReadyStream, setCfReadyStream] = useState<MediaStream>();
  const [cfRetrying, setCfRetrying] = useState(false);
  const cfRef = useRef(cf); cfRef.current = cf;
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
      share = shareControllerFactory({
        ...deps
      });
    } else {
      const signaling = signalingRef.current;
      if (!signaling) throw new Error('P2P signaling is not connected.');
      share = createP2pShareController({
        onProjectMediaError: setProjectMediaError,
        slug,
        signaling,
        fetchIceServers: () => requestMeetingIceServers(screenTurnProviderPreferenceRef.current),
        ...deps
      });
    }
    p2pShareUnsubscribeRef.current?.();
    p2pShareUnsubscribeRef.current = share.subscribe((states) => {
      setShareViewerStates(new Map(states));
      setShareViewerTurnProviders(new Map(share.getViewerTurnProviders?.() ?? []));
      p2pStats.observeShareStates(states);
    });
    return share;
  }, [p2pStats, requestMeetingIceServers, shareControllerFactory, slug]);
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
        if (screenSourceTransportRef.current === 'cloudflare-sfu') {
          const session = cfRef.current.createSession(); cfPublisherRef.current = session;
          await session.publish(stream, { ...options, encodingEngine: 'browser' });
          return;
        }
        const hybrid = new HybridScreenSharePublisher({
          sfuPublisher: {
            // LiveKit stops tracks on unpublish; publish clones so cancelling
            // the fallback track mid-share can never end the P2P source.
            publish: async (s, o) => {
              const cloned = cloneShareStream(s);
              sfuStreamRef.current = cloned;
              try {
                await controller.publishScreenShare(cloned, o);
              } catch (error) {
                if (sfuStreamRef.current === cloned) sfuStreamRef.current = undefined;
                for (const track of cloned.getTracks()) track.stop();
                throw error;
              }
            },
            release: async () => {
              const cloned = sfuStreamRef.current;
              sfuStreamRef.current = undefined;
              if (cloned) {
                try { await controller.releaseScreenShare(cloned); }
                finally { for (const track of cloned.getTracks()) track.stop(); }
              }
            }
          },
          getViewers: () => viewerRosterRef.current,
          createShareController,
          onControllerCreated: (share) => { p2pShareRef.current = share; },
          onViewerStatesChanged: setShareViewerStates
        });
        hybridShareRef.current = hybrid;
        await hybrid.publish(stream, options);
      },
      release: async (stream) => {
        const cfSession = cfPublisherRef.current; cfPublisherRef.current = undefined;
        if (cfSession) await cfSession.close();
        const hybrid = hybridShareRef.current;
        hybridShareRef.current = undefined;
        p2pShareUnsubscribeRef.current?.();
        p2pShareUnsubscribeRef.current = undefined;
        setShareViewerStates(new Map());
        setShareViewerTurnProviders(new Map());
        setEncodingDiagnostics(new Map());
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
    // A revoked/expired session cannot recover by polling. Keep this scoped
    // to the join effect so a fresh join can fetch credentials again.
    let terminalIceError: ApiRequestError | undefined;
    type ViewerSignal =
      | { type: 'offer'; from: string; sdp: string; generation?: string; turnProvider?: P2pTurnProvider }
      | { type: 'ice'; from: string; candidate: string | null; generation?: string };
    /** Viewer signaling received while ICE credentials are in flight. */
    const pendingViewerSignals: ViewerSignal[] = [];
    let viewerSignalTail = Promise.resolve();
    const iceServersFetches = new Map<RequestedIceTurnProvider, Promise<P2pIceServerConfiguration>>();
    let latestViewerIceRequestToken = 0;
    let blockedViewerSignalProvider: RequestedIceTurnProvider | undefined;
    const fetchIceServersOnce = (requestedProvider: RequestedIceTurnProvider = 'auto'): Promise<P2pIceServerConfiguration> => {
      if (terminalIceError) return Promise.reject(terminalIceError);
      const inFlight = iceServersFetches.get(requestedProvider);
      if (inFlight) return inFlight;
      const fetchPromise = requestMeetingIceServers(requestedProvider).catch((error: unknown) => {
        if (error instanceof ApiRequestError && [401, 403, 404, 410].includes(error.status)) {
          terminalIceError = error;
          if (retryTimer !== undefined) clearTimeout(retryTimer);
          if (iceRefreshTimer !== undefined) clearTimeout(iceRefreshTimer);
          retryTimer = undefined;
          iceRefreshTimer = undefined;
          pendingViewerSignals.length = 0;
        }
        throw error;
      }).finally(() => {
        iceServersFetches.delete(requestedProvider);
      });
      iceServersFetches.set(requestedProvider, fetchPromise);
      return fetchPromise;
    };
    const configurationMatchesRequest = (
      configuration: P2pIceServerConfiguration,
      requestedProvider: RequestedIceTurnProvider
    ): boolean => requestedProvider === 'auto' || configuration.turnProvider === requestedProvider;
    const applyIceConfiguration = (configuration: P2pIceServerConfiguration): void => {
      iceConfiguration = configuration;
      viewerP2pRef.current?.updateIceServers(configuration.iceServers, configuration.turnProvider);
      scheduleIceRefresh(configuration);
    };
    const fetchAndApplyIceServers = async (
      requestedProvider: RequestedIceTurnProvider = 'auto'
    ): Promise<boolean> => {
      const requestToken = ++latestViewerIceRequestToken;
      const fresh = await fetchIceServersOnce(requestedProvider);
      if (!configurationMatchesRequest(fresh, requestedProvider)) {
        throw new Error(`Requested ${requestedProvider} ICE configuration but received ${fresh.turnProvider}.`);
      }
      if (cancelled || terminalIceError || requestToken !== latestViewerIceRequestToken) return false;
      applyIceConfiguration(fresh);
      return true;
    };
    const queuePendingViewerSignals = (): void => {
      const queued = pendingViewerSignals.splice(0);
      for (const pending of queued) dispatchViewerSignal(pending);
    };
    const scheduleIceServersRetry = (requestedProvider: RequestedIceTurnProvider = 'auto'): void => {
      if (cancelled || terminalIceError) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        fetchIceServersWithRetry(requestedProvider);
      }, 2_000);
    };
    const refreshViewerIceServers = (requestedProvider: RequestedIceTurnProvider = iceConfiguration?.turnProvider ?? 'auto'): void => {
      void fetchAndApplyIceServers(requestedProvider).catch(() => {
        if (cancelled || terminalIceError) return;
        iceRefreshTimer = setTimeout(() => {
          iceRefreshTimer = undefined;
          refreshViewerIceServers(requestedProvider);
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
        refreshViewerIceServers(configuration.turnProvider);
      }, delay);
    };
    const ensureController = (): P2pViewerController | undefined => {
      if (cfRef.current.publicationRef.current || iceConfiguration === undefined) return undefined;
      if (viewerP2pRef.current === undefined) {
        const viewerController = new P2pViewerController(signaling, iceConfiguration.iceServers, {
          onProjectMediaError: setProjectMediaError,
          iceTransportPolicy: viewerTransportPreferenceToIcePolicy(viewerTransportPreferenceRef.current),
          turnProvider: iceConfiguration.turnProvider,
          onFallbackRequested: (complete) => {
            if (cfRef.current.publicationRef.current) return;
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
      if (cfRef.current.publicationRef.current || cancelled || terminalIceError) return;
      viewerSignalTail = viewerSignalTail.then(async () => {
        if (cfRef.current.publicationRef.current || cancelled || terminalIceError) return;
        if (blockedViewerSignalProvider !== undefined && signal.type === 'ice') {
          pendingViewerSignals.push(signal);
          return;
        }
        if (signal.type === 'offer') {
          viewerSharerIdentityRef.current = signal.from;
          if (viewerTransportPreferenceRef.current === 'sfu') {
            signaling.sendScreenTransport('sfu');
            return;
          }
          const requestedProvider: RequestedIceTurnProvider = signal.turnProvider ?? 'coturn';
          const shouldRefreshIceServers = signal.turnProvider !== undefined
            ? iceConfiguration === undefined
              || iceConfiguration.turnProvider !== requestedProvider
              || iceConfigurationExpiresSoon(iceConfiguration)
            : iceConfiguration !== undefined
              && (iceConfiguration.turnProvider !== requestedProvider
                || iceConfigurationExpiresSoon(iceConfiguration));
          // A fresh offer may arrive long after page load. Refresh ICE
          // credentials when the cached TURN ones are about to expire:
          // gathering with expired credentials silently yields no relay
          // candidates, which strands asymmetric NAT pairs on the SFU even
          // though the sharer's fresh session could relay.
          if (shouldRefreshIceServers) {
            try {
              const applied = await fetchAndApplyIceServers(requestedProvider);
              if (!applied && (iceConfiguration === undefined
                || !configurationMatchesRequest(iceConfiguration, requestedProvider))) {
                blockedViewerSignalProvider = requestedProvider;
                pendingViewerSignals.push(signal);
                scheduleIceServersRetry(requestedProvider);
                return;
              }
            } catch {
              if (cancelled || terminalIceError) return;
              blockedViewerSignalProvider = requestedProvider;
              pendingViewerSignals.push(signal);
              scheduleIceServersRetry(requestedProvider);
              return;
            }
          }
          if (iceConfiguration === undefined || !configurationMatchesRequest(iceConfiguration, requestedProvider)) {
            blockedViewerSignalProvider = requestedProvider;
            pendingViewerSignals.push(signal);
            if (signal.turnProvider !== undefined) scheduleIceServersRetry(requestedProvider);
            return;
          }
          blockedViewerSignalProvider = undefined;
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
    const fetchIceServersWithRetry = (requestedProvider: RequestedIceTurnProvider = 'auto'): void => {
      void fetchAndApplyIceServers(requestedProvider).then((applied) => {
        if (cancelled || !applied) return;
        const activeIceConfiguration = iceConfiguration;
        if (blockedViewerSignalProvider !== undefined
          && (activeIceConfiguration === undefined
            || !configurationMatchesRequest(activeIceConfiguration, blockedViewerSignalProvider))) return;
        blockedViewerSignalProvider = undefined;
        ensureController();
        queuePendingViewerSignals();
      }).catch(() => {
        if (cancelled) return;
        if (requestedProvider === 'auto' && blockedViewerSignalProvider !== undefined) return;
        scheduleIceServersRetry(requestedProvider);
      });
    };
    fetchIceServersWithRetry();
    const signaling = (createSignalingClient ?? createP2pSignalingClient)(slug, join.participantIdentity, {
      onOffer: (from, sdp, generation, turnProvider) => {
        if (cfRef.current.publicationRef.current) return;
        dispatchViewerSignal({ type: 'offer', from, sdp, generation, turnProvider });
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
      onScreenTransport: (from, transport) => {
        if (screenSourceTransportRef.current === 'cloudflare-sfu') return;
        void hybridShareRef.current?.setViewerScreenTransport(from, transport).catch(() => setNotice(t('room.shareFailed')));
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
        void controller.setRemoteScreenShareSubscribed(viewerTransportPreferenceRef.current === 'sfu').catch(() => undefined);
      },
      onScreenSfu: (publication) => {
        cfRef.current.announce(publication);
        if (publication) {
          pendingViewerSignals.length = 0;
          blockedViewerSignalProvider = undefined;
          pendingFallbackCompletionRef.current = undefined;
          viewerSharerIdentityRef.current = undefined;
          viewerP2pRef.current?.close(); viewerP2pRef.current = undefined;
          setViewerTurnProvider(undefined);
          setViewerP2pState('idle'); setFallbackP2pStream(undefined);
          void controller.setRemoteScreenShareSubscribed(false).catch(() => undefined);
        }
      },
      onShareGone: () => {
        cfRef.current.announce(null);
        viewerSharerIdentityRef.current = undefined;
        viewerP2pRef.current?.close();
        viewerP2pRef.current = undefined;
        setViewerTurnProvider(undefined);
        pendingFallbackCompletionRef.current = undefined;
        setFallbackP2pStream(undefined);
        void controller.setRemoteScreenShareSubscribed(viewerTransportPreferenceRef.current === 'sfu').catch(() => undefined);
        // The host revoked (or the server ended) our share: tear it down fully.
        if (screenShareRef.current?.getState().status !== 'idle') {
          void screenShareRef.current?.stop();
        }
      },
      onWelcome: (peers) => {
        if (!cfRef.current.publicationRef.current && viewerTransportPreferenceRef.current === 'sfu') signaling.sendScreenTransport('sfu');
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
              void controller.setRemoteScreenShareSubscribed(viewerTransportPreferenceRef.current === 'sfu').catch(() => undefined);
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
          void controller.setRemoteScreenShareSubscribed(viewerTransportPreferenceRef.current === 'sfu').catch(() => undefined);
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
  }, [controller, createSignalingClient, join.participantIdentity, p2pStats, requestMeetingIceServers, slug]);

  useEffect(() => {
    void controller.setRemoteScreenShareSubscribed(!cf.publication && viewerTransportPreference === 'sfu').catch(() => undefined);
  }, [controller, cf.publication, viewerTransportPreference, state.connection]);

  useEffect(() => {
    if (cf.publication || viewerTransportPreference !== 'sfu' || screenState.status !== 'idle' || state.remoteScreenShare?.track) return;
    // Explicit demand may arrive before capture exists. Reassert it while
    // waiting, independently of P2P offers or ICE credential availability.
    const timer = window.setInterval(() => signalingRef.current?.sendScreenTransport('sfu'), 5_000);
    return () => window.clearInterval(timer);
  }, [cf.publication, viewerTransportPreference, screenState.status, state.remoteScreenShare?.track]);

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
      await cf.close();
      await screenShare.stop();
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
      else await screenShare.start(screenCodec, screenBitrate, screenQuality, screenSourceTransportRef.current === 'cloudflare-sfu' ? 'browser' : screenEncodingEngine);
    } catch (error) {
      if (screenSourceTransportRef.current === 'cloudflare-sfu') cf.reportError(error);
      else setNotice(t('room.shareFailed'));
    }
  }

  async function retryCloudflareSource() {
    const stream = screenState.stream;
    if (!stream || cfRetrying) return;
    setCfRetrying(true); cf.clearError();
    try {
      await cfPublisherRef.current?.close();
      if (screenShare.getState().stream !== stream || screenShare.getState().status !== 'sharing') return;
      const session = cf.createSession(); cfPublisherRef.current = session;
      await session.publish(stream, {
        ...screenShareQualityPresets[screenQuality],
        codec: screenCodec, maxBitrate: screenBitrate, encodingEngine: 'browser'
      });
    } catch (error) { cf.reportError(error); }
    finally { setCfRetrying(false); }
  }

  const handleViewerTransportPreferenceChange = useCallback((preference: ViewerTransportPreference) => {
    viewerTransportPreferenceRef.current = preference;
    setViewerTransportPreference(preference);
    try {
      saveViewerTransportPreference(window.localStorage, preference);
    } catch {
      // Keep the in-session selection when browser storage is unavailable.
    }

    if (cfRef.current.publicationRef.current) return;
    const viewerController = viewerP2pRef.current;
    signalingRef.current?.retryConnection();
    signalingRef.current?.sendScreenTransport(preference === 'sfu' ? 'sfu' : 'peer');
    if (preference === 'sfu') {
      if (viewerController) viewerController.requestSfu();
      else void controller.setRemoteScreenShareSubscribed(true).catch(() => undefined);
      return;
    }

    viewerController?.setIceTransportPolicy(viewerTransportPreferenceToIcePolicy(preference));
    const sharerIdentity = state.remoteScreenShare?.sharerIdentity
      ?? viewerSharerIdentityRef.current
      ?? viewerController?.getSharerIdentity();
    if (sharerIdentity) {
      signalingRef.current?.retryConnection();
    }
  }, [controller, state.remoteScreenShare?.sharerIdentity]);
  const handleScreenShareTurnProviderChange = useCallback((preference: ScreenShareTurnProviderPreference) => {
    screenTurnProviderPreferenceRef.current = preference;
    setScreenShareTurnProvider(preference);
    saveScreenShareTurnProviderPreference(window.localStorage, preference);
  }, []);

  const hostParticipants: ParticipantSummary[] = state.participants.map((participant) => ({
    identity: participant.identity,
    name: participant.name,
    isSharing: participant.isSharing
  }));
  // SFU is shown only after explicit selection. Peer renegotiation may retain
  // the last peer frame, but never substitutes a LiveKit backup behind it.
  const livekitViewerTrack = !cf.publication && viewerTransportPreference === 'sfu' ? state.remoteScreenShare?.track : undefined;
  const p2pViewerStream = viewerP2pState === 'p2p' || viewerP2pState === 'turn'
    || (viewerTransportPreference !== 'sfu' && viewerP2pState === 'negotiating')
    ? viewerP2pRef.current?.getStream() ?? undefined
    : viewerP2pState === 'livekit' && livekitViewerTrack === undefined
      ? fallbackP2pStream
      : undefined;
  const stageStream = screenState.stream ?? (cf.publication ? cf.stream : p2pViewerStream);
  const stageTrack = stageStream ? undefined : livekitViewerTrack;
  const stageAudioTrack = stageStream || viewerTransportPreference !== 'sfu' ? undefined : state.remoteScreenShare?.audioTrack;
  const stageMuted = Boolean(screenState.stream) || (!cf.stream && p2pViewerStream === undefined && stageAudioTrack === undefined);
  const hasActiveScreenShare = Boolean(stageStream || stageTrack);
  const screenTransportMode: ScreenTransportMode = (screenState.stream && screenSourceTransport === 'cloudflare-sfu') || cf.publication
    ? 'cloudflare-sfu' : screenState.stream
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
    : cf.publication?.sharerName ?? state.remoteScreenShare?.sharerName;
  const handleStageSourceReady = useCallback(() => {
    if (screenState.stream) return;
    if (cf.publication && cf.stream) { setCfReadyStream(cf.stream); return; }
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
  }, [cf.publication, cf.stream, controller, livekitViewerTrack, p2pViewerStream, screenState.stream, viewerP2pState]);

  useEffect(() => {
    if (!hasActiveScreenShare) {
      setScreenStats(undefined);
      setProjectReceiverStats(undefined);
      setEncodingDiagnostics(new Map());
      return;
    }
    let cancelled = false;
    let previous: WebRtcStatsSnapshot | undefined;
    const activeReports = async (): Promise<RTCStatsReport[]> => {
      if (screenTransportMode === 'cloudflare-sfu') {
        const report = await (cfPublisherRef.current ?? cfRef.current.viewer.current)?.getStatsReport();
        return report ? [report] : [];
      }
      if (screenState.status === 'sharing') {
        const reports = await p2pShareRef.current?.getStatsReports();
        if (reports && reports.length > 0) return reports;
      } else if (viewerP2pState === 'negotiating'
        || viewerP2pState === 'p2p'
        || viewerP2pState === 'turn') {
        const report = await viewerP2pRef.current?.getStatsReport();
        if (report) return [report];
        return [];
      }
      if (screenState.status !== 'sharing' && viewerTransportPreference !== 'sfu') return [];
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
        setProjectReceiverStats(viewerP2pRef.current?.getProjectStats());
        setEncodingDiagnostics(new Map(
          screenState.status === 'sharing'
            ? p2pShareRef.current?.getEncodingDiagnostics?.() ?? []
            : []
        ));
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
  }, [controller, hasActiveScreenShare, screenTransportMode, screenState.status, viewerP2pState, viewerTransportPreference]);

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
    screenShareBusy: screenState.status === 'starting' || screenState.status === 'stopping',
    screenShareStopping: screenState.status === 'stopping',
    screenCodec,
    screenSourceTransport,
    onScreenSourceTransportChange: (transport) => { screenSourceTransportRef.current = transport; setScreenSourceTransport(transport); if (transport === 'cloudflare-sfu') setScreenEncodingEngine('browser'); },
    cloudflareSfuAvailable: cf.available,
    screenEncodingEngine,
    onScreenEncodingEngineChange: setScreenEncodingEngine,
    screenBitrate,
    screenQuality,
    screenShareTurnProvider,
    availableTurnProviders: availableScreenTurnProviders,
    onMicrophoneToggle: () => void controller.setMicrophoneEnabled(!state.microphoneEnabled),
    onMicrophoneDeviceChange: (deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId),
    onSpeakerDeviceChange: (deviceId) => void changeSpeaker(deviceId),
    onResumeAudio: () => { void controller.resumeAudioPlayback(); void viewerP2pRef.current?.resumeProjectAudio(); },
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
    screenShareTurnProviderVisible: hostAuthorized || Boolean(state.screenShareAuthorized),
    onScreenShareTurnProviderChange: handleScreenShareTurnProviderChange,
    viewerTransportPreferenceVisible: Boolean(!cf.publication && !screenState.stream && hasActiveScreenShare),
    viewerTransportPreference,
    onViewerTransportPreferenceChange: handleViewerTransportPreferenceChange,
    screenViewerCount: viewerCount,
    p2pRetryVisible: Boolean(
      (screenSourceTransport !== 'cloudflare-sfu' && screenState.status === 'sharing' && viewerCount > 0)
      || (hasActiveScreenShare && canRetryViewerScreenTransport(viewerP2pState))
    ),
    onP2pRetry: () => {
      signalingRef.current?.retryConnection();
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
    {cf.error && <p role="alert">{cf.error}</p>}
    {cf.error && screenState.stream && screenSourceTransport === 'cloudflare-sfu' && <button type="button" disabled={cfRetrying} onClick={() => void retryCloudflareSource()}>{t('controls.cloudflareSfuRetry')}</button>}
    {cf.publication && cf.publication.sharerIdentity !== join.participantIdentity && cf.error && <button type="button" onClick={cf.retry}>{t('controls.cloudflareSfuRetry')}</button>}
    {projectMediaError && <p role="alert">{projectMediaError} — {t('controls.browserEncoding')} / SFU</p>}
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
        {hasActiveScreenShare && (!cf.publication || screenState.stream || cfReadyStream === cf.stream) && <p className="meeting-sharing-label">
          <MonitorUp aria-hidden="true" size={18} />
          <span>{t('room.sharingBy', { name: sharerName ?? t('screen.participant') })}</span>
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
      encodingDiagnostics={screenState.status === 'sharing' ? encodingDiagnostics : undefined}
      requestedCodec={screenCodec}
      projectReceiver={projectReceiverStats}
      onProjectAudioResume={() => { void viewerP2pRef.current?.resumeProjectAudio(); }}
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
  const tracks = stream.getTracks().map((track) => {
    const cloned = track.clone();
    if (track.contentHint) cloned.contentHint = track.contentHint;
    return cloned;
  });
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
