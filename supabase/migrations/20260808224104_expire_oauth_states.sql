-- Expire abandoned OAuth states.
--
-- `/api/atproto/login` is UNAUTHENTICATED — it has to be, since it is how you
-- sign in. Every call resolves a handle over the network, generates a DPoP
-- keypair, and INSERTs a row into atproto_states using service_role.
--
-- Successful logins delete their own state at the callback. Abandoned ones —
-- somebody closing the tab, or a script calling the endpoint in a loop —
-- accumulated forever. The original migration even added an index on
-- created_at and said it "supports cleanup", but nothing ever did the
-- cleaning. A comment promising work that does not exist is worse than no
-- comment: it reads like the problem is handled.
--
-- This is the shape of hobby-project risk that actually matters. Nobody steals
-- anything; your free-tier database fills up because an endpoint was free to
-- call and nothing ever swept up.


-- ---------------------------------------------------------------------------
-- The sweep itself.
--
-- Ten minutes is generous: an OAuth round trip is seconds, and the state is
-- useless once the callback has run. SECURITY DEFINER so it runs as the owner
-- regardless of caller, and an empty search_path so nothing can be shadowed by
-- a caller-controlled schema — the standard hardening for a definer function,
-- and the reason to write `public.atproto_states` in full below.
-- ---------------------------------------------------------------------------
create or replace function public.expire_atproto_states()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.atproto_states
   where created_at < now() - interval '10 minutes';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Nobody reaches this over the API. It is called by the schedule below, and by
-- the login route through service_role, which bypasses grants anyway.
revoke all on function public.expire_atproto_states() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Run it on a schedule, so cleanup does not depend on anybody visiting.
--
-- pg_cron is available on Supabase but not installed by default. If the
-- extension cannot be created (a plan or platform that lacks it), the DO block
-- below leaves the function in place and says so: the login route ALSO sweeps
-- opportunistically, so expiry still happens either way. Two mechanisms,
-- neither of which is load-bearing alone.
-- ---------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;

  -- Unschedule first so re-running this migration is safe.
  perform cron.unschedule('expire-atproto-states')
   where exists (select 1 from cron.job where jobname = 'expire-atproto-states');

  perform cron.schedule(
    'expire-atproto-states',
    '*/15 * * * *',
    $sql$select public.expire_atproto_states()$sql$
  );

  raise notice 'pg_cron scheduled: expire-atproto-states every 15 minutes';
exception
  when others then
    raise notice 'pg_cron unavailable (%); relying on opportunistic cleanup in the login route', sqlerrm;
end;
$$;
