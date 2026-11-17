/**
 * A WebAuthn software authenticator for Node (ES256, attestation "none").
 *
 * It does what a platform authenticator does: holds a P-256 key pair, makes a
 * credential on `create`, signs `authenticatorData || SHA-256(clientDataJSON)`
 * on `get`, increments a sign counter, sets the UP+UV flags. It is NOT a mock
 * of the server: the Rails API verifies every ceremony with the `webauthn`
 * gem (challenge, origin, RP id hash, flags, signature, counter) exactly as it
 * does for a browser. `exportCredential` / `importCredential` model a synced
 * passkey so two clients can sign in to the same account.
 */
import { createHash, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  throw new Error('cbor: length too large for this minimal encoder');
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  const parts: Buffer[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

export interface ExportedCredential { id: string; privateKeyPem: string; signCount: number }

export class SoftwareAuthenticator {
  private constructor(
    readonly credentialId: Buffer,
    private privateKey: ReturnType<typeof createPrivateKey>,
    private jwk: { x: string; y: string },
    public signCount: number,
    private origin: string,
    private rpId: string,
  ) {}

  static create(origin: string, rpId: string): SoftwareAuthenticator {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string };
    return new SoftwareAuthenticator(randomBytes(32), privateKey, jwk, 0, origin, rpId);
  }

  static importCredential(c: ExportedCredential, origin: string, rpId: string): SoftwareAuthenticator {
    const privateKey = createPrivateKey(c.privateKeyPem);
    const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string };
    return new SoftwareAuthenticator(Buffer.from(c.id, 'base64url'), privateKey, jwk, c.signCount, origin, rpId);
  }

  exportCredential(): ExportedCredential {
    return { id: b64u(this.credentialId), privateKeyPem: this.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), signCount: this.signCount };
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() equivalent. `challenge` is the base64url string from the server. */
  create(challenge: string, opts: { origin?: string } = {}) {
    const rpIdHash = createHash('sha256').update(this.rpId).digest();
    const cose = new Map<Cbor, Cbor>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.jwk.x, 'base64url')],
      [-3, Buffer.from(this.jwk.y, 'base64url')],
    ]);
    const counter = Buffer.alloc(4);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), counter, Buffer.alloc(16), credLen, this.credentialId, cbor(cose)]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      type: 'public-key',
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      response: { attestationObject: b64u(attestationObject), clientDataJSON: b64u(this.clientData('webauthn.create', challenge, opts.origin)) },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() equivalent. */
  get(challenge: string, opts: { corruptSignature?: boolean } = {}) {
    this.signCount += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    const authData = Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([0x05]), counter]);
    const clientData = this.clientData('webauthn.get', challenge);
    const signer = createSign('sha256');
    signer.update(Buffer.concat([authData, createHash('sha256').update(clientData).digest()]));
    const signature = signer.sign(this.privateKey);
    if (opts.corruptSignature) signature[signature.length - 1] ^= 0xff;
    return {
      type: 'public-key',
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}
