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
    """Insert sample rows so the UI has something to show.

    Seeded rows are attributed to a clearly synthetic subject rather than being
    passed off as real people. The database would refuse them otherwise: since
    the attributed-messages migration there is no way to insert a row that
    nobody vouched for, and that is the feature, not an obstacle.
    """
    config = load_config()
    created = 0

    with httpx.Client(timeout=15.0) as client:
        for _ in range(count):
            name = random.choice(NAMES)
            subject = f"seed:{name.lower().replace(' ', '-')}"
            payload = {
                "name": name,
                "body": random.choice(LINES),
                "subject": subject,
                "gate": "seed",
            }
            response = client.post(
                f"{config.rest_url}/messages",
                headers={
                    **config.signed_headers(subject, "seed", name),
                    "Prefer": "return=representation",
                },
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
    """Prove the database — not the application — enforces who may write.

    This does not read your policy files and take their word for it. It behaves
    like an attacker and checks what the database genuinely permits, in two
    passes:

      1. Holding only the public anon key. Since the attributed-messages
         migration the honest answer is "nothing at all": anon has no grants on
         public.messages, so it cannot even read.

      2. Holding a token minted from the signing key. This half is skipped if
         the key is not configured locally, because the FIRST half is the one
         that matters — it is what a stranger can reach.
    """
    config = load_config()
    failures = 0

    print("Pass 1 — holding only the public anon key\n")

    with httpx.Client(timeout=15.0) as client:
        # Anon used to be able to read and insert. Both must now be refused
        # outright: the grant is gone, so this is a permission error rather
        # than an empty result.
        probe = client.get(
            f"{config.rest_url}/messages", headers=config.headers, params={"limit": 1}
        )
        if probe.status_code == 200:
            print(f"{FAIL} anon can still READ the guestbook (HTTP 200)")
            failures += 1
        else:
            print(f"{OK} anon cannot read messages (HTTP {probe.status_code})")

        probe = client.post(
            f"{config.rest_url}/messages",
            headers=config.headers,
            json={"name": "rls-audit", "body": "canary", "subject": "x", "gate": "none"},
        )
        if probe.status_code < 400:
            print(f"{FAIL} anon can still WRITE to the guestbook (HTTP {probe.status_code})")
            failures += 1
        else:
            print(f"{OK} anon cannot write messages (HTTP {probe.status_code})")

        # A token with perfect claims but the wrong signature. This is what
        # separates "holding a key" from "holding THE key" — and it is why the
        # anon key being public costs nothing.
        forged = (
            "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiJkaWQ6cGxjOmF0dGFja2VyIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ."
            "ZmFrZS1zaWduYXR1cmUtdGhhdC1zaG91bGQtbmV2ZXItdmVyaWZ5"
        )
        probe = client.get(
            f"{config.rest_url}/messages",
            headers={**config.headers, "Authorization": f"Bearer {forged}"},
            params={"limit": 1},
        )
        if probe.status_code == 200:
            print(f"{FAIL} a FORGED token was accepted — signature verification is broken!")
            failures += 1
        else:
            print(f"{OK} a forged token is rejected (HTTP {probe.status_code})")

        # The OAuth tables hold refresh tokens and DPoP private keys. The anon
        # key must not see them AT ALL — not an empty list, but a hard refusal,
        # because the tables are REVOKEd rather than merely policy-filtered.
        for table in ("atproto_states", "atproto_sessions"):
            probe = client.get(
                f"{config.rest_url}/{table}",
                headers=config.headers,
                params={"select": "*", "limit": 1},
            )
            if probe.status_code == 200:
                print(f"{FAIL} {table} IS READABLE with the anon key — refresh tokens exposed!")
                failures += 1
            else:
                print(f"{OK} {table} invisible to anon (HTTP {probe.status_code})")

        # ------------------------------------------------------------------
        # Pass 2 — holding a legitimately minted token.
        # ------------------------------------------------------------------
        if not (config.jwt_kid and config.jwt_private_jwk):
            print(
                f"\n{WARN} Pass 2 skipped: no signing key configured locally.\n"
                f"  Set SUPABASE_JWT_KID and SUPABASE_JWT_PRIVATE_KEY to check\n"
                f"  that a real token can only write as itself."
            )
        else:
            print("\nPass 2 — holding a token minted from the signing key\n")
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            me = "audit:self"
            mine = config.signed_headers(me, "audit", "rls-audit")

            probe = client.get(
                f"{config.rest_url}/messages", headers=mine, params={"limit": 1}
            )
            if probe.status_code == 200:
                print(f"{OK} a signed-in caller CAN read")
            else:
                print(f"{FAIL} a signed-in caller cannot read (HTTP {probe.status_code}); the app is broken")
                failures += 1

            probe = client.post(
                f"{config.rest_url}/messages",
                headers={**mine, "Prefer": "return=representation"},
                json={
                    "name": "rls-audit",
                    "body": f"canary {stamp}",
                    "subject": me,
                    "gate": "audit",
                },
            )
            if probe.status_code == 201:
                canary_id = probe.json()[0]["id"]
                print(f"{OK} a signed-in caller can write AS THEMSELVES")
            else:
                canary_id = None
                print(f"{FAIL} a signed-in caller cannot write (HTTP {probe.status_code}); the app is broken")
                failures += 1

            # THE point of the whole migration: the token says who you are, and
            # the row has to agree. Impersonation is refused by Postgres, not
            # by the handler being careful.
            impersonations = [
                ("another subject", {"subject": "did:plc:somebody-else", "gate": "audit", "name": "rls-audit"}),
                ("another display name", {"subject": me, "gate": "audit", "name": "Someone Important"}),
                ("another gate", {"subject": me, "gate": "cloudflare-access", "name": "rls-audit"}),
            ]
            for what, row in impersonations:
                probe = client.post(
                    f"{config.rest_url}/messages", headers=mine, json={**row, "body": "impersonation"}
                )
                if probe.status_code < 400:
                    print(f"{FAIL} a signed-in caller COULD write as {what}!")
                    failures += 1
                else:
                    print(f"{OK} cannot write as {what} (HTTP {probe.status_code})")

            if canary_id is not None:
                client.patch(
                    f"{config.rest_url}/messages",
                    headers=mine,
                    params={"id": f"eq.{canary_id}"},
                    json={"body": "TAMPERED"},
                )
                check = client.get(
                    f"{config.rest_url}/messages",
                    headers=mine,
                    params={"id": f"eq.{canary_id}", "select": "body"},
                ).json()
                if check and check[0]["body"] == "TAMPERED":
                    print(f"{FAIL} UPDATE SUCCEEDED — a signer can rewrite their own history!")
                    failures += 1
                else:
                    print(f"{OK} cannot edit even their OWN row (no update policy)")

                client.delete(
                    f"{config.rest_url}/messages", headers=mine, params={"id": f"eq.{canary_id}"}
                )
                still = client.get(
                    f"{config.rest_url}/messages",
                    headers=mine,
                    params={"id": f"eq.{canary_id}", "select": "id"},
                ).json()
                if still:
                    print(f"{OK} cannot delete even their OWN row (no delete policy)")
                else:
                    print(f"{FAIL} DELETE SUCCEEDED — the guestbook is erasable!")
                    failures += 1

    print()
    if failures:
        print(f"{FAIL} {failures} check(s) FAILED. Review supabase/migrations/.")
        return 1

    print(
        f"{OK} The database enforces attribution.\n\n"
        f"  Forging an entry now requires the SIGNING KEY, not a bearer key.\n"
        f"  The anon key is public by design and, on this table, useless."
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

    # A deployment behind Cloudflare Access redirects an unauthenticated probe
    # to the team login page, which answers 200 with HTML. Parsed naively that
    # looks healthy, and it would ALSO look healthy if the gate had fallen off
    # entirely — so check where we actually landed. Being bounced to the login
    # page is the correct, passing result for a gated endpoint.
    if "cloudflareaccess.com" in str(response.url):
        print(f"{OK} {label:<12} gated by Access (login required)  {url}")
        return True

    if response.status_code != 200:
        print(f"{FAIL} {label:<12} HTTP {response.status_code}  {url}")
        return False

    try:
        payload = response.json()
    except ValueError:
        # 200 but not JSON means something is serving a page where the API
        # should be. Never report that as healthy.
        print(f"{FAIL} {label:<12} 200 but not JSON — is something else serving this?  {url}")
        return False

    platform = payload.get("platform", "?")
    gate = payload.get("gate")
    suffix = f", gate '{gate}'" if gate else ""

    print(f"{OK} {label:<12} healthy, served by '{platform}'{suffix}  {url}")
    return True


def status() -> int:
    """Check every deployment that has a URL configured."""
    targets = [
        ("vercel", os.environ.get("VERCEL_URL")),
        ("cf-access", os.environ.get("ACCESS_URL")),
    ]

    configured = [(label, url) for label, url in targets if url]
    if not configured:
        print(
            f"{WARN} No deployment URLs set.\n"
            f"  Export VERCEL_URL and/or ACCESS_URL, or add them to .env."
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

    # Probe with the ANON key, and expect to be REFUSED.
    #
    # This check used to assert a 200 here, back when the guestbook was
    # readable by anyone. After the attributed-messages migration, anon has no
    # grants on public.messages at all — so a 200 is now the regression and a
    # 401 is the healthy answer. CI caught this on the very deploy that made it
    # true, which is the check earning its keep.
    #
    # Same reasoning as the Access probe above, which treats a redirect to the
    # login page as passing: for a gated resource, being turned away IS the
    # correct response, and answering freely is the alarming one.
    with httpx.Client() as client:
        try:
            response = client.get(
                f"{config.rest_url}/messages",
                headers=config.headers,
                params={"select": "id", "limit": 1},
                timeout=10.0,
            )
        except httpx.RequestError as error:
            print(f"{FAIL} {'supabase':<12} unreachable ({type(error).__name__})")
            return 1

        if response.status_code in (401, 403, 404):
            print(
                f"{OK} {'supabase':<12} reachable, and anon is correctly refused "
                f"(HTTP {response.status_code})"
            )
        elif response.status_code == 200:
            print(
                f"{FAIL} {'supabase':<12} anon CAN READ messages — the lockdown "
                f"has regressed. Check supabase/migrations/…_attributed_messages.sql"
            )
            healthy = False
        else:
            print(f"{FAIL} {'supabase':<12} unexpected HTTP {response.status_code}")
            healthy = False

    return 0 if healthy else 1
