# Managed Pricing setup (App Store listing) — enable auto-renewing trials

The app is built around Shopify **Managed Pricing / Shopify App Pricing**: it sends
merchants to the hosted plan page
(`charges/{appHandle}/pricing_plans`, see `hostedPlanPageUrl` in
`app/lib/billingSync.server.ts`) and reads the resulting subscription back.

That hosted page — and the **Pricing** configuration in the Partner Dashboard —
only exist once the app has a **public App Store listing**. On Custom / unlisted
distribution there is no "Pricing" section and the `pricing_plans` URL just
redirects back to Apps. That is why "Pricing" appeared to be missing, and why no
auto-renewing subscription is ever created today.

Follow these steps once; afterward Shopify creates the trial subscription and
auto-bills on its own — no renewal code needed.

## 1. Switch the app to public distribution

Partner Dashboard → **App distribution** (or **Apps → All apps → TryOnAI →
Distribution**) → **Choose distribution** → select **Public distribution
(Shopify App Store)** → **Select**.

(Ref: [Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method).)

## 2. Open the Pricing config and enable Shopify App Pricing

Apps → All apps → **TryOnAI** → **Distribution** → beside *Shopify App Store
listing* click **Manage listing** → under *Published languages* click **Edit** →
under *Pricing content* click **Manage**.

On the Pricing index page click **Settings** → select **Shopify App Pricing** →
in the dialog click **Switch**.

(Ref: [Setup subscription charges](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges).)

## 3. Create the plans — names, prices and trial MUST match the code

The billing sync matches the returned subscription to a `PlanKey` by **plan
handle** (the `PlanKey` string) first, then by **exact recurring price**
(`planFromSubscription` in `billingSync.server.ts`, prices in `app/lib/plans.ts`).
So the plans you create must line up exactly:

| Plan name | Monthly price | Free trial | Included try-ons* |
| --------- | ------------- | ---------- | ----------------- |
| Starter   | **$8.99**     | **14 days**| 60                |
| Growth    | **$29.99**    | **14 days**| 200               |
| Scale     | **$99.99**    | **14 days**| 650               |

For each: under *Public plans* click **Add** → **Billing: Monthly** → enter the
exact price above → under **Free trial duration** enter **14** → name it exactly
`Starter` / `Growth` / `Scale` → save. Add the plan description for every
published locale or it won't show.

\* Included try-ons and the per-try-on overage are **self-enforced by the app**
(see `computeCap` / the gate in `tryonGate.server.ts` and the cap disclosure on
the billing page), not by Shopify's recurring charge. Managed Pricing here only
needs the recurring **price + 14-day trial**; metering stays in-app. (Moving
overage to Shopify usage charges is optional and separate —
[Setup usage charges](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges).)

> If a price or name drifts from the table, `planFromSubscription` falls back to
> "keep last-known plan", so the dashboard and the app can disagree. Keep them in
> sync, or update `PLANS` in `app/lib/plans.ts` to match.

## 4. Test before publishing

Shopify App Pricing includes a **$0 private test plan** (under *Private plans*).
Use it to verify the flow end to end without charging anyone:

1. On a development store, open the app → **Billing** → **Start your plan**.
2. The hosted page opens; approve the (test) plan — the approval screen shows the
   14-day free trial.
3. Back in the app, `/app/billing` shows the plan **Active** with
   `Renews on <trial-end date>`.

## 5. Submit for review

Public plans only go live to real merchants after the app passes App Store
review. Submit from the listing when ready. Until then, the $0 test plan exercises
the exact same trial → auto-renew path.

## Result

Once live, a merchant picks a plan on the hosted page and approves the recurring
charge (with the 14-day trial). Shopify delays the first charge by 14 days and
then bills automatically every 30 days — the auto-renewal that was missing,
handled entirely by Shopify. Shopify also tracks trial days over a 180-day window
to stop reinstall-to-refresh-trial abuse.

## Sources

- [Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)
- [Shopify App Pricing (overview)](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Setup subscription charges](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges)
- [Offer free trials](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/offer-free-trials)
