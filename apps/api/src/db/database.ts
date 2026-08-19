import Database from 'better-sqlite3';

export function createDatabase(path: string): Database.Database {
  const db = new Database(path);

  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return db;
}
