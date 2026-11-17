/**
 * Origin / domain matching for autofill — the anti-phishing gate.
 *
 * Rules (all must pass before any fill):
 *  1. The page must be https, except http://localhost / 127.0.0.1 (dev only).
 *  2. The page host must not be an IP address (no filling on raw IPs).
 *  3. The item's stored URL host must match the page host exactly, or one
 *     must be a subdomain of the other (login.example.com <-> example.com).
 *  4. Punycode hosts (xn--) need explicit user confirmation (homograph risk).
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
  return IPV4.test(host) || host.startsWith('[');
}

export function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
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
  if (page.protocol !== 'https:' && !isLocalhost(page.hostname)) {
    return { allowed: false, reason: 'Refusing to fill on a non-HTTPS page.' };
  }
  const pageHost = normalizeHost(page.hostname);
  if (isIpHost(pageHost)) {
    return { allowed: false, reason: 'Refusing to fill on a raw IP address.' };
  }
  const itemHost = normalizeHost(item.hostname);
  if (!domainsMatch(pageHost, itemHost)) {
    return {
      allowed: false,
      reason: `This login is for ${itemHost}, but the page is ${pageHost}.`,
    };
  }
  if (pageHost.startsWith('xn--') && settings.requireConfirmForPunycode) {
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
