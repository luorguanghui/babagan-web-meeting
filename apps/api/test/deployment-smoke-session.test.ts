import fastifyCookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import {
  createDeploymentSmokeSession,
  deleteDeploymentSmokeSession
} from '../src/smoke/deployment-smoke-session.js';

describe('deployment smoke session', () => {
  const databases: ReturnType<typeof createDatabase>[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('creates an authenticated disposable participant and removes it afterwards', () => {
    const db = createDatabase(':memory:');
    databases.push(db);
    migrate(db);
    const secret = 'deployment-smoke-cookie-secret-32-bytes';

    const probe = createDeploymentSmokeSession(db, secret, 1_800_000_000_000);

    expect(probe.slug).toMatch(/^[A-Za-z0-9_-]{22,256}$/);
    expect(probe.cookieHeader).toMatch(/^wm_participant=/);
    const signed = decodeURIComponent(probe.cookieHeader.slice('wm_participant='.length));
    const unsigned = fastifyCookie.unsign(signed, secret);
    expect(unsigned.valid).toBe(true);
    expect(db.prepare('SELECT status, name FROM meetings WHERE slug = ?').get(probe.slug))
      .toEqual({ status: 'created', name: 'Deployment smoke probe' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM participant_sessions').get())
      .toEqual({ count: 1 });

    expect(deleteDeploymentSmokeSession(db, probe.slug)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM meetings').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM participant_sessions').get())
      .toEqual({ count: 0 });
  });

  it('refuses to replace an existing non-terminal meeting', () => {
    const db = createDatabase(':memory:');
    databases.push(db);
    migrate(db);
    db.prepare(`
      INSERT INTO meetings (
        id, slug, name, password_hash, status, share_identity,
        created_at, expires_at, empty_since, ended_at, version
      ) VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?, NULL, NULL, 0)
    `).run('real-meeting', 'real-meeting-slug-123456', 'Real meeting', 10, 20);

    expect(() => createDeploymentSmokeSession(db, 'deployment-smoke-cookie-secret-32-bytes', 11))
      .toThrow(/UNIQUE constraint failed/);
    expect(db.prepare('SELECT id, name FROM meetings').all())
      .toEqual([{ id: 'real-meeting', name: 'Real meeting' }]);
  });
});
