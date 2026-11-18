/**
 * The one file to edit before publishing.
 *
 * Every `null` below is a REPLACE-ME placeholder: pages show it as a highlighted
 * [TOKEN] so it cannot slip out unnoticed. `npm --workspace apps/landing run
 * check:placeholders` lists what is still empty (add --strict to fail on any).
 *
 * Prices are PROPOSALS from the competitor research of 18 Nov 2026
 * (docs/landing-pricing.md); nothing is billed by the product yet.
 */
export const site = {
  name: 'My Secret',
  origin: 'https://msecret.app',
  appUrl: 'https://my.msecret.app/',
  /** Last edit of the legal pages. */
  updated: '2026-11-18',
  placeholders: {
    COMPANY_NAME: null as string | null,
    COMPANY_ADDRESS: null as string | null,
    COUNTRY: null as string | null,
    SUPPORT_EMAIL: null as string | null,
    SECURITY_EMAIL: null as string | null,
    PRIVACY_EMAIL: null as string | null,
    EMAIL_PROVIDER: null as string | null,
    PAYMENT_PROVIDER: null as string | null,
    BACKUP_RETENTION_DAYS: null as string | null,
    SESSION_PURGE_DAYS: null as string | null,
    REFUND_DAYS: null as string | null,
  },
} as const;

export type PlaceholderKey = keyof typeof site.placeholders;

/** USD, proposals. Pro yearly is the headline price. */
export const pricing = {
  currency: 'USD',
  pro: { monthly: 2.99, yearly: 24 },
  lifetime: 89,
  /** Free-plan limits that the plans page states. Not enforced by the product yet. */
  free: { syncedDevices: 2, fileStorageMB: 100 },
  pro_limits: { fileStorageGB: 5 },
} as const;

/** Competitor facts read from each vendor's own public pricing page on 18 Nov 2026. */
export const competitors = [
  {
    name: '1Password',
    plan: 'Individual',
    yearlyUsd: '47.88',
    yearlyNote: { en: '$3.99 a month billed yearly; $2.99 for the first year', vi: '3,99 USD mỗi tháng, trả theo năm; 2,99 USD cho năm đầu' },
    free: { en: 'No free plan, 14-day trial', vi: 'Không có gói miễn phí, dùng thử 14 ngày' },
    lifetime: { en: 'Not offered on the page', vi: 'Trang giá không có' },
    source: 'https://1password.com/pricing/password-manager',
  },
  {
    name: 'Bitwarden',
    plan: 'Premium',
    yearlyUsd: '19.80',
    yearlyNote: { en: 'Billed yearly', vi: 'Trả theo năm' },
    free: { en: 'Free plan, always free', vi: 'Có gói miễn phí' },
    lifetime: { en: 'Not offered on the page', vi: 'Trang giá không có' },
    source: 'https://bitwarden.com/pricing/',
  },
  {
    name: 'Proton Pass',
    plan: 'Plus',
    yearlyUsd: '35.88',
    yearlyNote: { en: '$23.88 for the first 12 months, then $35.88 a year', vi: '23,88 USD cho 12 tháng đầu, sau đó 35,88 USD mỗi năm' },
    free: { en: 'Free plan, 2 vaults, no item sharing', vi: 'Có gói miễn phí, 2 kho, không chia sẻ từng mục' },
    lifetime: { en: 'Not offered on the page', vi: 'Trang giá không có' },
    source: 'https://proton.me/pass/pricing',
  },
  {
    name: 'Enpass',
    plan: 'Premium',
    yearlyUsd: '23.88',
    yearlyNote: { en: '$1.99 a month billed annually', vi: '1,99 USD mỗi tháng, trả theo năm' },
    free: { en: 'Free up to 25 items', vi: 'Miễn phí tới 25 mục' },
    lifetime: { en: 'Not offered on the page', vi: 'Trang giá không có' },
    source: 'https://www.enpass.io/pricing/',
  },
] as const;

export const asOf = { en: '18 November 2026', vi: '18 tháng 11 năm 2026' } as const;

export type Mark = 'yes' | 'no' | 'partial' | 'na';
export interface Cell { v: Mark; en?: string; vi?: string }
const y = (en?: string, vi?: string): Cell => ({ v: 'yes', en, vi });
const n = (en?: string, vi?: string): Cell => ({ v: 'no', en, vi });
const p = (en?: string, vi?: string): Cell => ({ v: 'partial', en, vi });
const u: Cell = { v: 'na' };

/** Columns of the feature matrix, in order. `ours` is My Secret; the rest are read from the vendor pages above. */
export const matrixColumns = ['ours', '1Password', 'Bitwarden', 'Proton Pass', 'Enpass'] as const;

export type FeatureId = 'freePlan' | 'lifetime' | 'localFirst' | 'itemTypes' | 'passkeys' | 'totp' | 'files' | 'health' | 'sharing' | 'emergency' | 'family';

/**
 * Facts only from each vendor's own pricing page (18 Nov 2026) or this repo.
 * `na` = the page does not confirm availability, never "no".
 * `no` requires an explicit exclusion. Proposed My Secret plans are labelled.
 */
export const matrix: Array<{ id: FeatureId; cells: [Cell, Cell, Cell, Cell, Cell] }> = [
  { id: 'freePlan', cells: [y('Unlimited items', 'Không giới hạn mục'), n('14-day trial only', 'Chỉ dùng thử 14 ngày'), y('Unlimited items', 'Không giới hạn mục'), y('2 vaults', '2 kho'), y('Up to 25 items', 'Tối đa 25 mục')] },
  { id: 'lifetime', cells: [p(`Planned · $${pricing.lifetime} once`, `Dự kiến · ${pricing.lifetime} USD một lần`), u, u, u, u] },
  { id: 'localFirst', cells: [y(), u, u, u, u] },
  { id: 'itemTypes', cells: [y('12 types', '12 loại'), y('Addresses, cards', 'Địa chỉ, thẻ'), y('Notes, cards, identities', 'Ghi chú, thẻ, danh tính'), y('Notes, cards', 'Ghi chú, thẻ'), y('Cards, custom templates', 'Thẻ, mẫu tùy chỉnh')] },
  { id: 'passkeys', cells: [y(), u, y(), y(), y()] },
  { id: 'totp', cells: [y(), u, y('Premium'), y('Plus'), y()] },
  { id: 'files', cells: [y(`Proposed Pro allowance: ${pricing.pro_limits.fileStorageGB} GB`, `Dung lượng Pro đề xuất: ${pricing.pro_limits.fileStorageGB} GB`), y('1 GB', '1 GB'), y('5 GB, Premium', '5 GB, Premium'), y('Plus'), y('Your own cloud', 'Đám mây của bạn')] },
  { id: 'health', cells: [y(), y(), y('Premium'), y(), y()] },
  { id: 'sharing', cells: [y('Verified contacts', 'Người nhận đã xác minh'), y(), y(), y('Plus'), u] },
  { id: 'emergency', cells: [n(), u, y('Premium'), y('Plus'), u] },
  { id: 'family', cells: [y('Up to 6 · early access', 'Tối đa 6 · dùng sớm'), y('Up to 5', 'Tối đa 5'), y('Up to 6', 'Tối đa 6'), y('Up to 6', 'Tối đa 6'), y('Up to 6', 'Tối đa 6')] },
];
