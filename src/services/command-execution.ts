import axios from 'axios';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { validateEndpointResponse } from './response-validation';
import { restTransportOptions, grpcTransport, streamCollector, grpcDeadline, DEVICE_REQUEST_TIMEOUT_MS } from '../security/device-transport';

type CommandRequest = {
  protocol: 'rest' | 'grpc';
  url: string;
  slot: number;
  oid: string;
  body?: unknown;
};

function normalizeRestUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The device URL must use HTTP or HTTPS.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function parseGrpcTarget(rawUrl: string): { target: string; secure: boolean } {
  const trimmed = rawUrl.trim();
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The gRPC URL must use HTTP or HTTPS.');
  }
  const secure = parsed.protocol === 'https:';
  return {
    target: `${parsed.hostname}:${parsed.port || (secure ? '443' : '80')}`,
    secure
  };
}

function loadCatenaService(): any {
  const protoDirectory = path.resolve(process.cwd(), 'vendor/st2138-a/interface/proto');
  const definition = protoLoader.loadSync(path.join(protoDirectory, 'service.proto'), {
    includeDirs: [protoDirectory],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: false
  });
  return (grpc.loadPackageDefinition(definition) as any).st2138.CatenaService;
}

function readCommandStream(client: any, request: Record<string, unknown>): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const stream = client.ExecuteCommand(request, { deadline: grpcDeadline() });
    const responses: any[] = [];
    stream.on('data', streamCollector(responses));
    stream.on('error', reject);
    stream.on('end', () => resolve(responses));
  });
}

export async function executeDeviceCommand(input: CommandRequest) {
  if (!Number.isSafeInteger(input.slot) || input.slot < 0) {
    throw new Error('A valid device slot is required.');
  }
  if (!input.oid.trim()) throw new Error('A command OID is required.');

  if (input.protocol === 'rest') {
    const deviceUrl = normalizeRestUrl(input.url);
    const oid = input.oid.split('/').map(encodeURIComponent).join('/');
    const endpoint = `/st2138-api/v1/${input.slot}/command/${oid}?respond=true`;
    const fullUrl = `${deviceUrl}${endpoint}`;
    try {
      const response = await axios.post(fullUrl, input.body, {
        ...restTransportOptions(),
        timeout: DEVICE_REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
        headers: { ...restTransportOptions().headers, Accept: 'application/json', 'Content-Type': 'application/json' }
      });
      const validation = await validateEndpointResponse({
        protocol: 'rest', method: 'POST', endpoint, status: response.status, payload: response.data
      });
      return {
        protocol: 'rest' as const,
        slot: input.slot,
        oid: input.oid,
        ok: response.status >= 200 && response.status < 300 && validation.ok,
        status: response.status,
        request: { method: 'POST', url: fullUrl, body: input.body ?? null },
        response: response.data ?? null,
        validation
      };
    } catch (error) {
      return {
        protocol: 'rest' as const,
        slot: input.slot,
        oid: input.oid,
        ok: false,
        status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
        request: { method: 'POST', url: fullUrl, body: input.body ?? null },
        response: axios.isAxiosError(error) ? error.response?.data ?? null : null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (input.protocol !== 'grpc') throw new Error('Protocol must be rest or grpc.');

  const { target, secure } = parseGrpcTarget(input.url);
  const transport = grpcTransport(target, secure);
  const Service = loadCatenaService();
  const client = new Service(
    transport.target,
    transport.credentials,
    transport.options
  );
  const request = {
    slot: input.slot,
    oid: input.oid,
    respond: true,
    ...(input.body === undefined ? {} : { value: input.body })
  };

  try {
    const responses = await readCommandStream(client, request);
    const commandError = responses.find((response) => response.exception)?.exception;
    const validation = await validateEndpointResponse({
      protocol: 'grpc', method: 'ExecuteCommand', endpoint: 'CatenaService.ExecuteCommand',
      status: 0, payload: responses, isStream: true
    });
    return {
      protocol: 'grpc' as const,
      slot: input.slot,
      oid: input.oid,
      ok: !commandError && validation.ok,
      status: commandError ? 'COMMAND_EXCEPTION' : 'OK',
      request: { method: 'CatenaService.ExecuteCommand', payload: request },
      response: responses,
      validation,
      ...(commandError ? { error: commandError.details || commandError.type || 'The command failed.' } : {})
    };
  } finally {
    client.close();
  }
}