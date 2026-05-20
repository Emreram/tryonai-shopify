# 1. Set production `application_url`

**Where:** [../shopify.app.toml](../shopify.app.toml) line 5.

**Current:**
```toml
application_url = "https://example.com"
```

**Action:** Replace with the real production hostname before `shopify app deploy`. Shopify will reject the deploy if `application_url` is not a valid HTTPS URL it can reach. The placeholder also breaks the privacy-compliance webhook URLs, which are resolved as `<application_url>/webhooks/customers/data_request` etc.

Also update [../shopify.app.toml](../shopify.app.toml) line 31:
```toml
[auth]
redirect_urls = [ "https://example.com/api/auth" ]
```
to use the same production hostname.

**Done when:** `npx shopify app deploy --no-release` does not warn about the URL, and visiting `https://<application_url>/privacy` in an incognito browser renders the privacy page.
