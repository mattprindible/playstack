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
| `SUPABASE_JWT_KID`, `SUPABASE_JWT_PRIVATE_KEY` | `seed`; `audit-rls` pass 2 | see below |
| `VERCEL_URL` | `status` | optional |
| `ACCESS_URL` | `status` | optional |

`status` skips any deployment whose URL is unset, so it degrades quietly rather
than failing.

## What `audit-rls` actually proves

It does not read the policy files and take their word for it. It behaves like
an attacker and checks what the database genuinely permits, in two passes.

**Pass 1 — holding only the public anon key.** The honest answer is now
*nothing at all*: anon has no grants on `public.messages`, so it cannot even
read. It also presents a token with perfect claims and a bogus signature, which
must be refused — that check is what makes the anon key being public costless.
This pass needs no secrets and is the one that matters, because it is what a
stranger can reach.

**Pass 2 — holding a token minted from the signing key.** Verifies that a real
caller can read and write *as themselves*, and cannot write as another subject,
another display name, or another gate. Skipped with a warning if the signing
key is not configured locally.

Pass 2 then covers ownership, which is where the expectations recently
inverted: an author **can** now edit and delete their own entry, **cannot**
change anything but its body, and **cannot** touch anybody else's.

Two of those are checked in an unusual way, because RLS filters rather than
refusing. A stranger's edit comes back looking like a success — it simply
matched no rows — so the audit re-reads the row and asserts it did not move,
rather than trusting a status code. Likewise the immutable columns are pinned
by a trigger, not a policy, so tampering is *accepted and ignored*: the pass
condition is "the statement succeeded and changed nothing it shouldn't."

A side effect worth having: the audit now cleans up after itself. Every run
before this left its canary row in the guestbook, because deletion was
impossible by design.

`seed` needs the signing key too. Since the migration there is no way to insert
a row that nobody vouched for, so seeded messages are attributed to an
obviously synthetic `seed:` subject rather than passed off as real people.
