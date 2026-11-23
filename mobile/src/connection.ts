// Adapted from DS Bot 0.3.8 (Apache-2.0), mobile/src/connection.ts (see NOTICE).
import { RelayTransport, RpcClient, SecureTransport, type DeviceIdentity, type PairingOffer } from '@phone-link';

export interface PhoneIdentity extends DeviceIdentity { accessToken: string }
export type SavedComputer = Omit<PairingOffer, 'code'>;
export interface PairingStatus { instanceId: string; canSend: boolean }
export interface MainMessage { id: string; sequence: number; role: 'user' | 'main' | 'system'; text: string; createdAt: number; status: string }
export interface HistoryPage { messages: MainMessage[]; mainState: string; before?: number }
export interface WorkStatus { id: string; goal: string; state: string; summary?: string }
export interface WorkPage { items: WorkStatus[]; after?: string }
export interface SendReceipt { status: string; messageId: string }

export function connectToComputer(computer: SavedComputer, identity: PhoneIdentity, name: string, pairingCode?: string) {
  const carrier = new RelayTransport(computer.server, { deviceId: identity.deviceId, identityKey: identity.publicKey,
    accessToken: identity.accessToken, targetDeviceId: computer.hostDeviceId });
  const transport = new SecureTransport(carrier, identity, { deviceId: computer.hostDeviceId, identityKey: computer.hostKey }, {
    hello: { name, ...(pairingCode ? { pairingCode } : {}) },
  });
  const client = new RpcClient(transport);
  const call = <Result>(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 8000) =>
    client.rpc<Result>('product', { endpoint, payload }, { signal, timeoutMs });
  let binding: PairingStatus | undefined;
  function instance() {
    if (!binding) throw new Error('The computer is not connected.');
    return binding.instanceId;
  }
  return {
    async open(signal?: AbortSignal) {
      if (signal?.aborted) throw new Error('Connection cancelled.');
      const stop = () => { void client.close(); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        await client.connect();
        const opened = await call<PairingStatus>('open', {}, signal);
        if (typeof opened?.instanceId !== 'string' || typeof opened.canSend !== 'boolean') {
          throw Object.assign(new Error('The host does not expose mobile access status.'), { code: 'MOBILE_PROTOCOL' });
        }
        return binding = opened;
      } catch (error) {
        await client.close();
        throw error;
      } finally { signal?.removeEventListener('abort', stop); }
    },
    history: (before?: number, signal?: AbortSignal) => call<HistoryPage>('history', { instanceId: instance(), limit: 24,
      ...(before === undefined ? {} : { before }) }, signal),
    work: (after?: string, signal?: AbortSignal) => call<WorkPage>('work-board', { instanceId: instance(), limit: 24,
      ...(after === undefined ? {} : { after }) }, signal),
    async send(text: string, commandId: string) {
      if (!binding?.canSend) throw Object.assign(new Error('This pairing is read-only.'), { code: 'SOURCE_NOT_AUTHORIZED' });
      return call<SendReceipt>('send', { instanceId: instance(), commandId, text }, undefined, 90_000);
    },
    onClose: (handler: (error?: Error) => void) => client.onClose(() => handler(carrier.closeReason)),
    close: () => client.close(),
  };
}

export function linkError(error: unknown, fallback: string) {
  const code = (error as { code?: string } | undefined)?.code;
  switch (code) {
    case 'DEVICE_REVOKED': case 'NOT_PAIRED': return 'Access on this computer was removed. Pair again on the computer.';
    case 'MOBILE_PROTOCOL': return 'Update DS SuperAgent on this computer before connecting.';
    case 'MOBILE_SEND_PENDING': return 'An earlier send is unconfirmed. Retry the same text or check Main before discarding its retry record.';
    case 'PEER_IDENTITY_MISMATCH': return 'The computer identity does not match the pairing code.';
    case 'SOURCE_NOT_AUTHORIZED': return 'This pairing does not allow the requested action.';
    case 'HOST_OFFLINE': return 'The paired computer is offline.';
    case 'SERVER_UNREACHABLE': return 'The relay cannot be reached.';
    default: return fallback;
  }
}
