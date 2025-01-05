-- Reset the database for testing
-- Drops the account table and any associated data
drop table if exists account;

-- Clear any related indices or triggers we might add later
-- drop index if exists idx_accounts_email;
-- drop trigger if exists accounts_updated_at;