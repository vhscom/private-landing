-- Initialize the auth database schema with secure session management

-- Account table: Stores user credentials and profile data
create table if not exists account (
    -- Primary user identifier
    id integer primary key,
    -- Unique login identifier with case-sensitive uniqueness
    email text unique not null,
    -- Password data in format: $pbkdf2-shaXXX$v1$iterations$salt$hash$digest
    password_data text not null,
    -- Creation timestamp in UTC
    created_at text default current_timestamp
);

-- Session table: Manages authenticated user sessions
create table if not exists session (
    -- UUID v4 session identifier
    id text primary key,
    -- References account.id for session ownership
    user_id integer not null,
    -- Security tracking information
    user_agent text not null,
    ip_address text not null,
    -- Session lifecycle management
    expires_at text not null,
    created_at text not null,
    -- Ensures session belongs to valid user
    foreign key (user_id) references account(id)
);

-- Indices for performance optimization
create index if not exists idx_session_user on session(user_id);
create index if not exists idx_session_expiry on session(expires_at);
create index if not exists idx_session_user_expiry on session(user_id, expires_at);