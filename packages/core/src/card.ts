import creditCardType from 'credit-card-type';

export const CARD_BRANDS = ['Visa', 'Mastercard', 'American Express', 'JCB', 'UnionPay', 'NAPAS', 'Discover', 'Diners Club', 'Maestro', 'other'] as const;
export const CARD_TYPES = ['credit', 'debit'] as const;

export function cardBrands(current: string): readonly string[] {
  return current && !CARD_BRANDS.some((brand) => brand === current) ? [...CARD_BRANDS, current] : CARD_BRANDS;
}

export function cardIssuer(title: string, bank: unknown): string {
  if (typeof bank !== 'string' || !bank.trim()) return title;
  const issuer = bank.trim();
  if (!title.trim()) return issuer;
  const lowerTitle = title.trim().toLowerCase();
  const lowerIssuer = issuer.toLowerCase();
  return lowerTitle === lowerIssuer || lowerTitle.startsWith(`${lowerIssuer} `) ? title : `${issuer} · ${title}`;
}

export function cardNumberDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function detectCardBrand(value: string): string | undefined {
  const digits = cardNumberDigits(value);
  if (!/^\d{1,19}$/.test(digits)) return;
  if (digits.startsWith('9704')) return 'NAPAS';
  const [match, alternative] = creditCardType(digits);
  if (match?.matchStrength && !alternative && CARD_BRANDS.some((brand) => brand === match.niceType)) {
    return match.niceType;
  }
}

export function formatCardNumber(value: string, brand = detectCardBrand(value)): string {
  const digits = cardNumberDigits(value);
  if (!/^\d*$/.test(digits)) return value;
  if (brand === 'American Express' || brand === 'Diners Club') {
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10)].filter(Boolean).join(' ');
  }
  return digits.match(/\d{1,4}/g)?.join(' ') ?? '';
}

export function cardLast4(fields: Record<string, unknown>): string {
  const number = typeof fields.card_number === 'string' ? cardNumberDigits(fields.card_number) : '';
  if (number.length >= 4) return number.slice(-4);
  return typeof fields.last4 === 'string' ? fields.last4 : '';
}

export function isCardVerificationField(key: string): boolean {
  return /^(cvv2?|cvc2?)$/i.test(key);
}

export function prepareCardFields(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) {
    if (isCardVerificationField(key)) delete fields[key];
  }
  delete fields.bank;
  if (typeof fields.card_number === 'string') {
    const number = cardNumberDigits(fields.card_number);
    fields.card_number = number;
    fields.last4 = cardLast4(fields);
    if (!fields.brand) {
      const brand = detectCardBrand(number);
      if (brand) fields.brand = brand;
    }
  }
  if (fields.card_type !== 'credit') {
    delete fields.credit_limit;
    delete fields.statement_day;
  }
}

export function cardInputError(fields: Record<string, string>, code: string): 'invalidNumber' | 'invalidCvv' | 'invalidStatementDay' | undefined {
  const number = cardNumberDigits(fields.card_number ?? '');
  if (fields.card_number?.trim() && !/^\d{12,19}$/.test(number)) return 'invalidNumber';
  if (code && !/^\d{3,4}$/.test(code)) return 'invalidCvv';
  const day = fields.statement_day?.trim();
  if (fields.card_type === 'credit' && day && !/^(0?[1-9]|[12]\d|3[01])$/.test(day)) return 'invalidStatementDay';
}

export function encodeLocalCardCode(id: string, code: string): string {
  if (!/^\d{3,4}$/.test(code)) throw new Error('Invalid card verification code');
  return JSON.stringify(['local-card-code-v1', id, code]);
}

export function decodeLocalCardCode(id: string, plaintext: string): string {
  const value: unknown = JSON.parse(plaintext);
  if (!Array.isArray(value) || value[0] !== 'local-card-code-v1' || value[1] !== id
      || typeof value[2] !== 'string' || !/^\d{3,4}$/.test(value[2])) {
    throw new Error('Invalid local card code');
  }
  return value[2];
}
