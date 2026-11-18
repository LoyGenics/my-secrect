export const EMAIL_CODE_LENGTH = 6;
export const RECOVERY_REVIEW_LENGTH = 4;

export function isAccountEmail(address: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(address);
}

export function normalizeOtp(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, EMAIL_CODE_LENGTH);
}

export function normalizeMfaRecoveryCode(value: string): string {
  const characters = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}

export function matchesRecoveryKeyEnding(recoveryKey: string, input: string): boolean {
  return input.length === RECOVERY_REVIEW_LENGTH && recoveryKey.endsWith(input);
}
