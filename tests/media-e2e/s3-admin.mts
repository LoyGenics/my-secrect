// Direct S3 access with the stack's (throwaway) root credentials — the view of
// a hostile storage operator. Used only by tests to overwrite, truncate, list
// and delete stored objects behind the API's back. Minimal SigV4 (header
// auth, UNSIGNED-PAYLOAD), path-style, over the public Caddy endpoint.
import { createHash, createHmac } from 'node:crypto';

const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is required (run via tests/media-e2e/run.sh)`); return v; };

function hmac(key: Buffer | string, data: string): Buffer { return createHmac('sha256', key).update(data).digest(); }
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const encodeKey = (key: string) => key.split('/').map((s) => encodeURIComponent(s)).join('/');

export function s3Admin() {
  const endpoint = new URL(need('E2E_S3_ENDPOINT'));
  const bucket = need('E2E_S3_BUCKET');
  const accessKey = need('E2E_S3_ACCESS_KEY');
  const secretKey = need('E2E_S3_SECRET_KEY');
  const region = 'us-east-1';

  async function request(method: string, path: string, query: Record<string, string> = {}, body?: Uint8Array): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const qs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    const headers: Record<string, string> = { host: endpoint.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
    const signed = Object.keys(headers).sort();
    const canonical = [method, path, qs, ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
    const { host: _host, ...sendHeaders } = headers;
    return fetch(`${endpoint.origin}${path}${qs ? `?${qs}` : ''}`, { method, body: body as unknown as BodyInit, headers: { ...sendHeaders, authorization: auth } });
  }

  return {
    async put(key: string, bytes: Uint8Array) {
      const r = await request('PUT', `/${bucket}/${encodeKey(key)}`, {}, bytes);
      if (r.status !== 200) throw new Error(`admin PUT ${key}: HTTP ${r.status} ${await r.text()}`);
    },
    async get(key: string): Promise<Uint8Array | null> {
      const r = await request('GET', `/${bucket}/${encodeKey(key)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`admin GET ${key}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async del(key: string) {
      const r = await request('DELETE', `/${bucket}/${encodeKey(key)}`);
      if (r.status !== 204 && r.status !== 200) throw new Error(`admin DELETE ${key}: HTTP ${r.status}`);
    },
    /** Keys (and sizes) under a prefix. Single page (<= 1000 keys) is enough for these tests. */
    async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
      const r = await request('GET', `/${bucket}`, { 'list-type': '2', prefix });
      if (r.status !== 200) throw new Error(`admin LIST ${prefix}: HTTP ${r.status}`);
      const xml = await r.text();
      return [...xml.matchAll(/<Contents>.*?<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs)].map((m) => ({ key: m[1], size: Number(m[2]) }));
    },
  };
}
