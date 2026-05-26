"""
Daytona Postgres Smoke Test
===========================

Spawns a Daytona sandbox, installs psycopg2 (pure-Python Postgres driver),
connects to Supabase via DIRECT_URL, and verifies:
  1) The connection works from a network unrestricted by corp DPI.
  2) All 7 public tables exist.
  3) The _prisma_migrations row for init_postgres is present with the
     correct checksum (so future `prisma migrate deploy` will recognize
     the baseline as already applied).

This is the Chapter-3 "done when" verification step. Use this instead of
daytona-prisma-runner.py while binaries.prisma.sh is unreachable from
Daytona sandboxes.

Run from the app root:
    python scripts/daytona-postgres-smoke.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams


APP_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = APP_DIR / ".env"

EXPECTED_MIGRATION = "20260520114313_init_postgres"
EXPECTED_CHECKSUM = "fc361d0c604d9f3cc397a5ac0fab9bc4ec2fbbf13654fe0a56c67fbec8bd5c95"
EXPECTED_TABLES = {
    "Session", "Shop", "MerchantSettings", "BillingState",
    "UsageLog", "AttributedOrder", "_prisma_migrations",
}


def load_db_urls() -> dict[str, str]:
    raw: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        raw[key.strip()] = value.strip()

    def expand(value: str) -> str:
        for _ in range(5):
            m = re.search(r"\$\{([A-Z0-9_]+)\}", value)
            if not m:
                break
            value = value.replace(m.group(0), raw.get(m.group(1), ""))
        return value

    return {k: expand(v) for k, v in raw.items() if k in ("DATABASE_URL", "DIRECT_URL")}


def main() -> int:
    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        print("ERROR: DAYTONA_API_KEY env var not set.", file=sys.stderr)
        return 2

    urls = load_db_urls()
    direct_url = urls.get("DIRECT_URL")
    if not direct_url:
        print("ERROR: DIRECT_URL missing from .env", file=sys.stderr)
        return 2

    daytona = Daytona(DaytonaConfig(api_key=api_key))

    print(">>> Creating sandbox (python:3.12)...")
    sandbox = daytona.create(
        CreateSandboxFromImageParams(
            image="python:3.12-slim",
            env_vars={"DIRECT_URL": direct_url},
        )
    )
    print(f">>> Sandbox id: {sandbox.id}")

    try:
        print(">>> Installing psycopg2-binary...")
        install = sandbox.process.exec(
            "pip install --quiet psycopg2-binary 2>&1 | tail -5",
            timeout=120,
        )
        if install.exit_code != 0:
            print(install.result or "")
            return 1

        smoke_code = f'''
import os, sys, psycopg2

direct_url = os.environ["DIRECT_URL"]
print("Connecting to:", direct_url.split("@")[1] if "@" in direct_url else "(masked)")

conn = psycopg2.connect(direct_url, sslmode="require", connect_timeout=10)
conn.autocommit = True
cur = conn.cursor()

# 1) Server version
cur.execute("SELECT version()")
print("Postgres:", cur.fetchone()[0].split(" on ")[0])

# 2) Public tables
cur.execute(
    """SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name"""
)
tables = {{r[0] for r in cur.fetchall()}}
expected = {sorted(EXPECTED_TABLES)!r}
expected_set = set(expected)
missing = expected_set - tables
extra = tables - expected_set
print(f"Tables ({{len(tables)}}):", sorted(tables))
if missing:
    print("MISSING:", sorted(missing))
    sys.exit(3)
if extra:
    print("UNEXPECTED EXTRA:", sorted(extra))

# 3) RLS state
cur.execute(
    """SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname='public' ORDER BY tablename"""
)
rls = cur.fetchall()
print("RLS per table:")
for name, enabled in rls:
    print(f"  {{name}}: {{'ON' if enabled else 'OFF'}}")
all_rls_on = all(enabled for _, enabled in rls)
print("All RLS on:", all_rls_on)

# 4) _prisma_migrations row
cur.execute(
    'SELECT migration_name, checksum, applied_steps_count, finished_at '
    'FROM "_prisma_migrations" ORDER BY started_at'
)
rows = cur.fetchall()
print(f"_prisma_migrations rows: {{len(rows)}}")
for r in rows:
    print(f"  {{r[0]}} checksum={{r[1][:12]}}... steps={{r[2]}} finished={{r[3]}}")

expected_name = {EXPECTED_MIGRATION!r}
expected_sum = {EXPECTED_CHECKSUM!r}
matched = any(r[0] == expected_name and r[1] == expected_sum for r in rows)
if not matched:
    print(f"FAIL: missing or wrong-checksum row for {{expected_name}}")
    sys.exit(4)

# 5) Write/read smoke (insert + delete a Shop row, then clean up)
import uuid
test_domain = f"smoke-{{uuid.uuid4().hex[:8]}}.myshopify.com"
cur.execute('INSERT INTO "Shop" (id, domain) VALUES (gen_random_uuid()::text, %s) RETURNING id', (test_domain,))
new_id = cur.fetchone()[0]
cur.execute('SELECT domain FROM "Shop" WHERE id = %s', (new_id,))
got = cur.fetchone()[0]
assert got == test_domain, f"readback mismatch: {{got}} vs {{test_domain}}"
cur.execute('DELETE FROM "Shop" WHERE id = %s', (new_id,))
print(f"Write/read smoke OK (inserted+deleted Shop row for {{test_domain}})")

cur.close()
conn.close()
print("ALL CHECKS PASSED")
'''

        print(">>> Running smoke test against Supabase...")
        run = sandbox.process.code_run(smoke_code)
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
    sys.exit(main())
