import { createHash, randomBytes, randomUUID } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import type Database from 'better-sqlite3';

export interface DeploymentSmokeSession {
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
  })();

  const signedToken = fastifyCookie.sign(rawToken, cookieSecret);
  return {
    slug,
    cookieHeader: `wm_participant=${encodeURIComponent(signedToken)}`
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
