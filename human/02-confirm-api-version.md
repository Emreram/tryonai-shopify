# 2. Confirm `api_version` is current

**Two version constants exist:**

| File | Field | Value | Drives |
|------|-------|-------|--------|
| [../shopify.app.toml](../shopify.app.toml) line 12 | `api_version` | `2026-07` | Webhook payload version |
| [../app/shopify.server.ts](../app/shopify.server.ts) line 13 | `ApiVersion.October25` | `2025-10` | GraphQL Admin API calls from the app |

**Action:** Before submission, open https://shopify.dev/docs/api/usage/versioning and confirm:

1. `2026-07` is a **stable** (not release-candidate) version on submission day. Today is 2026-05-20, so `2026-07` is forward-dated and may not yet be stable.
2. The `@shopify/shopify-app-react-router` package version (`^1.1.0`) actually ships an `ApiVersion.July26` constant. If it does not, the toml and the SDK will use different API versions — webhooks fire under `2026-07` payload schema while the app code reads them against `2025-10` types.

**Recommended:** bump both to the latest stable on submission day, or downgrade the toml to the matching SDK version (`api_version = "2025-10"`).

**Done when:** Both files reference the same Shopify API version, and that version is listed as stable on shopify.dev.
