-- Preserve existing data and migrations; serialize admission at the database boundary.
DROP INDEX one_non_terminal_meeting;

CREATE INDEX meetings_open_order
ON meetings (created_at) WHERE status IN ('created', 'active', 'grace');

CREATE TRIGGER limit_open_meetings_insert
BEFORE INSERT ON meetings
WHEN NEW.status IN ('created', 'active', 'grace')
  AND (SELECT COUNT(*) FROM meetings WHERE status IN ('created', 'active', 'grace')) >= 3
BEGIN
  SELECT RAISE(ABORT, 'MEETING_LIMIT_REACHED');
END;

CREATE TRIGGER limit_open_meetings_update
BEFORE UPDATE OF status ON meetings
WHEN NEW.status IN ('created', 'active', 'grace')
  AND (SELECT COUNT(*) FROM meetings WHERE status IN ('created', 'active', 'grace') AND id <> OLD.id) >= 3
BEGIN
  SELECT RAISE(ABORT, 'MEETING_LIMIT_REACHED');
END;
