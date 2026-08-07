import type { IdGenerator } from '../../src/services/meeting-service.js';

export class FakeIds implements IdGenerator {
  private sequence = 0;

  uuid(): string {
    return `meeting-${++this.sequence}`;
  }

  slug(): string {
    return `meeting-slug-${++this.sequence}`;
  }

  token(): string {
    return `token-${++this.sequence}`;
  }

  participantIdentity(): string {
    return `participant-${++this.sequence}`;
  }
}
