# 4. Partner Dashboard listing + support email

Non-code deliverables — none of these can be created from this repo. All happen in https://partners.shopify.com → your app → App Store listing.

## Support email
- [ ] Register a monitored inbox (e.g. `support@tryonai.app`). Cannot be a personal Gmail per App Store requirements.
- [ ] Enter it in **Partner Dashboard → App setup → Emergency developer contact** and **Support → Support email**.

## Listing assets

| Asset | Spec | Status |
|-------|------|--------|
| App icon | 1200×1200 PNG, no transparency | TODO |
| Feature image | 1600×900 PNG | TODO |
| Screenshot 1 | 1600×900 or 1280×800 PNG — try-on widget in storefront | TODO |
| Screenshot 2 | same — admin settings page | TODO |
| Screenshot 3 | same — generated result example | TODO |
| Short description | ≤100 chars | TODO |
| Long description | 500–4000 chars; mention OpenAI sub-processor | TODO |
| Primary category | **Store design** → **Try-on** (verify exact taxonomy in dashboard at submission time) | TODO |

(Marketing video and demo loop are post-launch, per the chapter plan.)

## Privacy / Terms URLs

Once [01-set-application-url.md](01-set-application-url.md) is done, paste these into **Partner Dashboard → App listing → App details**:

- Privacy policy URL: `https://<application_url>/privacy`
- Terms of service URL: `https://<application_url>/terms`

## GDPR webhook URLs

The `[webhooks.privacy_compliance]` block in [../shopify.app.toml](../shopify.app.toml) registers them on `shopify app deploy`. As a belt-and-braces check, also paste them into **Partner Dashboard → App setup → Compliance webhooks**:

- Customer data request URL: `https://<application_url>/webhooks/customers/data_request`
- Customer redact URL: `https://<application_url>/webhooks/customers/redact`
- Shop redact URL: `https://<application_url>/webhooks/shop/redact`

**Done when:** Every row above is ticked, and the Partner Dashboard listing preview shows the icon, screenshots, descriptions, and policy URLs.
