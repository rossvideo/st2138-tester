import { runSt2138ValidateResponse, St2138ValidateResult } from '../validation/st2138-cli-validator';

export type ResponseValidation = {
  schema: string | null;
  ran: boolean;
  ok: boolean;
  note: string;
  results: St2138ValidateResult[];
};

export type ParamInfoScope = {
  prefix: string;
  recursive: boolean;
  knownOids: readonly string[];
};

function shapeCheck(name: string, definition: string, ok: boolean, message: string, target = 'response'): St2138ValidateResult {
  return {
    ran: true, ok, exitCode: ok ? 0 : 2, stderr: '',
    stdout: `Applying tester rule '${name}' to ${target}\n${ok ? 'Shape check passed.' : `ERROR: ${message}`}`,
    test: { name, kind: 'Tester rule', definition },
    failingLine: null, failingLines: [], failingLineContent: []
  };
}

function validateParamInfoScope(payload: unknown[], scope: ParamInfoScope): St2138ValidateResult {
  const { prefix, recursive, knownOids } = scope;
  const inScope = (oid: string) => prefix
    ? oid === prefix || (recursive && oid.startsWith(`${prefix}/`))
    : recursive || !oid.includes('/');
  const returned = new Set<string>();
  for (const item of payload) {
    const oid = (item as { info?: { oid?: unknown } } | null)?.info?.oid;
    if (typeof oid === 'string') returned.add(oid);
  }
  const expected = prefix ? new Set([prefix, ...knownOids.filter(inScope)]) : new Set(knownOids.filter(inScope));
  const missing = [...expected].filter(oid => !returned.has(oid));
  const unexpected = [...returned].filter(oid => !inScope(oid));
  const errors = [
    ...(missing.length ? [`Missing OIDs: ${missing.join(', ')}.`] : []),
    ...(unexpected.length ? [`Out-of-scope OIDs: ${unexpected.join(', ')}.`] : [])
  ];
  return shapeCheck('ParamInfo recursive scope',
    `For ${prefix || 'the slot'} with recursion ${recursive ? 'enabled' : 'disabled'}, return the requested parameter(s)${recursive ? ' and their known descendants' : ' without descendants'}.`,
    errors.length === 0, errors.join(' '), 'parameter metadata stream');
}

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
  return validateItems('component_param', payload, true);
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
  const responseRule = `An object with only ${[...allowedResponseKeys].join(', ')}; info must be an object.`;
  const infoRule = `An object with only ${[...allowedInfoKeys].join(', ')}; oid and type must be strings.`;

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      results.push(shapeCheck('ParamInfoResponse shape', responseRule, false, 'ParamInfoResponse must be an object.'));
      continue;
    }
    const response = item as Record<string, any>;
    const responseOk = Object.keys(response).every(key => allowedResponseKeys.has(key))
      && !!response.info && typeof response.info === 'object' && !Array.isArray(response.info);
    results.push(shapeCheck('ParamInfoResponse shape', responseRule, responseOk,
      'ParamInfoResponse must contain an info object and optional array_length.'));
    if (!responseOk) continue;

    const info = response.info as Record<string, any>;
    const infoOk = Object.keys(info).every(key => allowedInfoKeys.has(key))
      && typeof info.oid === 'string' && typeof info.type === 'string';
    results.push(shapeCheck('ParamInfo shape', infoRule, infoOk,
      'ParamInfo must contain a valid oid and type, with only protobuf-defined fields.'));
    if (!infoOk) continue;

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

async function validatePushUpdates(payload: unknown, protocol: 'rest' | 'grpc'): Promise<ResponseValidation> {
  const updates = Array.isArray(payload) ? payload : [payload];
  const results: St2138ValidateResult[] = [];
  const kinds = [
    'value', 'device_component', 'refused', 'invalidated_external_object_id', 'trap_message',
    'invalidate_device_model', 'external_object', 'remove_device_components', 'slots_added', 'slots_removed'
  ];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every(key => keys.includes(key));
  for (const [index, update] of updates.entries()) {
    const target = `streamed update ${index + 1}`;
    const updateOk = isRecord(update) && hasOnly(update, ['slot', ...kinds])
      && kinds.filter(kind => kind in update).length === 1
      && (protocol === 'grpc' || 'slot' in update);
    let schemaPayload = update;
    if (protocol === 'grpc' && isRecord(update)) {
      schemaPayload = {
        ...update,
        ...(!('slot' in update) ? { slot: 0 } : {}),
        ...(isRecord(update.trap_message) && !('type' in update.trap_message)
          ? { trap_message: { ...update.trap_message, type: 0 } } : {})
      };
    }
    results.push({ ...await runSt2138ValidateResponse('push_updates', schemaPayload), chunk: index + 1 });
    if (!updateOk) continue;
    const kind = kinds.find(key => key in update)!;
    const value = update[kind];
    const addCheck = (result: St2138ValidateResult, submember = kind) => {
      results.push({ ...result, submember });
    };
    const checkSchema = async (schema: string, fieldValue: unknown, submember = kind) => {
      addCheck(await runSt2138ValidateResponse(schema, fieldValue), submember);
    };
    await checkSchema('slot', 'slot' in update ? update.slot : 0, 'slot');
    if (kind === 'value' || kind === 'external_object') {
      const field = kind === 'value' ? 'value' : 'external_object';
      const valid = isRecord(value) && hasOnly(value, ['oid', field]) && 'oid' in value && field in value;
      addCheck(shapeCheck(`${kind} shape`, `An object with oid and ${field}, and no other fields.`, valid,
        `${kind} must contain oid and ${field}.`, target));
      if (valid) {
        await checkSchema('fqoid', value.oid, `${kind}.oid`);
        await checkSchema(kind === 'value' ? 'value' : 'external_object_payload', value[field], `${kind}.${field}`);
      }
    } else if (kind === 'device_component') {
      const componentKinds = ['device', 'param', 'shared_constraint', 'menu', 'command', 'language_pack'];
      const valid = isRecord(value) && hasOnly(value, componentKinds)
        && componentKinds.filter(key => key in value).length === 1;
      addCheck(shapeCheck('Device component shape', `An object with exactly one of: ${componentKinds.join(', ')}.`, valid,
        'device_component must contain exactly one recognized component.', target));
      if (valid) {
        for (const result of await validateDeviceComponentEvent(value, typeof update.slot === 'number' ? update.slot : 0)) {
          addCheck(result, `${kind}.${Object.keys(value)[0]}`);
        }
      }
    } else if (kind === 'trap_message') {
      const valid = isRecord(value) && hasOnly(value, ['type', 'trap_data'])
        && (!('trap_data' in value) || (Array.isArray(value.trap_data) && value.trap_data.every(item => typeof item === 'string')));
      addCheck(shapeCheck('Trap message shape', 'An object with only type (defaults to 0) and optional trap_data (an array of strings).', valid,
        'trap_message must contain a valid type and string trap_data.', target));
      if (valid) {
        await checkSchema('trap_message_type', 'type' in value ? value.type : 0, 'trap_message.type');
      }
    } else if (kind === 'slots_added' || kind === 'slots_removed') {
      await checkSchema('slot_list', value);
    } else if (kind === 'remove_device_components') {
      await checkSchema('push_remove_device_components', { remove_device_components: value });
    } else if (kind === 'refused') {
      await checkSchema('exception', value);
    } else if (kind === 'invalidate_device_model') {
      await checkSchema('push_invalidate_device_model', { invalidate_device_model: value });
    } else {
      addCheck(shapeCheck('Invalidated external object ID', 'A string.', typeof value === 'string',
        'invalidated_external_object_id must be a string.', target));
    }
  }
  const ok = results.every(result => result.ok);
  return {
    schema: 'push_updates', ran: true, ok,
    note: ok ? `${updates.length} update(s) validated` : 'PushUpdates validation failed',
    results
  };
}

type EndpointResponse = {
  protocol: 'rest' | 'grpc';
  method: string;
  endpoint: string;
  status: number;
  payload: unknown;
  isStream?: boolean;
  paramInfoScope?: ParamInfoScope;
};

function isSuccessfulResponse(input: EndpointResponse): boolean {
  return input.protocol === 'rest' ? input.status >= 200 && input.status < 300 : input.status === 0;
}

export async function validateEndpointResponse(input: EndpointResponse): Promise<ResponseValidation> {
  const validation = await validateResponseBody(input);
  if (!input.paramInfoScope || !isSuccessfulResponse(input) || !Array.isArray(input.payload)) return validation;

  const scope = validateParamInfoScope(input.payload, input.paramInfoScope);
  return {
    ...validation,
    ran: true,
    ok: validation.ok && scope.ok,
    note: scope.ok ? validation.note : 'parameter metadata did not match the requested recursive scope',
    results: [...validation.results, scope]
  };
}

async function validateResponseBody(input: EndpointResponse): Promise<ResponseValidation> {
  const successful = isSuccessfulResponse(input);
  if (successful && input.isStream && (input.payload === undefined || input.payload === null)) {
    return { schema: null, ran: false, ok: true, note: 'The stream opened, but returned no event body to validate.', results: [] };
  }
  if (successful && input.isStream && Array.isArray(input.payload) && input.payload.length === 0) {
    return { schema: null, ran: false, ok: true, note: 'The stream opened, but returned no event body to validate.', results: [] };
  }

  if (successful && input.isStream && (
    (input.protocol === 'rest' && /\/connect(?:\?|$)/.test(input.endpoint))
    || (input.protocol === 'grpc' && input.method.replace(/^CatenaService\./, '') === 'Connect')
  )) {
    return validatePushUpdates(input.payload, input.protocol);
  }

  if (input.protocol === 'rest' && input.isStream && !/\/param-info\//.test(input.endpoint)
    && /\/\d+\/stream(?:\?|$)/.test(input.endpoint)) {
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