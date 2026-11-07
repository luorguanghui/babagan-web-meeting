import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';

let directory: string;
let db: Database.Database;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'three-meeting-migration-')); db = createDatabase(join(directory, 'meetings.sqlite')); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const meeting = (id: string) => ({ id, slug: 'slug-' + id, name: id, passwordHash: null, createdAt: 1_000, expiresAt: 100_000 });

it('upgrades the existing two-migration database without losing rooms or sessions and is idempotent', () => {
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const name of ['001_initial.sql', '002_media_cleanup.sql']) {
    db.exec(readFileSync(new URL('../src/db/migrations/' + name, import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, 1_000);
  }
  const repo = new SqliteMeetingRepository(db);
  const original = repo.createMeeting(meeting('one'));
  repo.createHostSession({ id: 'host-one', meetingId: original.id, tokenHash: 'hash', createdAt: 1_000, expiresAt: 100_000, revokedAt: null });
  expect(() => repo.createMeeting(meeting('two'))).toThrow(/UNIQUE/);
  migrate(db); migrate(db);
  expect(repo.findBySlug(original.slug)).toEqual(original);
  expect(repo.findHostSessionByTokenHash('hash', 2_000)?.meetingId).toBe(original.id);
  expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 3 });
  repo.createMeeting(meeting('two')); repo.createMeeting(meeting('three'));
  expect(() => repo.createMeeting(meeting('four'))).toThrow('MEETING_LIMIT_REACHED');
});

it('enforces the cap for terminal-to-open updates while allowing lifecycle changes within an open room', () => {
  migrate(db); const repo = new SqliteMeetingRepository(db);
  const closed = repo.createMeeting(meeting('closed'));
  repo.updateMeetingLifecycle(closed.id, { status: 'ended', emptySince: null, endedAt: 2_000 });
  for (const id of ['one', 'two', 'three']) repo.createMeeting(meeting(id));
  db.prepare("UPDATE meetings SET status = 'active' WHERE id = 'one'").run();
  db.prepare("UPDATE meetings SET status = 'grace' WHERE id = 'two'").run();
  expect(() => db.prepare("UPDATE meetings SET status = 'active' WHERE id = 'closed'").run()).toThrow('MEETING_LIMIT_REACHED');
  expect(repo.countNonTerminal()).toBe(3);
  repo.updateMeetingLifecycle('one', { status: 'ended', emptySince: null, endedAt: 3_000 });
  db.prepare("UPDATE meetings SET status = 'created' WHERE id = 'closed'").run();
  expect(repo.countNonTerminal()).toBe(3);
});

it('admits exactly three independent simultaneous SQLite writers', async () => {
  migrate(db);
  const require = createRequire(import.meta.url);
  const nativeModule = require.resolve('better-sqlite3');
  const workers: Worker[] = [];
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.nativeModule);
    const db = new Database(workerData.path);
    db.pragma('busy_timeout = 5000');
    parentPort.once('message', () => {
      try {
        db.prepare("INSERT INTO meetings (id,slug,name,status,created_at,expires_at,version) VALUES (?,?,?,'created',1000,100000,0)").run(workerData.id,workerData.id,workerData.id);
        parentPort.postMessage({ accepted: true });
      } catch (error) { parentPort.postMessage({ accepted: false, code: error.code, message: error.message }); }
      finally { db.close(); parentPort.close(); }
    });
    parentPort.postMessage({ ready: true });
  `;
  try {
    const ready: Array<Promise<void>> = [];
    const results: Array<Promise<{ accepted: boolean; code?: string; message?: string }>> = [];
    for (let index = 0; index < 4; index++) {
      const worker = new Worker(code, { eval: true, workerData: { nativeModule, path: join(directory, 'meetings.sqlite'), id: 'worker-' + index } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.ready) resolve(); }); }));
      results.push(new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if ('accepted' in message) resolve(message); }); }));
    }
    await Promise.all(ready);
    workers.forEach(worker => worker.postMessage('go'));
    const outcome = await Promise.all(results);
    expect(outcome.filter(result => result.accepted)).toHaveLength(3);
    expect(outcome.filter(result => !result.accepted)).toEqual([{ accepted: false, code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'MEETING_LIMIT_REACHED' }]);
    expect(new SqliteMeetingRepository(db).countNonTerminal()).toBe(3);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}, 15_000);
