/** Local-only synthetic API for native UI review. Never a production server.
 * Run: node apps/mobile/dev/ui-review-server.mjs
 * Configure ONLY a dedicated simulator with http://127.0.0.1:3737.
 * Email codes 123456 and MFA 654321 are fixtures; no email is sent.
 * POST /__review/state { family: 'owner'|'full'|'member'|'invited'|'none' }.
 * No vault contents are read or written by this server.
 */
import http from 'node:http';
import sodium from 'libsodium-wrappers-sumo';
await sodium.ready;
let identity = null;
let familyMode = 'owner';
const peer = sodium.crypto_box_keypair();
const now = '2026-11-18T02:00:00.000Z';
const session = { token: 'ui-review-session-not-a-real-token', user_id: 'review-user', expires_in: 3600 };
function familyState() {
  const members = [{ id: 'member-1', user_id: 'review-user', email: 'review@example.com', role: 'owner', status: 'active' }, { id: 'member-2', user_id: 'person-2', email: 'alex@example.com', role: 'member', status: 'active' }];
  if (familyMode === 'full') for (let n = 3; n <= 6; n++) members.push({ id: `member-${n}`, user_id: `person-${n}`, email: `person${n}@example.com`, role: 'member', status: n === 6 ? 'pending' : 'active' });
  return { current_user_id: 'review-user', family: ['none','invited'].includes(familyMode) ? null : { id: 'review-family', owner_id: 'review-user', role: familyMode === 'member' ? 'member' : 'owner', seats: 6, members }, invitation: familyMode === 'invited' ? { id: 'review-invitation', owner_email: 'alex@example.com', expires_at: '2026-11-25T02:00:00Z' } : null };
}
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  let data = {}; try { data = body ? JSON.parse(body) : {}; } catch { /* invalid fixture request */ }
  const path = new URL(req.url, 'http://127.0.0.1:3737').pathname;
  function send(value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
  if (path === '/__review/state') { familyMode = data.family ?? familyMode; return send({ family: familyMode }); }
  if (path === '/v1/auth/email/request' || path === '/v1/auth/step-up/email/request') return send({ status: 'sent', expires_in: 300 });
  if (path === '/v1/auth/email/verify') return send({ registration_ticket: 'ui-review-ticket', expires_in: 600 });
  if (path === '/v1/auth/email/session') return send({ mfa_required: true, mfa_token: 'ui-review-mfa', user_id: 'review-user' });
  if (path === '/v1/auth/mfa/verify') return send(session);
  if (path.startsWith('/v1/auth/step-up/')) return send({ verified: true });
  if (path === '/v1/auth/passkeys') return send({ passkeys: [{ id: 'review-passkey', credential_id_prefix: 'Review passkey', created_at: now }] });
  if (path === '/v1/auth/sessions') return send({ sessions: [{ id: 'review-session', device_id: 'Review iPhone', current: true, user_agent: 'My Secret iOS', ip_address: '127.0.0.1', created_at: now }, { id: 'review-other', device_id: 'Review Mac', current: false, user_agent: 'My Secret macOS', ip_address: '127.0.0.1', created_at: now }] });
  if (path === '/v1/devices') return send({ devices: [{ id: 'review-phone', platform: 'ios', trusted_at: now, created_at: now, last_seen_at: now }, { id: 'review-mac', platform: 'macos', trusted_at: null, created_at: now, last_seen_at: now }] });
  if (path === '/v1/auth/activity') return send({ events: [{ event_type: 'session.created', device_id: 'Review iPhone', created_at: now }] });
  if (path === '/v1/auth/mfa/enroll') return send({ secret: 'JBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/Review?secret=JBSWY3DPEHPK3PXP' });
  if (path === '/v1/auth/mfa/confirm' || path === '/v1/auth/mfa/recovery_codes') return send({ mfa_enabled: true, recovery_codes: ['REVIEW-CODE-01','REVIEW-CODE-02','REVIEW-CODE-03'] });
  if (path === '/v1/family') { if (req.method === 'POST') familyMode = 'owner'; return send(familyState()); }
  if (path.startsWith('/v1/family/')) return send(familyState());
  if (path === '/v1/identity-key') {
    if (req.method === 'PUT') identity = { user_id: 'review-user', public_key: data.public_key, encrypted_secret_key: data.encrypted_secret_key, created_at: now };
    return identity ? send({ identity_key: identity }) : send({ error: 'not_found' }, 404);
  }
  if (path === '/v1/identity-keys/lookup') return send({ user_id: 'review-peer', email: data.email, public_key: sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL) });
  if (path === '/v1/shares') return send({ shares: [] });
  if (req.method === 'DELETE') return send({ revoked: true });
  return send({ error: 'unsupported_review_fixture' }, 404);
});
server.listen(3737, '127.0.0.1', () => console.log('Synthetic mobile UI API listening on 127.0.0.1:3737'));
