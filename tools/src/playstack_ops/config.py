"""Configuration loading.

Reads the repo-root `.env` so the Python tools and the JavaScript apps share a
single source of truth. Real environment variables always win, which is what
lets CI inject secrets without a file existing at all.

We parse the file by hand rather than adding python-dotenv: it is fifteen lines
and it keeps the dependency count at one.
"""

from __future__ import annotations

import os
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

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url}/rest/v1"

    @property
    def headers(self) -> dict[str, str]:
        return {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {self.supabase_anon_key}",
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

    return Config(
        supabase_url=get("SUPABASE_URL"),
        supabase_anon_key=get("SUPABASE_ANON_KEY"),
    )
