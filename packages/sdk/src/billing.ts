import { ApiError, type ApiClientConfig } from './index';

export type PurchaseOption = 'monthly' | 'yearly' | 'lifetime';
export type BillingProvider = 'stripe' | 'app_store' | 'google_play';
export interface BillingPurchase {
  id: string; provider: BillingProvider; option: PurchaseOption; status: string;
  entitled: boolean; expires_at: string | null; cancel_at_period_end: boolean;
  review_required: boolean; verified_at: string;
}
export interface BillingState {
  tier: 'free' | 'pro'; lifetime: boolean; expires_at: string | null;
  checkout_blocked: boolean; environment: 'test' | 'live'; portal_available: boolean;
  stores_ready: boolean; app_user_id: string; purchases: BillingPurchase[];
  catalog: Array<{ option: PurchaseOption; available: boolean; amount?: number; currency?: string }>;
}

/** Only account and billing metadata. Never send any vault content or keys. */
export class BillingApiClient {
  constructor(private readonly config: ApiClientConfig) {}
  private async request<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
    const token = await this.config.getToken();
    const path = `/v1/billing${suffix}`;
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method, cache: 'no-store', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, path, result);
    return result as T;
  }
  get(): Promise<BillingState> { return this.request(''); }
  refresh(): Promise<BillingState> { return this.request('/refresh', 'POST'); }
  checkout(option: PurchaseOption): Promise<{ url: string }> { return this.request('/checkout', 'POST', { option }); }
  portal(): Promise<{ url: string }> { return this.request('/portal', 'POST'); }
}

export function stripeRedirectUrl(value: string, kind: 'checkout' | 'portal'): string {
  const url = new URL(value);
  const expected = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  if (url.protocol !== 'https:' || url.hostname !== expected || url.username || url.password || url.port) {
    throw new Error('invalid_billing_redirect');
  }
  return url.href;
}

export function storeManagementUrl(provider: Exclude<BillingProvider, 'stripe'>, lifetime = false): string {
  if (provider === 'app_store') return lifetime ? 'https://reportaproblem.apple.com/' : 'https://apps.apple.com/account/subscriptions';
  return lifetime ? 'https://play.google.com/store/account/orderhistory' : 'https://play.google.com/store/account/subscriptions';
}

/** Stripe amounts use the currency's smallest unit, including JPY/KRW. */
export function formatBillingPrice(amount: number, currency: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() });
  const code = currency.toLowerCase();
  const zeroDecimal = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  // ISK/UGX retain two-decimal API representations for compatibility.
  const digits = code === 'isk' || code === 'ugx' ? 2 : zeroDecimal.has(code) ? 0 : formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / (10 ** digits));
}
