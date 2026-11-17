/**
 * Desktop theme entry point — re-exports the shared design system.
 *
 * The values live in @my-secrect/ui (packages/ui/src/tokens.ts +
 * theme.ts); this file is only the local alias so desktop code imports
 * from './theme' instead of reaching across the monorepo. Relative import
 * is deliberate: apps/desktop does not yet declare the @my-secrect/ui
 * dependency (see packages/ui/README.md, adoption step 2) — switch these
 * two lines to the package specifiers when it does.
 *
 * Usage (in main.tsx, once the app wires it up):
 *   import { initTheme } from './theme';
 *   initTheme();
 */
export * from '../../../packages/ui/src/tokens';
export * from '../../../packages/ui/src/theme';
