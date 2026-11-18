# Account billing and cross-platform access

User-confirmed purchase options (18 November 2026): **Free, monthly, yearly,
Lifetime**. Amounts, currency and paid allowances remain unconfirmed. Existing
landing-page prices are proposals, not authorization to charge those amounts.

## Ownership

The Rails account is the entitlement owner. Payment providers prove purchases;
clients never set an entitlement or submit an authoritative expiration date.
Billing never receives vault keys, encrypted item payloads or plaintext contents.
One account can have multiple independent purchases. Effective access is the
union of valid purchases, not whichever webhook arrived last. A refund on one
provider must not remove access bought on another.

Purchase option | Entitlement | Billing behavior
--- | --- | ---
Free | free | No payment provider or renewal
Monthly | pro | Recurring, until verified paid/trial period ends
Yearly | pro | Recurring, until verified paid/trial period ends
Lifetime | pro | One payment, no expiration; revoked for refund/dispute

## Provider boundary

- Web: Stripe hosted Checkout. Monthly/yearly use `subscription`; Lifetime
  uses `payment`. The backend owns an allowlist of Price IDs and checks each
  Price's type. Customer ownership is mapped in the database before Checkout.
- iOS: App Store subscription products for monthly/yearly and a non-consumable
  product for Lifetime. Native purchasing and Restore Purchases stay in iOS.
- Android: Google Play subscriptions/base plans and a non-consumable one-time
  product. Native purchasing and restoration stay in Android.
- The mobile verification adapter may use RevenueCat for Apple/Google receipt
  validation and notifications. It must use the authenticated Rails UUID as its
  app user ID, reject anonymous ownership/implicit account transfers, isolate
  sandbox from production and reconcile server-side before granting access.
  RevenueCat is an implementation dependency, not another customer purchase
  channel. Do not ingest Stripe purchases a second time through RevenueCat.

Store purchases are managed at the original store. Cross-platform access does
not move a subscription or its recurring charge to a different provider.
Block a new web Checkout while any paid entitlement or unsettled checkout is
present. An upgrade to Lifetime while subscribed needs an explicit future
migration policy; it must not silently leave a recurring subscription running.

## State and delivery

Persist customer mapping, provider purchase ID, environment, purchase option,
status, expiry, cancellation-at-period-end and last verified time. Scope unique
purchase identities by provider and environment. Store provider event IDs for
deduplication without retaining complete event payloads or payment details.

Verify Stripe signatures over the raw body. Only acknowledge a relevant event
after successful reconciliation; transient provider failures must return an
error for retry. Retrieve current provider state under a per-account lock so
duplicate/out-of-order deliveries converge. A Checkout success URL is only
navigation; it never grants access. Unpaid/asynchronous Lifetime checkout must
wait for verified payment. Cancellation retains access through the verified
expiry; renewal failure does not extend it. Refund/dispute handling must
reconcile the affected purchase and preserve independent purchases.

## UX

Settings includes a Plan and billing section in English and Vietnamese:
current access, original purchase source, expiration/renewal, history of
independent purchases and a management action for each source. Show all four
purchase options. Fetch prices from the provider; hide purchasing when not
configured rather than inventing amounts. Distinguish loading, signed out,
offline, payment processing, retry and configuration unavailable.

Free/local vault access and encrypted export must remain available when a paid
purchase expires. Expiration never deletes ciphertext. Paid quotas/features
need a separately approved policy; do not silently reduce existing allowances.
Account deletion must not leave a Stripe recurring charge running: require
cancellation first or cancel it with a verified provider operation before
deleting billing ownership. Store cancellations remain in the original store.

## Configuration and rollout

Use an existing isolated Stripe sandbox for development. Keep restricted API
keys and webhook secrets server-side in deployment secrets. No key in Vite
environment variables, browser storage, source control or screenshots.
Configure three Stripe Prices, a customer portal and a verified webhook
destination before enabling purchase controls. Confirm amounts, currency,
entitlements/limits and Lifetime terms before creating the live catalog.
Stripe Tax requires the appropriate business registrations and product/price
tax configuration; an `automatic_tax` flag alone is not sufficient.

Store rollout additionally requires App Store Connect/Play Console products,
provider credentials, native development builds, restore testing, renewal,
cancellation and refund tests. Never label unconnected store adapters as live.

## References checked on 18 November 2026

- https://docs.stripe.com/billing/subscriptions/webhooks
- https://docs.stripe.com/checkout/fulfillment
- https://developer.apple.com/app-store/review/guidelines/#multiplatform-services
- https://developer.android.com/google/play/billing/backend
- https://www.revenuecat.com/docs/customers/identifying-customers
- https://www.revenuecat.com/docs/integrations/webhooks
