import type {
  IssueTokenInput,
  MediaService,
  PublishSource
} from '../../src/livekit/media-service.js';

export class FakeMediaService implements MediaService {
  readonly identities = new Map<string, Set<string>>();
  readonly issuedTokens: IssueTokenInput[] = [];
  readonly sourceUpdates: Array<{
    roomName: string;
    identity: string;
    sources: PublishSource[];
  }> = [];
  readonly removedParticipants: Array<{ roomName: string; identity: string }> = [];
  readonly deletedRooms: string[] = [];
  pingCount = 0;
  removeError?: Error;

  async listParticipantIdentities(roomName: string): Promise<Set<string>> {
    return new Set(this.identities.get(roomName) ?? []);
  }

  async issueToken(input: IssueTokenInput): Promise<string> {
    this.issuedTokens.push(input);
    return `livekit-token:${input.meetingId}:${input.identity}`;
  }

  async updateParticipantSources(
    roomName: string,
    identity: string,
    sources: PublishSource[]
  ): Promise<void> {
    this.sourceUpdates.push({ roomName, identity, sources: [...sources] });
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    if (this.removeError) throw this.removeError;
    this.removedParticipants.push({ roomName, identity });
    this.identities.get(roomName)?.delete(identity);
  }

  async deleteRoom(roomName: string): Promise<void> {
    this.deletedRooms.push(roomName);
    this.identities.delete(roomName);
  }

  async ping(): Promise<void> {
    this.pingCount++;
  }

}
