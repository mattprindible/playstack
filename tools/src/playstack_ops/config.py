"""Configuration loading.

Reads the repo-root `.env` so the Python tools and the JavaScript apps share a
single source of truth. Real environment variables always win, which is what
lets CI inject secrets without a file existing at all.

We parse the file by hand rather than adding python-dotenv: it is fifteen lines
and it keeps the dependency count at one.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env"


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_anon_key: str
    # Present only when the signing key is configured locally. Commands that
    # need to WRITE require it; the RLS audit deliberately works without it,
    # because its most important assertion is what a stranger cannot do.
    jwt_kid: str | None = None
    jwt_private_jwk: str | None = None

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url}/rest/v1"

    @property
    def headers(self) -> dict[str, str]:
        """Anon-only headers: what somebody holding just the public key can send.

        Note `apikey` and `Authorization` carry the same value here. That is the
        shape the apps used to use everywhere, and since the migration it buys
        nothing — anon has no grants on public.messages at all.
        """
        return {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {self.supabase_anon_key}",
            "Content-Type": "application/json",
        }

    def signed_headers(self, subject: str, gate: str, label: str) -> dict[str, str]:
        """Headers for a caller the signing key vouches for.

        `apikey` still identifies the project; `Authorization` now carries a
        short-lived token whose claims RLS compares against the row being
        written. See packages/core/src/token.ts — this is its Python twin, and
        the two must agree or every insert is refused.
        """
        import jwt  # imported lazily so read-only commands need no crypto

        if not self.jwt_kid or not self.jwt_private_jwk:
            raise ConfigError(
                "Writing needs SUPABASE_JWT_KID and SUPABASE_JWT_PRIVATE_KEY. "
                "The guestbook no longer accepts unattributed inserts."
            )

        key = jwt.PyJWK.from_json(self.jwt_private_jwk, algorithm="ES256").key
        now = int(time.time())
        token = jwt.encode(
            {
                "sub": subject,
                "role": "authenticated",
                "gate": gate,
                "label": label,
                "aud": "authenticated",
                "iat": now,
                "exp": now + 60,
            },
            key,
            algorithm="ES256",
            headers={"kid": self.jwt_kid, "typ": "JWT"},
        )
        return {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }


class ConfigError(RuntimeError):
    """Raised when required configuration is absent."""


def load_config() -> Config:
    file_values = _load_env_file(ENV_FILE)

    def get(key: str) -> str:
        value = os.environ.get(key) or file_values.get(key)
        if not value:
            raise ConfigError(
                f"Missing {key}. Set it in {ENV_FILE} or export it. "
                f"See .env.example."
            )
        return value.rstrip("/")

    def optional(key: str) -> str | None:
        return os.environ.get(key) or file_values.get(key) or None

    return Config(
        supabase_url=get("SUPABASE_URL"),
        supabase_anon_key=get("SUPABASE_ANON_KEY"),
        jwt_kid=optional("SUPABASE_JWT_KID"),
        jwt_private_jwk=optional("SUPABASE_JWT_PRIVATE_KEY"),
    )
