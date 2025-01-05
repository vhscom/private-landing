-- Initialize the auth database schema
-- Creates the accounts table if it doesn't exist with:
-- - Unique email constraint
-- - Combined password data field storing format: $algorithm$version$iterations$salt$hash$digest
-- - Automatic timestamp on creation
create table if not exists account (
    id integer primary key,
    email text unique not null,
    -- Combined field for all password verification data
    password_data text not null,
    -- Keeping separate fields commented for reference/future use
    -- password_hash text not null,
    -- salt text not null,
    -- digest text,
    created_at text default current_timestamp
);