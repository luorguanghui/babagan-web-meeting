import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { LiveKitMediaService } from './livekit/livekit-media-service.js';
import type { MediaService as LiveKitMediaPort } from './livekit/media-service.js';
import { LiveKitWebhookHandler } from './livekit/webhook-handler.js';
import { SqliteMeetingRepository } from './repositories/sqlite-meeting-repository.js';
import { Argon2PasswordHasher } from './security/password-hasher.js';
import { HostApplicationService } from './services/host-application-service.js';
import { KeyedMutex } from './services/keyed-mutex.js';
import { MeetingService, type IdGenerator, type MediaService as MeetingMediaPort } from './services/meeting-service.js';
import { ParticipantApplicationService } from './services/participant-application-service.js';

interface ManagedApp {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
  log: { error(value: unknown, message?: string): void };
}

interface SignalSource {
  once(event: 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGTERM', listener: () => void): unknown;
}

export async function startManagedServer(dependencies: {
  app: ManagedApp;
  database: Pick<Database.Database, 'close'>;
  meetings: Pick<MeetingService, 'runCleanup'>;
  signals?: SignalSource;
  intervalMs?: number;
  port?: number;
}): Promise<{ shutdown(): Promise<void> }> {
  const signals = dependencies.signals ?? process;
  const intervalMs = dependencies.intervalMs ?? 30_000;
  let cleanupPromise: Promise<void> | undefined;
  let shuttingDown: Promise<void> | undefined;

  const runCleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        await dependencies.meetings.runCleanup();
      } catch {
        dependencies.app.log.error({}, 'Meeting cleanup failed');
      } finally {
        cleanupPromise = undefined;
      }
    })();
    return cleanupPromise;
  };

  await runCleanup();
  await dependencies.app.listen({ host: '0.0.0.0', port: dependencies.port ?? 3000 });
  const interval = setInterval(() => { void runCleanup(); }, intervalMs);
  interval.unref();

  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      clearInterval(interval);
      signals.off('SIGTERM', onSigterm);
      await cleanupPromise;
      try {
        await dependencies.app.close();
      } finally {
        dependencies.database.close();
      }
    })();
    return shuttingDown;
  };
  const onSigterm = () => {
    void shutdown().catch(() => dependencies.app.log.error({}, 'Server shutdown failed'));
  };
  signals.once('SIGTERM', onSigterm);
  return { shutdown };
}

export async function startServer(): Promise<{ app: FastifyInstance; shutdown(): Promise<void> }> {
  const config = loadConfig(process.env);
  const database = createDatabase(config.databasePath);
  try {
    migrate(database);
    const repository = new SqliteMeetingRepository(database);
    const media = new LiveKitMediaService({
      internalUrl: config.livekitInternalUrl,
      apiKey: config.livekitApiKey,
      apiSecret: config.livekitApiSecret
    });
    const clock = { now: () => Date.now() };
    const ids = new SecureIds();
    const mutex = new KeyedMutex();
    const passwords = new Argon2PasswordHasher();
    const meetings = new MeetingService({
      repository,
      media: legacyMeetingMediaBridge(media),
      passwords,
      clock,
      ids,
      config,
      mutex
    });
    const hosts = new HostApplicationService({
      repository, meetings, media, passwords, clock, ids, config, mutex
    });
    const participants = new ParticipantApplicationService({ repository, media, clock, config });
    const webhooks = new LiveKitWebhookHandler({
      database,
      media,
      apiKey: config.livekitApiKey,
      apiSecret: config.livekitApiSecret,
      clock
    });
    const app = await buildApp({ config, meetings, hosts, participants, media, webhooks });
    const managed = await startManagedServer({ app, database, meetings });
    return { app, shutdown: managed.shutdown };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function legacyMeetingMediaBridge(media: LiveKitMediaPort): MeetingMediaPort {
  return {
    listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
    issueParticipantToken: ({ meetingId, identity, nickname }) => media.issueToken({
      meetingId, identity, nickname
    }),
    removeParticipant: (meetingId, identity) => media.removeParticipant(meetingId, identity),
    closeMeeting: (meetingId) => media.deleteRoom(meetingId)
  };
}

class SecureIds implements IdGenerator {
  uuid(): string { return randomUUID(); }
  slug(): string { return randomBytes(24).toString('base64url'); }
  token(): string { return randomBytes(32).toString('base64url'); }
  participantIdentity(): string { return randomUUID(); }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'API startup failed');
    process.exitCode = 1;
  });
}
