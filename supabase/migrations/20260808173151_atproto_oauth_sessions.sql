-- ATProto OAuth storage.
--
-- These two tables hold the most sensitive data in the project: refresh tokens
-- and DPoP private keys. Anyone who reads them can act as the signed-in user
-- against their PDS. Contrast with public.messages, where the whole design
-- assumes the anon key is public and RLS decides what it may do.
--
-- Here the intent is the opposite: NOBODY reaches these with the anon key.
-- Access requires the service_role key, which bypasses RLS and lives only in
-- the Vercel Function's environment.

create table public.atproto_states (
  key         text primary key,
  state       jsonb       not null,
  created_at  timestamptz not null default now()
);

create table public.atproto_sessions (
  did         text primary key,
  handle      text        not null,
  session     jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- OAuth states are single-use and short-lived; this supports cleanup.
create index atproto_states_created_at_idx on public.atproto_states (created_at);


-- ---------------------------------------------------------------------------
-- Lock them down. TWO independent mechanisms, deliberately.
--
-- 1. REVOKE removes the grant entirely — the anon role has no privilege on
--    these tables at all, so PostgREST reports them as nonexistent rather than
--    empty.
--
-- 2. RLS with ZERO policies means deny-by-default even if a grant is
--    accidentally restored later by some future migration.
--
-- Either alone would do. Both means a single mistake is not enough to expose
-- refresh tokens. Compare public.messages, which is deliberately readable —
-- the difference between these two files IS the security model.
-- ---------------------------------------------------------------------------
revoke all on public.atproto_states   from anon, authenticated;
revoke all on public.atproto_sessions from anon, authenticated;

alter table public.atproto_states   enable row level security;
alter table public.atproto_sessions enable row level security;

-- No `create policy` statements. That absence is intentional and load-bearing:
-- with RLS on and no policy, every anon/authenticated query matches no rows.
-- service_role bypasses RLS and is the only way in.
--
-- Verify with `uv run playstack-ops audit-rls`, which now checks that the anon
-- key genuinely cannot see these tables.
