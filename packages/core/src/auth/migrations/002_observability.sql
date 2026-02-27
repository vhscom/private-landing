-- 002_observability.sql
-- Observability tables for structured security events and agent credentials (ADR-008)
-- Documentation-only — actual schema is created lazily by ensureSchema() in
-- packages/observability/src/schema.ts using create table if not exists.
-- This file exists for reference and manual migration workflows.

-- Security event table: Durable, queryable records of security-relevant actions
create table if not exists security_event (
    -- Auto-incrementing identifier (creates sqlite_sequence tracking table)
    id integer primary key autoincrement,
    -- Well-known event type (e.g. login.success, rate_limit.reject)
    type text not null,
    -- Source IP address of the request
    ip_address text not null,
    -- References account.id when event is user-attributable
    user_id integer,
    -- Request User-Agent header
    user_agent text,
    -- HTTP response status code
    status integer,
    -- Untyped JSON payload for event-specific context
    detail text,
    -- Creation timestamp in UTC
    created_at text not null default (datetime('now')),
    -- Attribution: 'app:private-landing' or 'agent:<name>'
    actor_id text not null default 'app:private-landing'
);

-- Indices for event query filtering
create index if not exists idx_security_event_type on security_event(type);
create index if not exists idx_security_event_created on security_event(created_at);
create index if not exists idx_security_event_user on security_event(user_id);
create index if not exists idx_security_event_ip on security_event(ip_address);

-- Agent credential table: Non-human principals for /ops API access
create table if not exists agent_credential (
    -- Auto-incrementing identifier
    id integer primary key autoincrement,
    -- Unique agent name used as identifier
    name text not null unique,
    -- SHA-256 hash of the 256-bit random API key (raw key never stored)
    key_hash text not null,
    -- Access level: 'read' for queries, 'write' for mutations
    trust_level text not null default 'read' check (trust_level in ('read', 'write')),
    -- Optional human-readable description
    description text,
    -- Creation timestamp in UTC
    created_at text not null default (datetime('now')),
    -- Soft-revocation timestamp (null = active)
    revoked_at text
);

-- Partial index: only active (non-revoked) agents need fast lookup
create index if not exists idx_agent_credential_name
    on agent_credential(name) where revoked_at is null;
