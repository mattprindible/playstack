-- Guestbook schema.
--
-- This file is the whole "backend" in the traditional sense. There is no ORM
-- and no model layer: the table definition, the constraints and the access
-- rules all live here, in plain Postgres, and Supabase just exposes them.
--
-- Migrations are applied in filename order and are never edited once pushed.
-- To change something, add a NEW migration.

create table public.messages (
  id          bigint generated always as identity primary key,
  name        text        not null,
  body        text        not null,
  created_at  timestamptz not null default now(),

  -- The API validates these too (packages/core/src/handler.ts), but the
  -- database gets the final say. Anything holding a valid key can talk to
  -- PostgREST directly, so client-side validation is a convenience, never a
  -- control.
  constraint messages_name_length check (char_length(trim(name)) between 1 and 50),
  constraint messages_body_length check (char_length(trim(body)) between 1 and 500)
);

-- The API always reads newest-first; this index makes that ordering cheap.
create index messages_created_at_idx on public.messages (created_at desc);


-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- THE IMPORTANT PART. Without `enable row level security`, the anon key can
-- read and write every row in this table. RLS flips the table to deny-by-
-- default, after which nothing is permitted unless a policy below allows it.
--
-- `anon` is the role your public API key maps to. `authenticated` is a
-- logged-in user. We grant both the same rights here because a guestbook is
-- public by design.
-- ---------------------------------------------------------------------------
alter table public.messages enable row level security;

create policy "messages are readable by everyone"
  on public.messages
  for select
  to anon, authenticated
  using (true);

create policy "anyone may sign the guestbook"
  on public.messages
  for insert
  to anon, authenticated
  with check (true);

-- Deliberately NO update or delete policy.
--
-- Deny-by-default means their absence is the enforcement: a visitor cannot
-- edit or remove somebody else's message, and we did not have to write a rule
-- saying so. Verify this yourself with `uv run playstack-ops audit-rls`.
