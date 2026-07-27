-- Migration 0003: add install_id to device_keys
--
-- Links a device key to its SSH authorized_keys entry so that revoking the
-- dashboard credential also removes the corresponding SSH access in one
-- atomic operation. Bridge-paired keys (enrolled via the dashboard UI or
-- the remote-access-enroll CLI with an explicit install_id) carry the UUID;
-- keys minted without an enrollment context have NULL and are unaffected by
-- the SSH cleanup path.
--
-- Nullable because existing rows pre-date the column and must not be
-- forced to acquire an installId they never had.

ALTER TABLE device_keys ADD COLUMN install_id TEXT;
