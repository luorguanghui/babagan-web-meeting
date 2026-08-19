import { createDatabase } from '../db/database.js';
import { TokenService } from '../livekit/token-service.js';
import {
  createDeploymentSmokeSession,
  deleteDeploymentSmokeSession
} from './deployment-smoke-session.js';

const [command, slug] = process.argv.slice(2);
const databasePath = process.env.DATABASE_PATH;
const cookieSecret = process.env.COOKIE_SECRET;
const livekitApiKey = process.env.LIVEKIT_API_KEY;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET;

if (!databasePath || !cookieSecret) {
  throw new Error('DATABASE_PATH and COOKIE_SECRET are required');
}

const db = createDatabase(databasePath);
try {
  if (command === 'create' && slug === undefined) {
    if (!livekitApiKey || !livekitApiSecret) {
      throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required');
    }
    const probe = createDeploymentSmokeSession(db, cookieSecret);
    let livekitToken: string;
    try {
      livekitToken = await new TokenService(livekitApiKey, livekitApiSecret).issueToken({
        meetingId: probe.meetingId,
        identity: probe.identity,
        nickname: 'Deployment smoke probe'
      });
    } catch (error) {
      deleteDeploymentSmokeSession(db, probe.slug);
      throw error;
    }
    process.stdout.write(`SMOKE_MEETING_SLUG=${probe.slug}\n`);
    process.stdout.write(`SMOKE_PARTICIPANT_COOKIE=${probe.cookieHeader}\n`);
    process.stdout.write(`SMOKE_LIVEKIT_TOKEN=${livekitToken}\n`);
  } else if (command === 'delete' && slug?.match(/^[A-Za-z0-9_-]{22,256}$/)) {
    if (!deleteDeploymentSmokeSession(db, slug)) {
      throw new Error('deployment smoke session was not found');
    }
  } else {
    throw new Error('Usage: deployment-smoke-session-cli.js create | delete SLUG');
  }
} finally {
  db.close();
}
