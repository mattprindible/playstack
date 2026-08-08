"""The actual operations: seed, audit-rls, status."""

from __future__ import annotations

import os
import random
from datetime import datetime, timezone

import httpx

from .config import Config, load_config

NAMES = [
    "Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson",
    "Radia Perlman", "Barbara Liskov", "Tim Berners-Lee", "Margaret Hamilton",
]

LINES = [
    "Deployed on a Friday. No regrets.",
    "It works on my machine, and now also on yours.",
    "The same handler answered this on two clouds.",
    "Row Level Security is doing the heavy lifting here.",
    "No build step was harmed in the making of this page.",
    "Shipped from a laptop in under an hour.",
]

OK = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
WARN = "\033[33m!\033[0m"


# --------------------------------------------------------------------------
# seed
# --------------------------------------------------------------------------
def seed(count: int) -> int:
    """Insert sample rows so the UI has something to show."""
    config = load_config()
    created = 0

    with httpx.Client(timeout=15.0) as client:
        for _ in range(count):
            payload = {
                "name": random.choice(NAMES),
                "body": random.choice(LINES),
            }
            response = client.post(
                f"{config.rest_url}/messages",
                headers={**config.headers, "Prefer": "return=representation"},
                json=payload,
            )
            if response.status_code >= 400:
                print(f"{FAIL} insert failed ({response.status_code}): {response.text[:200]}")
                return 1
            created += 1
            print(f"{OK} {payload['name']}: {payload['body']}")

    print(f"\nInserted {created} message(s).")
    return 0


# --------------------------------------------------------------------------
# audit-rls
# --------------------------------------------------------------------------
def audit_rls() -> int:
    """Prove Row Level Security is actually enforced.

    This does not read your policy files and take their word for it. It behaves
    like an attacker holding your public anon key and checks what the database
    genuinely permits.
    """
    config = load_config()
    failures = 0

    print("Auditing RLS with the ANON key (what any visitor could do)\n")

    with httpx.Client(timeout=15.0) as client:
        # 1. Reading should be allowed — it is a public guestbook.
        response = client.get(
            f"{config.rest_url}/messages", headers=config.headers, params={"limit": 1}
        )
        if response.status_code == 200:
            print(f"{OK} SELECT permitted (expected — the guestbook is public)")
        else:
            print(f"{FAIL} SELECT blocked ({response.status_code}); the app cannot work")
            return 1

        # 2. Insert a canary we can then try to tamper with.
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        response = client.post(
            f"{config.rest_url}/messages",
            headers={**config.headers, "Prefer": "return=representation"},
            json={"name": "rls-audit", "body": f"canary {stamp}"},
        )
        if response.status_code >= 400:
            print(f"{FAIL} INSERT blocked ({response.status_code}); the app cannot work")
            return 1

        canary = response.json()[0]
        canary_id = canary["id"]
        print(f"{OK} INSERT permitted (expected — anyone may sign)")

        # 3. Tampering must fail. There is no UPDATE policy, so RLS should match
        #    zero rows and change nothing.
        client.patch(
            f"{config.rest_url}/messages",
            headers=config.headers,
            params={"id": f"eq.{canary_id}"},
            json={"body": "TAMPERED"},
        )
        check = client.get(
            f"{config.rest_url}/messages",
            headers=config.headers,
            params={"id": f"eq.{canary_id}", "select": "body"},
        ).json()

        if check and check[0]["body"] == "TAMPERED":
            print(f"{FAIL} UPDATE SUCCEEDED — anyone can rewrite others' messages!")
            failures += 1
        else:
            print(f"{OK} UPDATE denied (no update policy exists)")

        # 4. Deletion must fail too.
        client.delete(
            f"{config.rest_url}/messages",
            headers=config.headers,
            params={"id": f"eq.{canary_id}"},
        )
        still_there = client.get(
            f"{config.rest_url}/messages",
            headers=config.headers,
            params={"id": f"eq.{canary_id}", "select": "id"},
        ).json()

        if still_there:
            print(f"{OK} DELETE denied (no delete policy exists)")
        else:
            print(f"{FAIL} DELETE SUCCEEDED — anyone can erase the guestbook!")
            failures += 1

        # 5. The OAuth tables hold refresh tokens and DPoP private keys. The
        #    anon key must not see them AT ALL — not an empty list, not a 401,
        #    but a 404, because the tables are REVOKEd rather than merely
        #    policy-filtered. PostgREST then reports them as nonexistent, which
        #    leaks nothing about what this project stores.
        for table in ("atproto_states", "atproto_sessions"):
            probe = client.get(
                f"{config.rest_url}/{table}",
                headers=config.headers,
                params={"select": "*", "limit": 1},
            )
            if probe.status_code == 200:
                print(f"{FAIL} {table} IS READABLE with the anon key — refresh tokens exposed!")
                failures += 1
            elif probe.status_code == 404:
                print(f"{OK} {table} invisible to anon (404, not an empty list)")
            else:
                print(f"{OK} {table} blocked to anon (HTTP {probe.status_code})")

    print()
    if failures:
        print(f"{FAIL} {failures} RLS check(s) FAILED. Review supabase/migrations/.")
        return 1

    print(
        f"{OK} RLS enforced.\n\n"
        f"  The canary row (id={canary_id}) is deliberately left behind: being\n"
        f"  unable to delete it is the proof. Removing it requires the\n"
        f"  service_role key, which bypasses RLS and lives only in the dashboard."
    )
    return 0


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------
def _probe(client: httpx.Client, label: str, url: str) -> bool:
    try:
        response = client.get(url, timeout=10.0)
    except httpx.RequestError as error:
        print(f"{FAIL} {label:<12} unreachable ({type(error).__name__})")
        return False

    if response.status_code != 200:
        print(f"{FAIL} {label:<12} HTTP {response.status_code}  {url}")
        return False

    try:
        platform = response.json().get("platform", "?")
    except ValueError:
        platform = "?"

    print(f"{OK} {label:<12} healthy, served by '{platform}'  {url}")
    return True


def status() -> int:
    """Check every deployment that has a URL configured."""
    targets = [
        ("vercel", os.environ.get("VERCEL_URL")),
        ("cloudflare", os.environ.get("WORKER_URL")),
    ]

    configured = [(label, url) for label, url in targets if url]
    if not configured:
        print(
            f"{WARN} No deployment URLs set.\n"
            f"  Export VERCEL_URL and/or WORKER_URL, or add them to .env."
        )
        return 0

    healthy = True
    with httpx.Client(follow_redirects=True) as client:
        for label, url in configured:
            base = url if url.startswith("http") else f"https://{url}"
            healthy &= _probe(client, label, f"{base.rstrip('/')}/api/health")

    # Supabase itself, via the same REST endpoint the apps use.
    try:
        config = load_config()
    except Exception as error:  # noqa: BLE001 - surface config problems plainly
        print(f"{WARN} supabase    not configured: {error}")
        return 0 if healthy else 1

    with httpx.Client() as client:
        response = client.get(
            f"{config.rest_url}/messages",
            headers=config.headers,
            params={"select": "id", "limit": 1},
            timeout=10.0,
        )
        if response.status_code == 200:
            print(f"{OK} {'supabase':<12} reachable, RLS-scoped read OK")
        else:
            print(f"{FAIL} {'supabase':<12} HTTP {response.status_code}")
            healthy = False

    return 0 if healthy else 1
