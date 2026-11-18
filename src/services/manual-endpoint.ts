import axios from 'axios';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { validateEndpointResponse } from './response-validation';
import { readSseEvents } from '../openapi/endpoint-audit';
import { grpcComponentsToDeviceModel, validateGrpcComponents } from './device-scan';
import { runSt2138ValidateJsOnModel, St2138ValidateResult } from '../validation/st2138-cli-validator';
import { restTransportOptions, connectStreamTransportOptions, grpcTransport, streamCollector, grpcDeadline, captureGrpcConnect, DEVICE_REQUEST_TIMEOUT_MS } from '../security/device-transport';

type ManualEndpointRequest = {
  protocol: 'rest' | 'grpc';
  url: string;
  method: string;
  endpoint: string;
  slot: number | null;
  body?: unknown;
  isStream?: boolean;
  knownParamOids?: string[];
};

function requireKnownParamOids(knownParamOids?: string[]): string[] {
  if (!knownParamOids) {
    throw new Error('Refresh the page and run a new scan before checking parameter metadata manually. This report did not supply the expected OIDs.');
  }
  return knownParamOids;
}

function normalizeBaseUrl(rawUrl: string): string {
  const candidate = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Device URL must use HTTP or HTTPS.');
  return parsed.toString().replace(/\/+$/, '');
}

function grpcService(): any {
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

function grpcTarget(rawUrl: string): { target: string; secure: boolean } {
  const parsed = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  const secure = parsed.protocol === 'https:';
  return { target: `${parsed.hostname}:${parsed.port || (secure ? '443' : '80')}`, secure };
}

function callUnary(client: any, method: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client[method](request, { deadline: grpcDeadline() }, (error: Error | null, response: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function callStream(client: any, method: string, request: unknown): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const stream = client[method](request, { deadline: grpcDeadline() });
    const values: unknown[] = [];
    stream.on('data', streamCollector(values));
    stream.on('error', reject);
    stream.on('end', () => resolve(values));
  });
}

function parseRequestPreview(preview?: string): any {
  if (!preview || preview === '(not sent)') return {};
  try {
    const parsed = JSON.parse(preview);
    return parsed?.payload ?? parsed;
  } catch {
    return {};
  }
}

function parseSseEvents(text: string): unknown[] {
  return text.split(/\r?\n\r?\n/).map((event) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) return undefined;
    try { return JSON.parse(data); } catch { return data; }
  }).filter((event) => event !== undefined);
}

async function captureSse(stream: any): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => {
      stream.destroy();
      resolve(parseSseEvents(text));
    }, 5000);
    stream.on('data', (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    stream.on('error', (error: Error) => { clearTimeout(timeout); reject(error); });
    stream.on('end', () => { clearTimeout(timeout); resolve(parseSseEvents(text)); });
  });
}

export async function runManualEndpoint(input: ManualEndpointRequest & { requestPreview?: string }) {
  if (input.protocol === 'rest') {
    const baseUrl = normalizeBaseUrl(input.url);
    if (!input.endpoint.startsWith('/st2138-api/') || input.endpoint.startsWith('//')) {
      throw new Error('REST endpoint must be a relative ST 2138 API path.');
    }
    const method = input.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
      throw new Error('Unsupported HTTP method.');
    }
    const requestUrl = `${baseUrl}${input.endpoint}`;

    try {
      const { pathname, searchParams } = new URL(requestUrl);
      const metadataStream = input.isStream && method === 'GET'
        ? /\/\d+\/param-info\/(?:(.+)\/)?stream$/.exec(pathname) : null;
      const paramInfoScope = metadataStream ? {
        prefix: metadataStream[1]?.split('/').map(decodeURIComponent).join('/') ?? '',
        recursive: searchParams.has('recursive'),
        knownOids: requireKnownParamOids(input.knownParamOids)
      } : undefined;
      const response = await axios.request({
        ...restTransportOptions(),
        url: requestUrl,
        method,
        data: input.body,
        timeout: DEVICE_REQUEST_TIMEOUT_MS,
        responseType: input.isStream ? 'stream' : 'json',
        ...(input.isStream && /\/connect(?:\?|$)/.test(input.endpoint) ? await connectStreamTransportOptions(requestUrl) : {}),
        validateStatus: () => true
      });
      if (input.isStream && /\/connect(?:\?|$)/.test(input.endpoint) && response.status >= 200 && response.status < 300
        && !/^text\/event-stream(?:\s*;|$)/i.test(String(response.headers['content-type'] || ''))) {
        response.data.destroy();
        throw new Error('Connect response must use the text/event-stream content type.');
      }
      const payload = paramInfoScope && response.status >= 200 && response.status < 300
        ? await readSseEvents(response.data, true)
        : input.isStream ? await captureSse(response.data) : response.data;
      const validation = await validateEndpointResponse({
        protocol: 'rest', method, endpoint: input.endpoint, status: response.status, payload, isStream: input.isStream, paramInfoScope
      });
      return {
        protocol: 'rest' as const,
        method,
        endpoint: input.endpoint,
        status: response.status,
        ok: response.status >= 200 && response.status < 300 && validation.ok,
        request: { method, url: requestUrl, body: input.body ?? null },
        response: payload ?? null,
        validation
      };
    } catch (error) {
      return {
        protocol: 'rest' as const,
        method,
        endpoint: input.endpoint,
        status: axios.isAxiosError(error) ? error.response?.status ?? null : null,
        ok: false,
        request: { method, url: requestUrl, body: input.body ?? null },
        response: axios.isAxiosError(error) ? error.response?.data ?? null : null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (input.protocol !== 'grpc') throw new Error('Protocol must be rest or grpc.');
  const rpcMethod = input.endpoint.replace(/^CatenaService\./, '').split(' · ')[0];
  const Service = grpcService();
  if (!Service.service[rpcMethod]) throw new Error(`Unknown CatenaService method: ${rpcMethod}`);
  const { target, secure } = grpcTarget(input.url);
  const transport = grpcTransport(target, secure);
  const client = new Service(transport.target, transport.credentials, transport.options);
  const parsedRequest = input.body ?? parseRequestPreview(input.requestPreview);
  const request = input.slot === null || input.slot === undefined
    ? parsedRequest
    : { ...(parsedRequest && typeof parsedRequest === 'object' && !Array.isArray(parsedRequest) ? parsedRequest : {}), slot: input.slot };

  try {
    const isStream = Boolean(Service.service[rpcMethod].responseStream);
    const paramInfoScope = rpcMethod === 'ParamInfoRequest' ? {
      prefix: typeof request?.oid_prefix === 'string' ? request.oid_prefix : '',
      recursive: Boolean(request?.recursive),
      knownOids: requireKnownParamOids(input.knownParamOids)
    } : undefined;
    const payload = isStream
      ? rpcMethod === 'Connect' ? await captureGrpcConnect(client, request) : await callStream(client, rpcMethod, request)
      : await callUnary(client, rpcMethod, request);
    let validation;
    if (rpcMethod === 'DeviceRequest' && isStream) {
      const deviceValidation = await runSt2138ValidateJsOnModel(
        grpcComponentsToDeviceModel(Number((request as any).slot), payload as any[])
      );
      validation = await validateGrpcComponents(payload as any[], deviceValidation);
    } else {
      validation = await validateEndpointResponse({
        protocol: 'grpc', method: rpcMethod, endpoint: input.endpoint, status: 0, payload, isStream, paramInfoScope
      });
    }
    return {
      protocol: 'grpc' as const,
      method: rpcMethod,
      endpoint: input.endpoint,
      status: 0,
      ok: validation.ok,
      request,
      response: payload,
      validation
    };
  } catch (error) {
    const code = (error as any)?.code;
    const validation = await validateEndpointResponse({
      protocol: 'grpc', method: rpcMethod, endpoint: input.endpoint,
      status: typeof code === 'number' ? code : -1,
      payload: { type: 'RpcError', details: error instanceof Error ? error.message : String(error) }
    });
    return {
      protocol: 'grpc' as const,
      method: rpcMethod,
      endpoint: input.endpoint,
      status: typeof code === 'number' ? code : null,
      ok: false,
      request,
      response: null,
      validation,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    client.close();
  }
}