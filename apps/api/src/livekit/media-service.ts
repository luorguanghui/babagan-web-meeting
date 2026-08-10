export type PublishSource = 'microphone' | 'screen_share' | 'screen_share_audio';

export interface IssueTokenInput {
  meetingId: string;
  identity: string;
  nickname: string;
  sources?: PublishSource[];
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface MediaService {
  listParticipantIdentities(roomName: string): Promise<Set<string>>;
  issueToken(input: IssueTokenInput): Promise<string>;
  updateParticipantSources(
    roomName: string,
    identity: string,
    sources: PublishSource[]
  ): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  ping(): Promise<void>;
  fetchIceServers(): Promise<IceServer[]>;
}

export const NORMAL_PUBLISH_SOURCES = ['microphone'] as const;
export const SHARE_PUBLISH_SOURCES = [
  'microphone',
  'screen_share',
  'screen_share_audio'
] as const;

export function normalizePublishSources(sources: PublishSource[]): PublishSource[] {
  if (matchesSources(sources, NORMAL_PUBLISH_SOURCES)) return [...NORMAL_PUBLISH_SOURCES];
  if (matchesSources(sources, SHARE_PUBLISH_SOURCES)) return [...SHARE_PUBLISH_SOURCES];
  throw new Error('Unsupported LiveKit publish source set');
}

function matchesSources(
  actual: PublishSource[],
  expected: readonly PublishSource[]
): boolean {
  return actual.length === expected.length && actual.every((source, index) => source === expected[index]);
}
