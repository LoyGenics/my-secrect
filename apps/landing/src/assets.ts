import ghostMark from '../../../packages/ui/assets/brand/source/ghost-key-cutout.webp';
/** Clay art from the shared brand set (packages/ui/assets/illustrations). Decorative: alt is empty on purpose. */
import hero from '../../../packages/ui/assets/mascot/ghost-proud.webp';
import locked from '../../../packages/ui/assets/mascot/ghost-sleepy.webp';
import passphrase from '../../../packages/ui/assets/mascot/ghost-guard.webp';
import recovery from '../../../packages/ui/assets/mascot/ghost-thinking.webp';
import done from '../../../packages/ui/assets/mascot/ghost-success.webp';
import offline from '../../../packages/ui/assets/mascot/ghost-sad.webp';
import login from '../../../packages/ui/assets/illustrations/type-login.webp';
import passkey from '../../../packages/ui/assets/illustrations/type-passkey.webp';
import bank from '../../../packages/ui/assets/illustrations/type-bank-account.webp';
import card from '../../../packages/ui/assets/illustrations/type-card.webp';
import identity from '../../../packages/ui/assets/illustrations/type-identity.webp';
import ssh from '../../../packages/ui/assets/illustrations/type-ssh-key.webp';
import api from '../../../packages/ui/assets/illustrations/type-api-key.webp';
import note from '../../../packages/ui/assets/illustrations/type-secure-note.webp';
import document from '../../../packages/ui/assets/illustrations/type-document.webp';
import media from '../../../packages/ui/assets/illustrations/type-media.webp';
import collection from '../../../packages/ui/assets/illustrations/type-collection.webp';
import custom from '../../../packages/ui/assets/illustrations/type-custom.webp';

export const art = { hero, locked, passphrase, recovery, done, offline };
/** Same order as `home.keeps.items`. */
export const typeArt = [login, passkey, bank, card, identity, ssh, api, note, document, media, collection, custom];
export const tints = ['--tint-sky', '--tint-lavender', '--tint-mint', '--tint-butter', '--tint-coral', '--tint-tangerine'] as const;

/** Vendor artwork from official websites; provenance in public/brands/SOURCES.md. */
export const competitorLogos = {
  '1Password': '/brands/1password.svg',
  Bitwarden: '/brands/bitwarden.svg',
  'Proton Pass': '/brands/proton-pass.svg',
  Enpass: '/brands/enpass.svg',
} as const;

export { ghostMark };
