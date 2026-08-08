-- Make the DATABASE enforce who signed the guestbook.
--
-- Until now, attribution was enforced in application code: the handler
-- overwrote `name` with the verified identity before inserting. That is
-- correct, and it was also the only thing standing there. The database itself
-- said:
--
--   create policy "anyone may sign the guestbook"
--     on public.messages for insert to anon with check (true);
--
-- Anything holding the anon key could write any name it liked. While an
-- ungated deployment existed, that was reachable by anyone on the internet.
-- With the gates in place it still meant a leaked anon key could forge entries
-- indistinguishable from real ones.
--
-- After this migration, the anon role cannot touch this table at all, and a
-- signed-in caller can only insert rows that match the claims in their own
-- token. Forging an entry now requires the SIGNING KEY, not a bearer key.


-- ---------------------------------------------------------------------------
-- 1. Attribution columns.
--
--   subject — the stable verified id (an ATProto DID, an Access user UUID).
--             Never displayed. This is what the policy checks.
--   gate    — which gate vouched. Recorded so a row can be traced back to the
--             mechanism that admitted it, and so one gate cannot mint rows
--             claiming to have come through the other.
--
-- Existing rows predate attribution. They are backfilled honestly rather than
-- being given a plausible-looking owner: 'legacy:unattributed' is the truth,
-- and a row you cannot vouch for should say so.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column subject text,
  add column gate    text;

update public.messages
   set subject = 'legacy:unattributed',
       gate    = 'none'
 where subject is null;

alter table public.messages
  alter column subject set not null,
  alter column gate    set not null;

create index messages_subject_idx on public.messages (subject);


-- ---------------------------------------------------------------------------
-- 2. Replace the old policies.
-- ---------------------------------------------------------------------------
drop policy "anyone may sign the guestbook"     on public.messages;
drop policy "messages are readable by everyone" on public.messages;


-- ---------------------------------------------------------------------------
-- 3. GRANTS — a different layer from policies, and the one that bites.
--
-- Supabase grants ALL privileges on new public tables to anon and
-- authenticated by default. RLS then filters rows, which is why the guestbook
-- behaved correctly despite those grants: with no UPDATE policy, an UPDATE
-- matches zero rows and changes nothing.
--
-- TRUNCATE is the exception, and it is worth understanding rather than just
-- fixing. **TRUNCATE is not row-level at all, so RLS never sees it.** It
-- answers only to the grant. Verified against this database: as `anon`, with
-- every policy in place, `truncate public.messages` emptied the table.
--
-- It was not reachable over HTTP — PostgREST exposes no TRUNCATE verb and this
-- project has no RPC functions — so this was a latent hole rather than a live
-- one. It becomes live the day anyone adds a SECURITY DEFINER function. Least
-- privilege costs one line, so take it.
--
-- The rule: policies decide WHICH ROWS you may touch. Grants decide whether
-- you may touch the table at all. You need both, and a few commands answer
-- only to grants.
-- ---------------------------------------------------------------------------
revoke all on public.messages from anon;

revoke all on public.messages from authenticated;
grant select, insert on public.messages to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The new policies.
--
-- NOTE the use of `auth.jwt() ->> 'sub'` rather than `auth.uid()`.
--
-- auth.uid() is defined as ((request.jwt.claims ->> 'sub')::uuid) — it CASTS
-- TO UUID. Our subjects are ATProto DIDs ('did:plc:…'), which are not UUIDs,
-- so auth.uid() raises `invalid input syntax for type uuid` and the policy
-- errors instead of denying. Verified the hard way against this database.
--
-- If your identities do not come from Supabase Auth, reach for auth.jwt(),
-- which returns the claims as jsonb and keeps `sub` as text.
-- ---------------------------------------------------------------------------
create policy "signed-in readers only"
  on public.messages
  for select
  to authenticated
  using (true);

create policy "you may only sign as yourself"
  on public.messages
  for insert
  to authenticated
  with check (
    -- The row must be attributed to the token's own subject...
    subject = auth.jwt() ->> 'sub'
    -- ...through the gate that token was minted by...
    and gate = auth.jwt() ->> 'gate'
    -- ...and displayed under the label that gate verified. `left(...)` mirrors
    -- the handler truncating a long email or handle to the column's 50-char
    -- limit, so a legitimate long identity is not locked out.
    and name = left(auth.jwt() ->> 'label', 50)
  );

-- Still deliberately NO update or delete policy. Deny-by-default means their
-- absence is the enforcement.
--
-- Verify all of this with `uv run playstack-ops audit-rls`, which now checks
-- that anon is refused outright, that a minted token cannot write as somebody
-- else, and that TRUNCATE is no longer granted.
