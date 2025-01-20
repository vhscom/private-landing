export const RESET_SQL = `
drop table if exists session;
drop table if exists account;`;

export const SCHEMA_SQL = `
create table if not exists account (
  id integer primary key,
  email text unique not null,
  password_data text not null,
  created_at text default current_timestamp
);

create table if not exists session (
  id text primary key,
  user_id integer not null references account(id),
  user_agent text not null,
  ip_address text not null,
  expires_at text not null,
  created_at text not null
);

create index if not exists idx_session_user on session(user_id);
create index if not exists idx_session_expiry on session(expires_at);
create index if not exists idx_session_user_expiry on session(user_id, expires_at);`;

export const TEST_USER_SQL = `
INSERT INTO account (id, email, password_data, created_at)
VALUES (1, 'test@example.com', '$pbkdf2-sha384$v1$100000$fW5ySXH4aQnPKYK8b7lGcA==$xE6bLhkhkXbmhMGYYInoBXOdHGZwzkpUtNdKcM0OjwSxi7oh0OfBl18OnAE4aNQe$KDLmfcH0/kcSIYmpc9vlE2LPtHCCB7ew234vojdYGfpW3H49nd3fISuDZ24uMRKr', '2025-01-20 04:10:35');`;
