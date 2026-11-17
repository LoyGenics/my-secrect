// Entry point. `packages/crypto-adapters` uses Node's `Buffer` (Buffer.from
// for base64). React Native / Hermes has no global Buffer, so polyfill it
// BEFORE any vault/crypto import runs.
import './polyfills';
import { Buffer } from 'buffer';
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
import { registerRootComponent } from 'expo';
import App from './src/App';
registerRootComponent(App);
