import axios, { AxiosInstance } from 'axios';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { runEndpointAudit } from '../openapi/endpoint-audit';
import { getOpenApiSpec, OpenApiSpecInfo } from '../openapi/openapi-spec';
import { runGrpcApiChecks, runGrpcMemberChecks, runRestMemberChecks } from './member-checks';
import { runSt2138ValidateJsOnModel, runSt2138ValidateResponse } from '../validation/st2138-cli-validator';
import { validateEndpointResponse, ResponseValidation } from './response-validation';
import { restTransportOptions, grpcTransport, streamCollector, mapDeviceSlots, grpcDeadline, DEVICE_REQUEST_TIMEOUT_MS } from '../security/device-transport';

type DiscoveryAttempt = {
  endpoint: string;
  status: number | null;
  response: unknown;
  validation?: ResponseValidation;
  error?: string;
  unreachable?: boolean;
};

const GRPC_ALARM_SEVERITY_VALUES: Record<string, number> = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFORMATIONAL: 6,
  DEBUG: 7
};

const UNREACHABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET'
]);

function deviceNotFound(rawUrl: string): Error {
  return Object.assign(new Error(`Couldn't find device at ${rawUrl}.`), { code: 'device_not_found' });
}

function isGrpcUnreachable(error: any): boolean {
  return error?.code === grpc.status.UNAVAILABLE || error?.code === grpc.status.DEADLINE_EXCEEDED;
}

export type ScanProgress = (message: string) => void;

function normalizeDeviceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The device URL must use HTTP or HTTPS.');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function isSlotList(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((slot) => Number.isSafeInteger(slot) && slot >= 0);
}

function createClient(): AxiosInstance {
  return axios.create({
    ...restTransportOptions(),
    timeout: DEVICE_REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    headers: {
      ...restTransportOptions().headers,
      Accept: 'application/json',
      'Detail-Level': 'FULL'
    }
  });
}

let catenaServiceConstructor: any;

function getCatenaServiceConstructor(): any {
  if (catenaServiceConstructor) return catenaServiceConstructor;

  const protoDirectory = path.resolve(process.cwd(), 'vendor/st2138-a/interface/proto');
  const definition = protoLoader.loadSync(path.join(protoDirectory, 'service.proto'), {
    includeDirs: [protoDirectory],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: false
  });
  const loaded = grpc.loadPackageDefinition(definition) as any;
  catenaServiceConstructor = loaded.st2138.CatenaService;
  return catenaServiceConstructor;
}

function parseGrpcTarget(rawUrl: string): { target: string; secure: boolean } {
  const trimmed = rawUrl.trim();
  const hasScheme = /^https?:\/\//i.test(trimmed);
  const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  const secure = parsed.protocol === 'https:';
  const port = parsed.port || (secure ? '443' : '80');
  return { target: `${parsed.hostname}:${port}`, secure };
}

function readGrpcSlots(client: any): Promise<number[]> {
  return new Promise((resolve, reject) => {
    client.GetPopulatedSlots({}, { deadline: grpcDeadline() }, (error: Error | null, result: any) => {
      if (error) return reject(error);
      const slots = result?.slots;
      if (!Array.isArray(slots) || slots.length === 0) {
        return reject(new Error('GetPopulatedSlots returned no populated slots.'));
      }
      resolve(slots.map(Number));
    });
  });
}

function readGrpcDevice(client: any, slot: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const stream = client.DeviceRequest({ slot, detail_level: 0 }, {
      deadline: grpcDeadline()
    });
    const components: any[] = [];
    stream.on('data', streamCollector(components));
    stream.on('error', reject);
    stream.on('end', () => resolve(components));
  });
}

function setNestedValue(target: Record<string, any>, oid: string, value: unknown): void {
  const parts = oid.split('/').filter(Boolean);
  if (parts.length === 0) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function assembleGrpcDevice(slot: number, components: any[]): Record<string, any> {
  const model: Record<string, any> = {
    slot,
    params: {}
  };

  for (const component of components) {
    if (component.device) Object.assign(model, component.device);
    if (component.param) setNestedValue(model.params, component.param.oid, component.param.param);
    if (component.command) {
      model.commands ??= {};
      setNestedValue(model.commands, component.command.oid, component.command.command);
    }
    if (component.shared_constraint) {
      model.constraints ??= {};
      setNestedValue(model.constraints, component.shared_constraint.oid, component.shared_constraint.constraint);
    }
    if (component.menu) {
      const [groupName, ...menuPath] = String(component.menu.oid || '').split('/').filter(Boolean);
      if (groupName && menuPath.length > 0) {
        model.menu_groups ??= {};
        model.menu_groups[groupName] ??= { menus: {} };
        model.menu_groups[groupName].menus ??= {};
        model.menu_groups[groupName].order ??= 0;
        setNestedValue(model.menu_groups[groupName].menus, menuPath.join('/'), component.menu.menu);
      }
    }
    if (component.language_pack) {
      model.language_packs ??= {};
      model.language_packs[component.language_pack.language] = component.language_pack.language_pack;
    }
  }

  for (const group of Object.values(model.menu_groups || {}) as Array<Record<string, any>>) {
    group.menus ??= {};
    group.order ??= 0;
    for (const menu of Object.values(group.menus) as Array<Record<string, any>>) {
      menu.order ??= 0;
    }
  }

  return model;
}

function normalizeProtoModel(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeProtoModel);
  if (!value || typeof value !== 'object') return value;

  const normalized: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'kind' || child === null || child === undefined) continue;
    normalized[key] = key === 'severity' && typeof child === 'string'
      && Object.prototype.hasOwnProperty.call(GRPC_ALARM_SEVERITY_VALUES, child)
      ? GRPC_ALARM_SEVERITY_VALUES[child]
      : normalizeProtoModel(child);
  }
  return normalized;
}

function restoreIntegerChoiceDefaults(value: any): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(restoreIntegerChoiceDefaults);
    return;
  }

  const choices = value.int32_choice?.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (choice.value === undefined) choice.value = 0;
    }
  }

  if (value.commands && typeof value.commands === 'object') {
    for (const command of Object.values(value.commands) as Array<Record<string, any>>) {
      command.response ??= false;
    }
  }

  Object.values(value).forEach(restoreIntegerChoiceDefaults);
}

export function restoreGrpcDescriptorDefaults(model: Record<string, any>): void {
  const restoreParamMap = (paramMap: any) => {
    if (!paramMap || typeof paramMap !== 'object' || Array.isArray(paramMap)) return;
    for (const descriptor of Object.values(paramMap) as Array<Record<string, any>>) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      descriptor.read_only ??= false;
      if (descriptor.params) restoreParamMap(descriptor.params);
    }
  };

  restoreParamMap(model.params);
  if (model.commands && typeof model.commands === 'object') {
    for (const command of Object.values(model.commands) as Array<Record<string, any>>) {
      if (!command || typeof command !== 'object') continue;
      command.read_only ??= false;
      command.response ??= false;
      if (command.params) restoreParamMap(command.params);
    }
  }
}

export function grpcComponentsToDeviceModel(slot: number, components: any[]): Record<string, any> {
  const model = normalizeProtoModel(assembleGrpcDevice(slot, components));
  restoreIntegerChoiceDefaults(model);
  restoreGrpcDescriptorDefaults(model);
  return model;
}

export async function validateGrpcComponents(components: any[], deviceValidation: any): Promise<ResponseValidation> {
  const results = [deviceValidation];

  for (const raw of components) {
    const component = normalizeProtoModel(raw);
    if (component.device) continue;
    if (component.param) {
      restoreIntegerChoiceDefaults(component.param.param);
      restoreGrpcDescriptorDefaults({ params: { item: component.param.param }, commands: {} });
      results.push(await runSt2138ValidateResponse('fqoid', component.param.oid));
      results.push(await runSt2138ValidateResponse('param', component.param.param));
    } else if (component.command) {
      restoreIntegerChoiceDefaults(component.command.command);
      restoreGrpcDescriptorDefaults({ params: {}, commands: { item: component.command.command } });
      results.push(await runSt2138ValidateResponse('component_command', component.command));
    } else if (component.shared_constraint) {
      results.push(await runSt2138ValidateResponse('component_constraint', component.shared_constraint));
    } else if (component.menu) {
      results.push(await runSt2138ValidateResponse('component_menu', component.menu));
    } else if (component.language_pack) {
      results.push(await runSt2138ValidateResponse('component_language_pack', component.language_pack));
    } else {
      results.push(await runSt2138ValidateResponse('device_component', component));
    }
  }

  const ok = results.every((result) => result.ok);
  return {
    schema: 'device_component',
    ran: true,
    ok,
    note: ok ? `${components.length} streamed component(s) validated` : 'one or more streamed components failed ST 2138 validation',
    results
  };
}

async function supportedLanguages(
  client: AxiosInstance,
  deviceUrl: string,
  apiPrefix: string,
  slot: number
): Promise<string[]> {
  try {
    const response = await client.get(`${deviceUrl}${apiPrefix}/${slot}/languages`);
    return response.status >= 200 && response.status < 300 && Array.isArray(response.data)
      ? response.data.filter((language: unknown): language is string => typeof language === 'string' && language.length > 0)
      : [];
  } catch {
    return [];
  }
}

function memberAuditResults(slot: number, checks: any[], protocol: 'rest' | 'grpc') {
  return checks.flatMap((check) => {
    const [initialRead, ...updateSteps] = check.steps;
    const path = `/st2138-api/v1/${slot}/value/${check.path.split('/').map(encodeURIComponent).join('/')}`;
    const results = [{
      endpoint: protocol === 'rest' ? path : `${initialRead?.request?.method || 'CatenaService.GetValue'} · ${check.path}`,
      pathTemplate: '/{slot}/value/{fqoid}',
      slot,
      method: initialRead?.request?.method || (protocol === 'rest' ? 'GET' : 'CatenaService.GetValue'),
      isStream: false,
      mutating: false,
      tested: true,
      status: initialRead?.status || 0,
      ok: initialRead?.ok === true,
      notImplemented: false,
      warning: Boolean(initialRead?.warning),
      schemaValid: initialRead?.ok === true,
      note: initialRead?.error || 'initial value read',
      requestPreview: JSON.stringify(initialRead?.request, null, 2),
      responsePreview: JSON.stringify(initialRead?.response, null, 2),
      memberType: 'Parameter',
      readOnly: check.readOnly,
      memberDataType: check.type,
      oid: check.path,
      operation: 'READ',
      title: 'Read parameter value',
      validation: initialRead?.validation,
      manualRequest: protocol === 'grpc' ? initialRead?.request?.payload : undefined,
      manualBody: undefined
    }];

    if (updateSteps.length > 0) {
      const setStep = updateSteps.find((step: any) => step.name.startsWith('set-') || step.name.startsWith('restore-'));
      const method = setStep?.request?.method || (protocol === 'rest' ? 'PUT' : 'CatenaService.SetValue');
      results.push({
        endpoint: protocol === 'rest' ? path : `${method} · ${check.path}`,
        pathTemplate: '/{slot}/value/{fqoid}',
        slot,
        method,
        isStream: false,
        mutating: true,
        tested: true,
        status: setStep?.status || 0,
        ok: check.ok,
        notImplemented: false,
        warning: updateSteps.some((step: any) => Boolean(step.warning)),
        schemaValid: check.ok,
        note: check.reason || 'parameter SET, read-back, and restore result',
        requestPreview: updateSteps.map((step: any) => `${step.name}\n${JSON.stringify(step.request, null, 2)}`).join('\n\n'),
        responsePreview: updateSteps.map((step: any) => `${step.name}\n${JSON.stringify({ status: step.status, ok: step.ok, response: step.response, error: step.error, warning: step.warning }, null, 2)}`).join('\n\n'),
        memberType: 'Parameter',
        readOnly: check.readOnly,
        memberDataType: check.type,
        oid: check.path,
        operation: 'UPDATE',
        title: 'Update parameter value',
        manualBody: protocol === 'rest' ? setStep?.request?.body : undefined,
        manualRequest: protocol === 'grpc' ? setStep?.request?.payload : undefined,
        validation: {
          schema: 'empty',
          ran: updateSteps.some((step: any) => step.validation?.ran),
          ok: updateSteps.filter((step: any) => step.validation?.ran).every((step: any) => step.validation.ok),
          note: 'SET, read-back, and restore response validation',
          results: updateSteps.flatMap((step: any) => step.validation?.results || [])
        }
      });
    }

    return results;
  });
}

export async function scanRestDevice(rawUrl: string, specOverride?: OpenApiSpecInfo, onProgress?: ScanProgress) {
  const deviceUrl = normalizeDeviceUrl(rawUrl);
  const client = createClient();
  onProgress?.('Checking populated device slots…');
  const discoveryEndpoints = ['/st2138-api/v1/devices', '/st2138-api/v1/device'];
  const discoveryAttempts: DiscoveryAttempt[] = [];
  let slots: number[] | null = null;
  let discoveryEndpoint: string | null = null;

  for (const endpoint of discoveryEndpoints) {
    try {
      const response = await client.get(`${deviceUrl}${endpoint}`);
      const validation = await validateEndpointResponse({
        protocol: 'rest', method: 'GET', endpoint, status: response.status, payload: response.data
      });
      discoveryAttempts.push({ endpoint, status: response.status, response: response.data, validation });
      if (response.status >= 200 && response.status < 300 && validation.ok && isSlotList(response.data?.slots)) {
        slots = response.data.slots;
        discoveryEndpoint = endpoint;
        break;
      }
    } catch (error) {
      discoveryAttempts.push({
        endpoint,
        status: null,
        response: null,
        error: error instanceof Error ? error.message : String(error),
        unreachable: UNREACHABLE_NETWORK_CODES.has((error as any)?.code)
      });
    }
  }

  if (!slots || !discoveryEndpoint) {
    if (discoveryAttempts.length > 0 && discoveryAttempts.every((attempt) => attempt.unreachable)) {
      throw deviceNotFound(rawUrl);
    }
    if (discoveryAttempts.some((attempt) => attempt.status === 401)) {
      throw Object.assign(new Error('JWT required for testing.'), { code: 'jwt_required' });
    }
    throw new Error(`Slot discovery failed. Attempts: ${JSON.stringify(discoveryAttempts)}`);
  }

  onProgress?.(`Found ${slots.length} populated slot(s): ${slots.join(', ')}. Loading device models…`);
  const slotResults = await mapDeviceSlots(slots, async (slot) => {
    const endpoint = `/st2138-api/v1/${slot}`;
    try {
      onProgress?.(`Loading device model for slot ${slot}…`);
      const response = await client.get(`${deviceUrl}${endpoint}`);
      const model = response.status >= 200 && response.status < 300
        && response.data !== null
        && typeof response.data === 'object'
        && !Array.isArray(response.data)
        ? response.data
        : null;

      let validation = null;
      if (model) {
        onProgress?.(`Analyzing ST 2138 model for slot ${slot}…`);
        validation = await runSt2138ValidateJsOnModel(model);
      } else {
        onProgress?.(`No device model was returned for slot ${slot}.`);
      }
      const memberChecks = model
        ? await runRestMemberChecks(client, deviceUrl, slot, model,
          (message) => onProgress?.(message))
        : { summary: { total: 0, passed: 0, failed: 0 }, checks: [] };
      onProgress?.(`Finished model analysis for slot ${slot}.`);

      return {
        slot,
        endpoint,
        status: response.status,
        fetched: model !== null,
        model,
        validation,
        memberChecks,
        endpointSummary: { passed: 0, failed: 0 },
        ok: model !== null
          && validation?.ran === true
          && validation.ok
          && memberChecks.summary.failed === 0
      };
    } catch (error) {
      onProgress?.(`Model analysis failed for slot ${slot}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        slot,
        endpoint,
        status: null,
        fetched: false,
        model: null,
        validation: null,
        endpointSummary: { passed: 0, failed: 0 },
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  const spec = specOverride || await getOpenApiSpec();
  const endpoints = spec.endpoints.filter((endpoint) => !/\/command(?:\/|$)/i.test(endpoint.pathTemplate));
  const memberEndpoints = endpoints.filter((endpoint) =>
    endpoint.pathTemplate.includes('{fqoid}')
    && /\/param(?:-info)?\/\{fqoid\}/.test(endpoint.pathTemplate)
  );
  const deviceEndpoints = endpoints.filter((endpoint) => !endpoint.pathTemplate.includes('{slot}'));
  const slotEndpoints = endpoints.filter((endpoint) => endpoint.pathTemplate.includes('{slot}'));
  const sampleSlot = slots[0];
  const sampleModel = slotResults.find((result) => result.slot === sampleSlot && result.model)?.model;
  const sampleLanguages = await supportedLanguages(client, deviceUrl, spec.apiPrefix, sampleSlot);
  const skipRestEndpoint = (endpoint: typeof spec.endpoints[number], model: any, languageCount: number) => {
    if (endpoint.operationId === 'RefreshToken') return 'token refresh requires an authenticated session';
    if (endpoint.pathTemplate.includes('/subscriptions') && model?.subscriptions !== true) {
      return 'subscriptions are not advertised by this slot';
    }
    if (endpoint.pathTemplate.includes('/language-pack/') && languageCount === 0) {
      return 'the slot advertises no supported languages';
    }
    return undefined;
  };
  onProgress?.('Auditing device-wide REST endpoints…');
  const endpointAudit = await runEndpointAudit(client, deviceEndpoints, {
    deviceUrl,
    apiPrefix: spec.apiPrefix,
    sampleSlot,
    sampleLanguageCode: sampleLanguages[0] || '',
    deviceModel: sampleModel
  }, {
    skipReason: (endpoint, context) => skipRestEndpoint(endpoint, context.deviceModel, sampleLanguages.length)
  });

  for (const slot of slots) {
    onProgress?.(`Auditing REST endpoints and parameters for slot ${slot}…`);
    const slotModel = slotResults.find((result) => result.slot === slot && result.model)?.model;
    const languages = await supportedLanguages(client, deviceUrl, spec.apiPrefix, slot);
    endpointAudit.push(...await runEndpointAudit(client, slotEndpoints, {
      deviceUrl,
      apiPrefix: spec.apiPrefix,
      sampleSlot: slot,
      sampleLanguageCode: languages[0] || '',
      deviceModel: slotModel
    }, {
      skipReason: (endpoint, context) => skipRestEndpoint(endpoint, context.deviceModel, languages.length)
    }));

    const memberChecks = slotResults.find((result) => result.slot === slot)?.memberChecks?.checks || [];
    for (const member of memberChecks) {
      endpointAudit.push(...await runEndpointAudit(client, memberEndpoints, {
        deviceUrl,
        apiPrefix: spec.apiPrefix,
        sampleSlot: slot,
        sampleLanguageCode: languages[0] || '',
        deviceModel: slotModel,
        fqoid: member.path,
        memberType: 'Parameter',
        memberReadOnly: member.readOnly
      }));
    }

    const languagePackEndpoints = slotEndpoints.filter((endpoint) => endpoint.pathTemplate.includes('/language-pack/'));
    for (const language of languages.slice(1)) {
      endpointAudit.push(...await runEndpointAudit(client, languagePackEndpoints, {
        deviceUrl,
        apiPrefix: spec.apiPrefix,
        sampleSlot: slot,
        sampleLanguageCode: language,
        deviceModel: slotModel
      }));
    }
  }

  const testedEndpoints = endpointAudit.filter((result) => result.tested);
  endpointAudit.push(...slotResults.flatMap((result) => memberAuditResults(result.slot, result.memberChecks?.checks || [], 'rest')));
  const allTestedEndpoints = endpointAudit.filter((result) => result.tested);
  for (const slotResult of slotResults) {
    const slotEndpoints = allTestedEndpoints.filter((endpoint) => endpoint.slot === slotResult.slot);
    slotResult.endpointSummary = {
      passed: slotEndpoints.filter((endpoint) => endpoint.ok).length,
      failed: slotEndpoints.filter((endpoint) => !endpoint.ok).length
    };
    slotResult.ok = slotResult.ok && slotResult.endpointSummary.failed === 0;
  }

  return {
    protocol: 'rest' as const,
    deviceUrl,
    scannedAt: new Date().toISOString(),
    discovery: {
      endpoint: discoveryEndpoint,
      slots,
      attempts: discoveryAttempts
    },
    summary: {
      total: slotResults.length,
      passed: slotResults.filter((result) => result.ok).length,
      failed: slotResults.filter((result) => !result.ok).length,
      endpoints: {
        total: endpointAudit.length,
        tested: allTestedEndpoints.length,
        passed: allTestedEndpoints.filter((result) => result.ok).length,
        failed: allTestedEndpoints.filter((result) => !result.ok).length,
        skipped: endpointAudit.length - allTestedEndpoints.length
      }
    },
    slots: slotResults,
    endpointAudit
  };
}

export async function scanGrpcDevice(rawUrl: string, onProgress?: ScanProgress) {
  const { target, secure } = parseGrpcTarget(rawUrl);
  const transport = grpcTransport(target, secure);
  const Service = getCatenaServiceConstructor();
  const client = new Service(
    transport.target,
    transport.credentials,
    transport.options
  );

  try {
    onProgress?.('Checking populated device slots…');
    const slots = await readGrpcSlots(client).catch((error) => {
      throw isGrpcUnreachable(error) ? deviceNotFound(rawUrl) : error;
    });
    const slotListValidation = await validateEndpointResponse({
      protocol: 'grpc', method: 'GetPopulatedSlots', endpoint: 'CatenaService.GetPopulatedSlots',
      status: 0, payload: { slots }
    });
    const endpointAudit: Array<{
      endpoint: string;
      pathTemplate: string;
      slot: number | null;
      method: string;
      isStream: boolean;
      mutating: boolean;
      tested: boolean;
      status: number;
      ok: boolean;
      notImplemented: boolean;
      warning: boolean;
      schemaValid: boolean;
      note: string;
      requestPreview: string;
      responsePreview: string;
      title?: string;
      memberType?: string;
      memberDataType?: string;
      oid?: string;
      operation?: string;
      resourceGroup?: 'Subscriptions' | 'Language packs';
      resourceKey?: string;
      resourceKind?: 'languages' | 'language-pack';
      validation?: ResponseValidation | ResponseValidation[];
      manualRequest?: unknown;
      manualBody?: unknown;
    }> = [];
    endpointAudit.push({
      endpoint: 'CatenaService.GetPopulatedSlots',
      pathTemplate: 'CatenaService.GetPopulatedSlots',
      slot: null,
      method: 'READ',
      operation: 'READ',
      isStream: false,
      mutating: false,
      tested: true,
      status: 0,
      ok: slotListValidation.ok,
      notImplemented: false,
      warning: false,
      schemaValid: true,
      note: `${slots.length} populated slot(s) found`,
      requestPreview: '{}',
      responsePreview: JSON.stringify({ slots }, null, 2),
      title: 'Discover populated slots',
      validation: slotListValidation
    });
    onProgress?.(`Found ${slots.length} populated slot(s): ${slots.join(', ')}. Loading device models…`);
    const slotResults = await mapDeviceSlots(slots, async (slot) => {
      try {
        onProgress?.(`Loading streamed device model for slot ${slot}…`);
        const components = await readGrpcDevice(client, slot);
        onProgress?.(`Analyzing ST 2138 model for slot ${slot}…`);
        const model = grpcComponentsToDeviceModel(slot, components);
        const validation = await runSt2138ValidateJsOnModel(model);
        const componentValidation = await validateGrpcComponents(components, validation);
        const memberChecks = await runGrpcMemberChecks(client, slot, model,
          (message) => onProgress?.(message));
        onProgress?.(`Checking gRPC API responses for slot ${slot}…`);
        const apiChecks = await runGrpcApiChecks(client, slot, model);
        onProgress?.(`Finished model analysis for slot ${slot}.`);
        return {
          slot,
          fetched: components.length > 0,
          model,
          componentCount: components.length,
          validation,
          componentValidation,
          memberChecks,
          apiChecks,
          endpointSummary: { passed: 0, failed: 0 },
          ok: components.length > 0
            && validation.ran
            && validation.ok
            && componentValidation.ok
            && memberChecks.summary.failed === 0
        };
      } catch (error) {
        onProgress?.(`Model analysis failed for slot ${slot}: ${error instanceof Error ? error.message : String(error)}`);
        return {
          slot,
          fetched: false,
          model: null,
          componentCount: 0,
          validation: null,
          endpointSummary: { passed: 0, failed: 0 },
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });

    for (const slotResult of slotResults) {
      endpointAudit.push({
        endpoint: 'CatenaService.DeviceRequest',
        pathTemplate: 'CatenaService.DeviceRequest',
        slot: slotResult.slot,
        method: 'READ',
        operation: 'READ',
        isStream: true,
        mutating: false,
        tested: true,
        status: 0,
        ok: slotResult.componentValidation?.ok === true,
        notImplemented: false,
        warning: false,
        schemaValid: slotResult.componentValidation?.ok === true,
        note: slotResult.componentValidation?.note || slotResult.error || 'streamed device response validation unavailable',
        requestPreview: JSON.stringify({ slot: slotResult.slot, detail_level: 'FULL' }, null, 2),
        responsePreview: `${slotResult.componentCount || 0} component(s) received`,
        title: 'Read device components',
        validation: slotResult.componentValidation,
        manualRequest: { slot: slotResult.slot, detail_level: 0 }
      });
      endpointAudit.push(...memberAuditResults(slotResult.slot, slotResult.memberChecks?.checks || [], 'grpc'));
      for (const check of slotResult.apiChecks?.checks || []) {
        endpointAudit.push({
          endpoint: check.endpoint,
          pathTemplate: check.endpoint,
          slot: check.slot,
          method: check.method || check.operation || 'READ',
          isStream: check.isStream,
          mutating: false,
          tested: check.tested,
          status: check.status,
          ok: check.ok,
          notImplemented: false,
          warning: false,
          schemaValid: check.ok,
          note: check.note,
          requestPreview: check.requestPreview,
          responsePreview: check.responsePreview,
          title: check.title,
          memberType: check.memberType,
          oid: check.oid,
          operation: check.operation || 'READ',
          manualRequest: check.manualRequest,
          validation: check.validation,
          resourceGroup: check.resourceGroup,
          resourceKey: check.resourceKey,
          resourceKind: check.resourceKind
        });
      }
    }

    const skippedMethods: Array<{
      method: string;
      title: string;
      reason: string;
      resourceGroup?: 'Subscriptions';
      operation?: 'READ' | 'CREATE' | 'UPDATE' | 'DELETE';
    }> = [
      { method: 'ExternalObjectRequest', title: 'Read external object', reason: 'No external-object identifiers were discoverable in the device model.', operation: 'READ' },
      { method: 'MultiSetValue', title: 'Set multiple parameter values', reason: 'Batch writes are not run because the scan cannot guarantee transactional restoration.', operation: 'UPDATE' },
      { method: 'UpdateSubscriptions', title: 'Update subscriptions', reason: 'Subscription changes are not required for a model scan.', resourceGroup: 'Subscriptions', operation: 'UPDATE' },
      { method: 'Connect', title: 'Open streaming session', reason: 'A long-lived session is not required for this scan.', operation: 'CREATE' },
      { method: 'AddLanguage', title: 'Add language pack', reason: 'Adding a language mutates device configuration.', operation: 'CREATE' },
      { method: 'RefreshToken', title: 'Refresh access token', reason: 'The scan does not establish an authenticated token session.', operation: 'UPDATE' },
      { method: 'RevokeAccess', title: 'Revoke access', reason: 'Access revocation is destructive and cannot be restored by the scan.', operation: 'DELETE' }
    ];

    for (const slot of slots) {
      for (const skipped of skippedMethods) {
        endpointAudit.push({
          endpoint: `CatenaService.${skipped.method}`,
          pathTemplate: `CatenaService.${skipped.method}`,
          slot,
          method: skipped.operation || 'READ',
          isStream: false,
          mutating: ['MultiSetValue', 'UpdateSubscriptions', 'AddLanguage', 'RevokeAccess'].includes(skipped.method),
          tested: false,
          status: 0,
          ok: false,
          notImplemented: false,
          warning: false,
          schemaValid: false,
          note: `Not run: ${skipped.reason}`,
          requestPreview: '(not sent)',
          responsePreview: '(not run)',
          title: skipped.title,
          operation: skipped.operation,
          resourceGroup: skipped.resourceGroup,
          manualRequest: {}
        });
      }
    }

    for (const slotResult of slotResults) {
      const slotEndpoints = endpointAudit.filter((endpoint) => endpoint.slot === slotResult.slot && endpoint.tested);
      slotResult.endpointSummary = {
        passed: slotEndpoints.filter((endpoint) => endpoint.ok).length,
        failed: slotEndpoints.filter((endpoint) => !endpoint.ok).length
      };
      slotResult.ok = slotResult.ok && slotResult.endpointSummary.failed === 0;
    }

    const passed = slotResults.filter((result) => result.ok).length;
    const testedEndpoints = endpointAudit.filter((result) => result.tested);

    return {
      protocol: 'grpc' as const,
      deviceUrl: target,
      scannedAt: new Date().toISOString(),
      discovery: { endpoint: 'CatenaService.GetPopulatedSlots', slots },
      summary: {
        total: slotResults.length,
        passed,
        failed: slotResults.length - passed,
        endpoints: {
          total: endpointAudit.length,
          tested: testedEndpoints.length,
          passed: testedEndpoints.filter((result) => result.ok).length,
          failed: testedEndpoints.filter((result) => !result.ok).length,
          skipped: endpointAudit.length - testedEndpoints.length
        }
      },
      slots: slotResults,
      endpointAudit
    };
  } finally {
    client.close();
  }
}