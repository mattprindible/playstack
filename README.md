# playstack

A deliberately small, deliberately framework-free reference for running
**Cloudflare + Supabase + Vercel** together — with real CI/CD, real tests, and
a real deploy on every platform's free tier.

The app is a guestbook: one table, one form, one list. It is trivial on purpose.
Everything worth learning here is the wiring around it.

---

## The one idea

Cloudflare Workers and Vercel Functions have quietly converged on the same
contract: **give me a `Request`, I'll give you back a `Response`.** That is a web
standard, not a vendor API.

So this repo writes the API *once* and runs it on *both*:

```
                     ┌─────────────────────────────┐
                     │  packages/core/src/         │
   the SAME file ───▶│    handler.ts               │
                     │  (Request) => Response      │
                     └──────────┬──────────────────┘
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
   apps/web/api/[...path].ts            apps/worker/src/index.ts
   ~5 lines of glue                     ~10 lines of glue
             │                                     │
             ▼                                     ▼
      ┌─────────────┐                       ┌─────────────┐
      │   VERCEL    │                       │ CLOUDFLARE  │
      └──────┬──────┘                       └──────┬──────┘
             │        both serve the same           │
             │        apps/web/public/              │
             └──────────────┬───────────────────────┘
                            ▼
                   ┌──────────────────┐
                   │     SUPABASE     │
                   │  Postgres + RLS  │
                   └──────────────────┘
```

Open `/api/health` on either deployment. Same code, and it tells you which host
answered. Because the app logic is identical, everything that *does* differ
between the two platforms becomes visible and easy to compare.

---

## Why there is no framework

You asked for fundamentals, so nothing here hides the mechanism:

| Instead of | This repo uses | So you can see |
| --- | --- | --- |
| Next.js | Plain HTML + ES modules | What the browser actually loads |
| An ORM | Plain `.sql` migrations | The real schema and real constraints |
| `supabase-js` | `fetch` against PostgREST | That Supabase's data API is just HTTP |
| Vitest / Jest | `node --test` | A test runner you didn't install |
| A bundler | Node 24 native TS | That TypeScript is types, not a build system |

The cost is real and worth stating: you get no ISR, no image optimization, and
no PPR from Vercel, and you'd feel the absence of a framework on a large app.
For learning the platform boundaries, that's the right trade.

---

## Two things that surprised me while building this

**Node 24 runs `.ts` files directly.** There is no build step anywhere in this
repo. Node strips the type annotations at runtime. `tsc` is still installed, but
only to *check* types in CI (`pnpm typecheck`) — it never emits anything.
`tsconfig.json` sets `erasableSyntaxOnly`, which fails the build if anyone
writes TypeScript that Node *can't* strip, so the no-build promise can't quietly
rot.

**The test suite has zero dependencies.** `node --test` is the runner,
`node:assert` is the assertion library, and `fetch` is faked with a
five-line function. Given supply-chain attacks were part of why you picked pnpm,
the part of the toolchain you run most often costing zero packages is a genuine
win.

---

## Supply-chain posture

You mentioned this as a motivation, so it's explicit rather than incidental.

**`pnpm-workspace.yaml`**

- `minimumReleaseAge: 1440` — refuses any package version published in the last
  24 hours. The classic npm attack is a stolen token publishing a malicious
  patch that gets caught within hours; this sits out that entire window. Highest
  value setting here, one line.
- `allowBuilds:` — install scripts are **blocked by default**. A `postinstall`
  is arbitrary code running the moment you install, and it's how most attacks
  actually land. Three packages are allowed, each with a written reason. When you
  add a dependency and pnpm refuses to build it, check *why* it wants a script
  before adding it — the legitimate answer is nearly always "unpacking a native
  binary".

**Lockfiles are authoritative.** CI uses `pnpm install --frozen-lockfile` and
`uv sync --locked`. Both fail rather than resolve something new.

One honest gap: the GitHub Actions in `.github/workflows/ci.yml` are pinned to
version tags (`@v5`), and tags are mutable. Pinning to full commit SHAs is
stricter and is what I'd recommend before you rely on this in anger.

---

## Layout

```
playstack/
├── packages/core/          ← all the logic, platform-agnostic
│   └── src/
│       ├── handler.ts        the (Request) => Response router
│       ├── handler.test.ts   8 tests, no network, no deps
│       ├── supabase.ts       PostgREST over plain fetch
│       └── env.ts            the one place platforms differ
│
├── apps/web/               ← the Vercel deployment
│   ├── public/               static site (also served by Cloudflare)
│   ├── api/[...path].ts      catch-all Function → core handler
│   └── vercel.ts             typed project config
│
├── apps/worker/            ← the Cloudflare deployment
│   ├── src/index.ts          fetch handler → core handler
│   └── wrangler.jsonc        assets point at ../web/public
│
├── supabase/migrations/    ← the schema AND the security model
├── tools/                  ← uv-managed Python ops CLI
└── .github/workflows/ci.yml
```

---

## Command surface

Each platform's CLI installs **per project**, not globally, so the version is
pinned in a lockfile and CI runs exactly what you run.

```bash
# Everything
pnpm check                  # typecheck + test — run this before pushing
pnpm test                   # node --test
pnpm typecheck              # tsc --noEmit

# Supabase
pnpm exec supabase db push      # apply migrations to the remote database
pnpm exec supabase migration new <name>
pnpm exec supabase gen types typescript --linked   # types from your real schema

# Cloudflare
pnpm --filter @playstack/worker exec wrangler dev
pnpm --filter @playstack/worker exec wrangler deploy
pnpm --filter @playstack/worker exec wrangler secret put SUPABASE_URL
pnpm --filter @playstack/worker exec wrangler tail        # live production logs

# Vercel
pnpm --filter @playstack/web exec vercel dev
pnpm --filter @playstack/web exec vercel deploy --prod
pnpm --filter @playstack/web exec vercel env pull .env    # sync env down

# Python ops
cd tools
uv run playstack-ops status      # health-check every deployment
uv run playstack-ops seed -n 5   # insert sample messages
uv run playstack-ops audit-rls   # prove RLS is actually enforced
```

There's also `cf`, Cloudflare's newer CLI covering the whole platform (DNS,
zones, R2, D1…) rather than just Workers. Worth knowing about:
`cf agent-context --list` emits machine-readable tool definitions per product,
which is built specifically for coding agents.

---

## How secrets flow

The most confusing part of any multi-platform setup, so here it is plainly.

| Where | Holds | Set with |
| --- | --- | --- |
| `.env` (local, gitignored) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | copied from `.env.example` |
| `apps/worker/.dev.vars` | same two, for `wrangler dev` | created by hand |
| Cloudflare | same two, in production | `wrangler secret put` — **once**, they persist |
| Vercel | same two, in production | `vercel env add` |
| GitHub Actions | deploy credentials only | repo secrets |

Note the Worker's secrets live on Cloudflare and are *not* passed through CI. CI
only holds credentials to *deploy*, never the app's own configuration — so a
leaked CI token has a much smaller blast radius.

**About the anon key:** it's designed to be public, and it ships to the browser.
Its power is bounded entirely by Row Level Security. That's the bargain — the key
is public, and the *database* decides what it may do. The `service_role` key is
the opposite: it bypasses RLS completely, and it appears nowhere in this repo.

---

## Row Level Security, and proving it

`supabase/migrations/…_create_messages.sql` enables RLS and then grants exactly
two things: anyone may `select`, anyone may `insert`. There is deliberately **no
update or delete policy** — under deny-by-default, their absence *is* the
enforcement.

Don't take that on faith. `uv run playstack-ops audit-rls` behaves like an
attacker holding your public key: it inserts a canary row, then tries to modify
and delete it, and reports what the database actually allowed.

It leaves the canary row behind — being unable to delete it is the passing
result.

---

## Setup from scratch

```bash
pnpm install
cd tools && uv sync && cd ..

# 1. Supabase
pnpm exec supabase login
pnpm exec supabase projects create playstack --region us-east-1
pnpm exec supabase link --project-ref <ref>
pnpm exec supabase db push

cp .env.example .env        # fill in URL + anon key from the dashboard

# 2. Cloudflare
cd apps/worker
cp ../../.env .dev.vars     # local dev
pnpm exec wrangler secret put SUPABASE_URL
pnpm exec wrangler secret put SUPABASE_ANON_KEY
pnpm exec wrangler deploy

# 3. Vercel
cd ../web
pnpm exec vercel link
pnpm exec vercel env add SUPABASE_URL production
pnpm exec vercel env add SUPABASE_ANON_KEY production
pnpm exec vercel deploy --prod
```

### Optional: fully local Supabase

`pnpm exec supabase start` runs the entire stack — Postgres, PostgREST, Auth,
Studio — in Docker on your machine. It needs Docker, which isn't installed here,
so this project uses the hosted free tier as its dev database instead. Nothing
depends on the local stack: the tests are hermetic (they stub `fetch`), so CI
never needs a database at all.

---

## CI/CD

```
test ──┬─→ migrate ──┬─→ deploy-vercel ──┬─→ verify
       │             └─→ deploy-worker ──┘
       └─ on a PR, stops here
```

`needs:` is what makes tests a gate rather than a suggestion. Migrations run
before the code that depends on them, the two hosts deploy in parallel from the
same commit, and `verify` health-checks the result — because a deploy that
"succeeded" while serving 500s is not a successful deploy.

Required GitHub repo **secrets**: `SUPABASE_DB_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Required **variables**: `VERCEL_URL`, `WORKER_URL`.
