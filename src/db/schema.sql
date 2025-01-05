-- Creates the accounts table if it doesn't exist
create table if not exists accounts (
    id integer primary key,
    email text unique not null,
    password_hash text not null,
    salt text not null,
    created_at text default current_timestamp
);