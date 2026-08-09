-- Let people edit and delete their OWN entries — and nothing else.
--
-- Every prior migration in this directory ends by pointing out that there is
-- deliberately no UPDATE or DELETE policy, and that their absence is the
-- enforcement. That was true and it was the right default. This migration
-- supersedes those notes rather than editing them: migrations are applied in
-- filename order and are never rewritten once pushed, so the honest record is
-- an old file that was correct when written plus a new file that says what
-- changed.
--
-- What makes this worth reading is that the obvious version of it is wrong in
-- two different ways, and Postgres tells you about neither.


-- ---------------------------------------------------------------------------
-- 1. An edit should admit that it was an edit.
--
-- Nullable, and no backfill: every existing row genuinely has never been
-- edited, so NULL is the truth. Compare the `legacy:unattributed` backfill in
-- the attribution migration — there, NULL had to become something, because
-- "unknown author" is a fact worth recording. Here, "never edited" already has
-- a perfectly good representation.
--
-- Nothing may set this column but the database itself. See the trigger below.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column edited_at timestamptz;


-- ---------------------------------------------------------------------------
-- 2. Grants, again — the layer that is not row-level.
--
-- `authenticated` currently holds exactly SELECT and INSERT. Policies cannot
-- grant what the role does not have, so without this line every UPDATE and
-- DELETE fails on privileges before any policy is consulted, and the error
-- names the table rather than the policy — which sends you debugging the wrong
-- file.
--
-- Still narrow, still no TRUNCATE. The reason is in the attribution migration:
-- TRUNCATE is not row-level, so RLS never sees it and it answers only to the
-- grant. `grant all` here would hand every signed-in visitor the ability to
-- empty the guestbook, with every policy below still perfectly intact.
-- ---------------------------------------------------------------------------
grant update, delete on public.messages to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The policies.
--
-- THE FIRST TRAP: an UPDATE policy has two halves, and they answer different
-- questions.
--
--   using      — which EXISTING rows may this statement target?
--                Evaluated against the row as it is now.
--   with check — what may the row look like AFTERWARDS?
--                Evaluated against the row as it will be written.
--
-- Omit `with check` and Postgres does not complain: it silently reuses `using`
-- for both. That sounds like a safe default and is not. `using` here asks only
-- "is this row yours" — a question the edited row still answers yes to after
-- you have changed the name on it. The INSERT policy goes to real trouble to
-- pin `name` to the gate-verified label so nobody can sign as somebody else;
-- an UPDATE policy without its own `with check` reopens exactly that hole one
-- statement later. Insert honestly, then edit into a forgery.
--
-- So the check is spelled out in full, and it is deliberately the same three
-- clauses the INSERT policy uses. Two policies enforcing one invariant should
-- look identical, so that a reader can see they are the same rule.
-- ---------------------------------------------------------------------------
create policy "you may only edit your own entry"
  on public.messages
  for update
  to authenticated
  using (
    subject = auth.jwt() ->> 'sub'
    and gate = auth.jwt() ->> 'gate'
  )
  with check (
    subject = auth.jwt() ->> 'sub'
    and gate = auth.jwt() ->> 'gate'
    and name = left(auth.jwt() ->> 'label', 50)
  );

-- DELETE takes NO `with check`, and cannot — there is no resulting row to
-- check. `using` is the whole policy. That asymmetry is not an inconsistency:
-- `with check` exists to constrain what you write, and a delete writes nothing.
create policy "you may only delete your own entry"
  on public.messages
  for delete
  to authenticated
  using (
    subject = auth.jwt() ->> 'sub'
    and gate = auth.jwt() ->> 'gate'
  );


-- ---------------------------------------------------------------------------
-- 4. THE SECOND TRAP: `with check` cannot see the old row.
--
-- The policy above stops you changing `name`, because it pins name to a value
-- derived from your token. Now try to express "you may not change
-- `created_at`" the same way. You cannot. There is no token claim to compare a
-- timestamp against, and `with check` is handed only the NEW row — OLD is not
-- in scope. RLS can constrain what a row IS. It cannot constrain what a row
-- CHANGED FROM.
--
-- So an edit could otherwise silently backdate itself, or null out `edited_at`
-- to hide that it happened. Neither is a security hole, both are lies, and
-- this project's whole position is that the database gets the final say rather
-- than the handler promising to behave.
--
-- A BEFORE UPDATE trigger is the tool that does see both rows. Assigning OLD
-- values back onto NEW pins the immutable columns no matter what PostgREST was
-- asked to write — the update succeeds, it just cannot touch them. Only `body`
-- survives from the incoming row.
--
-- Note what is NOT here: `security definer`. This function needs no privileges
-- beyond the caller's — it only rewrites a row already in flight — and the
-- attribution migration explains why gratuitous SECURITY DEFINER functions are
-- what turn a loose grant into a live hole. INVOKER is the boring, correct
-- choice; `set search_path` keeps it from resolving anything unexpected.
--
-- Ordering, since it decides whether any of this works: BEFORE ROW triggers
-- run first, and the policy's `with check` is evaluated on what they produce.
-- The trigger therefore hands the check a row that already satisfies it. That
-- makes the two genuinely belt and braces — drop the trigger and the policy
-- still refuses a forged name; drop the policy and the trigger still pins it.
-- ---------------------------------------------------------------------------
create function public.messages_pin_immutable_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Everything except `body` is restored to what it already was. An edit
  -- changes what you said, never who said it or when.
  new.id         := old.id;
  new.name       := old.name;
  new.subject    := old.subject;
  new.gate       := old.gate;
  new.created_at := old.created_at;

  -- Stamped by the database, so it can be neither forged nor suppressed. The
  -- API never sends this column and could not usefully lie about it if it did.
  new.edited_at  := now();

  return new;
end;
$$;

create trigger messages_pin_immutable_columns
  before update on public.messages
  for each row
  execute function public.messages_pin_immutable_columns();


-- ---------------------------------------------------------------------------
-- 5. What is still refused, and by what.
--
--   editing someone else's entry   — policy `using`, on the old row
--   renaming your own entry        — policy `with check`, AND the trigger
--   backdating your own entry      — the trigger (RLS structurally cannot)
--   hiding that you edited         — the trigger
--   emptying the table             — the grant, which withholds TRUNCATE
--   anything at all as `anon`      — the revoke in the attribution migration
--
-- Six rules, four mechanisms, and the interesting part is that no single one of
-- them could have carried the others. `uv run playstack-ops audit-rls` proves
-- each independently.
-- ---------------------------------------------------------------------------
