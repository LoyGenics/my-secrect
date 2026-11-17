/**
 * Origin / domain matching for autofill — the anti-phishing gate.
 *
 * Rules (all must pass before any fill):
 *  1. The page must be https, except http://localhost / 127.0.0.1 (dev only).
 *  2. The page host must not be an IP address (no filling on raw IPs).
 *  3. The item's stored URL host must match the page host exactly, or one
 *     must be a subdomain of the other (login.example.com <-> example.com).
 *  4. Punycode hosts (an xn-- label in ANY position, including subdomains)
 *     need explicit user confirmation (homograph risk).
 *  5. Bank/card items need explicit user confirmation (settings default on).
 *  6. The content script only ever fills the top-level frame — iframes are
 *     never filled (checked in content.ts with window.top === window.self).
 */

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

export function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
export function isIpHost(host: string): boolean {
  if (IPV4.test(host)) return true;
  // Phase F fix: URL.hostname strips the brackets from IPv6 literals, so an
  // IPv6 host arrives here bare ("::1", "2001:db8::1"). Any colon means an
  // IP literal — the old '[' check never matched and IPv6 fills were allowed.
  if (host.includes(':')) return true;
  return host.startsWith('[');
}

export function isLocalhost(host: string): boolean {
  // Phase F fix: URL.hostname for http://[::1]/ is "::1" (no brackets).
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function domainsMatch(pageHost: string, itemHost: string): boolean {
  const p = normalizeHost(pageHost);
  const i = normalizeHost(itemHost);
  if (!p || !i) return false;
  if (p === i) return true;
  return p.endsWith('.' + i) || i.endsWith('.' + p);
}

export type FillCheck =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: true; needsConfirmation: string };

/** Rules 1-2 (the page alone, no item): https or localhost dev, never a raw IP. */
function pageRefusal(page: URL): string | null {
  if (page.protocol !== 'https:' && !isLocalhost(page.hostname)) return 'Refusing to fill on a non-HTTPS page.';
  if (isIpHost(normalizeHost(page.hostname))) return 'Refusing to fill on a raw IP address.';
  return null;
}

/** Page-only gate for injecting the content script and accepting a login submission. */
export function checkPageAllowed(pageUrl: string): { allowed: true } | { allowed: false; reason: string } {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { allowed: false, reason: 'Could not parse the page URL.' };
  }
  const reason = pageRefusal(page);
  return reason ? { allowed: false, reason } : { allowed: true };
}

export function checkFillAllowed(
  pageUrl: string,
  itemUrl: string,
  itemType: string,
  settings: { requireConfirmForBank: boolean; requireConfirmForPunycode: boolean },
): FillCheck {
  let page: URL;
  let item: URL;
  try {
    page = new URL(pageUrl);
    item = new URL(itemUrl);
  } catch {
    return { allowed: false, reason: 'Could not parse the page or item URL.' };
  }
  const refusal = pageRefusal(page);
  if (refusal) return { allowed: false, reason: refusal };
  const pageHost = normalizeHost(page.hostname);
  const itemHost = normalizeHost(item.hostname);
  if (!domainsMatch(pageHost, itemHost)) {
    return {
      allowed: false,
      reason: `This login is for ${itemHost}, but the page is ${pageHost}.`,
    };
  }
  // Phase F fix: the old check only looked at the FIRST label, so a punycode
  // label in a subdomain (login.xn--e1afmkfd.example.com) skipped confirmation.
  const hasPunycodeLabel = pageHost.split('.').some((label) => label.startsWith('xn--'));
  if (hasPunycodeLabel && settings.requireConfirmForPunycode) {
    return {
      allowed: true,
      needsConfirmation: 'This site uses a punycode (xn--) domain, which can hide look-alike characters. Fill only if you trust it.',
    };
  }
  if ((itemType === 'bank_account' || itemType === 'card') && settings.requireConfirmForBank) {
    return {
      allowed: true,
      needsConfirmation: 'This is a bank / card item. Confirm before filling it.',
    };
  }
  return { allowed: true };
}
