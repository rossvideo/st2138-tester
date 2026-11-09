import type { AxiosInstance } from 'axios';
import type { HttpMethod, OpenApiEndpoint } from './openapi-spec';
import { validateEndpointResponse, ResponseValidation } from '../services/response-validation';

/** Status that means "not implemented" per transport (lined up with Catena). */
const REST_NOT_IMPLEMENTED_STATUS = 501;
// gRPC equivalent (code 12 = UNIMPLEMENTED) is handled by the gRPC path when wired.
export const GRPC_NOT_IMPLEMENTED_CODE = 12;

const STREAM_TIMEOUT_MS = 5000;

/** Methods that only read state and are safe to run automatically. */
const SAFE_METHODS: HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

export type EndpointAuditResult = {
  endpoint: string;
  pathTemplate: string;
  /** The slot this endpoint targets, or null for device-wide endpoints (no {slot}). */
  slot: number | null;
  method: HttpMethod;
  isStream: boolean;
  /** True for PUT/POST/DELETE/PATCH — gated behind a per-endpoint checkbox. */
  mutating: boolean;
  /** Whether this endpoint was actually called in this audit run. */
  tested: boolean;
  status: number;
  ok: boolean;
  notImplemented: boolean;
  /** Reached the device but returned something noteworthy that is not a hard fail. */
  warning: boolean;
  schemaValid: boolean;
  note: string;
  /** Human-readable "what we sent" (method, URL, body). */
  requestPreview: string;
  /** Human-readable "what came back" (status body), trimmed for size. */
  responsePreview: string;
  validation?: ResponseValidation | null;
  memberType?: string;
  oid?: string;
  operation?: string;
  manualBody?: unknown;
  manualRequest?: unknown;
  title?: string;
};

export type AuditContext = {
  /** Absolute device base URL, already normalized (e.g. https://host). */
  deviceUrl: string;
  /** Path prefix from the spec server url (e.g. /st2138-api/v1). */
  apiPrefix: string;
  sampleSlot: number;
  sampleLanguageCode: string;
  fqoid?: string;
  memberType?: string;
  memberReadOnly?: boolean;
  /**
   * The device model for `sampleSlot`. No longer used to generate per-member
   * ({fqoid}) endpoints — those are covered by the Member Tests section — but
   * kept so existing callers can keep passing it harmlessly.
   */
  deviceModel?: any;
};

export function isMutatingMethod(method: HttpMethod): boolean {
  return !SAFE_METHODS.includes(method);
}

/**
 * Per ST 2138, DELETE is only defined for assets and language-packs. Any other
 * resource is expected to refuse DELETE (405), so a 405 there is a pass and an
 * actual success is suspicious (warning, not fail).
 */
export function isDeletableResource(pathTemplate: string): boolean {
  return /\/asset(\/|$)/.test(pathTemplate) || /\/language-pack(\/|$)/.test(pathTemplate);
}

function validateEndpointShape(pathTemplate: string, payload: any): { schemaValid: boolean; note: string } {
  if (pathTemplate === '/devices') {
    const slots = payload?.slots;
    const valid = Array.isArray(slots) && slots.every((slot: unknown) => Number.isInteger(slot));
    return { schemaValid: valid, note: valid ? 'slots array is valid' : 'Expected { slots: integer[] }' };
  }

  if (pathTemplate === '/{slot}') {
    const hasShape = payload && typeof payload === 'object' && (payload.params || payload.commands || payload.slot !== undefined);
    return {
      schemaValid: !!hasShape,
      note: hasShape ? 'device model shape detected' : 'Expected device model object'
    };
  }

  if (pathTemplate.includes('/value')) {
    const isObj = payload && typeof payload === 'object';
    return { schemaValid: !!isObj, note: isObj ? 'value response object detected' : 'Expected value response object' };
  }

  if (pathTemplate.endsWith('/languages')) {
    const valid = Array.isArray(payload) && payload.every((code: unknown) => typeof code === 'string');
    return { schemaValid: valid, note: valid ? 'languages array is valid' : 'Expected string[] of language codes' };
  }

  if (pathTemplate.includes('/language-pack/')) {
    const pack = payload?.language_pack ?? payload;
    const valid =
      !!pack &&
      typeof pack === 'object' &&
      !Array.isArray(pack) &&
      (typeof pack.name === 'string' || typeof pack.words === 'object');
    return { schemaValid: valid, note: valid ? 'language pack shape detected' : 'Expected { name, words } language pack' };
  }

  const valid = payload !== null && payload !== undefined;
  return { schemaValid: valid, note: valid ? 'received JSON payload' : 'No JSON payload received' };
}

/**
 * Fills slot, FQOID, and language placeholders for the current audit target.
 */
export function resolvePath(
  endpoint: OpenApiEndpoint,
  ctx: AuditContext
): { resolved: string; placeholderNote: string | null } {
  let resolved = endpoint.pathTemplate;
  resolved = resolved.replace('{slot}', String(ctx.sampleSlot));
  if (ctx.fqoid) {
    resolved = resolved.replace('{fqoid}', ctx.fqoid.split('/').map(encodeURIComponent).join('/'));
  }
  resolved = resolved.replace('{language-code}', encodeURIComponent(ctx.sampleLanguageCode));
  return { resolved, placeholderNote: null };
}

/** Minimal request body for mutating methods so the endpoint can be reached. */
function bodyForMethod(method: HttpMethod): any {
  if (method === 'PUT' || method === 'POST' || method === 'PATCH') return {};
  return undefined;
}

/** Stringifies a value for display, trimming very large payloads. */
function previewOf(value: unknown, max = 4000): string {
  if (value === undefined || value === null) return '';
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length > max) {
    return `${text.slice(0, max)}\n… (truncated, ${text.length} chars total)`;
  }
  return text;
}

/** Normalizes axios header containers (AxiosHeaders or plain object) to a map. */
function normalizeHeaders(headers: unknown): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') return {};
  const maybe = headers as { toJSON?: () => Record<string, unknown> };
  if (typeof maybe.toJSON === 'function') {
    try {
      return maybe.toJSON();
    } catch {
      /* fall through to plain-object handling */
    }
  }
  return headers as Record<string, unknown>;
}

/** Hides the bearer token body while keeping the scheme + last 4 chars. */
function maskHeaderValue(key: string, value: string): string {
  if (/^authorization$/i.test(key)) {
    const match = value.match(/^(\S+)\s+(.*)$/);
    if (match) {
      const tail = match[2].length > 4 ? match[2].slice(-4) : '';
      return `${match[1]} ****${tail}`;
    }
    return '****';
  }
  return value;
}

/** Renders headers as "Key: value" lines (Authorization token masked). */
function formatHeaders(headers: unknown): string {
  const obj = normalizeHeaders(headers);
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}: ${maskHeaderValue(k, raw)}`;
    });
  return lines.length ? lines.join('\n') : '(none)';
}

/** Best-effort read of the headers an instance would send for a given method. */
function configuredHeaders(client: AxiosInstance, method: HttpMethod): Record<string, unknown> {
  const defaults = (client.defaults?.headers ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const assign = (src: unknown) => {
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        // Skip axios's nested per-method buckets (common/get/post/...).
        if (v !== null && v !== undefined && typeof v !== 'object') result[k] = v;
      }
    }
  };
  assign(defaults.common);
  assign(defaults[method.toLowerCase()]);
  assign(defaults);
  return result;
}

/** Builds the "what we sent" preview: method, full URL, headers, and body. */
export function buildRequestPreview(method: string, fullUrl: string, headers: unknown, body: unknown): string {
  const hasBody = body !== undefined && body !== null;
  const bodyText = hasBody ? (previewOf(body) || '{}') : '(empty)';
  return `${method} ${fullUrl}\n\nHeaders:\n${formatHeaders(headers)}\n\nBody:\n${bodyText}`;
}

/** Builds the "what came back" preview: HTTP status, headers, and body. */
export function buildResponsePreview(
  status: number,
  headers: unknown,
  body: unknown,
  opts: { isStream?: boolean; bodyText?: string } = {}
): string {
  const headerText = `Headers:\n${formatHeaders(headers)}`;
  const bodyText =
    opts.bodyText ?? (opts.isStream ? '(event stream — body not captured)' : previewOf(body) || '(empty response body)');
  return `HTTP ${status}\n\n${headerText}\n\nBody:\n${bodyText}`;
}

function classify(status: number, ok: boolean): { ok: boolean; notImplemented: boolean } {
  if (status === REST_NOT_IMPLEMENTED_STATUS) return { ok: false, notImplemented: true };
  return { ok, notImplemented: false };
}

/** Factual standard reason phrase for a status code. The code itself is shown in the Status column. */
function shortReason(status: number): string {
  switch (status) {
    case 400: return 'bad request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not found';
    case 405: return 'method not allowed';
    case 409: return 'conflict';
    case 500: return 'server error';
    case 501: return 'not implemented';
    case 503: return 'unavailable';
    default: return '';
  }
}

type CallResult = {
  status: number;
  ok: boolean;
  kind: 'ok' | 'http' | 'timeout' | 'error';
  payload?: any;
  /** Final request headers actually sent (from axios config). */
  requestHeaders?: unknown;
  /** Request body actually sent. */
  requestBody?: unknown;
  /** Response headers received. */
  responseHeaders?: unknown;
};

function isTimeout(error: any): boolean {
  return error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
}

async function callStream(client: AxiosInstance, url: string, method: HttpMethod): Promise<CallResult> {
  const requestBody = bodyForMethod(method);
  try {
    // Read one SSE event so its payload can be validated, then close the stream.
    const response = await client.request({
      url,
      method,
      data: requestBody,
      responseType: 'stream',
      timeout: STREAM_TIMEOUT_MS,
      validateStatus: () => true
    });

    const stream = response.data;
    const payload = response.status >= 200 && response.status < 300
      ? await readFirstSseEvent(stream)
      : undefined;

    const ok = response.status >= 200 && response.status < 300;
    return {
      status: response.status,
      ok,
      kind: ok ? 'ok' : 'http',
      payload,
      requestHeaders: response.config?.headers,
      requestBody,
      responseHeaders: response.headers
    };
  } catch (error: any) {
    return {
      status: 0,
      ok: false,
      kind: isTimeout(error) ? 'timeout' : 'error',
      requestHeaders: error?.config?.headers,
      requestBody
    };
  }
}

function readFirstSseEvent(stream: any): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (events: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy?.();
      resolve(events);
    };
    const timer = setTimeout(() => finish([]), STREAM_TIMEOUT_MS);

    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      buffer += chunk.toString();
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) return;
      const eventText = buffer.slice(0, boundary);
      const data = eventText.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) return finish([]);
      try {
        finish([JSON.parse(data)]);
      } catch {
        finish([data]);
      }
    });
    stream.on('end', () => finish([]));
    stream.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function callRegular(client: AxiosInstance, url: string, method: HttpMethod): Promise<CallResult> {
  const requestBody = bodyForMethod(method);
  try {
    const response = await client.request({
      url,
      method,
      data: requestBody,
      validateStatus: () => true
    });
    const ok = response.status >= 200 && response.status < 300;
    return {
      status: response.status,
      ok,
      kind: ok ? 'ok' : 'http',
      payload: response.data,
      requestHeaders: response.config?.headers,
      requestBody,
      responseHeaders: response.headers
    };
  } catch (error: any) {
    return {
      status: 0,
      ok: false,
      kind: isTimeout(error) ? 'timeout' : 'error',
      payload: null,
      requestHeaders: error?.config?.headers,
      requestBody,
      responseHeaders: error?.response?.headers
    };
  }
}

export type ExecutionOutcome = {
  status: number;
  ok: boolean;
  notImplemented: boolean;
  warning: boolean;
  schemaValid: boolean;
  note: string;
  requestPreview: string;
  responsePreview: string;
  validation: ResponseValidation | null;
};

/**
 * Performs a single endpoint request (stream-aware) and classifies the result.
 * Notes are kept to a couple of factual words; the status code lives in its own column.
 *
 * Device-wide endpoints (no {slot} in the path — /health, /devices, /connect,
 * /access) are mandatory: any non-2xx is a hard fail, so even a 501 "not
 * implemented" fails rather than being softened to a warning. Slot-scoped
 * endpoints keep the softer rule (501 → warning, 404/other → fail). A 2xx GET
 * whose body doesn't match the expected shape is also downgraded to a fail.
 */
export async function executeEndpoint(
  client: AxiosInstance,
  fullUrl: string,
  endpoint: { method: HttpMethod; isStream: boolean; pathTemplate: string },
  usedPlaceholder = false
): Promise<ExecutionOutcome> {
  const call = endpoint.isStream
    ? await callStream(client, fullUrl, endpoint.method)
    : await callRegular(client, fullUrl, endpoint.method);

  // Endpoints without a {slot} placeholder are device-wide and mandatory.
  const mandatory = !endpoint.pathTemplate.includes('{slot}');

  const classified = classify(call.status, call.ok);
  let ok = classified.ok;
  // Mandatory endpoints don't get the "not implemented → warning" softening:
  // a 501 (or anything non-2xx) here is a hard fail.
  let notImplemented = mandatory ? false : classified.notImplemented;
  let warning = false;

  // ST 2138 only defines DELETE for assets and language-packs. On any other
  // resource a 405 is the correct (passing) response, while a real 2xx success
  // is unexpected and should warn rather than fail.
  const reached = call.kind === 'ok' || call.kind === 'http';
  const validation = reached
    ? await validateEndpointResponse({
      protocol: 'rest',
      method: endpoint.method,
      endpoint: new URL(fullUrl).pathname + new URL(fullUrl).search,
      status: call.status,
      payload: call.payload,
      isStream: endpoint.isStream
    })
    : null;
  const deleteOnNonDeletable =
    endpoint.method === 'DELETE' && !isDeletableResource(endpoint.pathTemplate);
  if (deleteOnNonDeletable && reached) {
    if (call.status === 405) {
      ok = true;
      notImplemented = false;
    } else if (call.status >= 200 && call.status < 300) {
      ok = false;
      warning = true;
    }
  }

  let schemaValid = ok;
  // Tracks a reached-but-non-compliant GET response so we can both fail it and
  // still label it "unexpected shape" (distinct from a transport-level failure).
  let shapeInvalid = false;
  if (ok && !endpoint.isStream && endpoint.method === 'GET') {
    schemaValid = validateEndpointShape(endpoint.pathTemplate, call.payload).schemaValid;
    // A 2xx response with a non-compliant body is a conformance failure, not a pass.
    if (!schemaValid) {
      shapeInvalid = true;
      ok = false;
    }
  }

  if (ok && validation && !validation.ok) {
    shapeInvalid = true;
    schemaValid = false;
    ok = false;
  }

  let note = '';
  if (call.kind === 'timeout') note = 'timeout';
  else if (call.kind === 'error') note = 'no response';
  else if (warning) note = 'succeeded — DELETE only valid for assets/language-packs';
  else if (deleteOnNonDeletable && call.status === 405) note = 'expected — DELETE not supported here';
  else if (notImplemented) note = 'not implemented';
  else if (shapeInvalid) note = 'unexpected shape';
  else if (!ok) note = shortReason(call.status);
  else note = 'reached';

  if (usedPlaceholder) note = note ? `${note} · placeholder id` : 'placeholder id';
  if (validation && !validation.ok) note = `${note}; ${validation.note}`;
  else if (validation && !validation.ran) note = `${note}; ${validation.note}`;

  const requestHeaders = call.requestHeaders ?? configuredHeaders(client, endpoint.method);
  const requestPreview = buildRequestPreview(endpoint.method, fullUrl, requestHeaders, call.requestBody);

  let responsePreview: string;
  if (call.kind === 'timeout') {
    responsePreview = '(request timed out — no response received)';
  } else if (call.kind === 'error') {
    responsePreview = '(no response — connection error)';
  } else {
    responsePreview = buildResponsePreview(call.status, call.responseHeaders, call.payload, {
      isStream: endpoint.isStream,
      bodyText: endpoint.isStream
        ? Array.isArray(call.payload) && call.payload.length ? JSON.stringify(call.payload, null, 2) : '(no SSE event received)'
        : undefined
    });
  }

  return { status: call.status, ok, notImplemented, warning, schemaValid, note, requestPreview, responsePreview, validation };
}

export type RunAuditOptions = {
  /** Methods to call automatically. Defaults to safe (read-only) methods. */
  autoRunMethods?: HttpMethod[];
  /** Reason to leave a capability-dependent operation untested. */
  skipReason?: (endpoint: OpenApiEndpoint, ctx: AuditContext) => string | undefined;
};

/**
 * Audits the device/slot-wide endpoints in the spec. Per-member ({fqoid})
 * endpoints are skipped here because every member is tested individually in the
 * Member Tests section. By default only GET (read-only) endpoints are actually
 * called (v1 behavior); mutating endpoints (PUT/POST/DELETE) are listed but left
 * untested so they can be opt-in tested via a per-endpoint checkbox in the UI.
 */
export async function runEndpointAudit(
  client: AxiosInstance,
  endpoints: OpenApiEndpoint[],
  ctx: AuditContext,
  options: RunAuditOptions = {}
): Promise<EndpointAuditResult[]> {
  const autoRun = new Set(options.autoRunMethods ?? SAFE_METHODS);
  const results: EndpointAuditResult[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.pathTemplate.includes('{fqoid}') && !ctx.fqoid) continue;

    const { resolved, placeholderNote } = resolvePath(endpoint, ctx);
    const resolvedEndpoint = `${ctx.apiPrefix}${resolved}`;
    const mutating = isMutatingMethod(endpoint.method);
    // Slot-specific endpoints carry a {slot} placeholder; everything else is
    // device-wide (audited once, not attributed to any single slot).
    const slot = endpoint.pathTemplate.includes('{slot}') ? ctx.sampleSlot : null;

    const base = {
      endpoint: resolvedEndpoint,
      pathTemplate: endpoint.pathTemplate,
      slot,
      method: endpoint.method,
      isStream: endpoint.isStream,
      mutating,
      manualBody: bodyForMethod(endpoint.method),
      ...(ctx.fqoid ? {
        memberType: ctx.memberType || 'Parameter',
        readOnly: ctx.memberReadOnly,
        oid: ctx.fqoid,
        operation: endpoint.method === 'GET' ? 'READ' : endpoint.method === 'PUT' ? 'UPDATE' : endpoint.method,
        title: `${endpoint.method === 'GET' ? 'Read' : endpoint.method === 'PUT' ? 'Update' : endpoint.method} ${endpoint.operationId || endpoint.pathTemplate.split('/').filter(Boolean).slice(-1)[0] || 'member'} endpoint`
      } : {})
    };

    const skipReason = options.skipReason?.(endpoint, ctx);
    if (skipReason) {
      results.push({
        ...base,
        tested: false,
        status: 0,
        ok: false,
        notImplemented: false,
        warning: false,
        schemaValid: false,
        note: `not run: ${skipReason}`,
        requestPreview: buildRequestPreview(
          endpoint.method,
          `${ctx.deviceUrl}${resolvedEndpoint}`,
          configuredHeaders(client, endpoint.method),
          bodyForMethod(endpoint.method)
        ),
        responsePreview: `(not run: ${skipReason})`
      });
      continue;
    }

    if (!autoRun.has(endpoint.method)) {
      // Not run automatically (v1 keeps writes opt-in). Listed for coverage.
      results.push({
        ...base,
        tested: false,
        status: 0,
        ok: false,
        notImplemented: false,
        warning: false,
        schemaValid: false,
        note: '',
        requestPreview: buildRequestPreview(
          endpoint.method,
          `${ctx.deviceUrl}${resolvedEndpoint}`,
          configuredHeaders(client, endpoint.method),
          bodyForMethod(endpoint.method)
        ),
        responsePreview: '(not run yet — press Run to send this request)'
      });
      continue;
    }

    const outcome = await executeEndpoint(
      client,
      `${ctx.deviceUrl}${resolvedEndpoint}`,
      endpoint,
      !!placeholderNote
    );
    results.push({ ...base, tested: true, ...outcome });
  }

  return results;
}
