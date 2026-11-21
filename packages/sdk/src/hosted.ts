/** The hosted My Secret cloud every client uses by default. Vaults sync their
 *  ciphertext here after sign-in; a different server is a developer override
 *  only (build-time env / development builds), never a user-facing choice. */
export const HOSTED_API_BASE_URL = 'https://my.msecret.app/api';
