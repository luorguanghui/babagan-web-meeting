import { createHash, randomBytes, randomUUID } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import type Database from 'better-sqlite3';
import { meetingSessionCookieName, participantCookie } from '../security/session-token.js';

export interface DeploymentSmokeSession {
  meetingId: string;
  identity: string;
  slug: string;
  cookieHeader: string;
}

export function createDeploymentSmokeSession(
  db: Database.Database,
  cookieSecret: string,
  now = Date.now()
): DeploymentSmokeSession {
  const meetingId = randomUUID();
  const slug = randomBytes(18).toString('base64url');
  const identity = `smoke-${randomUUID()}`;
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const expiresAt = now + 5 * 60_000;

  db.transaction(() => {
    const open = db.prepare("SELECT COUNT(*) AS count FROM meetings WHERE status IN ('created', 'active', 'grace')").get() as { count: number };
    if (open.count !== 0) throw new Error('Cannot create a deployment probe while a meeting is open');
    db.prepare(`
      INSERT INTO meetings (
        id, slug, name, password_hash, status, share_identity,
        created_at, expires_at, empty_since, ended_at, version
      ) VALUES (?, ?, 'Deployment smoke probe', NULL, 'created', NULL, ?, ?, NULL, NULL, 0)
    `).run(meetingId, slug, now, expiresAt);
    db.prepare(`
      INSERT INTO participant_sessions (
        identity, meeting_id, nickname, token_hash, expires_at, revoked_at
      ) VALUES (?, ?, 'Deployment smoke probe', ?, ?, NULL)
    `).run(identity, meetingId, tokenHash, expiresAt);
  }).immediate();

  const signedToken = fastifyCookie.sign(rawToken, cookieSecret);
  return {
    meetingId,
    identity,
    slug,
    cookieHeader: `${meetingSessionCookieName(participantCookie, slug)}=${encodeURIComponent(signedToken)}`
  };
}

export function deleteDeploymentSmokeSession(
  db: Database.Database,
  slug: string
): boolean {
  const result = db.prepare(`
    DELETE FROM meetings
    WHERE slug = ? AND name = 'Deployment smoke probe'
  `).run(slug);
  return result.changes === 1;
}
