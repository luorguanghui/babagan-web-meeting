import { P2P_ICE_CACHE_TTL_SECONDS } from '@meeting/contracts';
import {
  AccessToken,
  RoomServiceClient,
  ServerError,
  TrackSource
} from 'livekit-server-sdk';

import {
  normalizePublishSources,
  type IceServer,
  type IssueTokenInput,
  type MediaService,
  type PublishSource
} from './media-service.js';
import { TokenService } from './token-service.js';

interface RoomAdministrationClient {
  listParticipants(roomName: string): Promise<Array<{ identity: string }>>;
  updateParticipant(
    roomName: string,
    identity: string,
    options: { permission?: Record<string, unknown> }
  ): Promise<unknown>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  listRooms(names?: string[]): Promise<unknown[]>;
}

export interface LiveKitMediaServiceOptions {
  internalUrl: string | URL;
  apiKey: string;
  apiSecret: string;
  roomService?: RoomAdministrationClient;
  fetchImpl?: typeof fetch;
}

export class LiveKitMediaService implements MediaService {
  private readonly rooms: RoomAdministrationClient;
  private readonly tokens: TokenService;
  private readonly serverApiUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly iceFetch: typeof fetch;
  private iceServersCache: { value: IceServer[]; expiresAt: number } | null = null;

  public constructor(options: LiveKitMediaServiceOptions) {
    this.rooms = options.roomService ?? new RoomServiceClient(
      toLiveKitServerApiUrl(options.internalUrl),
      options.apiKey,
      options.apiSecret
    ) as RoomAdministrationClient;
    this.tokens = new TokenService(options.apiKey, options.apiSecret);
    this.serverApiUrl = toLiveKitServerApiUrl(options.internalUrl);
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.iceFetch = options.fetchImpl ?? fetch;
  }

  async listParticipantIdentities(roomName: string): Promise<Set<string>> {
    const participants = await this.rooms.listParticipants(roomName);
    return new Set(participants.map((participant) => participant.identity));
  }

  issueToken(input: IssueTokenInput): Promise<string> {
    return this.tokens.issueToken(input);
  }

  async updateParticipantSources(
    roomName: string,
    identity: string,
    requestedSources: PublishSource[]
  ): Promise<void> {
    const sources = normalizePublishSources(requestedSources);
    await this.rooms.updateParticipant(roomName, identity, {
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: false,
        canPublishSources: sources.map(toTrackSource)
      }
    });
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      await this.rooms.removeParticipant(roomName, identity);
    } catch (error) {
      if (isParticipantNotFound(error)) return;
      throw error;
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(roomName);
    } catch (error) {
      if (isRoomNotFound(error)) return;
      throw error;
    }
  }

  async ping(): Promise<void> {
    await this.rooms.listRooms([]);
  }

  async fetchIceServers(): Promise<IceServer[]> {
    const now = Date.now();
    const cached = this.iceServersCache;
    if (cached && cached.expiresAt > now) return cached.value;

    const authorization = `Bearer ${await new AccessToken(this.apiKey, this.apiSecret).toJwt()}`;
    const response = await this.iceFetch(`${this.serverApiUrl}rtc/ice`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization
      },
      body: '{}'
    });
    if (!response.ok) {
      throw new Error(`LiveKit ICE endpoint returned HTTP ${response.status}`);
    }
    const servers = parseIceServers(await response.json());
    this.iceServersCache = { value: servers, expiresAt: now + P2P_ICE_CACHE_TTL_SECONDS * 1_000 };
    return servers;
  }
}

function parseIceServers(body: unknown): IceServer[] {
  const iceServers = isRecord(body) ? body.iceServers : undefined;
  if (!Array.isArray(iceServers)) {
    throw new Error('LiveKit ICE response is missing the iceServers list');
  }
  return iceServers.map(parseIceServer);
}

function parseIceServer(entry: unknown): IceServer {
  if (!isRecord(entry)
    || !Array.isArray(entry.urls)
    || entry.urls.some((url) => typeof url !== 'string')) {
    throw new Error('LiveKit ICE response contains a malformed server entry');
  }
  const server: IceServer = { urls: entry.urls };
  if (typeof entry.username === 'string') server.username = entry.username;
  if (typeof entry.credential === 'string') server.credential = entry.credential;
  return server;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toLiveKitServerApiUrl(input: string | URL): string {
  const url = new URL(input.toString());
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.toString();
}

function toTrackSource(source: PublishSource): TrackSource {
  switch (source) {
    case 'microphone': return TrackSource.MICROPHONE;
    case 'screen_share': return TrackSource.SCREEN_SHARE;
    case 'screen_share_audio': return TrackSource.SCREEN_SHARE_AUDIO;
  }
}

function isRoomNotFound(error: unknown): boolean {
  return error instanceof ServerError && (error.status === 404 || error.code === 'not_found');
}

function isParticipantNotFound(error: unknown): boolean {
  return error instanceof ServerError
    && error.status === 404
    && error.code === 'not_found'
    && /\bparticipant\b.*\bnot found\b/i.test(error.message);
}
