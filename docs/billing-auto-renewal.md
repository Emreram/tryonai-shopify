# Billing: trial → paid auto-renewal

## Symptom

> "Subscribers are not automatically renewing after 14 days — this costs me money."

After the 14-day trial, merchants are **not** automatically converted to a paid,
auto-renewing subscription. They have to manually pick a plan, and many never do,
so the revenue is lost.

## Root cause

The app's 14-day trial is a **self-managed free period**, not a Shopify
subscription:

- `TRIAL_DAYS = 14` / `TRIAL_TRYONS = 30` (`app/lib/plans.ts`).
- The trial is tracked locally via `BillingState.trialStartedAt`
  (`prisma/schema.prisma`).
- When the trial age exceeds 14 days the try-on gate blocks the shop with
  `trial_expired` (HTTP 402) and sends them to `/app/billing`
  (`app/lib/tryonGate.server.ts`).

During this self-managed trial **no Shopify subscription exists**, so **no
recurring charge was ever authorized**. Shopify can only auto-renew a charge the
merchant has approved — there is literally nothing to renew. Auto-conversion
therefore cannot happen; the merchant has to come back and choose a plan by hand.

## Fix: put the trial on the Shopify subscription

With Shopify **App Pricing / Managed Pricing** (which this app uses — see
`hostedPlanPageUrl` in `app/lib/billingSync.server.ts`), the free trial is
configured **on the plan itself** as trial days. The merchant approves the
recurring charge up front; Shopify delays the first charge by the trial days and
then **bills automatically** every cycle (every 30 days, or 365 for an annual
plan). That first automatic charge *is* the auto-renewal that's missing today.

Per Shopify's docs, Managed Pricing "automates most common billing tasks, such
as recurring charges, usage-based pricing, free trials, proration, test charges,
and price updates", and "any recurring charges are billed automatically **once
merchants approve the subscription**." The emphasis matters: the self-managed
trial never asks the merchant to approve a subscription, so there is no
authorized recurring charge for Shopify to renew. Configuring trial days on the
plan folds the free period into an approved subscription, which then renews on
its own.

Note (anti-abuse): Shopify "tracks trial days over a 180-day period to prevent
users from repeatedly reinstalling apps to exploit free trial periods", so a
merchant who reinstalls within 180 days does not get a fresh trial — extra
protection the current per-install self-managed trial does not provide.

The app code already supports this model:

- `billingSync.server.ts` reads `subscription.trialDays` and derives
  `trialEndsAt` / `currentCycleEnd` from the live subscription.
- The billing page already shows `Renews on <date>` for an active plan, which
  during a Shopify trial is the trial-end date.

So once the plans carry trial days and merchants subscribe up front, no renewal
code is needed — Shopify drives it.

### Required step — Partner Dashboard (not in code)

Managed Pricing plans and their trial days are configured in the Shopify
Partner Dashboard, **not** in this repository:

1. Partner Dashboard → your app → **Pricing**.
2. For each paid plan (Starter, Growth, Scale), set **Free trial = 14 days**
   ("When creating or editing a plan, you can specify the number of free trial
   days").
3. Save. New subscriptions from the hosted pricing page now include a 14-day
   trial and auto-bill afterward.

### What changed in code

To make merchants actually create a subscription (so there is something to
auto-renew), onboarding now steers them to **start a plan up front** with clear
"14 days free, then it renews automatically" framing, instead of deferring plan
selection to "when you're ready":

- `app/routes/app._index.tsx` — the setup guide leads with starting the plan;
  trial banner explains the free period is part of the plan.
- `app/routes/app.billing.tsx` — the trial section explains that choosing a plan
  starts the 14-day free trial and then renews automatically.

## Verifying auto-renewal

1. Install on a development store, open the hosted pricing page, choose a plan.
   The approval screen should show the 14-day free trial.
2. After approval, `/app/billing` shows the plan as **Active** with
   `Renews on <trial-end date>`.
3. Shopify charges automatically at trial end and each cycle after — visible in
   the store's **Settings → Billing** and in `app_subscriptions` on Shopify.

## Sources (Shopify docs)

- [Shopify App Pricing (overview)](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [About billing for your app](https://shopify.dev/docs/apps/launch/billing)
- [Offer free trials](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/offer-free-trials)
- [Setup subscription charges](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges)
- [About subscription billing](https://shopify.dev/docs/apps/launch/billing/subscription-billing)
