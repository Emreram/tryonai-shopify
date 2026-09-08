#!/usr/bin/env bash
#
# Installs the OpenRouter API key everywhere this app needs it.
#
#   ./scripts/set-openrouter-key.sh
#
# Prompts for the key (input is hidden), verifies it against OpenRouter, writes
# it to the local .env, and pushes it to Vercel for Production/Preview/
# Development. Also removes the now-unused OPENAI_API_KEY so there is exactly
# one model credential.
#
# Nothing is written anywhere until the key has been verified.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
VAR_NAME="OPENROUTER_API_KEY"
IMAGE_MODEL="openai/gpt-image-2"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required but was not found on PATH."
command -v curl >/dev/null 2>&1 || die "curl is required but was not found on PATH."

bold "TryOnAI — OpenRouter key setup"
echo
echo "Create or copy a key at https://openrouter.ai/keys"
echo "It looks like: sk-or-v1-xxxxxxxx…"
echo

# ---- 1. read the key (hidden input) ----------------------------------------

# Read from the terminal so the key is never echoed. When there is no
# controlling tty (CI, a piped invocation) fall back to stdin.
printf 'Paste your OpenRouter API key, then press Enter: '
if { exec 3</dev/tty; } 2>/dev/null; then
  IFS= read -rs OPENROUTER_KEY <&3
  exec 3<&-
else
  IFS= read -r OPENROUTER_KEY
fi
echo
echo

[ -n "$OPENROUTER_KEY" ] || die "No key entered."
# Strip stray whitespace a copy/paste can pick up.
OPENROUTER_KEY="$(printf '%s' "$OPENROUTER_KEY" | tr -d '[:space:]')"

case "$OPENROUTER_KEY" in
  sk-or-*) ;;
  sk-*) die "That looks like an OpenAI key (sk-…), not an OpenRouter key (sk-or-v1-…)." ;;
  *) die "That does not look like an OpenRouter key. Expected it to start with 'sk-or-'." ;;
esac

# ---- 2. verify against OpenRouter ------------------------------------------

bold "Verifying the key"

KEY_HTTP_BODY="$(mktemp)"
trap 'rm -f "$KEY_HTTP_BODY"' EXIT

KEY_STATUS="$(curl -sS -o "$KEY_HTTP_BODY" -w '%{http_code}' \
  --max-time 30 \
  -H "Authorization: Bearer $OPENROUTER_KEY" \
  https://openrouter.ai/api/v1/key)"

case "$KEY_STATUS" in
  200) ;;
  401) die "OpenRouter rejected the key (401). It may be revoked, disabled, or mistyped." ;;
  *)   die "OpenRouter returned HTTP $KEY_STATUS while checking the key: $(cat "$KEY_HTTP_BODY")" ;;
esac

# Report label / spend headroom. `limit` is null when the key is uncapped.
node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const d = body.data ?? {};
const money = (v) => (typeof v === "number" ? `$${v.toFixed(2)}` : "unlimited");
console.log(`  \u001b[32m\u2713\u001b[0m key accepted: ${d.label ?? "(unlabelled)"}`);
console.log(`  \u001b[32m\u2713\u001b[0m spent so far: ${money(d.usage)} | key limit: ${money(d.limit)} | remaining: ${money(d.limit_remaining)}`);
if (d.is_free_tier) {
  console.log("  \u001b[33m!\u001b[0m This is a FREE-TIER key. gpt-image-2 is a paid model — add credits at");
  console.log("    https://openrouter.ai/settings/credits or renders will fail with HTTP 402.");
}
if (typeof d.limit_remaining === "number" && d.limit_remaining <= 0) {
  console.log("  \u001b[33m!\u001b[0m limit_remaining is 0 — renders will fail with HTTP 402 until you top up.");
}
' "$KEY_HTTP_BODY"

# Confirm the image model is actually served (no auth needed; catches a
# renamed/retired slug before it becomes a production 404).
if curl -sS --max-time 30 \
  "https://openrouter.ai/api/v1/images/models/$IMAGE_MODEL/endpoints" \
  | grep -q '"supports_streaming"'; then
  ok "$IMAGE_MODEL is available and supports streaming"
else
  warn "Could not confirm $IMAGE_MODEL on OpenRouter — continuing anyway."
fi

echo

# ---- 3. write the local .env -----------------------------------------------

bold "Writing $ENV_FILE"

touch "$ENV_FILE"
# Rewrite in place: drop any existing OPENROUTER_API_KEY / OPENAI_API_KEY lines,
# then append the new value. Done via node so the key never lands in a shell
# history-visible argv and quoting is exact.
KEY_VALUE="$OPENROUTER_KEY" node -e '
const fs = require("fs");
const file = process.argv[1];
const name = process.argv[2];
const lines = fs.readFileSync(file, "utf8").split("\n");
const kept = lines.filter((l) => !/^\s*(OPENROUTER_API_KEY|OPENAI_API_KEY)\s*=/.test(l));
while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
kept.push(`${name}=${process.env.KEY_VALUE}`, "");
fs.writeFileSync(file, kept.join("\n"));
' "$ENV_FILE" "$VAR_NAME"

ok "$VAR_NAME set in .env (and any stale OPENAI_API_KEY removed)"
echo

# ---- 4. push to Vercel ------------------------------------------------------

bold "Pushing to Vercel"

if [ ! -d "$REPO_ROOT/.vercel" ]; then
  echo "  This project is not linked to Vercel yet. Linking now"
  echo "  (pick the existing 'tryonai-app' project when asked)."
  echo
  if ! npx --yes vercel link --cwd "$REPO_ROOT"; then
    warn "Linking failed or was cancelled — skipping the Vercel step."
    warn "Set $VAR_NAME manually at Vercel → Project → Settings → Environment Variables."
    echo
    bold "Local .env is set. Done."
    exit 0
  fi
fi

for TARGET in production preview development; do
  # `env rm` fails when the var is absent; that is fine and expected.
  npx --yes vercel env rm "$VAR_NAME" "$TARGET" --yes --cwd "$REPO_ROOT" >/dev/null 2>&1 || true
  if printf '%s' "$OPENROUTER_KEY" \
      | npx --yes vercel env add "$VAR_NAME" "$TARGET" --cwd "$REPO_ROOT" >/dev/null 2>&1; then
    ok "$VAR_NAME -> $TARGET"
  else
    warn "Could not set $VAR_NAME for $TARGET — set it in the Vercel dashboard."
  fi

  # The app no longer reads OPENAI_API_KEY; leaving it around invites confusion
  # about which credential is live.
  npx --yes vercel env rm OPENAI_API_KEY "$TARGET" --yes --cwd "$REPO_ROOT" >/dev/null 2>&1 \
    && ok "removed stale OPENAI_API_KEY from $TARGET" || true
done

echo
bold "Deploy so the new key takes effect"
echo "  Environment variables are read at runtime, but an existing deployment"
echo "  keeps its old values until you redeploy:"
echo
echo "    npx vercel --prod"
echo
echo "  Then run one try-on and check the logs:"
echo "    npx vercel logs --prod | grep tryon_"
echo
echo "  A healthy render logs  event:\"tryon_complete\"  with a usage.cost."
echo "  A failure logs         event:\"tryon_error\"     with error_code:"
echo "    billing    -> out of OpenRouter credits (HTTP 402); top up"
echo "    auth       -> key rejected (HTTP 401)"
echo "    throttle   -> rate limited (HTTP 429); retry_after_s says how long"
echo "    moderation -> the photo was refused (HTTP 403)"
echo "    upstream   -> the model provider is down (HTTP 5xx)"
