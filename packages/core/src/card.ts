export const CARD_BRANDS = ['Visa', 'Mastercard', 'American Express', 'JCB', 'UnionPay', 'NAPAS', 'Discover', 'Diners Club', 'Maestro', 'other'] as const;
export const CARD_TYPES = ['credit', 'debit'] as const;

export function cardBrands(current: string): readonly string[] {
  return current && !CARD_BRANDS.some((brand) => brand === current) ? [...CARD_BRANDS, current] : CARD_BRANDS;
}

export function cardIssuer(title: string, bank: unknown): string {
  if (typeof bank !== 'string' || !bank.trim()) return title;
  const issuer = bank.trim();
  if (!title.trim()) return issuer;
  return title.toLowerCase().includes(issuer.toLowerCase()) ? title : `${issuer} · ${title}`;
}

export function cardNumberDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
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
    fields.card_number = cardNumberDigits(fields.card_number);
    fields.last4 = cardLast4(fields);
  }
  if (fields.card_type !== 'credit') {
    delete fields.credit_limit;
    delete fields.statement_day;
  }
}

export function cardInputError(fields: Record<string, string>, code: string): 'invalidNumber' | 'invalidCvv' | 'invalidStatementDay' | undefined {
  const number = cardNumberDigits(fields.card_number ?? '');
  if (number && !/^\d{12,19}$/.test(number)) return 'invalidNumber';
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
