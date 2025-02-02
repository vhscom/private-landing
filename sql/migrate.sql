-- Migration: Combine password fields and add session support
-- Changes:
-- 1. Consolidate password storage into single field
-- 2. Add session management table
-- 3. Update foreign key relationships

-- Create temporary account table with new structure
create table account_new (
    id integer primary key,
    email text unique not null,
    -- Combined password data format: $pbkdf2-shaXXX$v1$iterations$salt$hash$digest
    password_data text not null,
    created_at text default current_timestamp
);

-- Migration path for existing data (commented for reference)
-- insert into account_new (id, email, password_data, created_at)
-- select id, email,
--        '$pbkdf2-sha384$v1$100000$' || salt || '$' || password_hash,
--        created_at
-- from account;

-- Replace old table
drop table if exists account;
alter table account_new rename to account;

-- Add session management
create table if not exists session (
    id text primary key,
    user_id integer not null,
    user_agent text not null,
    ip_address text not null,
    expires_at text not null,
    created_at text not null,
    foreign key (user_id) references account(id)
);
