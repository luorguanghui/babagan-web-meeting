import { readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

const migrations = [
  {
    name: '001_initial.sql',
    sql: readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
  }
] as const;

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  const recordMigration = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)'
  );

  const runPendingMigrations = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.get(migration.name)) continue;
      db.exec(migration.sql);
      recordMigration.run(migration.name, Date.now());
    }
  });

  runPendingMigrations();
}
