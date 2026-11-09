import axios from 'axios';
import YAML from 'yaml';

/**
 * Loads the ST2138 OpenAPI spec at launch so the endpoint audit always reflects
 * the current spec (per requirement: "copy the official at launch time so it stays
 * current even between builds"). The spec is a multi-file document: openapi.yaml
 * lists the paths, each $ref-ing a file under ./paths that declares the methods.
 */

const DEFAULT_SPEC_URL =
  process.env.OPENAPI_SPEC_URL ||
  'https://raw.githubusercontent.com/SMPTE/st2138-a/develop/interface/openapi/openapi.yaml';

const DEFAULT_API_PREFIX = '/st2138-api/v1';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

export type OpenApiEndpoint = {
  /** Path template exactly as written in the spec, e.g. "/{slot}/value/{fqoid}". */
  pathTemplate: string;
  method: HttpMethod;
  /** True when any response is served as Server-Sent Events (text/event-stream). */
  isStream: boolean;
  operationId?: string;
};

export type OpenApiSpecInfo = {
  /** Path prefix taken from servers[0].url, e.g. "/st2138-api/v1". */
  apiPrefix: string;
  endpoints: OpenApiEndpoint[];
  /** Where the spec came from: the remote URL, or "fallback" if the fetch failed. */
  source: string;
  loadedAt: string;
};

/**
 * Fallback endpoint list derived from the spec, used only if the launch fetch
 * fails so the audit still functions offline. The primary path is the live fetch.
 */
const FALLBACK_ENDPOINTS: OpenApiEndpoint[] = [
  { pathTemplate: '/health', method: 'GET', isStream: false },
  { pathTemplate: '/devices', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/stream', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/command/{fqoid}', method: 'POST', isStream: false },
  { pathTemplate: '/{slot}/command/{fqoid}/stream', method: 'POST', isStream: true },
  { pathTemplate: '/{slot}/asset/{fqoid}', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/asset/{fqoid}', method: 'POST', isStream: false },
  { pathTemplate: '/{slot}/asset/{fqoid}', method: 'PUT', isStream: false },
  { pathTemplate: '/{slot}/asset/{fqoid}', method: 'DELETE', isStream: false },
  { pathTemplate: '/{slot}/asset/{fqoid}/stream', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/param-info/{fqoid}', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/param-info/{fqoid}/stream', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/param-info/stream', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/value/{fqoid}', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/value/{fqoid}', method: 'PUT', isStream: false },
  { pathTemplate: '/{slot}/values', method: 'PUT', isStream: false },
  { pathTemplate: '/{slot}/subscriptions', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/subscriptions', method: 'PUT', isStream: false },
  { pathTemplate: '/{slot}/subscriptions/stream', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/param/{fqoid}', method: 'GET', isStream: false },
  { pathTemplate: '/connect', method: 'GET', isStream: true },
  { pathTemplate: '/{slot}/language-pack/{language-code}', method: 'GET', isStream: false },
  { pathTemplate: '/{slot}/language-pack/{language-code}', method: 'POST', isStream: false },
  { pathTemplate: '/{slot}/language-pack/{language-code}', method: 'DELETE', isStream: false },
  { pathTemplate: '/{slot}/language-pack/{language-code}', method: 'PUT', isStream: false },
  { pathTemplate: '/{slot}/languages', method: 'GET', isStream: false },
  { pathTemplate: '/access', method: 'GET', isStream: false },
  { pathTemplate: '/access', method: 'POST', isStream: false }
];

let cachedSpec: OpenApiSpecInfo | null = null;

async function fetchText(url: string): Promise<string> {
  const response = await axios.get(url, {
    timeout: 10000,
    responseType: 'text',
    transformResponse: (data) => data,
    headers: { Accept: 'text/yaml, text/plain, */*' }
  });
  return typeof response.data === 'string' ? response.data : String(response.data);
}

function parseYaml(raw: string): any {
  return YAML.parse(raw, { merge: true });
}

function extractApiPrefix(spec: any): string {
  const serverUrl = Array.isArray(spec?.servers) ? spec.servers[0]?.url : undefined;
  if (typeof serverUrl === 'string' && serverUrl.length > 0) {
    try {
      const pathname = new URL(serverUrl).pathname.replace(/\/+$/, '');
      if (pathname && pathname !== '/') return pathname;
    } catch {
      // serverUrl may be a bare path; fall through to default.
    }
  }
  return DEFAULT_API_PREFIX;
}

function operationIsStream(operation: any): boolean {
  const responses = operation?.responses;
  if (!responses || typeof responses !== 'object') return false;
  for (const response of Object.values(responses)) {
    const content = (response as any)?.content;
    if (content && typeof content === 'object' && 'text/event-stream' in content) {
      return true;
    }
  }
  return false;
}

function endpointsFromPathItem(pathTemplate: string, pathItem: any): OpenApiEndpoint[] {
  const endpoints: OpenApiEndpoint[] = [];
  if (!pathItem || typeof pathItem !== 'object') return endpoints;

  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (!operation || typeof operation !== 'object') continue;
    endpoints.push({
      pathTemplate,
      method: method.toUpperCase() as HttpMethod,
      isStream: operationIsStream(operation),
      operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined
    });
  }
  return endpoints;
}

async function resolvePathItem(specUrl: string, ref: unknown): Promise<any | null> {
  if (typeof ref !== 'string') return null;
  // Only external relative file refs are expected here (e.g. "./paths/Device.yaml").
  const refUrl = new URL(ref, specUrl).toString();
  const raw = await fetchText(refUrl);
  return parseYaml(raw);
}

/** Fetches and resolves the multi-file OpenAPI spec into a flat endpoint list. */
async function loadFromRemote(specUrl: string): Promise<OpenApiSpecInfo> {
  const rootRaw = await fetchText(specUrl);
  const root = parseYaml(rootRaw);
  const apiPrefix = extractApiPrefix(root);

  const paths = root?.paths;
  if (!paths || typeof paths !== 'object') {
    throw new Error('OpenAPI spec has no "paths" object');
  }

  const endpoints: OpenApiEndpoint[] = [];

  await Promise.all(
    Object.entries(paths).map(async ([pathTemplate, pathValue]) => {
      let pathItem = pathValue;
      // Paths in this spec are split into separate files via $ref.
      if (pathValue && typeof pathValue === 'object' && '$ref' in (pathValue as any)) {
        pathItem = await resolvePathItem(specUrl, (pathValue as any).$ref);
      }
      endpoints.push(...endpointsFromPathItem(pathTemplate, pathItem));
    })
  );

  endpoints.sort((a, b) =>
    a.pathTemplate === b.pathTemplate
      ? a.method.localeCompare(b.method)
      : a.pathTemplate.localeCompare(b.pathTemplate)
  );

  return {
    apiPrefix,
    endpoints,
    source: specUrl,
    loadedAt: new Date().toISOString()
  };
}

/** Loads the spec once at launch; logs and falls back on failure. */
export async function initializeOpenApiSpec(): Promise<OpenApiSpecInfo> {
  const specUrl = DEFAULT_SPEC_URL;
  try {
    console.log(`[openapi] Loading spec from ${specUrl}...`);
    cachedSpec = await loadFromRemote(specUrl);
    console.log(`[openapi] Loaded ${cachedSpec.endpoints.length} endpoints (prefix ${cachedSpec.apiPrefix}).`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[openapi] Failed to load spec (${msg}); using bundled fallback endpoint list.`);
    cachedSpec = {
      apiPrefix: DEFAULT_API_PREFIX,
      endpoints: FALLBACK_ENDPOINTS,
      source: 'fallback',
      loadedAt: new Date().toISOString()
    };
  }
  return cachedSpec;
}

/**
 * Returns the cached spec. If the launch load was skipped or is still running,
 * this lazily triggers a load and returns the fallback in the meantime.
 */
export async function getOpenApiSpec(): Promise<OpenApiSpecInfo> {
  if (cachedSpec) return cachedSpec;
  return initializeOpenApiSpec();
}
