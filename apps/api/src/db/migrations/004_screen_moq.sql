ALTER TABLE meetings ADD COLUMN share_grant_generation INTEGER NOT NULL DEFAULT 0;

-- Share permission can change through host actions, participant leave, or a
-- LiveKit webhook. Give all of those writes the same grant-generation semantics.
CREATE TRIGGER meetings_share_grant_generation
AFTER UPDATE OF share_identity ON meetings
WHEN OLD.share_identity IS NOT NEW.share_identity
BEGIN
  UPDATE meetings
  SET share_grant_generation = share_grant_generation + 1
  WHERE id = NEW.id;
END;

CREATE TABLE screen_moq_relays (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  relay_id TEXT,
  PRIMARY KEY (account_id, name)
);
