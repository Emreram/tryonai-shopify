# 5. App Store listing form — paste-ready values

Every field on the partner dashboard listing form, in the order Shopify presents them. Copy each code block straight into the corresponding field. If a field is optional and we don't have a value, it says "leave empty".

⚠️ **Save the form draft every few sections** — Shopify's editor loses unsaved changes on navigation. Click "Save" after each top-level group.

---

## Basic app information

**App name** (already set, 7/30): `TryOnAi`

**App icon:** synced from Partner Dashboard — no action needed in this form.

**Primary category:** `Store design > Images and media > 3D/AR/VR`

**Languages:** `English`

---

## App store listing content

### App introduction — max 100 chars

```
AI virtual try-ons help shoppers visualize apparel — boost conversion, reduce returns.
```
(86 chars)

### App details — max 500 chars

```
TryOnAI adds AI virtual try-ons to your apparel storefront. Shoppers upload a photo on the product page and instantly see how an item looks on them — no install, no account. Merchants get a one-click theme widget plus an embedded admin showing usage, plan status, and recent try-ons. It solves the "how does this fit?" uncertainty that drives apparel returns and abandoned carts — leading to higher conversion, fewer returns, and more confident buyers.
```
(~450 chars)

### Features — 3-5, max 80 chars each

```
AI try-on widget on product pages — shoppers preview items without signup
```
```
One-click storefront widget added via the theme editor, no code required
```
```
Embedded admin with usage, plan status, and recent try-on history
```
```
Shopper photos are processed for the preview only and never stored
```
```
Monthly plans with included usage cap and free trial
```

### Demo store URL (optional)

```
https://tryonaidev.myshopify.com/products/young-mbappe-longsleeve
```

### Feature media

- **Upload image:** `c:\Users\emre.semerci\Desktop\tryonaiSh\pics\feature_1600x900_final.png`
- **Video URL:** leave empty (no video)

**Alt text:**
```
Before-and-after AI try-on: a shopper's photo labeled "YOU" on the left, and the same shopper virtually wearing a different outfit labeled "TRY-ON" on the right.
```

### Screenshots — 3 required

**Screenshot 1**
- Upload: `c:\Users\emre.semerci\Desktop\tryonaiSh\pics\screenshot1_widget_open.png`
- Alt text:
```
Storefront try-on widget open on a Shopify product page
```

**Screenshot 2**
- Upload: `c:\Users\emre.semerci\Desktop\tryonaiSh\pics\screenshot2_admin.png`
- Alt text:
```
TryOnAI embedded admin with usage, plan and recent try-ons
```

**Screenshot 3**
- Upload: `c:\Users\emre.semerci\Desktop\tryonaiSh\pics\screenshot3_result.png`
- Alt text:
```
Generated try-on result with before-and-after preview
```

### Integrations (optional)

```
OpenAI
```
(Discloses the AI sub-processor — useful for transparency. Skip if reviewer asks for fewer.)

### Support

- **Preferred support channel:** `Support email address`
- **Support email:**
```
emergenceit1@gmail.com
```
- **Support portal URL:** leave empty
- **Support phone number:** leave empty

### Resources

- **Privacy policy URL:**
```
https://tryonai-app.vercel.app/privacy
```
- **Developer website (optional):**
```
https://tryonai-app.vercel.app
```
- **FAQ, Changelog, Tutorial, Additional documentation:** all leave empty

---

## Pricing details

**"I have approval to charge merchants outside of Shopify billing":** leave **UNCHECKED** - the app uses Shopify App Pricing.

Add **3 public plans** (data from [app/lib/plans.ts](tryonaishopfy/app/lib/plans.ts#L11-L16)):

**Plan 1 — Starter**
- Display name: `Starter`
- Price: `$49 USD / month`
- Trial: 14 days
- Top features description:
```
300 AI try-ons per month. $0.18 per extra try-on after the included allowance. 14-day free trial.
```

**Plan 2 — Growth**
- Display name: `Growth`
- Price: `$129 USD / month`
- Trial: 14 days
- Top features description:
```
1,200 AI try-ons per month. $0.15 per extra try-on after the included allowance. 14-day free trial.
```

**Plan 3 — Scale**
- Display name: `Scale`
- Price: `$349 USD / month`
- Trial: 14 days
- Top features description:
```
3,000 AI try-ons per month. $0.15 per extra try-on after the included allowance. 14-day free trial.
```

**Pricing info URL (optional):** leave empty

---

## App discovery content

### App card subtitle — max 62 chars

```
AI try-ons that lift apparel conversion and cut returns.
```
(56 chars)

### App store search terms — 1-5, max 20 chars each

```
virtual try-on
```
```
AI try on
```
```
apparel preview
```
```
fashion fit
```
```
try before buy
```

### Web search content (optional)

**Title tag (max 60):**
```
TryOnAI — AI virtual try-on for Shopify apparel stores
```
(56 chars)

**Meta description (max 160):**
```
Add AI virtual try-on to your Shopify product pages. Shoppers see how apparel looks on them before buying — driving higher conversion and fewer returns.
```
(152 chars)

---

## Install requirements

**Sales channel requirements:** check **`Shopify Online Store`**

> Required because the app ships a theme app extension (`tryon-button`) that lives on the storefront.

**Geographic requirements:** leave all unchecked (the app works globally).

---

## Tracking information

All fields **optional** — leave empty unless you want analytics. Can add later.

---

## Contact information

**Merchant review email:**
```
emergenceit1@gmail.com
```

**App submission email:**
```
emergenceit1@gmail.com
```

---

## App testing information

### Test account

Select: **`My app doesn't require an account to use it`**

> Rationale: Shopify reviewers install the app on their own test store via standard OAuth — they don't need credentials for the developer's store. The app uses Shopify-managed installation; there's no separate account layer.

### Screencast URL — 🚨 REQUIRED, you don't have one yet

Record a 3–8 minute video showing the full flow. Cheapest option:

1. Open **Snipping Tool** → **Record** (or use Windows Game Bar: `Win+G`, or download free OBS Studio).
2. Walk through:
   - Install app on the dev store
   - Land on embedded admin (show plan/trial/usage cards)
   - Open Online Store → Themes → Customize → add **Try-On Button** block to a product template → Save
   - Visit a product page on `tryonaidev.myshopify.com` → click **Try It On**
   - Upload a sample photo → wait for the AI result
   - Show the Before/After slider, Save / Share / Add to cart
   - Back to admin: usage counter incremented, recent try-on logged
   - Click **Choose a plan** → show the 3 paid plans
3. Upload as **unlisted** to YouTube (turn off comments, set unlisted).
4. Paste the YouTube URL.

URL format Shopify accepts:
```
https://www.youtube.com/watch?v=YOUR_VIDEO_ID
```

### Testing instructions — max 2800 chars

```
To test TryOnAI end-to-end:

1. Install the app on a development store from the Shopify App Store listing. Installation uses Shopify's managed install flow; no extra account is required.

2. After install you'll land on the embedded admin at /apps/tryonaishopfy. The home page shows trial, usage, billing, and setup status.

3. Add the storefront widget:
   - Go to Online Store > Themes > Customize on the test store.
   - Open a product template (Default product is fine).
   - Add a section/block: search for "Try-On Button" under the TryOnAI app.
   - Save the theme.

4. Test the storefront flow:
   - Visit any product page on the storefront (any product on tryonaidev.myshopify.com works).
   - Click the "Try It On" button — a modal opens prompting "Add your photo".
   - Upload any portrait photo (a stock model photo is fine — no real shopper PII is needed).
   - Wait ~10-20 seconds for the AI to generate the preview. The garment for the current product is auto-selected.
   - The result shows a Before/After slider with the shopper photo on the left and the AI-generated try-on on the right.
   - Test Save, Share, Try again, and Add to cart.

5. Verify usage tracking in admin:
   - Return to the embedded admin home page. "Try-ons used" and "Recent try-ons" should update.

6. Test billing upgrade:
   - From the admin home, click "Choose a plan".
   - You'll see the 3 paid plans: Starter ($49/mo, 300 try-ons), Growth ($129/mo, 1200 try-ons), Scale ($349/mo, 3000 try-ons). All plans include a 14-day free trial.
   - Selecting a plan opens Shopify's standard managed-billing approval screen.

7. Test uninstall:
   - From the dev store admin, uninstall the app.
   - The /webhooks/app/uninstalled handler runs and cleans up merchant data.
   - Reinstall from the listing. Shopify OAuth should run again, the admin should load without errors, trial usage should restart at 0/30, and the plan picker should work.

Notes for the reviewer:
- The app does not request order access. Billing is handled through Shopify App Pricing with monthly plans and per-try-on usage metering.
- Shopper photos are collected transiently for AI generation, sent to OpenAI, and not stored by TryOnAI. Merchants can access persisted usage metadata in the admin and CSV exports; images are zero-retention by design. The privacy policy at /privacy discloses this.
- Mandatory GDPR compliance webhooks (customers/data_request, customers/redact, shop/redact) are implemented and verify HMAC signatures.
- The app uses managed installation, so /auth/callback intentionally returns 410 Gone — this is expected behavior of @shopify/shopify-app-react-router for the AppStore distribution profile.
```
(~2700 chars — under 2800)

---

## Done when

- All 18 issues on the listing page resolve to 0
- "Save" succeeds on every section
- The page shows "Ready to submit" / "Ter controle indienen" enabled
- Then run Step 9 (Automatische controle op veelvoorkomende fouten) — should pass cleanly
- Submit
