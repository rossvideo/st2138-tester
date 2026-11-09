import * as grpc from '@grpc/grpc-js';
import { Agent } from 'https';

let deviceJwt: string | undefined;
let allowInsecureTls = false;

export const DEVICE_REQUEST_TIMEOUT_MS = 60000;
export const GRPC_DEADLINE_MS = DEVICE_REQUEST_TIMEOUT_MS;

export function grpcDeadline(): Date {
  return new Date(Date.now() + GRPC_DEADLINE_MS);
}

export function normalizeDeviceJwt(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8192) throw new Error('JWT must be a compact token of at most 8192 characters.');
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Paste the JWT token without the Bearer prefix.');
  }
  return token;
}

export function redactDeviceJwt(value: string): string {
  return deviceJwt ? value.split(deviceJwt).join('[REDACTED]') : value;
}

export function configureDeviceTransport(jwt?: unknown, insecureTls: unknown = false): void {
  if (typeof insecureTls !== 'boolean') throw new Error('Allow insecure TLS must be a boolean.');
  deviceJwt = normalizeDeviceJwt(jwt);
  allowInsecureTls = insecureTls;
}

export function restTransportOptions() {
  return {
    headers: deviceJwt ? { Authorization: `Bearer ${deviceJwt}` } : {},
    maxRedirects: 0,
    proxy: false as const,
    ...(allowInsecureTls ? { httpsAgent: new Agent({ rejectUnauthorized: false }) } : {}),
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };
}

export function grpcTransport(target: string, secure = false) {
  const token = deviceJwt;
  const options = {
    'grpc.max_receive_message_length': Infinity,
    'grpc.max_send_message_length': Infinity,
    'grpc.enable_http_proxy': 0,
    ...(token ? { interceptors: [((options: grpc.InterceptorOptions, nextCall: grpc.NextCall) => new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        metadata.set('authorization', `Bearer ${token}`);
        next(metadata, listener);
      }
    })) as grpc.Interceptor] } : {})
  };
  const credentials = secure
    ? grpc.credentials.createSsl(undefined, undefined, undefined, { rejectUnauthorized: !allowInsecureTls })
    : grpc.credentials.createInsecure();
  return { target, options, credentials };
}

export function streamCollector(values: unknown[]): (value: unknown) => void {
  return value => {
    values.push(value);
  };
}

export function assertValidSlots(slots: number[]): void {
  if (!slots.length || new Set(slots).size !== slots.length
    || slots.some(slot => !Number.isSafeInteger(slot) || slot < 0)) {
    throw new Error('Device scan requires unique, non-negative integer slots.');
  }
}

export async function mapDeviceSlots<Result>(slots: number[], run: (slot: number) => Promise<Result>): Promise<Result[]> {
  assertValidSlots(slots);
  return Promise.all(slots.map(run));
}