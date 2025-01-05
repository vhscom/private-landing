-- Migration to combine password fields
-- First create temporary table with new structure
create table accounts_new
(
    id            integer primary key,
    email         text unique not null,
    password_data text        not null,
    created_at    text default current_timestamp
);

-- If we had existing data, we'd migrate it here
-- insert into accounts_new (id, email, password_data, created_at)
-- select id, email, '$pbkdf2-sha384$v1$100000$' || salt || '$' || password_hash, created_at
-- from accounts;

-- Drop old table
drop table if exists accounts;

-- Rename new table to accounts
alter table accounts_new rename to accounts;