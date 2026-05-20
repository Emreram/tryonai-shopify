# 3. `shopify app check` clarification (INFO)

**Issue:** The original Chapter 1 task said "Run `shopify app check` via the Shopify CLI; fix every warning before submission." That command does **not exist** in the current Shopify CLI. It was likely confused with `shopify theme check` (which only validates Liquid themes) or with a pre-3.0 CLI command.

**What actually validates the app before submission:**

1. **Local gates** (already wired in `package.json`):
   ```powershell
   cd tryonaishopfy
   npm run typecheck
   npm run lint
   npm run build
   ```

2. **Shopify CLI dry-run** — validates `shopify.app.toml` schema and the app's app-side config without publishing:
   ```powershell
   npx shopify app deploy --no-release
   ```
   This is the closest equivalent to the imagined `app check`.

3. **Partner Dashboard automated review** runs only when you actually submit the app for App Store review. It checks: GDPR webhook URLs respond 200 with valid HMAC, OAuth flow works, billing API integration (if any), privacy URL is reachable, etc.

**No human action required** beyond running the three commands above before submitting — just don't waste time hunting for an `app check` subcommand.
