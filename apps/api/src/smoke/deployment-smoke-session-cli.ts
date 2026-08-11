import { createDatabase } from '../db/database.js';
import {
  createDeploymentSmokeSession,
  deleteDeploymentSmokeSession
} from './deployment-smoke-session.js';

const [command, slug] = process.argv.slice(2);
const databasePath = process.env.DATABASE_PATH;
const cookieSecret = process.env.COOKIE_SECRET;

if (!databasePath || !cookieSecret) {
  throw new Error('DATABASE_PATH and COOKIE_SECRET are required');
}

const db = createDatabase(databasePath);
try {
  if (command === 'create' && slug === undefined) {
    const probe = createDeploymentSmokeSession(db, cookieSecret);
    process.stdout.write(`SMOKE_MEETING_SLUG=${probe.slug}\n`);
    process.stdout.write(`SMOKE_PARTICIPANT_COOKIE=${probe.cookieHeader}\n`);
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
