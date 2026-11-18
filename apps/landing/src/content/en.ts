import { pricing } from '../site.config';

const amount = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
/** English copy. Double-bracket tokens are placeholders from site.config.ts (shown highlighted until filled). */
export interface LegalSection { h: string; p?: string[]; ul?: string[] }

export const en = {
  lang: 'en',
  htmlLang: 'en',
  meta: {
    home: { title: 'My Secret: an encrypted vault for everything private', description: 'Passwords, passkeys, cards, IDs, notes, SSH keys and private media in one vault, encrypted on your device before anything syncs.' },
    pricing: { title: 'Pricing: Free, Pro and Lifetime | My Secret', description: `Planned pricing: Free, $${amount(pricing.pro.yearly)} a year for Pro, or $${amount(pricing.lifetime)} once for Lifetime. Compare with 1Password, Bitwarden, Proton Pass and Enpass.` },
    security: { title: 'Security: how My Secret protects your data', description: 'Argon2id and XChaCha20-Poly1305, keys that stay on your devices, what the server can see, and the limits we have not solved yet.' },
    privacy: { title: 'Privacy policy | My Secret', description: 'What My Secret stores, what it never receives, how long it keeps it and how to delete your account.' },
    terms: { title: 'Terms of service | My Secret', description: 'The terms for using My Secret, including plans, the Lifetime plan and your responsibility for your keys.' },
    support: { title: 'Support | My Secret', description: 'Contact My Secret and find answers about recovery, sign-in, export and deleting your account.' },
  },
  nav: {
    skip: 'Skip to content', home: 'My Secret home', pricing: 'Pricing', security: 'Security', support: 'Support', cta: 'Sign in', language: 'Language', menu: 'Menu', close: 'Close menu',
  },
  cta: { early: 'Get early access', earlySubject: 'Early access to My Secret' },
  home: {
    hero: { h1: 'Your life.\nUnder lock.', sub: 'An encrypted vault for passwords, cards, IDs, notes and private media.', primary: 'Open the web app', secondary: 'See pricing' },
    scene: { label: 'Interactive illustration of a personal vault', open: 'Open the vault', close: 'Close the vault', pause: 'Pause motion', play: 'Resume motion', hint: 'A little look inside.', unavailable: 'A preview of your private space.' },
    principles: ['Encrypted on your device', 'Offline comes first', 'Your keys stay yours'],
    family: { h2: 'Close to them. Private to you.', sub: 'One family, up to six people. Everyone keeps a separate vault and chooses exactly what to share.', visual: '6 people. 6 private vaults.', points: ['Personal keys for every member', 'Invite and manage your family', 'Share individual items with verified contacts'], link: 'Explore Family' },
    keeps: {
      h2: 'Not just passwords.', sub: 'From your first login to your most personal files. Twelve kinds of private, together.', note: 'Encrypted before it leaves your device.',
      items: ['Logins', 'Passkeys', 'Bank accounts', 'Cards', 'IDs', 'SSH keys', 'API keys', 'Notes', 'Documents', 'Media', 'Collections', 'Custom'],
    },
    server: {
      h2: 'Private before it ever leaves.', sub: 'Encryption happens on your device. Sync carries the encrypted version, while you keep the keys.',
      yoursTitle: 'Stays on your devices',
      yours: ['Your master passphrase', 'Your recovery key', 'Your items, readable only after you unlock'],
      serverTitle: 'What the server stores',
      server: ['Encrypted items and files', 'Item ids, revision numbers, sizes and times', 'Your email and passkey public key'],
      link: 'How the encryption works',
    },
    signin: {
      h2: 'Sign in your way. Unlock with one passphrase.',
      items: [
        { t: 'Email code', d: 'A six-digit code to your inbox. No password to remember.' },
        { t: 'Passkey', d: 'Add one later for a faster sign-in.' },
        { t: 'Recovery key', d: 'Shown once. The only way back in if you forget your passphrase.' },
      ],
      note: 'Signing in never unlocks your vault. Only your passphrase does.',
    },
    everywhere: {
      h2: 'On the screens you already use.',
      items: [
        { t: 'Desktop', d: 'The full app, with encrypted backups and every item type.' },
        { t: 'Web', d: 'Open your vault in a browser. Export is encrypted only.' },
        { t: 'Phone', d: 'iPhone and Android apps with biometric unlock.' },
        { t: 'Browser extension', d: 'Fills logins on the sites you allow, and only there.' },
      ],
      note: 'My Secret is in early access. Apps arrive in stages.',
    },
    price: { h2: 'Free to start. Pro when you need more.', line: `Planned: Free, $${amount(pricing.pro.yearly)} a year, or $${amount(pricing.lifetime)} once.`, link: 'See plans' },
    faq: {
      h2: 'Questions people ask first',
      items: [
        { q: 'What if I forget my passphrase?', a: 'We cannot reset it, and no one can. Your recovery key is the only way back in, so keep it somewhere safe and offline.' },
        { q: 'Can you read my data?', a: 'No. Items are encrypted on your device before they leave it. The server stores ciphertext.' },
        { q: 'Has it been audited?', a: 'Not yet. My Secret has had no independent security audit. The Security page lists what is built and what is not.' },
        { q: 'Does it work offline?', a: 'Yes. Your vault lives on your device, and sync is optional.' },
        { q: 'Can I share items?', a: 'Yes. Share individual items with verified contacts, choose read or edit access, set an expiry and revoke access. Previously seen data cannot be erased from their device.' },
      ],
    },
  },
  pricing: {
    h1: 'Free to start. Pay yearly or once.',
    sub: 'My Secret is in early access. These are the prices we plan to charge, and nothing is billed yet.',
    plans: [
      {
        id: 'free', name: 'Free', price: '$0', unit: 'forever', blurb: 'Everything one person needs.',
        features: ['Unlimited items, all 12 types', 'Works offline on your device', 'Encrypted backup and export', `Sync across ${pricing.free.syncedDevices} devices`, `${pricing.free.fileStorageMB} MB of encrypted file storage`, 'Email-code and passkey sign-in'],
      },
      {
        id: 'pro', name: 'Pro', price: `$${amount(pricing.pro.yearly)}`, unit: 'a year', alt: `or $${amount(pricing.pro.monthly)} a month`, blurb: 'For people who live on several devices.', featured: true,
        features: ['Everything in Free', 'Unlimited synced devices', `${pricing.pro_limits.fileStorageGB} GB of encrypted file storage`, 'Encrypted item sharing'],
      },
      {
        id: 'lifetime', name: 'Lifetime', price: `$${amount(pricing.lifetime)}`, unit: 'once', blurb: 'One payment, no renewals.',
        features: ['Everything in Pro', 'Future Pro features included', 'Lifetime means the life of the product. The Terms explain it.'],
      },
      {
        id: 'family', name: 'Family', price: 'Free', unit: 'during early access', blurb: 'Up to six people. A private vault for each.',
        features: ['One owner and five members', 'Separate vaults and personal encryption keys', 'Invite, accept, leave and remove members', 'Share individual items through verified contacts'],
      },
    ],
    cta: 'Get early access',
    compare: {
      h2: 'How the price compares',
      intro: 'Annual individual plans in USD. Introductory offers and renewal prices are shown separately.',
      cols: { product: 'Product', plan: 'Paid plan', year: 'Per year in USD', free: 'Free plan', lifetime: 'Lifetime' },
      ours: { name: 'My Secret', plan: 'Pro', year: pricing.pro.yearly.toFixed(2), free: 'Free, unlimited items', lifetime: `$${amount(pricing.lifetime)} once (planned)` },
      source: 'Source',
    },
    matrix: {
      h2: 'My Secret next to the others',
      intro: 'The details that help you choose. Planned features and plan limits are labelled.',
      legend: { yes: 'Yes', no: 'No', partial: 'Partly', na: 'Not stated' },
      key: 'Comparison key',
      jump: 'Compare features with other apps',
      scrollHint: 'Swipe sideways to compare all five apps. Use the arrow keys when the table is focused.',
      oursStatus: 'Early access',
      featureCol: 'Feature',
      features: {
        freePlan: 'Free plan',
        lifetime: 'Lifetime plan',
        localFirst: 'Works fully offline with no account',
        itemTypes: 'Item types beyond logins',
        passkeys: 'Stores passkeys',
        totp: 'Built-in authenticator codes',
        files: 'Encrypted file storage',
        health: 'Password health reports',
        sharing: 'Secure sharing',
        emergency: 'Emergency access',
        family: 'Family plan',
      },
      footnote: 'My Secret is in early access and has had no independent security audit. Its paid plans and storage allowances are proposals. Competitor features may require a paid plan; absence from a pricing page is not treated as a missing feature.',
    },
    faq: {
      h2: 'About billing',
      items: [
        { q: 'Is billing live?', a: 'Not yet. Early access is free. We will announce paid plans before any charge.' },
        { q: 'What does Lifetime mean?', a: 'You pay once and keep Pro for as long as My Secret operates. If we ever shut down, we will give notice and time to export. The Terms have the exact wording.' },
        { q: 'What happens if I stop paying for Pro?', a: 'Your vault stays on your device and you can always export it. We will publish exactly how sync limits apply before billing starts.' },
        { q: 'Can I get a refund?', a: 'Our refund window will be [[REFUND_DAYS]] days. It is set out in the Terms.' },
      ],
    },
  },
  security: {
    h1: 'How My Secret protects your data',
    sub: 'What is built, how it works, and what is not solved yet.',
    sections: [
      { h: 'Keys stay with you', p: ['Your master passphrase is stretched with Argon2id into the keys that protect your vault. Items and files are encrypted with XChaCha20-Poly1305 using libsodium, on your device, before anything syncs.', 'The server never receives your passphrase, your recovery key or any decryption key.'] },
      { h: 'What the server can see', ul: ['Encrypted items and encrypted file chunks.', 'Item ids, revision numbers, timestamps, sizes and device ids.', 'Your email, your passkey public keys and your devices’ public keys.', 'Per session: a digest of the token, its expiry, the app name and the IP address, so you can review and end sessions.'] },
      { h: 'Signing in is not unlocking', p: ['Account sign-in uses an email code, or a passkey once you add one. Optional TOTP adds a second factor. Sign-in gives your device a short-lived session for sync and account actions.', 'Your vault opens only with your master passphrase, a recovery key or the biometric key on that device. Sensitive actions, such as removing a passkey or deleting the account, ask you to verify again first.'] },
      { h: 'If you lose access', p: ['There is no backdoor and no operator recovery. If you lose both your passphrase and your recovery key, no one can open your vault, including us.', 'Keep your recovery key offline, and keep an encrypted export somewhere safe.'] },
      { h: 'Devices and revoking them', p: ['Each device holds its own key. Revoking a device ends its sessions and rotates its key envelopes. It does not erase what that device already holds, and the interface says so.', 'An account that signs in with an email code only has no durable revocation: whoever holds the mailbox can enrol a new device. Adding a passkey closes that gap.'] },
      { h: 'Limits we have not solved', ul: ['No independent security audit yet.', 'The web app is a separate attack surface, so it is limited: encrypted export only and no browser autofill.', 'Shared items require the recipient to have an account and a verified sharing key. File attachments are not included in item sharing.', 'The phone apps do not yet have a device key, so a phone session covers account actions but not sync.', 'Rotating the vault key is not implemented, so revoking a device does not protect items it already holds.'] },
      { h: 'Report a vulnerability', p: ['Write to [[SECURITY_EMAIL]] with the steps to reproduce. Please give us reasonable time to fix a problem before you publish it.'] },
    ] as LegalSection[],
  },
  support: {
    h1: 'Support',
    sub: 'We answer by email. Never send your passphrase or your recovery key to anyone, including us.',
    contactH: 'Write to us',
    contact: 'Email [[SUPPORT_EMAIL]] and tell us the app, its version and what you expected to happen.',
    faqH: 'Common questions',
    faq: [
      { q: 'I forgot my master passphrase.', a: 'Unlock with your recovery key instead, then set a new passphrase. Without the recovery key nobody can open the vault.' },
      { q: 'I lost my phone or laptop.', a: 'Sign in on another device, open Security Center and revoke the lost device. Revoking ends its sessions but cannot erase data already on it.' },
      { q: 'The email code does not arrive.', a: 'Check your spam folder and wait a minute, then request a new code. Each new code replaces the last one. If your account has a passkey we send a notice instead of a code, so sign in with the passkey.' },
      { q: 'How do I export my data?', a: 'Open Settings, then Export. Exports are encrypted. Keep one offline with your recovery key.' },
      { q: 'How do I delete my account?', a: 'Open Security Center, choose Delete account and verify it is you. The server account and its encrypted data are deleted at once and cannot be restored. The vault on your device is not erased.' },
    ],
  },
  privacy: {
    h1: 'Privacy policy',
    sections: [
      { h: 'Who we are', p: ['My Secret is run by [[COMPANY_NAME]], [[COMPANY_ADDRESS]]. This policy covers the My Secret apps, the browser extension and this website. You can reach us at [[PRIVACY_EMAIL]].', 'In short: your vault is encrypted on your device, the server stores ciphertext, and we do not run ads, trackers or third-party analytics.'] },
      { h: 'Vault encryption', p: ['Vault sync sends encrypted items, files and names. Signing in, unlocking and recovery keep your master passphrase, recovery key and vault decryption keys on your device.'] },
      { h: 'Optional AI import', p: ['After you agree, we forward the text you pasted to the OpenAI API and return a preview. We do not store, log or publish the text or preview. We request that OpenAI does not store the response. OpenAI API data is excluded from training by default. Abuse monitoring logs may include the text and generally retain it for up to 30 days. CSV import is processed on your device.'] },
      { h: 'What we store', ul: [
        'Account: your email, your passkey public keys with their credential ids and counters, and your devices’ public keys.',
        'Vault: encrypted items, encrypted file chunks and an encrypted file manifest, plus item ids, revision numbers, timestamps, sizes and device ids.',
        'Family: group id, owner and member account ids, invitation state and expiry. Active members can see the group’s email roster; pending invitees see only their inviter.',
        'Sharing: the parties’ account ids and public keys, access permissions, expiry and encrypted shared records. Shared content is readable only by the intended parties.',
        'Sessions: a digest of each session token, its expiry, the app or browser name, the IP address and the step-up state.',
        'Audit events: an event type, a small amount of metadata such as the sign-in method, and a timestamp. They hold no content.',
        'Sign-up: the email and a digest of the six-digit code, until used or expired.',
      ] },
      { h: 'Logs', p: ['Server request logs record the method, the path with opaque ids, the status, the duration and a request id. They do not record query strings, request bodies or client IP addresses, and the reverse proxy keeps no access log.'] },
      { h: 'Ads, trackers and analytics', p: ['None. The apps and this website load no advertising or third-party analytics code. This website sets no cookies and stores only your language choice in your browser.'] },
      { h: 'Who processes data for us', ul: ['[[EMAIL_PROVIDER]] sends the sign-up email, so it receives your address and the code.', '[[PAYMENT_PROVIDER]] will process payments once paid plans start. We do not see your card number.', 'Our hosting and object-storage providers hold encrypted data and cannot read it.'] },
      { h: 'How long we keep data', ul: [
        'Vault data: until you delete the item, the vault or your account.',
        'Session records: until you delete your account, and removed [[SESSION_PURGE_DAYS]] days after they expire or are revoked.',
        'Audit events: kept without your identity after you delete your account.',
        'Backups: a backup made before you deleted your account can still hold your encrypted data for up to [[BACKUP_RETENTION_DAYS]] days.',
      ] },
      { h: 'Your choices', ul: [
        'Export your vault in encrypted form at any time.',
        'Delete your account in the app. Deletion is immediate and permanent on our servers. It does not erase the vault on your device.',
        'Ask for access to, or correction of, the account data we hold by writing to [[PRIVACY_EMAIL]].',
      ] },
      { h: 'Security', p: ['Keys never leave your device. Connections use TLS and the web app runs under a strict content security policy. Read the Security page for what is built and what is not. No independent audit has been done yet.'] },
      { h: 'Children', p: ['My Secret is not directed to children.'] },
      { h: 'Where data is processed', p: ['Our servers and providers may be in countries other than yours. We are based in [[COUNTRY]].'] },
      { h: 'Changes', p: ['If we change this policy in a way that matters, we will say so in the app or by email before it applies. The date at the top shows the latest version.'] },
    ] as LegalSection[],
  },
  terms: {
    h1: 'Terms of service',
    sections: [
      { h: 'Agreement', p: ['These terms are between you and [[COMPANY_NAME]] ("we"). By creating an account or using My Secret you agree to them. If you do not agree, do not use it.'] },
      { h: 'The service', p: ['My Secret is an encrypted personal vault with optional sync. It is in early access, so features can change, break or be removed.'] },
      { h: 'Your account', ul: ['You are responsible for the email address you use and for keeping your devices secure.', 'You must give a real email address and may not use another person’s account.', 'You can delete your account at any time in the app.'] },
      { h: 'Your content and your keys', p: ['What you store is yours. We cannot read it and we claim no rights to it, other than the right to store and transmit the encrypted data so the service works.', 'You are responsible for your master passphrase and your recovery key. We cannot recover either. If you lose both, your data is lost for good.'] },
      { h: 'Acceptable use', ul: ['Do not break the law or use My Secret to store content you have no right to hold.', 'Do not attack, overload or probe the service, or try to read other people’s data.', 'Do not resell the service.'] },
      { h: 'Plans and payment', p: ['A free plan is available. Paid plans, when they start, are Pro (monthly or yearly) and Lifetime. Prices are shown on the pricing page before you pay and are charged through [[PAYMENT_PROVIDER]]. Taxes may apply.', 'Pro renews each period until you cancel. You can cancel at any time and keep Pro until the end of the period you paid for.', 'Lifetime is one payment for Pro features for as long as we operate My Secret. It does not mean the lifetime of the buyer. If we decide to stop operating the service we will give you at least 90 days’ notice and time to export your data.', 'Refunds are available within [[REFUND_DAYS]] days of a first purchase. We will tell you about a price change before it applies to you.'] },
      { h: 'No warranty', p: ['My Secret is provided as is, during early access, without any warranty that it will be uninterrupted or error free. It has not had an independent security audit. Keep an encrypted export of your vault.'] },
      { h: 'Limit of liability', p: ['To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of data that you could have avoided with a backup or a recovery key. Our total liability for any claim is limited to what you paid us in the 12 months before it. Nothing here limits liability that the law does not let us limit.'] },
      { h: 'Ending the agreement', p: ['You can stop at any time and delete your account. We may suspend or end an account that breaks these terms or puts the service or other people at risk, and will tell you why when we can.'] },
      { h: 'Changes to these terms', p: ['We may update these terms. If a change matters we will tell you in the app or by email before it applies. Using the service after that means you accept it.'] },
      { h: 'Governing law', p: ['These terms are governed by the law of [[COUNTRY]]. Questions about them can go to [[SUPPORT_EMAIL]].'] },
    ] as LegalSection[],
  },
  footer: {
    tagline: 'Encrypted on your device. Stored as ciphertext.',
    product: 'Product', legal: 'Legal', company: 'Help', privacy: 'Privacy policy', terms: 'Terms of service',
    early: 'Early access software.', rights: '© 2026 [[COMPANY_NAME]]', updated: 'Last updated',
  },
  common: { updatedOn: 'Last updated', sourceFor: 'Source', open: 'Open' },
};

export type Copy = typeof en;
