import axios, { AxiosInstance } from 'axios';
import { isDeepStrictEqual } from 'util';
import { runSt2138ValidateResponse, St2138ValidateResult } from '../validation/st2138-cli-validator';
import { validateEndpointResponse } from './response-validation';
import { streamCollector, grpcDeadline } from '../security/device-transport';

type DeviceMember = {
  path: string;
  type: string;
  readOnly: boolean;
  descriptor: Record<string, any>;
  constraint?: Record<string, any>;
};

type CheckStep = {
  name: string;
  ok: boolean;
  transportOk: boolean;
  status: number | null;
  request: unknown;
  response: unknown;
  validation?: St2138ValidateResult;
  error?: string;
  warning?: string;
};

type ValueCall = CheckStep & { value?: unknown };

function collectMembers(model: any): DeviceMember[] {
  const members: DeviceMember[] = [];
  function walk(params: unknown, prefix = '', parentReadOnly = false): void {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    for (const [name, value] of Object.entries(params)) {
      if (!value || typeof value !== 'object') continue;
      const descriptor = value as Record<string, any>;
      const path = prefix ? `${prefix}/${name}` : name;
      const reference = descriptor.constraint?.ref_oid;
      members.push({
        path,
        type: String(descriptor.type || 'UNKNOWN'),
        readOnly: parentReadOnly || descriptor.read_only !== false,
        descriptor,
        constraint: reference ? model?.constraints?.[reference] : descriptor.constraint
      });
      if (String(descriptor.type || '').toUpperCase() === 'STRUCT') {
        walk(descriptor.params, path, parentReadOnly || descriptor.read_only !== false);
      }
    }
  }
  walk(model?.params);
  return members;
}

function bumpValue(value: any, maxLength?: number): { changed: boolean; value: any } {
  if (Array.isArray(value)) {
    if (!value.length) return { changed: false, value };
    const next = bumpValue(value[0], maxLength);
    return next.changed ? { changed: true, value: [next.value, ...value.slice(1)] } : { changed: false, value };
  }
  if (!value || typeof value !== 'object') return { changed: false, value };

  for (const [key, child] of Object.entries(value)) {
    if (key === 'int32_value' && typeof child === 'number' && Number.isInteger(child)) {
      return { changed: true, value: { ...value, [key]: child < 2147483647 ? child + 1 : child - 1 } };
    }
    if (key === 'float32_value' && typeof child === 'number') {
      const candidate = child + 0.5;
      return { changed: true, value: { ...value, [key]: Number.isFinite(candidate) ? candidate : child - 0.5 } };
    }
    if (key === 'string_value' && typeof child === 'string') {
      const candidate = child.length < (maxLength ?? Number.MAX_SAFE_INTEGER)
        ? `${child}x`
        : `${child.slice(0, -1)}${child.endsWith('x') ? 'y' : 'x'}`;
      if (candidate !== child) return { changed: true, value: { ...value, [key]: candidate } };
    }
    if (key === 'bool_value' && typeof child === 'boolean') {
      return { changed: true, value: { ...value, [key]: !child } };
    }
    if ((key === 'ints' || key === 'int32_array_values') && Array.isArray(child)) {
      const values = child.length ? child.slice() : [1];
      values[0] = values[0] + 1;
      return { changed: true, value: { ...value, [key]: values } };
    }
    if ((key === 'floats' || key === 'float32_array_values') && Array.isArray(child)) {
      const values = child.length ? child.slice() : [0.5];
      values[0] = values[0] + 0.5;
      return { changed: true, value: { ...value, [key]: values } };
    }
    if ((key === 'strings' || key === 'string_array_values') && Array.isArray(child)) {
      const values = child.length ? child.slice() : ['test'];
      values[0] = `${values[0]}x`;
      return { changed: true, value: { ...value, [key]: values } };
    }
    if (key === 'int32_array_values' || key === 'float32_array_values') {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const nested = bumpValue(child, maxLength);
        if (nested.changed) return { changed: true, value: { ...value, [key]: nested.value } };
      }
      const values = Array.isArray(child) ? child.slice() : [];
      if (!values.length) values.push(key === 'int32_array_values' ? 1 : 0.5);
      else values[0] = values[0] + (key === 'int32_array_values' ? 1 : 0.5);
      return { changed: true, value: { ...value, [key]: values } };
    }
    if (key === 'string_array_values' && Array.isArray(child)) {
      const values = child.length ? child.slice() : ['test'];
      values[0] = `${values[0]}x`;
      return { changed: true, value: { ...value, [key]: values } };
    }
    const nested = bumpValue(child, maxLength);
    if (nested.changed) return { changed: true, value: { ...value, [key]: nested.value } };
  }
  return { changed: false, value };
}

function changedTestValue(member: DeviceMember, original: any): { value: unknown; canChange: boolean } {
  const constraint = member.constraint;
  const type = member.type.toUpperCase();

  if (type === 'INT32' && Array.isArray(constraint?.int32_choice?.choices)) {
    const alternative = constraint.int32_choice.choices.find((choice: any) => choice.value !== original?.int32_value);
    if (alternative) return { value: { int32_value: alternative.value }, canChange: true };
  }
  if (type === 'INT32' && constraint?.int32_range && Number.isInteger(original?.int32_value)) {
    const range = constraint.int32_range;
    const step = Math.max(1, Math.abs(Number(range.step) || 1));
    const candidate = original.int32_value + step <= range.max_value
      ? original.int32_value + step
      : original.int32_value - step;
    if (candidate >= range.min_value && candidate <= range.max_value && candidate !== original.int32_value) {
      return { value: { int32_value: candidate }, canChange: true };
    }
  }
  if (type === 'FLOAT32' && constraint?.float_range && typeof original?.float32_value === 'number') {
    const range = constraint.float_range;
    const step = Math.max(0.01, Math.abs(Number(range.step) || 0.5));
    const candidate = original.float32_value + step <= range.max_value
      ? original.float32_value + step
      : original.float32_value - step;
    if (candidate >= range.min_value && candidate <= range.max_value && candidate !== original.float32_value) {
      return { value: { float32_value: candidate }, canChange: true };
    }
  }
  if (type === 'STRING') {
    const choices = constraint?.string_choice?.choices
      || constraint?.string_string_choice?.choices?.map((choice: any) => choice.value);
    if (Array.isArray(choices)) {
      const alternative = choices.find((choice: string) => choice !== original?.string_value);
      if (alternative !== undefined) return { value: { string_value: alternative }, canChange: true };
    }
  }

  const bumped = bumpValue(original, member.descriptor.max_length);
  return bumped.changed && !isDeepStrictEqual(bumped.value, original)
    ? { value: bumped.value, canChange: true }
    : { value: original, canChange: false };
}

function summarize(checks: Array<{ ok: boolean }>) {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length
  };
}

async function validateResponse(schema: string, response: unknown): Promise<St2138ValidateResult> {
  return runSt2138ValidateResponse(schema, response);
}

async function runMemberCheck(
  member: DeviceMember,
  getValue: (stepName: string) => Promise<ValueCall>,
  setValue: (value: unknown, stepName: string) => Promise<CheckStep>
) {
  const steps: CheckStep[] = [];
  const initial = await getValue('initial-read');
  steps.push(initial);

  if (!initial.ok || initial.value === undefined || initial.value === null) {
    return {
      ...member,
      ok: false,
      outcome: 'failed' as const,
      reason: 'Initial value could not be read and validated; no SET was attempted.',
      steps
    };
  }

  const test = changedTestValue(member, initial.value);
  const write = await setValue(test.value, 'set-test-value');
  steps.push(write);
  const readBack = await getValue('read-after-set');
  steps.push(readBack);

  const readBackOk = readBack.ok && readBack.value !== undefined && readBack.value !== null;
  const changed = readBackOk && !isDeepStrictEqual(readBack.value, initial.value);
  let restored = !changed && readBackOk;

  if (!readBackOk || changed) {
    const restore = await setValue(initial.value, 'restore-original-value');
    steps.push({
      ...restore,
      warning: !readBackOk
        ? 'Post-SET GET failed; the original value was sent as a best-effort restore.'
        : 'The value changed after SET; the original value was restored.'
    });
    const confirmation = await getValue('confirm-restore');
    steps.push(confirmation);
    restored = confirmation.ok && isDeepStrictEqual(confirmation.value, initial.value);
  }

  const setterExpected = member.readOnly ? !write.transportOk : write.transportOk;
  const writeResponseValid = write.validation?.ran === true && write.validation.ok;
  const valueExpected = member.readOnly ? !changed : (test.canChange ? changed : !changed);
  const passed = setterExpected
    && (writeResponseValid || (member.readOnly && !write.transportOk))
    && valueExpected
    && ((readBack.ok && readBackOk) || restored)
    && (!changed || restored);
  let reason = 'SET and read-back matched the expected parameter behavior.';
  if (member.readOnly && !write.transportOk && !changed && readBackOk) {
    reason = 'Read-only SET was rejected; the value remained unchanged.';
  } else if (member.readOnly && write.transportOk) {
    reason = changed
      ? 'Read-only SET was accepted; the original value was restored.'
      : 'Read-only SET was accepted unexpectedly; the value stayed unchanged.';
  } else if (!write.transportOk) {
    reason = changed
      ? restored
        ? 'SET failed after changing the value; the original value was restored and verified.'
        : 'SET failed after changing the value; restore was attempted but could not be verified.'
      : 'SET failed; the value did not change.';
    if (!writeResponseValid) reason += ' The error response failed ST 2138 validation.';
  } else if (!writeResponseValid) {
    reason = 'SET response failed ST 2138 validation.';
  } else if (!readBackOk) {
    reason = restored ? 'Read-back failed; restore was attempted and verified.' : 'Read-back and restore verification failed.';
  } else if (test.canChange && !changed) {
    reason = 'SET succeeded but the value did not change.';
  } else if (changed && !restored) {
    reason = 'The original value could not be verified after restore.';
  }

  return { ...member, ok: passed, outcome: passed ? 'passed' as const : 'failed' as const, reason, changed, restored, steps };
}

function requestUrl(deviceUrl: string, slot: number, memberPath: string): string {
  const encodedPath = memberPath.split('/').map(encodeURIComponent).join('/');
  return `${deviceUrl}/st2138-api/v1/${slot}/value/${encodedPath}`;
}

async function restRead(client: AxiosInstance, url: string, name: string): Promise<ValueCall> {
  try {
    const response = await client.get(url);
    const validation = response.status >= 200 && response.status < 300
      ? await validateResponse('value', response.data)
      : await validateResponse('exception', response.data);
    const transportOk = response.status >= 200 && response.status < 300
      && response.data !== undefined && response.data !== null;
    return {
      name,
      transportOk,
      ok: transportOk && validation.ok,
      status: response.status,
      request: { method: 'GET', url },
      response: response.data,
      value: response.data,
      validation,
      ...(!transportOk ? { error: 'The device did not return a successful value.' } : !validation.ok ? { error: 'Response failed ST 2138 value validation.' } : {})
    };
  } catch (error) {
    return {
      name,
      transportOk: false,
      ok: false,
      status: null,
      request: { method: 'GET', url },
      response: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function restWrite(client: AxiosInstance, url: string, value: unknown, name: string): Promise<CheckStep> {
  try {
    const response = await client.put(url, value);
    const transportOk = response.status >= 200 && response.status < 300;
    const schema = transportOk && (response.status === 204 || response.data == null || response.data === '') ? 'empty' : transportOk ? 'value' : 'exception';
    const payload = schema === 'empty' && (response.data == null || response.data === '') ? {} : response.data;
    const validation = await validateResponse(schema, payload);
    return {
      name,
      transportOk,
      ok: validation.ok,
      status: response.status,
      request: { method: 'PUT', url, body: value },
      response: response.data,
      validation,
      ...(!validation.ok ? { error: `Response failed ST 2138 ${schema} validation.` } : {})
    };
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : undefined;
    const validation = response?.data === undefined ? undefined : await validateResponse('exception', response.data);
    return {
      name,
      transportOk: false,
      ok: validation?.ok ?? false,
      status: response?.status ?? null,
      request: { method: 'PUT', url, body: value },
      response: response?.data ?? null,
      validation,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runRestMemberChecks(client: AxiosInstance, deviceUrl: string, slot: number, model: unknown,
  onProgress?: (message: string) => void) {
  const checks = [];
  const members = collectMembers(model);
  for (const [index, member] of members.entries()) {
    if (index === 0 || index + 1 === members.length || (index + 1) % 10 === 0) {
      onProgress?.(`Checking parameter ${index + 1} of ${members.length} on slot ${slot}: ${member.path}`);
    }
    const url = requestUrl(deviceUrl, slot, member.path);
    checks.push(await runMemberCheck(
      member,
      (name) => restRead(client, url, name),
      (value, name) => restWrite(client, url, value, name)
    ));
  }
  return { summary: summarize(checks), checks };
}

function grpcCall(client: any, method: string, request: unknown): Promise<{ response: any; status: number }> {
  return new Promise((resolve, reject) => {
    client[method](request, { deadline: grpcDeadline() }, (error: any, response: any) => {
      if (error) return reject(error);
      resolve({ response, status: 0 });
    });
  });
}

function grpcStream(client: any, method: string, request: unknown): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const stream = client[method](request, { deadline: grpcDeadline() });
    const responses: any[] = [];
    stream.on('data', streamCollector(responses));
    stream.on('error', reject);
    stream.on('end', () => resolve(responses));
  });
}

function grpcErrorStatus(error: any): number | null {
  return Number.isInteger(error?.code) ? error.code : null;
}

export async function runGrpcApiChecks(client: any, slot: number, model: unknown) {
  const checks: Array<Record<string, any> & { ok: boolean }> = [];
  const metadata = [
    ['ParamInfoRequest', 'param_info_response', true],
    ['GetParam', 'component_param', false],
    ['ListLanguages', 'language_list', false],
    ['LanguagePackRequest', 'component_language_pack', false]
  ] as const;

  const record = async (method: string, request: any, schema: string, stream = false, member: Record<string, any> = {}) => {
    try {
      const raw = stream ? await grpcStream(client, method, request) : (await grpcCall(client, method, request)).response;
      const values = method === 'ListLanguages' ? raw.languages : raw;
      const list = stream ? values : [values];
      const responseValidations = await Promise.all(list.map((value: unknown) =>
        validateEndpointResponse({
          protocol: 'grpc',
          method,
          endpoint: `CatenaService.${method}`,
          status: 0,
          payload: value
        })
      ));
      const validations = responseValidations.flatMap((validation) => validation.results);
      const ok = validations.every((validation) => validation.ok);
      const validationSummary = {
        schema,
        ran: responseValidations.some((validation) => validation.ran),
        ok,
        note: ok ? `${responseValidations.length} response item(s) valid` : 'response failed ST 2138 validation',
        results: validations
      };
      checks.push({
        method,
        endpoint: `CatenaService.${method}`,
        title: method === 'GetParam' ? 'Read parameter descriptor' : method === 'ParamInfoRequest' ? 'List parameter metadata' : method === 'ListLanguages' ? 'List supported languages' : 'Read language pack',
        slot,
        isStream: stream,
        tested: true,
        status: 0,
        ok,
        note: ok ? (stream ? `${values.length} response(s) validated` : 'response validated') : 'response failed ST 2138 validation',
        requestPreview: JSON.stringify(request, null, 2),
        responsePreview: JSON.stringify(raw, null, 2),
        validation: validationSummary,
        manualRequest: request,
        operation: method === 'GetParam' || method === 'ParamInfoRequest' || method === 'ListLanguages' || method === 'LanguagePackRequest' ? 'READ' : undefined,
        ...member
      });
    } catch (error) {
      const exception = {
        type: String((error as any)?.codeName || (error as any)?.code || 'RpcError'),
        details: error instanceof Error ? error.message : String(error)
      };
      const exceptionValidation = await validateResponse('exception', exception);
      checks.push({
        method,
        endpoint: `CatenaService.${method}`,
        title: method === 'GetParam' ? 'Read parameter descriptor' : method === 'ParamInfoRequest' ? 'List parameter metadata' : method === 'ListLanguages' ? 'List supported languages' : 'Read language pack',
        slot,
        isStream: stream,
        tested: true,
        status: grpcErrorStatus(error) ?? 0,
        ok: false,
        note: error instanceof Error ? error.message : String(error),
        requestPreview: JSON.stringify(request, null, 2),
        responsePreview: JSON.stringify(exception, null, 2),
        validation: {
          schema: 'exception',
          ran: true,
          ok: exceptionValidation.ok,
          note: exceptionValidation.stdout,
          results: [exceptionValidation]
        },
        ...member
      });
    }
  };

  await record('ParamInfoRequest', { slot, oid_prefix: '', recursive: true }, metadata[0][1], true);
  for (const member of collectMembers(model)) {
    await record('GetParam', { slot, oid: member.path }, metadata[1][1], false, {
      memberType: 'Parameter', oid: member.path, operation: 'READ'
    });
  }

  let languages: string[] = [];
  try {
    const { response } = await grpcCall(client, 'ListLanguages', { slot });
    languages = Array.isArray(response?.languages) ? response.languages : [];
    const validation = await validateEndpointResponse({
      protocol: 'grpc', method: 'ListLanguages', endpoint: 'CatenaService.ListLanguages',
      status: 0, payload: languages
    });
    checks.push({
      method: 'ListLanguages', endpoint: 'CatenaService.ListLanguages', title: 'List supported languages',
      slot, isStream: false, tested: true, status: 0, ok: validation.ok,
      note: validation.ok ? `${languages.length} language(s) validated` : 'response failed ST 2138 language-list validation',
      requestPreview: JSON.stringify({ slot }, null, 2), responsePreview: JSON.stringify(response, null, 2),
      validation,
      manualRequest: { slot }, operation: 'READ', resourceGroup: 'Language packs', resourceKind: 'languages'
    });
  } catch (error) {
    const exception = {
      type: String((error as any)?.codeName || (error as any)?.code || 'RpcError'),
      details: error instanceof Error ? error.message : String(error)
    };
    const exceptionValidation = await validateResponse('exception', exception);
    checks.push({
      method: 'ListLanguages', endpoint: 'CatenaService.ListLanguages', title: 'List supported languages',
      slot, isStream: false, tested: true, status: grpcErrorStatus(error) ?? 0, ok: false,
      note: error instanceof Error ? error.message : String(error), requestPreview: JSON.stringify({ slot }, null, 2),
      responsePreview: JSON.stringify(exception, null, 2),
      validation: { schema: 'exception', ran: true, ok: exceptionValidation.ok, note: exceptionValidation.stdout, results: [exceptionValidation] },
      manualRequest: { slot },
      operation: 'READ', resourceGroup: 'Language packs', resourceKind: 'languages'
    });
  }

  for (const language of languages) {
    await record('LanguagePackRequest', { slot, language }, metadata[3][1], false, {
      operation: 'READ', resourceGroup: 'Language packs', resourceKey: language, resourceKind: 'language-pack'
    });
  }

  return { summary: summarize(checks), checks };
}

export async function runGrpcMemberChecks(client: any, slot: number, model: unknown,
  onProgress?: (message: string) => void) {
  const checks = [];
  const members = collectMembers(model);
  for (const [index, member] of members.entries()) {
    if (index === 0 || index + 1 === members.length || (index + 1) % 10 === 0) {
      onProgress?.(`Checking parameter ${index + 1} of ${members.length} on slot ${slot}: ${member.path}`);
    }
    const getValue = async (name: string): Promise<ValueCall> => {
      const request = { slot, oid: member.path };
      try {
        const { response } = await grpcCall(client, 'GetValue', request);
        const validation = await validateResponse('value', response);
        return {
          name, transportOk: true, ok: validation.ok, status: 0,
          request: { method: 'CatenaService.GetValue', payload: request }, response, value: response, validation,
          ...(!validation.ok ? { error: 'Response failed ST 2138 value validation.' } : {})
        };
      } catch (error) {
        const exception = {
          type: String((error as any)?.codeName || (error as any)?.code || 'RpcError'),
          details: error instanceof Error ? error.message : String(error)
        };
        const validation = await validateResponse('exception', exception);
        return {
          name, transportOk: false, ok: false, status: grpcErrorStatus(error),
          request: { method: 'CatenaService.GetValue', payload: request }, response: exception, validation,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };
    const setValue = async (value: unknown, name: string): Promise<CheckStep> => {
      const request = { slot, value: { oid: member.path, value } };
      try {
        const { response } = await grpcCall(client, 'SetValue', request);
        const validation = await validateResponse('empty', response ?? {});
        return {
          name, transportOk: true, ok: validation.ok, status: 0,
          request: { method: 'CatenaService.SetValue', payload: request }, response, validation,
          ...(!validation.ok ? { error: 'Response failed ST 2138 empty validation.' } : {})
        };
      } catch (error) {
        const exception = {
          type: String((error as any)?.codeName || (error as any)?.code || 'RpcError'),
          details: error instanceof Error ? error.message : String(error)
        };
        const validation = await validateResponse('exception', exception);
        return {
          name, transportOk: false, ok: false, status: grpcErrorStatus(error),
          request: { method: 'CatenaService.SetValue', payload: request }, response: exception, validation,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };
    checks.push(await runMemberCheck(member, getValue, setValue));
  }
  return { summary: summarize(checks), checks };
}