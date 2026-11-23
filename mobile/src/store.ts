// Adapted from DS Bot 0.3.8 (Apache-2.0), mobile/src/store.ts (see NOTICE).
import * as SecureStore from 'expo-secure-store';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { deviceIdFor, generateKeyPair, randomToken } from '@phone-link';
import type { PhoneIdentity, SavedComputer } from './connection';

const IDENTITY = 'ds-superagent.phone.identity.v1';
const COMPUTERS = 'ds-superagent.phone.computers.v1';
const local = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, keychainService: 'io.github.icefireicer.ds-superagent.phone' };
const outboxKey = (hostId: string) => `ds-superagent.phone.outbox.v1.${hostId}`;

type PendingSend = { id: string; digest: string };
let writes: Promise<unknown> = Promise.resolve();

function withOutbox<Result>(write: () => Promise<Result>) {
  const operation = writes.then(write);
  writes = operation.catch(() => {});
  return operation;
}

async function read(key: string): Promise<unknown> {
  const text = await SecureStore.getItemAsync(key, local);
  return text === null ? undefined : JSON.parse(text);
}

export async function loadIdentity(): Promise<PhoneIdentity> {
  const saved = await read(IDENTITY) as Partial<PhoneIdentity> | undefined;
  if (saved) {
    if (typeof saved.privateKey !== 'string' || typeof saved.publicKey !== 'string' || typeof saved.accessToken !== 'string'
      || saved.deviceId !== deviceIdFor(saved.publicKey)) throw new Error('The phone identity could not be read.');
    return saved as PhoneIdentity;
  }
  const keys = generateKeyPair();
  const identity = { ...keys, deviceId: deviceIdFor(keys.publicKey), accessToken: randomToken() };
  await SecureStore.setItemAsync(IDENTITY, JSON.stringify(identity), local);
  return identity;
}

export async function loadComputers(): Promise<SavedComputer[]> {
  const stored = await read(COMPUTERS);
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || stored.length > 6 || !stored.every(item => item && typeof item.server === 'string'
    && typeof item.hostKey === 'string' && typeof item.name === 'string' && item.hostDeviceId === deviceIdFor(item.hostKey))) {
    throw new Error('The saved computers could not be read.');
  }
  return stored.map(({ server, hostDeviceId, hostKey, name }) => ({ server, hostDeviceId, hostKey, name }));
}

export async function saveComputers(computers: SavedComputer[]) {
  if (computers.length > 6) throw new Error('Remove a saved computer before pairing another one.');
  const records = computers.map(({ server, hostDeviceId, hostKey, name }) => ({ server, hostDeviceId, hostKey, name }));
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(records), local);
}

export async function reserveSend(hostId: string, text: string) {
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, text);
  return withOutbox(async () => {
    const key = outboxKey(hostId);
    const pending = await read(key) as PendingSend | undefined;
    if (pending?.digest === digest && typeof pending.id === 'string') return pending.id;
    if (pending) throw Object.assign(new Error('An earlier send is unconfirmed.'), { code: 'MOBILE_SEND_PENDING' });
    const id = randomUUID();
    await SecureStore.setItemAsync(key, JSON.stringify({ id, digest }), local);
    return id;
  });
}

export function clearSend(hostId: string, expectedId?: string) {
  return withOutbox(async () => {
    const key = outboxKey(hostId);
    if (expectedId !== undefined && (await read(key) as PendingSend | undefined)?.id !== expectedId) return;
    await SecureStore.deleteItemAsync(key, local);
  });
}
