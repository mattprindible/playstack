# playstack-ops

Operational scripts. Runs locally and in CI; never deployed.

```bash
cd tools
uv sync                         # create .venv from uv.lock, exactly

uv run playstack-ops status     # is everything up?
uv run playstack-ops seed -n 5  # insert sample guestbook messages
uv run playstack-ops audit-rls  # prove RLS is actually enforced
```

`pnpm status` and `pnpm audit:rls` from the repo root do the same thing.

`uv run` syncs the environment before running, so there is no "did I activate
the venv?" step. You never source `activate` in this project. The interpreter
is pinned in `.python-version` (3.14) — that file **must** stay committed, or
CI can resolve a different Python than you do.

## Configuration

Reads the repo-root `.env`; real environment variables win, which is how CI
injects values with no file present.

| Variable | Used by | Required |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | all commands | yes |
| `VERCEL_URL` | `status` | optional |
| `WORKER_URL` | `status` | optional |
| `ACCESS_URL` | `status` | optional |

`status` skips any deployment whose URL is unset, so it degrades quietly rather
than failing.

## What `audit-rls` actually proves

It does not read the policy files and take their word for it. Holding only the
public anon key, it behaves like an attacker: reads, inserts, then tries to
tamper with and delete its own canary row, and checks that the OAuth session
tables are invisible.

The canary row is deliberately left behind — **being unable to delete it is the
passing result.** Removing it requires `service_role`.
