// Entry point. `packages/crypto-adapters` uses Node's `Buffer` (Buffer.from
// for base64). React Native / Hermes has no global Buffer, so polyfill it
// BEFORE any vault/crypto import runs.
import './polyfills';
import { Buffer } from 'buffer';
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
import { registerRootComponent } from 'expo';
import { LogBox } from 'react-native';
// Known SDK barrel cycle; keep unrelated warnings visible in development.
if (__DEV__) LogBox.ignoreLogs(['Require cycle: ../../packages/sdk/src/security.ts']);
import App from './src/App';
// Dev-only crypto check (dev/CryptoCheck.tsx): EXPO_PUBLIC_CRYPTO_CHECK=1 npx expo start.
// Release bundles fold __DEV__ to false, so the check is not shipped.
const Root = __DEV__ && process.env.EXPO_PUBLIC_CRYPTO_CHECK === '1' ? require('./dev/CryptoCheck').default : App;
registerRootComponent(Root);
