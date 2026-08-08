# playstack

A deliberately small, deliberately framework-free reference for running
**Cloudflare + Supabase + Vercel** together — with real CI/CD, real tests, and
a real deploy on every platform's free tier.

The app is a guestbook: one table, one form, one list. It is trivial on purpose.
Everything worth learning here is the wiring around it.

**Live, from one commit and one shared handler:**

| | URL |
| --- | --- |
| Vercel | https://playstack-nine.vercel.app |
| Cloudflare | https://playstack.service-cloudflare-442.workers.dev |

Both read and write the same Supabase database. Hit `/api/health` on each and it
tells you which host answered.

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

## Three ways to gate the same guestbook

The app logic never changes. `packages/core` takes an optional `Gate` — resolve
a request to a verified identity, or refuse — and everything else follows.

| Variant | Where | Who gets in | Auth code you own |
| --- | --- | --- | --- |
| Public | Worker + Vercel | anyone | none |
| **Cloudflare Access** | `playstack.haha.computer` | emails on a list, via one-time PIN | ~40 lines, all verification |
| **ATProto OAuth** | Vercel | anyone with an ATProto handle | the OAuth client wiring |

When a gate is active the server **overwrites** the submitted name with the
verified identity, so nobody can sign as somebody else. That property has its
own test.

**Access is the striking one.** For a fixed group of friends there is no signup
form, no password, no session table, no reset email — you list addresses in a
policy and Cloudflare authenticates at the edge before your Worker runs. The
best auth implementation is the one you didn't write.

Two things that setup teaches:

- `workers_dev: false` is load-bearing. **Access protects a hostname, not a
  Worker.** Leave the `.workers.dev` route on and your gated app has a public
  back door that never appears in the Access dashboard.
- The Worker verifies the Access JWT itself — issuer *and* audience. Without
  the audience check, a token minted for any other app in your account would be
  accepted. A gate you didn't verify is a gate someone can walk around.

**ATProto is where "collapse everything onto Cloudflare" breaks.** The official
`@atproto/oauth-client-node` does not run on Workers
([issue #3292](https://github.com/bluesky-social/atproto/issues/3292), still
open: no `cache: 'no-cache'`, no `redirect: 'error'`, no DNS for handle
resolution). A community Workers port exists but was ~11 months stale with a
single maintainer — not what you want holding your auth. So the OAuth leg runs
on Vercel with official code, and the Worker stays the app. **That is the
concrete reason both runtimes still exist.**

Its data model is worth copying:

- ATProto tokens and DPoP keys live in Supabase behind `service_role`, in tables
  that are **both** `REVOKE`d from anon **and** RLS-enabled with zero policies.
  Two independent locks, so one mistake isn't enough. `audit-rls` verifies it.
- The browser never receives an ATProto token — only a signed httpOnly cookie
  carrying `did` + `handle`. A Worker can verify that cookie without ever
  holding a refresh token, exactly like the Access gate.
- The DID is the identity; the handle is display only, because handles can be
  reassigned.

### Read the graph, or index the network?

`/api/atproto/me` exists to make this concrete. Reading the signed-in user's own
profile and follows — and writing to their own PDS — costs **one authenticated
request and zero storage of your own**. A Worker and a cookie is a complete
backend for that.

Asking "what did my follows post about X" has no equivalent endpoint. You would
consume the firehose (or Jetstream), store what streams past, and keep it fresh
forever — an always-on service with real cost.

So the question that decides your architecture is not "do I need auth." It is:
**does this app act for one signed-in user, or answer questions about the
network?**

---

## What actually broke (the useful part)

Everything above sounds tidy. It was not. Cloudflare and Supabase deployed
almost immediately; Vercel took five separate fixes, and none of them were
guessable from the docs. If you only read one section, read this one.

**1. Vercel could not read pnpm 11's lockfile.** With `packageManager` set,
pnpm 11 manages itself and writes `packageManagerDependencies` /
`configDependencies` into `pnpm-lock.yaml`. Vercel's parser predates those keys,
logged `Error while parsing config file: pnpm-lock.yaml`, silently fell back to
**npm**, and npm then failed on `workspace:*` — an error three steps removed
from the cause. Fixed with `managePackageManagerVersions: false`.

**2. `vercel.ts` cannot configure a pnpm workspace.** I initially used it
because it is Vercel's current recommendation. It cannot work here: compiling a
TypeScript config requires `@vercel/config` to be installed, so the install runs
*before* any config is read — meaning an `installCommand` inside `vercel.ts` can
never be seen in time. `vercel.json` is parsed directly, with no install.
Reverted to JSON.

**3. pnpm's workspace symlink breaks `--prebuilt` deploys.** pnpm links
`apps/web/node_modules/@playstack/core` to a directory *outside* `apps/web`.
Vercel's builder records that symlink in the function's `filePathMap` but never
uploads it, so deploy fails with `File does not exist` — while the bundle
already contains every compiled file from it. `apps/web` now imports core by
relative path. The Worker keeps the idiomatic workspace import, because wrangler
has no such problem.

**4. Node wants `.ts` specifiers; Vercel emits `.js`.** The no-build-step trick
needs imports written as `./x.ts`. Vercel compiles ahead of time, emits `.js`,
and leaves the specifier saying `.ts` — so the Function died with
`ERR_MODULE_NOT_FOUND`. TypeScript's `rewriteRelativeImportExtensions` rewrites
them on emit only, leaving the source (and `node --test`) untouched.

**5. Vercel treated the Web-standard handler as a Node one.** This was the
expensive one. Vercel picks between `(req, res)` and `(Request) => Response` by
inspecting the export; handed a closure it cannot inspect, it assumes Node. It
then passed an `IncomingMessage` — whose `.url` is a bare path, not a URL — and
waited for a `res.end()` that a returned `Response` never triggers. **The
symptom was not an error but a hang**, up to the 300-second timeout, which looks
identical to a network problem. `apps/web/api/[...path].ts` now does the
Node→Web conversion explicitly.

**6. pnpm's symlinks break `vercel deploy --prebuilt`.** pnpm's isolated linker
is its best feature and Vercel cannot follow it: the deploy walks traced files,
hits a symlink pointing outside the project, and dies with
`File does not exist: "apps/web/node_modules/jose"` — though the package is
installed and the build succeeded. Fixed with `nodeLinker: hoisted`.

What that costs is *strictness*: hoisting makes phantom dependencies silently
work, so a package missing from `package.json` can go unnoticed. What it does
**not** cost is anything supply-chain related — the lockfile, `minimumReleaseAge`
and the `allowBuilds` allow-list are all unaffected.

Two smaller ones worth knowing:

- **Never name a script `dev` or `build` in a Vercel project's package.json if
  it calls the Vercel CLI.** `vercel dev` auto-runs both, so it invokes itself
  and dies with a recursion error. They are namespaced `vercel:build` here.
- **A missing Cloudflare secret surfaces as a bare `error code: 1101`** with no
  clue which variable is absent. The Worker now catches that and returns a 503
  naming it.

The honest lesson: Cloudflare Workers are Web-standard natively and the vanilla
path is the *documented* one, so it just worked. Vercel's vanilla path is fully
supported but not the maintained-and-marketed one, and the sharp edges cluster
where its Node heritage meets Web standards. That is worth knowing before you
pick a host for a framework-free project.

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
│   └── vercel.json           project config (NOT vercel.ts — see above)
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

# Vercel  (build locally, upload only the output — see "What actually broke")
pnpm deploy:vercel                                        # build + deploy, from root
pnpm --filter @playstack/web exec vercel env ls
pnpm --filter @playstack/web exec vercel logs <deployment-url>
pnpm --filter @playstack/web exec vercel curl /api/health  # bypasses SSO on preview URLs

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
| Cloudflare | same two, in production | `wrangler secret put` — **once per Worker**, they persist |
| Vercel | same two, in production | `vercel env add` |
| GitHub Actions | deploy credentials only | repo secrets |

Note the Worker's secrets live on Cloudflare and are *not* passed through CI. CI
only holds credentials to *deploy*, never the app's own configuration — so a
leaked CI token has a much smaller blast radius.

**Secrets are per-Worker, and this bites.** `playstack` and `playstack-access`
are two separate Workers; setting a secret on one does nothing for the other.
Deploying the Access variant looked fine and then 503'd at runtime, because it
had the Access config but no `SUPABASE_URL`. Adding a Worker means adding its
secrets:

```bash
cd apps/worker-access
printf '%s' "$SUPABASE_URL"      | pnpm exec wrangler secret put SUPABASE_URL
printf '%s' "$SUPABASE_ANON_KEY" | pnpm exec wrangler secret put SUPABASE_ANON_KEY
pnpm exec wrangler secret list   # confirm before assuming
```

It surfaced quickly only because `readEnv` names the missing variables in the
response body. A generic "server error" would have sent you reading Access logs
for something that had nothing to do with Access.

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

These are the commands that actually worked, in order.

```bash
pnpm install
cd tools && uv sync && cd ..

# 1. Supabase --------------------------------------------------------------
# `supabase login` needs a TTY; run it in a real terminal, not through a tool.
pnpm exec supabase login
pnpm exec supabase projects create playstack \
  --org-id <org> --region us-east-1 --db-password "$(openssl rand -hex 16)"

# NOTE: `supabase link` and `projects api-keys` are broken in CLI 2.112.0 —
# they reject the API's own timestamp format. Work around both:
#   - migrations: pass --db-url directly (no link required)
#   - anon key:   copy it from the dashboard
# Use the POOLER host. db.<ref>.supabase.co is IPv6-only and refuses IPv4.
pnpm exec supabase db push --db-url \
  "postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres"

cp .env.example .env        # fill in URL + anon key

# 2. Cloudflare ------------------------------------------------------------
cd apps/worker
grep -E '^SUPABASE_(URL|ANON_KEY)=' ../../.env > .dev.vars   # local dev
pnpm exec wrangler deploy                                     # create it first
printf '%s' "$SUPABASE_URL"      | pnpm exec wrangler secret put SUPABASE_URL
printf '%s' "$SUPABASE_ANON_KEY" | pnpm exec wrangler secret put SUPABASE_ANON_KEY

# 3. Vercel ----------------------------------------------------------------
cd ../web
pnpm exec vercel link --yes --project playstack
for e in production preview development; do
  printf '%s' "$SUPABASE_URL"      | pnpm exec vercel env add SUPABASE_URL $e
  printf '%s' "$SUPABASE_ANON_KEY" | pnpm exec vercel env add SUPABASE_ANON_KEY $e
done
pnpm exec vercel pull --yes --environment=production
pnpm exec vercel build --prod
pnpm exec vercel deploy --prebuilt --prod    # --prebuilt is required, not optional
```

**On Vercel URLs:** per-deployment URLs (`playstack-<hash>.vercel.app`) are
protected by Vercel Authentication and will 302 to an SSO login. The stable
production alias (`playstack-nine.vercel.app`) is public. Use
`vercel curl <path>` to test a protected preview URL without disabling
anything.

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
