-- #964: self-heal updated_at when a raw SQL UPDATE changes kanban status
-- without bumping the timestamp. The auto-archive sweep uses updated_at to
-- decide when a done card is old enough to archive; a raw status write that
-- leaves updated_at stale would archive the card on the very next page load.
CREATE TRIGGER IF NOT EXISTS kanban_cards_status_bumps_updated_at
AFTER UPDATE OF status ON kanban_cards
FOR EACH ROW WHEN NEW.status != OLD.status AND NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE kanban_cards SET updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = NEW.id;
END;
