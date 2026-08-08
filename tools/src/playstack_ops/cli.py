"""Command-line entry point.

argparse is in the standard library, so the CLI framework costs nothing.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from . import __version__
from .commands import audit_rls, seed, status
from .config import ConfigError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="playstack-ops",
        description="Operational scripts for the playstack monorepo.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    subcommands = parser.add_subparsers(dest="command", required=True)

    seed_cmd = subcommands.add_parser("seed", help="Insert sample guestbook messages.")
    seed_cmd.add_argument(
        "-n", "--count", type=int, default=5, help="How many messages (default: 5)."
    )

    subcommands.add_parser(
        "audit-rls", help="Verify Row Level Security is genuinely enforced."
    )
    subcommands.add_parser("status", help="Health-check every configured deployment.")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        if args.command == "seed":
            return seed(args.count)
        if args.command == "audit-rls":
            return audit_rls()
        if args.command == "status":
            return status()
    except ConfigError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
