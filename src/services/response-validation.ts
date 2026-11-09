import { runSt2138ValidateResponse, St2138ValidateResult } from '../validation/st2138-cli-validator';

export type ResponseValidation = {
  schema: string | null;
  ran: boolean;
  ok: boolean;
  note: string;
  results: St2138ValidateResult[];
};

function restResponseSchema(method: string, endpoint: string, status: number, payload: any, isStream: boolean): string | null {
  if (status < 200 || status >= 300) return 'exception';
  if (endpoint.endsWith('/health')) return 'empty';
  if (status === 204 || payload === undefined || payload === null || payload === '') return 'empty';
  if (/\/devices?$/.test(endpoint)) return 'slot_list';
  if (/\/st2138-api\/v1\/\d+$/.test(endpoint)) return 'device';
  if (/\/param-info(?:\/|$)/.test(endpoint)) return 'param_info_response';
  if (/\/subscriptions\/stream(?:\?|$)/.test(endpoint)) return 'component_param';
  if (/\/\d+\/stream(?:\?|$)/.test(endpoint)) return 'device_component';
  if (/\/param\/.+$/.test(endpoint)) return 'component_param';
  if (/\/value\/.+$/.test(endpoint)) return method === 'GET' ? 'value' : 'empty';
  if (/\/language-pack(?:\/|$)/.test(endpoint)) {
    if (method !== 'GET') return 'empty';
    return payload?.language ? 'component_language_pack' : 'language_pack';
  }
  if (endpoint.endsWith('/languages')) return 'language_list';
  if (endpoint.endsWith('/subscriptions')) return 'component_param';
  if (/\/asset(?:\/|$)/.test(endpoint)) return 'external_object_payload';
  if (/\/command(?:\/|$)/.test(endpoint)) return 'command_response';
  if (endpoint.endsWith('/access')) return method === 'POST' ? 'revocation_response' : 'connection_status';
  if (isStream) return 'push_updates';
  if (method === 'GET') return 'device_component';
  return 'empty';
}

function grpcResponseSchema(method: string, status: number, isStream: boolean): string | null {
  if (status !== 0) return 'exception';
  const schemaByMethod: Record<string, string> = {
    GetPopulatedSlots: 'slot_list',
    DeviceRequest: isStream ? 'device_component' : 'device',
    ExecuteCommand: 'command_response',
    ExternalObjectRequest: 'external_object_payload',
    ParamInfoRequest: 'param_info_response',
    SetValue: 'empty',
    GetValue: 'value',
    MultiSetValue: 'empty',
    UpdateSubscriptions: 'empty',
    GetParam: 'component_param',
    Connect: 'push_updates',
    AddLanguage: 'empty',
    LanguagePackRequest: 'component_language_pack',
    ListLanguages: 'language_list',
    RefreshToken: 'connection_status',
    RevokeAccess: 'revocation_response'
  };
  return schemaByMethod[method] || null;
}

async function validateItems(schema: string, payload: unknown, arrayItems = false): Promise<ResponseValidation> {
  if (payload === undefined || payload === null) {
    const result = await runSt2138ValidateResponse(schema, {});
    return { schema, ran: true, ok: result.ok, note: result.ok ? 'valid empty response' : 'response validation failed', results: [result] };
  }
  const items = arrayItems && Array.isArray(payload) ? payload : [payload];
  const results = await Promise.all(items.map((item) => runSt2138ValidateResponse(schema, item)));
  const ok = results.every((result) => result.ok);
  return {
    schema,
    ran: true,
    ok,
    note: ok ? `${items.length} response item(s) valid` : 'response failed ST 2138 validation',
    results
  };
}

async function validateComponentParams(payload: unknown): Promise<ResponseValidation> {
  const items = Array.isArray(payload) ? payload : [payload];
  const results: St2138ValidateResult[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof (item as any).oid !== 'string' || !(item as any).param
      || Object.keys(item as object).some((key) => key !== 'oid' && key !== 'param')) {
      results.push(await runSt2138ValidateResponse('component_param', item));
      continue;
    }
    results.push(await runSt2138ValidateResponse('fqoid', (item as any).oid));
    results.push(await runSt2138ValidateResponse('param', (item as any).param));
  }

  const ok = results.every((result) => result.ok);
  return {
    schema: 'component_param',
    ran: true,
    ok,
    note: ok ? `${items.length} parameter component(s) valid` : 'parameter component failed ST 2138 validation',
    results
  };
}

async function validateDeviceComponentEvent(component: any, slot: number | null): Promise<St2138ValidateResult[]> {
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    return [await runSt2138ValidateResponse('device_component', component)];
  }
  if (component.device) {
    const device = slot === null || component.device.slot !== undefined
      ? component.device
      : { ...component.device, slot };
    return [await runSt2138ValidateResponse('device', device)];
  }
  if (component.param) {
    const result = await validateComponentParams(component.param);
    return result.results;
  }
  if (component.command) return [await runSt2138ValidateResponse('component_command', component.command)];
  if (component.shared_constraint) return [await runSt2138ValidateResponse('component_constraint', component.shared_constraint)];
  if (component.menu) return [await runSt2138ValidateResponse('component_menu', component.menu)];
  if (component.language_pack) return [await runSt2138ValidateResponse('component_language_pack', component.language_pack)];
  return [await runSt2138ValidateResponse('device_component', component)];
}

async function validateDeviceComponentPayload(payload: unknown, slot: number | null): Promise<ResponseValidation> {
  const components = Array.isArray(payload) ? payload : [payload];
  const results = (await Promise.all(components.map((component) => validateDeviceComponentEvent(component, slot)))).flat();
  const ok = results.every((result) => result.ok);
  return {
    schema: 'device_component',
    ran: true,
    ok,
    note: ok ? `${components.length} device component(s) valid` : 'one or more device components failed ST 2138 validation',
    results
  };
}

async function validateGrpcParamInfoResponse(payload: unknown): Promise<ResponseValidation> {
  const items = Array.isArray(payload) ? payload : [payload];
  const results: St2138ValidateResult[] = [];
  const allowedResponseKeys = new Set(['info', 'array_length']);
  const allowedInfoKeys = new Set(['oid', 'name', 'type', 'template_oid']);

  const invalidShape = (message: string): St2138ValidateResult => ({
    ran: true,
    ok: false,
    exitCode: 2,
    stdout: `ERROR: ${message}`,
    stderr: '',
    failingLine: null,
    failingLines: [],
    failingLineContent: []
  });

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      results.push(invalidShape('ParamInfoResponse must be an object.'));
      continue;
    }
    const response = item as Record<string, any>;
    if (Object.keys(response).some((key) => !allowedResponseKeys.has(key))
      || !response.info || typeof response.info !== 'object' || Array.isArray(response.info)) {
      results.push(invalidShape('ParamInfoResponse must contain an info object and optional array_length.'));
      continue;
    }

    const info = response.info as Record<string, any>;
    if (Object.keys(info).some((key) => !allowedInfoKeys.has(key))
      || typeof info.oid !== 'string' || typeof info.type !== 'string') {
      results.push(invalidShape('ParamInfo must contain a valid oid and type, with only protobuf-defined fields.'));
      continue;
    }

    results.push(await runSt2138ValidateResponse('fqoid', info.oid));
    results.push(await runSt2138ValidateResponse('param_type', info.type));
    if (info.name !== undefined) results.push(await runSt2138ValidateResponse('polyglot_text', info.name));
    if (info.template_oid !== undefined && info.template_oid !== '') {
      results.push(await runSt2138ValidateResponse('template_oid', info.template_oid));
    }
    if (response.array_length !== undefined) {
      results.push(await runSt2138ValidateResponse('total_length', response.array_length));
    }
  }

  const ok = results.every((result) => result.ok);
  return {
    schema: 'protobuf ParamInfoResponse',
    ran: true,
    ok,
    note: ok ? `${items.length} protobuf ParamInfoResponse item(s) valid` : 'protobuf ParamInfoResponse failed ST 2138 field validation',
    results
  };
}

export async function validateEndpointResponse(input: {
  protocol: 'rest' | 'grpc';
  method: string;
  endpoint: string;
  status: number;
  payload: unknown;
  isStream?: boolean;
}): Promise<ResponseValidation> {
  if (input.isStream && (input.payload === undefined || input.payload === null)) {
    return { schema: null, ran: false, ok: true, note: 'The stream opened, but returned no event body to validate.', results: [] };
  }
  if (input.isStream && Array.isArray(input.payload) && input.payload.length === 0) {
    return { schema: null, ran: false, ok: true, note: 'The stream opened, but returned no event body to validate.', results: [] };
  }

  if (input.protocol === 'rest' && input.isStream && /\/\d+\/stream(?:\?|$)/.test(input.endpoint)) {
    const slotMatch = input.endpoint.match(/\/([0-9]+)\/stream(?:\?|$)/);
    return validateDeviceComponentPayload(input.payload, slotMatch ? Number(slotMatch[1]) : null);
  }

  if (input.protocol === 'grpc'
    && input.method.replace(/^CatenaService\./, '') === 'ParamInfoRequest'
    && input.status === 0) {
    return validateGrpcParamInfoResponse(input.payload);
  }

  const schema = input.protocol === 'grpc'
    ? grpcResponseSchema(input.method.replace(/^CatenaService\./, ''), input.status, Boolean(input.isStream))
    : restResponseSchema(input.method, input.endpoint, input.status, input.payload, Boolean(input.isStream));

  if (!schema) {
    return { schema: null, ran: false, ok: false, note: 'No ST 2138 response schema is mapped for this endpoint.', results: [] };
  }

  let payload = input.payload;
  if (schema === 'component_param') return validateComponentParams(payload);
  if (input.protocol === 'rest' && schema === 'component_language_pack' && Array.isArray(payload)) {
    return validateItems(schema, payload, true);
  }
  if (input.protocol === 'rest' && schema === 'language_pack' && (payload as any)?.language_pack) {
    payload = (payload as any).language_pack;
  }
  if (input.method === 'ListLanguages' && (payload as any)?.languages) {
    payload = (payload as any).languages;
  }
  if (schema === 'empty' && (payload === undefined || payload === null || payload === '')) payload = {};

  const arrayItems = (schema === 'component_param' && input.endpoint.endsWith('/subscriptions'))
    || input.isStream === true
    || (Array.isArray(payload) && schema !== 'language_list');
  return validateItems(schema, payload, arrayItems);
}