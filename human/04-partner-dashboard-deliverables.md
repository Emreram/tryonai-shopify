# 4. Partner Dashboard listing + support email

Non-code deliverables live in https://partners.shopify.com -> your app -> App Store listing. This file tracks what is ready from the repo and what still needs a logged-in dashboard or mailbox action.

## Support email

Direct Gmail (no custom domain). Simpler than provisioning `support@tryonai.app`; trade-off is the personal address is visible on the listing.

- [ ] Public support address: `emergenceit1@gmail.com`
- [ ] Configure Gmail vacation-responder auto-ack (Gmail -> Settings -> See all settings -> General -> Vacation responder):
  - Subject: `Thanks for contacting TryOnAI Support`
  - Body: `Thanks for contacting TryOnAI Support. We received your message and will respond within one business day.`
  - Leave end date empty so it stays on indefinitely. Tick "Only send a response to people in my Contacts" -> OFF (so first-time senders get the ack).
- [ ] Enter `emergenceit1@gmail.com` in Partner Dashboard -> App setup -> Emergency developer contact and App listing -> Support -> Support email.
- [ ] Send a test email from a third-party address (e.g. an Outlook account) and confirm both the inbox delivery and the auto-ack arrive within 5 minutes.

## Listing assets

| Asset | Spec | Status |
|-------|------|--------|
| App icon | 1200x1200 PNG, no transparency, <=1 MB | READY: `../../pics/icon_1200x1200_p8.png` (341 KB, PNG-8; original `icon_1200x1200.png` is 1.30 MB and exceeds Shopify's 1 MB cap) |
| Feature image | 1600x900 PNG, <=1 MB, no Shopify logo | READY: `../../pics/feature_1600x900_final.png` (373 KB, 256-color, Shopify badge painted over). Original `feature_1600x900.png` (1.34 MB) contains the "shopify app" badge bottom-left and must NOT be uploaded. |
| Screenshot 1 | 1600x900 PNG, storefront try-on widget open | READY: `../../pics/screenshot1_widget_open.png` (181 KB) |
| Screenshot 2 | 1600x900 PNG, embedded admin dashboard | READY: `../../pics/screenshot2_admin.png` (212 KB) |
| Screenshot 3 | 1600x900 PNG, generated before/after result | READY: `../../pics/screenshot3_result.png` (224 KB) |
| Short description | <= 100 chars | READY: see copy below |
| Long description | 500-4000 chars; mention OpenAI sub-processor | READY: see copy below |
| Primary category | Conversion -> Try-on | TODO: choose exact dashboard category containing `Try-on` |

## Partner Dashboard copy

Short description:

```text
AI virtual try-ons that help shoppers visualize apparel before checkout.
```

Long description:

```text
TryOnAI adds an AI-powered virtual try-on experience to your Shopify storefront, helping shoppers see how apparel could look before they buy. Merchants install the storefront widget, shoppers upload a photo, and TryOnAI generates an on-demand preview using the selected product image. The embedded admin shows usage, plan status, recent try-ons, and attributed order activity. TryOnAI uses OpenAI as an image-generation sub-processor; shopper photos are processed only to generate the preview and are not stored by TryOnAI.
```

## Screenshot checklist

- Capture at 1600x900.
- Use the dev store: `tryonaidev.myshopify.com`.
- Include one embedded admin dashboard screenshot.
- Include one storefront product page screenshot with the try-on widget open.
- Include one generated result screenshot showing the before/after reveal.

## Privacy / Terms URLs

Paste these into Partner Dashboard -> App listing -> App details:

- Privacy policy URL: `https://tryonai-app.vercel.app/privacy`
- Terms of service URL: `https://tryonai-app.vercel.app/terms`

## GDPR webhook URLs

The `[webhooks.privacy_compliance]` block in `shopify.app.toml` registers these on deploy. Also paste them into Partner Dashboard -> App setup -> Compliance webhooks:

- Customer data request URL: `https://tryonai-app.vercel.app/webhooks/customers/data_request`
- Customer redact URL: `https://tryonai-app.vercel.app/webhooks/customers/redact`
- Shop redact URL: `https://tryonai-app.vercel.app/webhooks/shop/redact`

**Done when:** every READY item is uploaded, all TODO items above are ticked, the Partner Dashboard listing preview shows the icon, feature image, screenshots, descriptions, category, and policy URLs, and a test email to `emergenceit1@gmail.com` receives an auto-ack within 5 minutes.
