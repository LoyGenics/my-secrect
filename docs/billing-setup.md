# Billing setup and current status

## Implemented locally

- Settings → Plan and billing on the shared web/desktop app, English and
  Vietnamese, including Free, Monthly, Yearly and Lifetime.
- Account-scoped purchase ledger and union of entitlements. No change to
  existing quotas or encryption. Free local access/export stays available.
- Hosted Stripe Checkout: recurring for monthly/yearly; one-time for Lifetime.
  Server-owned prices, customer ownership, durable checkout idempotency and
  duplicate purchase protection. A return URL never grants access.
- Customer Portal sessions for the authenticated account's customer only.
- Signature-verified Stripe webhook processing, deduplicated transactional
  reconciliation, asynchronous payment handling, lifecycle events, exact
  charge-to-purchase risk mapping and sandbox/live isolation.
- Apple/Google backend verification through RevenueCat's server API, authenticated
  webhooks and refresh. No client-supplied entitlement or expiry is trusted.
  Store transfers are rejected; configure keep-original restore behavior.
- Account deletion requires recurring charges to be stopped and pending or
  processing Checkouts to finish/expire before ciphertext deletion starts.

## Stripe sandbox prepared on 18 November 2026

- Account: `acct_1UGbHYBgSUuXy8tm` (Loygenics sandbox).
- Product: `prod_VeNblf3YhgkKRX` (My Secret Pro).
- Customer Portal configuration: `bpc_1Ud4rIBgSUuXy8tm71jNtXWZ`.
  Invoice history, payment method updates and cancellation at period end enabled.
- No Prices created: amounts and currency have not been approved. Proposed
  landing-page amounts must not become live prices without a product decision.
- No production deployment, live charge, webhook destination or native store
  purchase was made. CLI authentication is separate from the app's API key.

## Enable web purchasing

1. Confirm monthly/yearly/Lifetime amounts, currency, paid features/allowances
   and Lifetime terms. Product tax category, inclusive/exclusive pricing and
   applicable registrations need confirmation before collecting tax. Stripe Tax
   is not enabled by this implementation.
2. Under the sandbox Product, create a monthly recurring Price, a yearly
   recurring Price and a one-time Price for Lifetime. Use one-unit flat rates.
3. Put a restricted test API key in the backend's secret store as
   `STRIPE_API_KEY`. Required operations include Customers create, Prices read,
   Checkout Sessions/line items read/write, Subscriptions read, Billing Portal
   Sessions create, Charges/PaymentIntents/Invoices/InvoicePayments read. Never
   put a secret/restricted key in Vite, Expo, browser storage or source control.
4. Configure `BILLING_ENVIRONMENT=test`, `BILLING_WEB_URL` (the trusted web app
   origin, without query or fragment), `STRIPE_PRICE_MONTHLY`,
   `STRIPE_PRICE_YEARLY`, `STRIPE_PRICE_LIFETIME`, and
   `STRIPE_PORTAL_CONFIGURATION=bpc_1Ud4rIBgSUuXy8tm71jNtXWZ`.
5. Register `POST /api/v1/billing/webhooks/stripe` at the deployed API origin.
   Use API version `2026-10-28.endive`, matching stripe-ruby 21.0.0. Enable exactly:

   ```text
   checkout.session.completed
   checkout.session.async_payment_succeeded
   checkout.session.async_payment_failed
   checkout.session.expired
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   charge.refunded
   charge.dispute.created
   radar.early_fraud_warning.created
   ```

   Store its signing secret as `STRIPE_WEBHOOK_SECRET`. For a local API use
   `stripe listen --forward-to http://localhost:5475/api/v1/billing/webhooks/stripe`
   and the signing secret printed by that listener.
6. Run migrations, deploy the API and web build, sign in, then open Settings.
   Configured prices are read from Stripe and formatted for their currency.
   Sandbox Checkout must be tested for paid, failed and delayed payments;
   renewals, cancellation, duplicate delivery, refund and disputes. Verify access
   from another device using the same account. Do not enable live purchases
   until the application key, webhook and fulfillment have passed these tests.

`BILLING_WEB_URL` determines Checkout and Portal return URLs on the server;
the request cannot supply a destination. The web client also validates exact
Stripe HTTPS hosts before navigating. For custom Stripe Checkout domains,
extend the explicit redirect allowlist before enabling them.

## Enable iOS / Google Play

Mobile uses RevenueCat for native purchases and restoration. Live purchases
require the store catalog, public SDK keys and server configuration below.

1. Create monthly/yearly subscriptions and a non-consumable Lifetime product in
   each store. Configure App Store Server Notifications / Play RTDN in
   RevenueCat, including non-consumable refunds. Give the application their
   corresponding public SDK keys; secret keys remain on the backend.
2. Add each product to the RevenueCat `pro` entitlement. Additionally attach the
   iOS Lifetime product to `pro_app_store_lifetime` and the Android Lifetime
   product to `pro_google_play_lifetime`; these preserve independent purchase
   verification when one account bought Lifetime on both stores. Map exact product IDs
   to `monthly`, `yearly`, `lifetime` in `REVENUECAT_PRODUCTS`, as shown in the
   API `.env.example`. Configure `REVENUECAT_ENTITLEMENT=pro` and
   `REVENUECAT_SECRET_API_KEY`.
   Set the current offering's standard Monthly, Annual and Lifetime packages
   to the same mapped product identifiers returned by the native SDK. Start
   with base prices. The current screen excludes introductory offers and
   trials until it can display their terms and eligibility.
3. Configure RevenueCat restore behavior **Keep with original App User ID**.
   Bind Purchases to the signed-in Rails UUID returned as `app_user_id` by
   `GET /api/v1/billing/access`; require sign-in before purchasing. Do not allow
   anonymous purchases or account aliasing. Do not import Stripe purchases into
   RevenueCat for this architecture.
4. Register `POST /api/v1/billing/webhooks/revenuecat` and set an exact random
   Authorization header stored as `REVENUECAT_WEBHOOK_AUTHORIZATION`. Test and
   live API environments stay separate. Unrecognized accounts are not created
   by webhooks; unsupported transfers return a conflict for investigation.
5. Set `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` and
   `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` to the platform public SDK keys
   and rebuild the native binaries. Use an isolated RevenueCat project and
   store sandbox accounts when testing a development API. Mobile reconciles
   purchases using authenticated `POST /api/v1/billing/stores/refresh`.
   The rails account receives Pro only from verified provider data.
6. Verify both store sandboxes for purchase, restore to the same account,
   cancellation, expiry, billing issues, refund and switching accounts.

Store subscriptions remain managed in their original store. Current UI opens
the store subscription page; Lifetime opens purchase support/history. Cross-device
access never migrates the recurring charge to another provider.

## Enable free-tier ads

Create separate iOS and Android apps and banner units in AdMob. Configure
privacy messages in AdMob before enabling live ads. Set these public IDs
when generating the native projects and bundling the app.

- `EXPO_PUBLIC_ADMOB_IOS_APP_ID` and `EXPO_PUBLIC_ADMOB_IOS_BANNER_ID`
- `EXPO_PUBLIC_ADMOB_ANDROID_APP_ID` and `EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID`

Regenerate the native projects from the Expo config and rebuild the binaries
after changing the app IDs. Development builds use Google's demo banner only
when `EXPO_PUBLIC_ADMOB_TEST_ADS=1`. They never request live ad units. Release
builds request ads only with a configured platform app ID and banner unit,
server-confirmed Free status, and consent eligibility. Ads appear on the
unlocked Vault tab, and **Settings → Ad privacy choices** opens Google's
privacy form when required.

Update the published privacy policy, App Store privacy details, Play Data
Safety and the Play Console's ads declaration before shipping.

The Android ads wrapper is pinned to match Expo 52's Kotlin compiler. Google
lists June 30, 2027 as the sunset date for its bundled Android v23 SDK.
Upgrade Expo and the ads wrapper before that date.
See [Google's Android SDK timetable](https://developers.google.com/admob/android/deprecation).

## Operational behavior

- `risk_state` is a conservative hold on the exact affected Stripe purchase.
  It survives subsequent lifecycle reconciliation. Partial refunds, disputes and
  fraud warnings require operator review; no automatic restoration or refund is
  attempted. After resolving the provider issue, review and explicitly clear the
  corresponding hold in the Rails console, then refresh. Verify independent
  purchases remain effective. Add an operator workflow before production volume.
- Refresh reconciles current provider state under the account lock. Webhooks are
  mandatory for background updates; monitor non-2xx responses and retries.
- Deletion is blocked with `409 active_billing` while a subscription can renew
  or a checkout is unsettled. Users cancel at the original provider first; a
  scheduled cancellation may retain access until the paid period ends.
- `billing_events` retains event identity/type only, never raw payloads or
  payment details. It has no account email or user relation. Define retention
  according to the deployment's operational policy.
- The mobile plan controls advertising. Storage quotas and other allowances
  follow the existing policy.

Architecture and sources: [billing specification](../specs/billing.md).

## Local verification

- 51 focused Rails examples for billing, store verification, account deletion
  and Family passed. This includes the existing Family deletion regression,
  corrected by destroying sessions before devices.
- The full Rails suite passed with 348 examples, zero failures and three
  existing MinIO integration examples pending (no MinIO endpoint configured).
  The final 51-example focused pass additionally verifies the subsequent
  webhook-configuration check and independent store Lifetime entitlements.
- 11 SDK/localization checks passed, including redirect validation, purchase
  request scoping and Stripe currency formatting.
- Web/desktop production builds passed. The web screen was reviewed in Chrome
  using an isolated local account at desktop and 390px widths, in English and
  Vietnamese. The disabled purchasing state was verified against the real local
  Rails API, with no configured prices.
- Provider calls in billing specs are controlled test doubles. No real store
  receipt or paid Stripe Checkout was tested. Complete sandbox purchase testing
  still requires the application API key, Prices and webhook configuration.
