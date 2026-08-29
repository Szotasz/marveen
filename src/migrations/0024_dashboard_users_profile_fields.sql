-- Adds optional profile fields to dashboard_users for the self-service profile page.
-- Both columns are nullable with no DEFAULT so existing rows are unaffected.

ALTER TABLE dashboard_users ADD COLUMN email        TEXT;
ALTER TABLE dashboard_users ADD COLUMN display_name TEXT;
