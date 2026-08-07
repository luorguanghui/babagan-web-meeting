import { AccessToken, TrackSource } from 'livekit-server-sdk';

import {
  NORMAL_PUBLISH_SOURCES,
  normalizePublishSources,
  type IssueTokenInput,
  type PublishSource
} from './media-service.js';

const TOKEN_TTL_SECONDS = 300;

export class TokenService {
  public constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string
  ) {}

  async issueToken(input: IssueTokenInput): Promise<string> {
    const sources = normalizePublishSources(input.sources ?? [...NORMAL_PUBLISH_SOURCES]);
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      name: input.nickname,
      ttl: TOKEN_TTL_SECONDS
    });
    token.addGrant({
      room: input.meetingId,
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: sources.map(toTrackSource)
    });

    return token.toJwt();
  }
}

function toTrackSource(source: PublishSource): TrackSource {
  switch (source) {
    case 'microphone': return TrackSource.MICROPHONE;
    case 'screen_share': return TrackSource.SCREEN_SHARE;
    case 'screen_share_audio': return TrackSource.SCREEN_SHARE_AUDIO;
  }
}
