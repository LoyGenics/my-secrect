/**
 * Desktop design-system entry point: the one place desktop code imports
 * @my-secrect/ui from.
 *
 * It imports components.css as a side effect so every app that renders
 * desktop screens gets the component styles — including the web mirror
 * (apps/web renders this same App, but loads its own index.css, not
 * apps/desktop/src/index.css). tokens.css is loaded by each app's
 * index.css.
 *
 * Relative paths are deliberate: apps/desktop does not declare the
 * @my-secrect/ui dependency (matches the existing ../../../packages
 * imports across the app).
 */
import '../../../packages/ui/src/components.css';

export * from '../../../packages/ui/src/index';
