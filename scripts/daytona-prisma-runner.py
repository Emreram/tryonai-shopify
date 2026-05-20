"""
Daytona Prisma Runner
=====================

Spawns a Daytona cloud sandbox, uploads the local `prisma/` directory + a
minimal package.json, installs Prisma, and runs a Prisma CLI command against
Supabase Postgres. Used because this laptop's network blocks outbound Postgres
protocol (port 5432/6543) but allows HTTPS to Daytona, and the sandbox itself
has unrestricted egress.

Run from the app root:
    python scripts/daytona-prisma-runner.py "migrate status"
    python scripts/daytona-prisma-runner.py "migrate deploy"
    python scripts/daytona-prisma-runner.py "db pull"

DATABASE_URL and DIRECT_URL are read from ./.env (alongside this app root) and
passed into the sandbox at runtime. The API key is read from the
DAYTONA_API_KEY environment variable.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams, Image


APP_DIR = Path(__file__).resolve().parent.parent
PRISMA_DIR = APP_DIR / "prisma"
ENV_FILE = APP_DIR / ".env"


def load_db_urls() -> dict[str, str]:
    """Read DATABASE_URL and DIRECT_URL from tryonaishopfy/.env, expanding
    ${VAR} references (dotenv-expand semantics)."""
    raw: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        raw[key.strip()] = value.strip()

    def expand(value: str) -> str:
        # Repeat until no more ${VAR} substitutions are possible.
        for _ in range(5):
            m = re.search(r"\$\{([A-Z0-9_]+)\}", value)
            if not m:
                break
            value = value.replace(m.group(0), raw.get(m.group(1), ""))
        return value

    return {k: expand(v) for k, v in raw.items() if k in ("DATABASE_URL", "DIRECT_URL")}


def main(prisma_cmd: str) -> int:
    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        print("ERROR: DAYTONA_API_KEY env var not set.", file=sys.stderr)
        return 2

    urls = load_db_urls()
    if not urls.get("DATABASE_URL") or not urls.get("DIRECT_URL"):
        print("ERROR: DATABASE_URL or DIRECT_URL missing from tryonaishopfy/.env", file=sys.stderr)
        return 2

    schema_path = PRISMA_DIR / "schema.prisma"
    if not schema_path.exists():
        print(f"ERROR: {schema_path} not found.", file=sys.stderr)
        return 2

    daytona = Daytona(DaytonaConfig(api_key=api_key))

    print(">>> Creating sandbox (Node 22)...")
    sandbox = daytona.create(
        CreateSandboxFromImageParams(
            image=Image.debian_slim("3.12").run_commands(
                "apt-get update",
                "apt-get install -y curl ca-certificates gnupg",
                "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
                "apt-get install -y nodejs",
                "node --version && npm --version",
            ),
            env_vars={
                "DATABASE_URL": urls["DATABASE_URL"],
                "DIRECT_URL": urls["DIRECT_URL"],
            },
        )
    )
    print(f">>> Sandbox id: {sandbox.id}")

    try:
        work_dir = "/home/daytona/prisma-runner"
        sandbox.process.exec(f"mkdir -p {work_dir}/prisma")

        # Upload schema.prisma + the existing migrations folder.
        schema_text = schema_path.read_text(encoding="utf-8")
        sandbox.fs.upload_file(
            schema_text.encode("utf-8"),
            f"{work_dir}/prisma/schema.prisma",
        )

        migrations_dir = PRISMA_DIR / "migrations"
        if migrations_dir.exists():
            for entry in migrations_dir.rglob("*"):
                if entry.is_file():
                    rel = entry.relative_to(migrations_dir).as_posix()
                    target = f"{work_dir}/prisma/migrations/{rel}"
                    sandbox.process.exec(f"mkdir -p $(dirname {target})")
                    sandbox.fs.upload_file(entry.read_bytes(), target)

        # Minimal package.json so `npm install prisma @prisma/client` works in isolation.
        pkg = (
            '{"name":"prisma-runner","version":"1.0.0","private":true,'
            '"dependencies":{"prisma":"^6.16.3","@prisma/client":"^6.16.3"}}'
        )
        sandbox.fs.upload_file(pkg.encode("utf-8"), f"{work_dir}/package.json")

        print(">>> Installing prisma in sandbox (one-shot, ~30s)...")
        install = sandbox.process.exec(
            f"cd {work_dir} && npm install --no-audit --no-fund 2>&1 | tail -5",
            timeout=180,
        )
        print(install.result or "")

        # Pre-fetch Prisma engine binaries. binaries.prisma.sh occasionally
        # ECONNRESETs; retry a few times before declaring failure.
        print(">>> Pre-fetching Prisma engine binaries...")
        for attempt in range(1, 4):
            fetch = sandbox.process.exec(
                f"cd {work_dir} && npx --yes prisma -v 2>&1 | tail -20",
                timeout=120,
            )
            if fetch.exit_code == 0 and "Default Engines Hash" in (fetch.result or ""):
                print(f"  binaries ready (attempt {attempt})")
                break
            print(f"  attempt {attempt} failed, retrying...")
        else:
            print("ERROR: could not fetch Prisma binaries after 3 attempts:")
            print(fetch.result or "")
            return 1

        print(f">>> Running: npx prisma {prisma_cmd}")
        run = sandbox.process.exec(
            f"cd {work_dir} && npx --yes prisma {prisma_cmd}",
            timeout=180,
        )
        print("=" * 60)
        print(run.result or "")
        print("=" * 60)
        print(f">>> exit code: {run.exit_code}")
        return run.exit_code or 0

    finally:
        print(">>> Cleaning up sandbox...")
        try:
            sandbox.delete()
        except Exception as e:
            print(f"WARN: sandbox cleanup failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    cmd = " ".join(sys.argv[1:]) or "migrate status"
    sys.exit(main(cmd))
