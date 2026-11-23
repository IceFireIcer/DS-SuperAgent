// Adapted from DS Bot 0.3.8 (Apache-2.0), mobile/src/polyfills.ts (see NOTICE).
import 'react-native-url-polyfill/auto';
import { getRandomValues, randomUUID } from 'expo-crypto';

const current = globalThis.crypto;
if (typeof current?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { ...current, getRandomValues, randomUUID } });
}
