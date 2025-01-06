-- Reset database for testing/development
-- WARNING: Destroys all data and schema

-- Drop tables in correct order to handle foreign keys
drop table if exists session;
drop table if exists account;

-- Clear any indices (commented for reference)
-- drop index if exists idx_account_email;
-- drop index if exists idx_session_user;
-- drop index if exists idx_session_expiry;

-- Clear any triggers (commented for reference)
-- drop trigger if exists account_updated_at;
-- drop trigger if exists session_cleanup;