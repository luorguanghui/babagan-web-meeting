export type DomainErrorCode =
  | 'MEETING_ALREADY_ACTIVE'
  | 'MEETING_NOT_FOUND'
  | 'MEETING_EXPIRED'
  | 'MEETING_FULL'
  | 'INVALID_MEETING_PASSWORD'
  | 'MEDIA_SERVICE_UNAVAILABLE';

export class DomainError extends Error {
  public constructor(public readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
  }
}

export function domainError(code: DomainErrorCode): DomainError {
  return new DomainError(code);
}
