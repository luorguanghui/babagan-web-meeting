import { createHmac } from 'node:crypto';

export function createTurnCredentials(input: {
  secret: string;
  participantIdentity: string;
  ttlSeconds: number;
  nowSeconds: number;
}): { username: string; credential: string } {
  const expiry = Math.floor(input.nowSeconds) + input.ttlSeconds;
  const username = `${expiry}:${input.participantIdentity}`;
  const credential = createHmac('sha1', input.secret).update(username).digest('base64');
  return { username, credential };
}
