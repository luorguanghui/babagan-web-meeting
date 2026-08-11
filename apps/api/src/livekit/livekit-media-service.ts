import {
  RoomServiceClient,
  ServerError,
  TrackSource
} from 'livekit-server-sdk';

import {
  normalizePublishSources,
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
}

export class LiveKitMediaService implements MediaService {
  private readonly rooms: RoomAdministrationClient;
  private readonly tokens: TokenService;

  public constructor(options: LiveKitMediaServiceOptions) {
    this.rooms = options.roomService ?? new RoomServiceClient(
      toLiveKitServerApiUrl(options.internalUrl),
      options.apiKey,
      options.apiSecret
    ) as RoomAdministrationClient;
    this.tokens = new TokenService(options.apiKey, options.apiSecret);
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
