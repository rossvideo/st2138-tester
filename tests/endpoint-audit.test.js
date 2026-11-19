const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const http2 = require('node:http2');
const fs = require('node:fs');
const axios = require('axios');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('node:path');
const { Readable } = require('node:stream');
const { runEndpointAudit } = require('../src/openapi/endpoint-audit');
const { executeEndpoint } = require('../src/openapi/endpoint-audit');
const { runManualEndpoint } = require('../src/services/manual-endpoint');
const { collectComponents, runGrpcApiChecks } = require('../src/services/member-checks');
const { validateEndpointResponse } = require('../src/services/response-validation');
const { responseValidationOutput, validationDiagnostics } = require('../src/ui/validation.js');
const { renderReport } = require('../src/ui/render.js');
const { bindCommandRunner } = require('../src/ui/commands.js');
const { scanRestDevice, scanGrpcDevice, grpcComponentsToDeviceModel, validateGrpcComponents } = require('../src/services/device-scan');
const { executeDeviceCommand } = require('../src/services/command-execution');
const { configureDeviceTransport } = require('../src/security/device-transport');

test('normalizes the ST 2138 Syslog alarm enum names for schema validation', async () => {
  const severities = ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFORMATIONAL', 'DEBUG'];
  const component = {
    shared_constraint: {
      oid: 'alarms',
      constraint: {
        type: 'ALARM_TABLE',
        alarm_table: {
          alarms: severities.map((severity, bit_value) => ({
            bit_value,
            severity,
            description: { display_strings: { en: `${severity} alarm` } }
          }))
        }
      }
    }
  };
  const model = grpcComponentsToDeviceModel(1, [component]);

  assert.deepEqual(
    model.constraints.alarms.alarm_table.alarms.map(alarm => alarm.severity),
    [0, 1, 2, 3, 4, 5, 6, 7]
  );
  const validation = await validateGrpcComponents([component], { ok: true });
  assert.equal(validation.ok, true);
});

test('audits member routes against a concrete FQOID and tags CRUD operations', async () => {
  const requests = [];
  const client = {
    defaults: { headers: {} },
    async request(options) {
      requests.push(options);
      return {
        status: 200,
        data: { oid: 'meter', param: { type: 'FLOAT32' } },
        config: { headers: {} },
        headers: {}
      };
    }
  };
  const endpoints = [
    { pathTemplate: '/{slot}/param/{fqoid}', method: 'GET', isStream: false, operationId: 'Param' },
    { pathTemplate: '/{slot}/value/{fqoid}', method: 'PUT', isStream: false, operationId: 'SetValue' }
  ];

  const results = await runEndpointAudit(client, endpoints, {
    deviceUrl: 'http://device.test',
    apiPrefix: '/st2138-api/v1',
    sampleSlot: 5,
    sampleLanguageCode: 'en',
    fqoid: 'audio/meter',
    memberType: 'Parameter'
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://device.test/st2138-api/v1/5/param/audio/meter');
  assert.equal(results[0].memberType, 'Parameter');
  assert.equal(results[0].oid, 'audio/meter');
  assert.equal(results[0].operation, 'READ');
  assert.equal(results[0].tested, true);
  assert.equal(results[0].validation.schema, 'component_param');
  assert.equal(results[0].validation.ok, true);
  assert.equal(results[1].operation, 'UPDATE');
  assert.equal(results[1].tested, false);
});

test('GetComponent audits each discovered kind over REST and gRPC', async () => {
  const model = {
    params: { audio: { type: 'STRUCT', params: { meter: { type: 'FLOAT32' } } } },
    commands: { play: { type: 'EMPTY' } },
    constraints: { range: { type: 'INT_RANGE', int32_range: { min_value: 0, max_value: 2 } } },
    menu_groups: { main: { menus: { settings: {} } } },
    language_packs: { packs: { en: { name: 'English' } } }
  };
  const components = collectComponents(model, ['en', 'fr']);
  assert.deepEqual(components.map(({ kind, oid }) => [kind, oid]), [
    ['PARAM', 'audio'], ['PARAM', 'audio/meter'], ['COMMAND', 'play'], ['CONSTRAINT', 'range'],
    ['MENU', 'main/settings'], ['LANGUAGE_PACK', 'en'], ['LANGUAGE_PACK', 'fr']
  ]);
  const response = ({ kind, oid }) => {
    const id = oid.split('/').at(-1);
    if (kind === 'PARAM') return { param: { oid: id, param: { type: 'FLOAT32' } } };
    if (kind === 'COMMAND') return { command: { oid: id, command: { type: 'EMPTY', response: false } } };
    if (kind === 'CONSTRAINT') return { shared_constraint: { oid: id, constraint: model.constraints.range } };
    if (kind === 'MENU') return { menu: { oid, menu: {} } };
    return { language_pack: { language: oid, language_pack: { name: oid } } };
  };
  const endpoint = { pathTemplate: '/{slot}/component/{kind}/{fqoid}', method: 'GET', isStream: false, operationId: 'Component' };
  const restRequests = [];
  const restClient = {
    async request({ url }) {
      restRequests.push(new URL(url).pathname);
      const [kind, ...parts] = new URL(url).pathname.split('/component/')[1].split('/');
      return { status: 200, data: response({ kind, oid: parts.join('/') }) };
    }
  };
  const rest = [];
  for (const component of components) {
    rest.push(...await runEndpointAudit(restClient, [endpoint], {
      deviceUrl: 'http://device.test', apiPrefix: '/st2138-api/v1', sampleSlot: 2,
      sampleLanguageCode: '', fqoid: component.oid, componentKind: component.kind, memberType: component.memberType
    }));
  }
  assert.deepEqual(restRequests, components.map(({ kind, oid }) => `/st2138-api/v1/2/component/${kind}/${oid}`));
  assert(rest.every(check => check.validation.schema === 'component_response' && check.tested));
  assert.deepEqual(rest.filter(check => !check.ok).map(check => ({ endpoint: check.endpoint, validation: check.validation })), []);
  assert.equal(rest.find(check => check.memberType === 'Command').componentCommandType, 'EMPTY');

  const grpcRequests = [];
  const client = {
    ParamInfoRequest() { return Readable.from([]); },
    GetParam({ oid }, _options, callback) { callback(null, { oid: oid.split('/').at(-1), param: { type: 'FLOAT32' } }); },
    ListLanguages(_request, _options, callback) { callback(null, { languages: ['en', 'fr'] }); },
    LanguagePackRequest({ language }, _options, callback) { callback(null, { language, language_pack: { name: language } }); },
    GetComponent(request, _options, callback) { grpcRequests.push(request); callback(null, response(request)); }
  };
  const grpcChecks = (await runGrpcApiChecks(client, 2, model)).checks.filter(check => check.method === 'GetComponent');
  assert.deepEqual(grpcRequests, components.map(({ kind, oid }) => ({ slot: 2, kind, oid })));
  assert(grpcChecks.every(check => check.validation.schema === 'component_response'));
  assert.deepEqual(grpcChecks.filter(check => !check.ok).map(check => ({ request: check.manualRequest, validation: check.validation })), []);
  assert.equal(grpcChecks.find(check => check.memberType === 'Command').componentCommandType, 'EMPTY');
});

test('GetComponent validates the response schema and requested component for both protocols', async () => {
  for (const protocol of ['rest', 'grpc']) {
    const base = protocol === 'rest'
      ? { method: 'GET', endpoint: '/st2138-api/v1/1/component/PARAM/audio/meter', status: 200 }
      : { method: 'GetComponent', endpoint: 'CatenaService.GetComponent', status: 0, componentRequest: { kind: 'PARAM', oid: 'audio/meter' } };
    const validate = payload => validateEndpointResponse({ protocol, ...base, payload });
    const valid = await validate({ param: { oid: 'meter', param: { type: 'FLOAT32' } } });
    assert.equal(valid.schema, 'component_response');
    assert.equal(valid.ok, true);
    assert.equal((await validate({ menu: { oid: 'audio/meter', menu: {} } })).ok, false);
    assert.equal((await validate({ param: { oid: 'other', param: { type: 'FLOAT32' } } })).ok, false);
    const fullOid = await validate({ param: { oid: 'audio/meter', param: { type: 'FLOAT32' } } });
    assert.equal(fullOid.ok, false);
    assert.match(fullOid.results[0].stdout, /must match pattern/);
    assert.equal((await validate({ param: { oid: 'meter' } })).ok, false);
    assert.equal((await validate(null)).ok, false);
  }
  const grpcCommand = await validateEndpointResponse({
    protocol: 'grpc', method: 'GetComponent', endpoint: 'CatenaService.GetComponent', status: 0,
    componentRequest: { kind: 'COMMAND', oid: 'play' },
    payload: { command: { oid: 'play', command: { type: 'EMPTY' } } }
  });
  assert.equal(grpcCommand.ok, true);
});

test('REST audits both recursive modes for slot and member metadata streams', async () => {
  const requests = [];
  const client = {
    async request({ url }) {
      const { pathname, search, searchParams } = new URL(url);
      requests.push(pathname + search);
      const member = pathname.endsWith('/audio/stream');
      const recursive = searchParams.has('recursive');
      // Simulate a device that honors the flag slot-wide but ignores it for one member.
      const oids = recursive && !member ? ['audio', 'audio/meter'] : ['audio'];
      return {
        status: 200,
        data: Readable.from(oids.map(oid => `data: ${JSON.stringify({ info: { oid, type: oid === 'audio' ? 'STRUCT' : 'FLOAT32' } })}\n\n`))
      };
    }
  };
  const ctx = {
    deviceUrl: 'http://device.test', apiPrefix: '/st2138-api/v1', sampleSlot: 1,
    sampleLanguageCode: '', knownParamOids: ['audio', 'audio/meter']
  };
  const slot = await runEndpointAudit(client, [
    { pathTemplate: '/{slot}/param-info/stream', method: 'GET', isStream: true }
  ], ctx);
  const member = await runEndpointAudit(client, [
    { pathTemplate: '/{slot}/param-info/{fqoid}/stream', method: 'GET', isStream: true }
  ], { ...ctx, fqoid: 'audio' });

  assert.deepEqual(requests, [
    '/st2138-api/v1/1/param-info/stream',
    '/st2138-api/v1/1/param-info/stream?recursive=true',
    '/st2138-api/v1/1/param-info/audio/stream',
    '/st2138-api/v1/1/param-info/audio/stream?recursive=true'
  ]);
  assert.deepEqual([...slot, ...member].map(({ recursive, ok }) => [recursive, ok]),
    [[false, true], [true, true], [false, true], [true, false]]);
  assert.match(slot[1].responsePreview, /audio\/meter/);
  assert.match(member[1].validation.results.at(-1).stdout, /Missing OIDs: audio\/meter/);
});

test('gRPC audits both recursive modes and rejects descendants returned with the flag off', async () => {
  const requests = [];
  const model = { params: { audio: { type: 'STRUCT', params: { meter: { type: 'FLOAT32' } } } } };
  const client = {
    ParamInfoRequest(request) {
      requests.push(request);
      const { oid_prefix: prefix, recursive } = request;
      const oids = prefix === 'audio/meter' ? [prefix]
        : recursive || !prefix ? ['audio', 'audio/meter'] : ['audio'];
      return Readable.from(oids.map(oid => ({ info: { oid, type: oid === 'audio' ? 'STRUCT' : 'FLOAT32' } })));
    },
    GetParam({ oid }, _options, callback) {
      callback(null, { oid: oid.split('/').at(-1), param: { type: 'FLOAT32' } });
    },
    ListLanguages(_request, _options, callback) {
      callback(null, { languages: [] });
    }
  };
  const { checks } = await runGrpcApiChecks(client, 1, model);
  const streams = checks.filter(check => check.method === 'ParamInfoRequest');
  assert.deepEqual(requests, ['', 'audio', 'audio/meter'].flatMap(oid_prefix =>
    [false, true].map(recursive => ({ slot: 1, oid_prefix, recursive }))));
  assert.deepEqual(streams.map(check => check.ok), [false, true, true, true, true, true]);
  assert.deepEqual(streams.map(check => check.manualRequest), requests);
  assert.match(streams[0].validation.results.at(-1).stdout, /Out-of-scope OIDs: audio\/meter/);
});

test('manual REST metadata requests fail the same scope check as the audit', async (context) => {
  const server = http.createServer((request, response) => {
    const recursive = new URL(request.url, 'http://localhost').searchParams.has('recursive');
    const oids = recursive ? ['audio', 'audio/meter'] : ['counter'];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(oids.map(oid => `data: ${JSON.stringify({ info: { oid, type: 'FLOAT32' } })}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const knownParamOids = ['audio', 'audio/meter'];
  const [audit] = await runEndpointAudit(axios, [
    { pathTemplate: '/{slot}/param-info/stream', method: 'GET', isStream: true }
  ], {
    deviceUrl: url, apiPrefix: '/st2138-api/v1', sampleSlot: 0, sampleLanguageCode: '', knownParamOids
  });
  const input = {
    protocol: 'rest', url, method: 'GET', endpoint: audit.endpoint, slot: 0, isStream: true, knownParamOids
  };
  const manual = await runManualEndpoint(input);
  assert.equal(audit.ok, false);
  assert.deepEqual(manual.validation, audit.validation);
  assert.equal(manual.ok, false);
  assert.match(manual.validation.results.at(-1).stdout, /Missing OIDs: audio\./);

  const staleReport = await runManualEndpoint({ ...input, knownParamOids: undefined });
  assert.equal(staleReport.ok, false);
  assert.match(staleReport.error, /Refresh the page and run a new scan/);

  const recursive = await runManualEndpoint({ ...input, endpoint: `${input.endpoint}?recursive=false` });
  assert.equal(recursive.ok, true);
});

test('validates manual endpoint responses against their ST 2138 schema', async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url.endsWith('/health')) {
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ unexpected: true }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}`;

  const health = await runManualEndpoint({
    protocol: 'rest', url, method: 'GET', endpoint: '/st2138-api/v1/health', slot: null
  });
  const invalidDescriptor = await runManualEndpoint({
    protocol: 'rest', url, method: 'GET', endpoint: '/st2138-api/v1/1/param/level', slot: 1
  });

  assert.equal(health.ok, true);
  assert.equal(health.validation.schema, 'empty');
  assert.equal(health.validation.ok, true);
  assert.equal(invalidDescriptor.ok, false);
  assert.equal(invalidDescriptor.validation.schema, 'component_param');
  assert.equal(invalidDescriptor.validation.ok, false);
});

test('Read Param validates the complete response against component_param', async () => {
  for (const protocol of ['rest', 'grpc']) {
    const validate = payload => validateEndpointResponse({
      protocol, method: protocol === 'rest' ? 'GET' : 'GetParam',
      endpoint: protocol === 'rest' ? '/st2138-api/v1/1/param/level' : 'CatenaService.GetParam',
      status: protocol === 'rest' ? 200 : 0, payload
    });
    const valid = await validate({ oid: 'level', param: { type: 'FLOAT32' } });
    assert.equal(valid.ok, true);
    assert.equal(valid.results.length, 1);
    assert.equal(valid.results[0].test.name, 'component_param');
    assert.equal(valid.results[0].test.kind, 'JSON Schema');
    assert.deepEqual(responseValidationOutput(valid).diagnostics, [
      'Applying schema "component_param" to response\n✅ Passed'
    ]);
    for (const payload of [
      { oid: 'level' },
      { oid: 'level', param: { type: 'INVALID' } },
      { oid: 'level', param: { type: 'FLOAT32' }, extra: true },
      { oid: 'audio/level', param: { type: 'FLOAT32' } }
    ]) {
      const invalid = await validate(payload);
      assert.equal(invalid.ok, false);
      assert.equal(invalid.results[0].exitCode, 2);
      assert.match(responseValidationOutput(invalid).diagnostics[0], /Applying schema "component_param" to response\n❌ Failed\nERROR:/);
    }
  }
});

test('validates automatic endpoint responses and captures an SSE event', async () => {
  const responseClient = {
    defaults: { headers: {} },
    async request() {
      return { status: 200, data: { unexpected: true }, config: { headers: {} }, headers: {} };
    }
  };
  const invalidHealth = await executeEndpoint(responseClient, 'http://device.test/st2138-api/v1/health', {
    method: 'GET', isStream: false, pathTemplate: '/health'
  });
  assert.equal(invalidHealth.ok, false);
  assert.equal(invalidHealth.validation.schema, 'empty');
  assert.equal(invalidHealth.validation.ok, false);

  const streamClient = {
    defaults: { headers: {} },
    async request() {
      return {
        status: 200,
        data: Readable.from(['data: {"unexpected":true}\n\n']),
        config: { headers: {} },
        headers: {}
      };
    }
  };
  const invalidStream = await executeEndpoint(streamClient, 'http://device.test/st2138-api/v1/1/stream', {
    method: 'GET', isStream: true, pathTemplate: '/{slot}/stream'
  });
  assert.equal(invalidStream.validation.schema, 'device_component');
  assert.equal(invalidStream.validation.ran, true);
  assert.equal(invalidStream.validation.ok, false);
});

test('Connect skips SSE heartbeats and validates actual update fields', async () => {
    const client = {
      defaults: { headers: {} },
      async request() {
        return {
          status: 200, data: Readable.from([': keepalive\n\n', 'data: {"slot":0,"slots_added":{"slots":[0,1]}}\n\n']),
          config: { headers: {} }, headers: { 'content-type': 'text/event-stream' }
        };
      }
    };
    const result = await executeEndpoint(client, 'http://device.test/st2138-api/v1/connect', {
      method: 'GET', isStream: true, pathTemplate: '/connect'
    });
    assert.equal(result.ok, true);
    assert.equal(result.validation.schema, 'push_updates');
    assert.match(result.responsePreview, /slots_added/);
    assert.match(result.validation.results[0].stdout, /Applying schema 'push_updates' to response/);
    for (const payload of [
      { slot: 0, slots_added: { slots: [-1] } },
      { slot: 0, value: { oid: 'counter', value: { int32_value: 1 } }, slots_added: { slots: [0] } },
      { slot: 0, value: { oid: '?invalid', value: { int32_value: 1 } } },
      { slot: 0, value: { oid: 'counter', value: { unknown: 1 } } },
      { slot: null, slots_added: { slots: [0] } },
      { slot: 0, device_component: { device: {}, param: {} } },
      { slots_added: { slots: [0] } }
    ]) {
      const validation = await validateEndpointResponse({
        protocol: 'rest', method: 'GET', endpoint: '/st2138-api/v1/connect',
        status: 200, payload: [payload], isStream: true
      });
      assert.equal(validation.ok, false);
    }
    const grpcDefaultSlot = await validateEndpointResponse({
      protocol: 'grpc', method: 'Connect', endpoint: 'CatenaService.Connect',
      status: 0, payload: [{ slots_added: { slots: [0] } }], isStream: true
    });
    assert.equal(grpcDefaultSlot.ok, true);
    assert.match(grpcDefaultSlot.results[0].stdout, /Applying schema 'push_updates' to response/);
    const removed = await validateEndpointResponse({
      protocol: 'grpc', method: 'Connect', endpoint: 'CatenaService.Connect',
      status: 0, payload: [{ remove_device_components: { params: { oids: ['counter'] } } }], isStream: true
    });
    assert.equal(removed.ok, true);
    const invalidRemoved = await validateEndpointResponse({
      protocol: 'grpc', method: 'Connect', endpoint: 'CatenaService.Connect',
      status: 0, payload: [{ remove_device_components: { params: { oids: ['invalid/'] } } }], isStream: true
    });
    assert.equal(invalidRemoved.ok, false);
  });

test('Connect diagnostics identify each streamed update and its shape result', async () => {
  const validation = await validateEndpointResponse({
    protocol: 'rest', method: 'GET', endpoint: '/st2138-api/v1/connect',
    status: 200, isStream: true, payload: [
      { slot: 0, value: { oid: 'counter', value: { int32_value: 1 } } },
      { slot: 0, slots_added: { slots: [-1] } },
      { slots_added: { slots: [0] } }
    ]
  });
  const { diagnostics: chunks } = JSON.parse(JSON.stringify(responseValidationOutput(validation)));
  assert.deepEqual(chunks.map(chunk => chunk.chunk), [1, 2, 3]);
  assert.match(chunks[0].result, /response chunk 1\n✅ Passed$/);
  assert.doesNotMatch(chunks[0].result, /submember/);
  assert.deepEqual(chunks[0].submembers.map(check => check.member), ['slot', 'value', 'value.oid', 'value.value']);
  assert.match(chunks[0].submembers[2].result, /Applying schema "fqoid" to submember value\.oid\n✅ Passed$/);
  assert.match(chunks[1].result, /response chunk 2\n❌ Failed\nERROR:/);
  assert.match(chunks[1].submembers[1].result, /Applying schema "slot_list" to submember slots_added\n❌ Failed\nERROR:/);
  assert.deepEqual(chunks[2].submembers, []);
  const diagnostics = validationDiagnostics(validation);
  assert.match(diagnostics[0], /^Applying schema rule "push_updates" to response chunk 1\n✅ Passed\n/);
  assert.match(diagnostics[0], /\n\n  Applying schema "fqoid" to submember value\.oid\n  ✅ Passed\n\n  Applying schema "value" to submember value\.value\n  ✅ Passed/);
  assert.doesNotMatch(diagnostics[0], /No other fields are allowed|"\$ref"/);
  assert.match(diagnostics[1], /^Applying schema rule "push_updates" to response chunk 2\n❌ Failed\n/);
  assert.match(diagnostics[1], /\n\n  Applying schema "slot_list" to submember slots_added\n  ❌ Failed\n  ERROR:/);
  assert.match(diagnostics[2], /^Applying schema rule "push_updates" to response chunk 3\n❌ Failed\nERROR:/);
  assert.doesNotMatch(diagnostics[2], /to submember/);
});

  test('REST Connect negotiates HTTP/2 and respects TLS and authorization settings', async context => {
    const key = fs.readFileSync(path.join(__dirname, 'fixtures/test-device-key.pem'));
    const cert = fs.readFileSync(path.join(__dirname, 'fixtures/test-device-cert.pem'));
    const server = http2.createSecureServer({ key, cert, allowHTTP1: false });
    const sessions = new Set();
    server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
    const authorizations = [];
    server.on('stream', (stream, headers) => {
      authorizations.push(headers.authorization);
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.write('data: {"slot":0,"slots_added":{"slots":[0]}}\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(() => {
      configureDeviceTransport();
      for (const session of sessions) session.destroy();
      server.close();
    });
    const url = `https://127.0.0.1:${server.address().port}`;
    const endpoint = '/st2138-api/v1/connect';
    configureDeviceTransport();
    const rejected = await runManualEndpoint({ protocol: 'rest', url, method: 'GET', endpoint, slot: null, isStream: true });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /certificate/i);
    configureDeviceTransport('synthetic.payload.signature', true);
    const automatic = await executeEndpoint(axios.create({
      ...require('../src/security/device-transport').restTransportOptions()
    }), `${url}${endpoint}`, { method: 'GET', isStream: true, pathTemplate: '/connect' });
    const manual = await runManualEndpoint({ protocol: 'rest', url, method: 'GET', endpoint, slot: null, isStream: true });
    assert.equal(automatic.ok, true);
    assert.equal(manual.ok, true);
    assert.deepEqual(authorizations, ['Bearer synthetic.payload.signature', 'Bearer synthetic.payload.signature']);
  });

test('Connect rejects successful responses that are not event streams', async context => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const endpoint = '/st2138-api/v1/connect';
  const automatic = await executeEndpoint(axios.create(), `${url}${endpoint}`, {
    method: 'GET', isStream: true, pathTemplate: '/connect'
  });
  const manual = await runManualEndpoint({ protocol: 'rest', url, method: 'GET', endpoint, slot: null, isStream: true });
  assert.equal(automatic.ok, false);
  assert.match(automatic.note, /text\/event-stream/);
  assert.equal(manual.ok, false);
  assert.match(manual.error, /text\/event-stream/);
});

  test('gRPC Connect is a bounded device-wide stream in manual and automatic tests', async context => {
    const protoDirectory = path.resolve(__dirname, '../vendor/st2138-a/interface/proto');
    const definition = protoLoader.loadSync(path.join(protoDirectory, 'service.proto'), {
      includeDirs: [protoDirectory], keepCase: true, longs: String, enums: String, defaults: false, oneofs: false
    });
    const service = grpc.loadPackageDefinition(definition).st2138.CatenaService;
    const server = new grpc.Server();
    const requests = [];
    server.addService(service.service, {
      GetPopulatedSlots(call, callback) { callback(null, { slots: [0] }); },
      DeviceRequest(call) { call.end(); },
      Connect(call) {
        requests.push(call.request);
        if (call.request.user_agent === 'silent') {
          call.sendMetadata(new grpc.Metadata());
          return;
        }
        call.write({ slots_added: { slots: [0] } });
      }
    });
    const port = await new Promise((resolve, reject) => server.bindAsync(
      '127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => error ? reject(error) : resolve(boundPort)
    ));
    context.after(() => server.forceShutdown());
    const url = `http://127.0.0.1:${port}`;
    const manual = await runManualEndpoint({
      protocol: 'grpc', url, method: 'READ', endpoint: 'CatenaService.Connect', slot: null, body: {}, isStream: false
    });
    assert.equal(manual.ok, true);
    assert.deepEqual(manual.response, [{ slots_added: { slots: [0] } }]);
    const report = await scanGrpcDevice(url);
    const connects = report.endpointAudit.filter(endpoint => endpoint.endpoint === 'CatenaService.Connect');
    assert.equal(connects.length, 1);
    assert.equal(connects[0].slot, null);
    assert.equal(connects[0].isStream, true);
    assert.equal(connects[0].ok, true);
    assert.deepEqual(requests, [{}, {}]);
    const silent = await runManualEndpoint({
      protocol: 'grpc', url, method: 'READ', endpoint: 'CatenaService.Connect',
      slot: null, body: { user_agent: 'silent' }
    });
    assert.equal(silent.ok, true);
    assert.equal(silent.validation.ran, false);
    assert.match(silent.validation.note, /no event body/);
  });

test('validates a language list as one ST 2138 array response', async () => {
  const result = await validateEndpointResponse({
    protocol: 'grpc',
    method: 'ListLanguages',
    endpoint: 'CatenaService.ListLanguages',
    status: 0,
    payload: ['en', 'fr']
  });

  assert.equal(result.schema, 'language_list');
  assert.equal(result.ran, true);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  const [diagnostic] = responseValidationOutput(result).diagnostics;
  assert.equal(diagnostic, 'Applying schema "language_list" to response\n✅ Passed');
  const [check] = result.results;
  const [warning] = validationDiagnostics({
    ...result,
    results: [{ ...check, stdout: check.stdout.replace('✅ Schema validation succeeded.', 'WARNING: Example warning\n✅ Schema validation succeeded.') }]
  });
  assert.equal(warning, `${diagnostic}\nWARNING: Example warning`);
});

test('shows compact validator checks and failure diagnostics in both report views', async t => {
  const endpoint = '/st2138-api/v1/1/languages';
  const validation = await validateEndpointResponse({
    protocol: 'rest', method: 'GET', endpoint, status: 200, payload: [123]
  });
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });
  renderReport({
    protocol: 'rest', deviceUrl: 'http://device.test', scannedAt: new Date().toISOString(),
    summary: { total: 1, passed: 0, failed: 1 },
    slots: [{ slot: 1, ok: false }],
    endpointAudit: [{
      endpoint, pathTemplate: '/{slot}/languages', slot: 1, method: 'GET',
      tested: true, ok: false, status: 200, validation
    }]
  });
  for (const id of ['slotResults', 'endpointAudit']) {
    const markup = elements.get(id).innerHTML;
    assert.match(markup, /<summary>Validator details<\/summary>/);
    assert.match(markup, /Applying schema &quot;language_list&quot; to response\n❌ Failed/);
    assert.doesNotMatch(markup, /\$ref|Validation failed\./);
    assert.match(markup, /must be string/);
  }
});

test('reports passing devices separately from a failing node-wide endpoint', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });
  renderReport({
    protocol: 'rest', deviceUrl: 'http://node.test', scannedAt: new Date().toISOString(),
    summary: { total: 1, passed: 1, failed: 0 },
    slots: [{ slot: 2, ok: true, model: { params: { product: { params: {
      name: { value: { string_value: 'Audio Mixer' } }
    } } } } }],
    endpointAudit: [
      { endpoint: '/health', pathTemplate: '/health', slot: null, method: 'GET', tested: true, ok: false },
      { endpoint: '/2/param-info/stream', pathTemplate: '/{slot}/param-info/stream', slot: 2, method: 'GET', tested: true, ok: true }
    ]
  });
  assert.equal(elements.get('scanOutcome').textContent, '1 of 1 device passed');
  assert.equal(elements.get('deviceEndpointSummary').textContent, '0 of 1 passed · 1 failed');
  assert.match(elements.get('slotResults').innerHTML, /Slot 2 · Audio Mixer/);
  assert.match(elements.get('endpointAudit').innerHTML, /Node-wide endpoints/);
});

test('shows GetComponent results per member kind and slot in both protocols', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });

  for (const protocol of ['rest', 'grpc']) {
    const component = (slot, memberType, oid, tested, ok) => ({
      endpoint: protocol === 'grpc' ? 'CatenaService.GetComponent'
        : `/st2138-api/v1/${slot}/component/${memberType}/${oid}`,
      pathTemplate: protocol === 'grpc' ? 'CatenaService.GetComponent' : '/{slot}/component/{kind}/{fqoid}',
      method: protocol === 'grpc' ? 'GetComponent' : 'GET',
      slot, memberType, oid, tested, ok, note: '<diagnostic>',
      requestPreview: 'request', responsePreview: '<response>'
    });
    const checks = [
      component(1, 'Parameter', 'shared', true, true),
      component(1, 'Command', 'shared', true, false),
      component(1, 'Constraint', 'range', true, true),
      component(1, 'Menu', 'main/settings', true, false),
      component(1, 'Language pack', 'en', false, false),
      { endpoint: protocol === 'grpc' ? 'CatenaService.LanguagePackRequest' : '/st2138-api/v1/1/language-pack/en',
        pathTemplate: protocol === 'grpc' ? 'CatenaService.LanguagePackRequest' : '/{slot}/language-pack/{language-code}',
        method: protocol === 'grpc' ? 'LanguagePackRequest' : 'GET', slot: 1, tested: true, ok: true,
        resourceGroup: 'Language packs', resourceKind: 'language-pack', resourceKey: 'en' },
      component(2, 'Command', 'shared', true, true)
    ];
    renderReport({
      protocol, deviceUrl: 'http://node.test', scannedAt: new Date().toISOString(),
      summary: { total: 2, passed: 1, failed: 1 },
      slots: [
        { slot: 1, ok: false, model: { commands: { shared: { type: 'EMPTY' }, missing: { type: 'EMPTY' } } },
          memberChecks: { checks: [{ path: 'shared', ok: true, steps: [] }] } },
        { slot: 2, ok: true, model: { commands: { shared: { type: 'EMPTY' } } } }
      ],
      endpointAudit: checks
    });
    const commands = elements.get('commandGroups').innerHTML;
    const first = commands.split('data-slot="1" data-oid="shared"')[1].split('</form>')[0];
    const missing = commands.split('data-slot="1" data-oid="missing"')[1].split('</form>')[0];
    const second = commands.split('data-slot="2" data-oid="shared"')[1].split('</form>')[0];
    assert.match(first, /component-status fail">[\s\S]*?<span>GetComponent<\/span><strong>FAIL<\/strong>/);
    assert.match(first, /&lt;diagnostic&gt;/);
    assert.match(first, /&lt;response&gt;/);
    assert.match(missing, /component-status not-run"><span>GetComponent<\/span><strong>NOT RUN<\/strong>/);
    assert.match(second, /component-status pass">[\s\S]*?<span>GetComponent<\/span><strong>PASS<\/strong>/);
    assert.match(elements.get('slotResults').innerHTML,
      /member-path">shared<\/span>[\s\S]*?component-status pass">[\s\S]*?GetComponent<\/span><strong>PASS<\/strong>/);

    const api = elements.get('endpointAudit').innerHTML;
    assert.doesNotMatch(api, /component-status/);
    assert.equal((api.match(/class="endpoint-result /g) || []).length, checks.length);
    assert.equal((api.match(/class="endpoint-manual-form"/g) || []).length, checks.length);
    for (const [memberType, oid, status] of [
      ['Parameter', 'shared', 'pass'], ['Command', 'shared', 'fail'], ['Constraint', 'range', 'pass'],
      ['Menu', 'main/settings', 'fail']
    ]) {
      const group = api.split(`>${memberType}</span>`)[1].split('endpoint-member-type')[0];
      assert(group.includes(`class="member-path">${oid}</span>`), `${protocol} ${memberType} member`);
      assert(group.includes(`class="endpoint-result ${status}"`), `${protocol} ${memberType} status`);
    }
    assert.doesNotMatch(api, /<summary><span>Language pack<\/span>/);
    assert.equal((api.match(/<summary><span>Language packs<\/span>/g) || []).length, 1);
    const language = api.split('class="endpoint-language-group"')[1].split('endpoint-member-type')[0];
    assert.match(language, /<summary><span>en<\/span>/);
    assert.equal((language.match(/class="endpoint-result /g) || []).length, 2);
    assert.match(language, /class="endpoint-result not-run"/);
    assert.match(language, /class="endpoint-result pass"/);
    assert(language.includes(checks[4].endpoint));
    assert(language.includes(checks[5].endpoint));
  }
});

test('uses a fixed member API check order regardless of result arrival order', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });
  for (const protocol of ['rest', 'grpc']) {
    const definitions = [
      ['GetComponent', '/component/PARAM/meter', '/component/{kind}/{fqoid}', false],
      ['ParamInfoRequest', '/param-info/meter', '/param-info/{fqoid}', false],
      ['ParamInfoRequest', '/param-info/meter/stream', '/param-info/{fqoid}/stream', true],
      ['GetParam', '/param/meter', '/param/{fqoid}', false],
      ['GetValue', '/value/meter', '/value/{fqoid}', false],
      ['SetValue', '/value/meter', '/value/{fqoid}', false]
    ];
    const checks = definitions.map(([method, path, template, isStream]) => ({
      endpoint: protocol === 'grpc' ? `CatenaService.${method}` : `/st2138-api/v1/1${path}`,
      pathTemplate: protocol === 'grpc' ? `CatenaService.${method}` : `/{slot}${template}`,
      method: protocol === 'grpc' ? `CatenaService.${method}` : method === 'SetValue' ? 'PUT' : 'GET',
      isStream, ...(isStream ? { recursive: false } : {}),
      slot: 1, oid: 'meter', memberType: 'Parameter', tested: true, ok: true
    }));
    for (const order of [[5, 3, 1, 4, 2, 0], [4, 2, 0, 5, 3, 1]]) {
      const endpointAudit = order.map(index => checks[index]);
      renderReport({
        protocol, deviceUrl: 'http://node.test', scannedAt: new Date().toISOString(),
        summary: { total: 1, passed: 1, failed: 0 }, slots: [{ slot: 1, ok: true }], endpointAudit
      });
      const forms = [...elements.get('endpointAudit').innerHTML.matchAll(
        /class="endpoint-manual-form" data-protocol="[^"]*" data-method="([^"]*)" data-endpoint="([^"]*)"[^>]*data-stream="([^"]*)"/g
      )].map(([, method, endpoint, stream]) => [method, endpoint, stream]);
      assert.deepEqual(forms, checks.map(check => [check.method, check.endpoint, String(check.isStream)]), protocol);
      assert.deepEqual(endpointAudit, order.map(index => checks[index]), 'does not reorder scan results');
    }
  }
});

test('uses consistent API card headers for metadata streams, node-wide checks and languages', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });
  for (const protocol of ['rest', 'grpc']) {
    const grpcProtocol = protocol === 'grpc';
    const entry = (rpc, path, extra = {}) => ({
      endpoint: grpcProtocol ? `CatenaService.${rpc}` : `/st2138-api/v1${path}`,
      pathTemplate: grpcProtocol ? `CatenaService.${rpc}` : path.replace('/0/', '/{slot}/'),
      method: grpcProtocol ? rpc : 'GET', tested: true, ok: true, slot: 0, ...extra
    });
    const checks = [
      entry('GetPopulatedSlots', '/devices', { slot: null }),
      entry('ParamInfoRequest', '/0/param-info/counter/stream', {
        isStream: true, recursive: false, memberType: 'Parameter', oid: 'counter'
      }),
      entry('ListLanguages', '/0/languages', { resourceGroup: 'Language packs', resourceKind: 'languages' }),
      entry('LanguagePackRequest', '/0/language-pack/en', {
        resourceGroup: 'Language packs', resourceKind: 'language-pack', resourceKey: 'en'
      })
    ];
    renderReport({
      protocol, deviceUrl: 'http://node.test', scannedAt: new Date().toISOString(),
      summary: { total: 1, passed: 1, failed: 0 }, slots: [{ slot: 0, ok: true }], endpointAudit: checks
    });
    const api = elements.get('endpointAudit').innerHTML;
    const headers = [...api.matchAll(
      /<summary><span class="endpoint-method">([^<]+)<\/span><span class="endpoint-path">([^<]+)<small>([^<]+)<\/small><\/span><strong>PASS<\/strong><\/summary>/g
    )];
    assert.equal(headers.length, 5, `${protocol}: four cards and one recursion variant`);
    for (const check of checks) {
      const header = headers.find(([, , title, path]) => path === check.endpoint && !title.startsWith('Recursive:'));
      assert(header, `${protocol}: consistent header for ${check.endpoint}`);
      assert.equal(header[1], check.method);
      assert.notEqual(header[2], check.endpoint);
      assert.doesNotMatch(header[2], /\{slot\}|\/st2138-api/);
    }
    assert.equal((api.match(/class="endpoint-manual-form"/g) || []).length, 4);
    assert.equal((api.match(/data-param-info-stream/g) || []).length, 1);
  }
});

test('hides the command body only for a matching successful EMPTY GetComponent response', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });
  for (const protocol of ['rest', 'grpc']) {
    const component = (slot, oid, type, ok = true) => ({
      endpoint: protocol === 'grpc' ? 'CatenaService.GetComponent' : `/st2138-api/v1/${slot}/component/COMMAND/${oid}`,
      pathTemplate: protocol === 'grpc' ? 'CatenaService.GetComponent' : '/{slot}/component/{kind}/{fqoid}',
      method: protocol === 'grpc' ? 'GetComponent' : 'GET', memberType: 'Command', slot, oid,
      tested: true, ok, componentCommandType: type
    });
    const commands = { empty: { type: 'STRING' }, numeric: { type: 'STRING' }, value: { type: 'EMPTY' },
      failed: { type: 'EMPTY' }, missing: { type: 'EMPTY' } };
    renderReport({
      protocol, deviceUrl: 'http://node.test', scannedAt: new Date().toISOString(),
      summary: { total: 2, passed: 1, failed: 1 },
      slots: [{ slot: 1, ok: true, model: { commands } }, { slot: 2, ok: false, model: { commands: { empty: { type: 'STRING' } } } }],
      endpointAudit: [
        component(1, 'empty', 'EMPTY'), component(1, 'numeric', 1), component(1, 'value', 'STRING'),
        component(1, 'failed', 'EMPTY', false), component(2, 'empty', 'STRING')
      ]
    });
    const html = elements.get('commandGroups').innerHTML;
    const form = (slot, oid) => html.split(`data-slot="${slot}" data-oid="${oid}"`)[1].split('</form>')[0];
    for (const oid of ['empty', 'numeric']) {
      assert.doesNotMatch(form(1, oid), /Command body|<textarea/);
      assert.match(form(1, oid), /Run command/);
    }
    for (const oid of ['value', 'failed', 'missing']) assert.match(form(1, oid), /<textarea/);
    assert.match(form(2, 'empty'), /<textarea/);
  }
});

test('runs a command without a body input', async t => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  let submit;
  let sent;
  globalThis.document = { getElementById: () => ({ addEventListener(_event, listener) { submit = listener; } }) };
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, response: {} }) };
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  const status = { dataset: {} };
  const output = { dataset: {}, hidden: true };
  const button = {};
  const form = {
    dataset: { slot: '1', oid: 'empty' },
    querySelector(selector) {
      return { '.command-body': null, '.command-status': status, '.command-response': output, 'button[type="submit"]': button }[selector];
    }
  };
  bindCommandRunner(() => ({ protocol: 'grpc', url: 'http://node.test' }));
  await submit({ target: { closest: () => form }, preventDefault() {} });
  assert.equal(Object.hasOwn(sent, 'body'), false);
  assert.equal(sent.oid, 'empty');
  assert.equal(status.textContent, 'Command completed');
  assert.equal(button.disabled, false);
});

test('nests recursive REST and gRPC checks under one stream card per target', t => {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    }
  };
  t.after(() => { globalThis.document = previous; });

  for (const protocol of ['rest', 'grpc']) {
    const grpc = protocol === 'grpc';
    const endpointAudit = [undefined, 'audio/meter'].flatMap(oid => [false, true].map(recursive => ({
      endpoint: grpc ? 'CatenaService.ParamInfoRequest'
        : `/st2138-api/v1/1/param-info/${oid ? `${oid}/` : ''}stream${recursive ? '?recursive=true' : ''}`,
      pathTemplate: grpc ? 'CatenaService.ParamInfoRequest' : `/{slot}/param-info/${oid ? '{fqoid}/' : ''}stream`,
      method: grpc ? 'ParamInfoRequest' : 'GET',
      slot: 1, oid, memberType: oid ? 'Parameter' : undefined,
      recursive, isStream: true, tested: true, ok: recursive,
      manualRequest: grpc ? { slot: 1, oid_prefix: oid ?? '', recursive } : undefined
    })));
    renderReport({
      protocol, deviceUrl: 'http://device.test', scannedAt: new Date().toISOString(),
      summary: { total: 1, passed: 0, failed: 1 }, slots: [{ slot: 1, ok: false }], endpointAudit
    });

    for (const id of ['slotResults', 'endpointAudit']) {
      const markup = elements.get(id).innerHTML;
      const [, ...groups] = markup.split('param-info-stream-group">');
      assert.equal(groups.length, 2, `${protocol} ${id}: one card per target`);
      for (const group of groups) {
        assert.match(group, /^<summary>.*<strong[^>]*>FAIL<\/strong><\/summary><div class="param-info-stream-variants">/);
        assert.deepEqual(group.match(/Recursive: (?:off|on)/g), ['Recursive: off', 'Recursive: on']);
        if (id === 'endpointAudit') {
          assert.equal(group.match(/data-param-info-stream/g).length, 2);
          if (grpc) {
            assert.match(group, /data-manual-request="[^"]+&quot;recursive&quot;:false/);
            assert.match(group, /data-manual-request="[^"]+&quot;recursive&quot;:true/);
          } else {
            assert.match(group, /data-endpoint="[^"]+\/stream"/);
            assert.match(group, /data-endpoint="[^"]+\/stream\?recursive=true"/);
          }
        }
      }
    }
  }
});

test('validates ParamInfo responses for gRPC and REST', async () => {
  const protobufResponse = {
    info: {
      oid: 'audio/meter',
      name: { display_strings: { en: 'Meter' } },
      type: 'FLOAT32'
    },
    array_length: 2
  };
  const grpcResult = await validateEndpointResponse({
    protocol: 'grpc', method: 'ParamInfoRequest', endpoint: 'CatenaService.ParamInfoRequest',
    status: 0, payload: protobufResponse
  });
  const restResult = await validateEndpointResponse({
    protocol: 'rest', method: 'GET', endpoint: '/st2138-api/v1/1/param-info/audio/meter',
    status: 200, payload: protobufResponse
  });

  assert.equal(grpcResult.ok, true);
  assert.equal(grpcResult.schema, 'protobuf ParamInfoResponse');
  const diagnostics = responseValidationOutput(grpcResult).diagnostics.join('\n');
  assert.match(diagnostics, /Applying tester rule "ParamInfoResponse shape" to response\n✅ Passed/);
  assert.match(diagnostics, /Applying schema "fqoid" to response\n✅ Passed/);
  assert.doesNotMatch(diagnostics, /An object with only info|Schema validation succeeded/);
  assert.equal(restResult.ok, true);
  assert.equal(restResult.schema, 'param_info_response');
  const invalidRest = await validateEndpointResponse({
    protocol: 'rest', method: 'GET', endpoint: '/st2138-api/v1/1/param-info/audio/meter',
    status: 200, payload: { info: { oid: 'audio/meter' } }
  });
  assert.equal(invalidRest.ok, false);
  assert.match(invalidRest.results[0].stdout, /required property 'type'/);
});

test('runs a manual gRPC endpoint and validates its response', async (context) => {
  const protoDirectory = path.resolve(__dirname, '../vendor/st2138-a/interface/proto');
  const definition = protoLoader.loadSync(path.join(protoDirectory, 'service.proto'), {
    includeDirs: [protoDirectory],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: false
  });
  const service = grpc.loadPackageDefinition(definition).st2138.CatenaService;
  const server = new grpc.Server();
  let requestReceived;
  let authorizationReceived;
  server.addService(service.service, {
    GetPopulatedSlots(request, callback) {
      requestReceived = request.request;
      authorizationReceived = request.metadata.get('authorization');
      callback(null, { slots: [0, 4] });
    },
    ParamInfoRequest(call) {
      call.write({ info: { oid: 'audio', type: 'STRUCT' } });
      call.write({ info: { oid: 'audio/meter', type: 'FLOAT32' } });
      call.end();
    },
    GetComponent(call, callback) {
      if (call.request.kind === 'CONSTRAINT') {
        callback(null, { shared_constraint: { oid: call.request.oid, constraint: {
          type: 'INT_RANGE', int32_range: { min_value: 0, max_value: 2 }
        } } });
      } else {
        callback(null, { command: { oid: call.request.oid, command: { type: 'EMPTY', response: false } } });
      }
    }
  });
  const port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });
  context.after(() => new Promise((resolve, reject) => server.tryShutdown((error) => error ? reject(error) : resolve())));

  const result = await runManualEndpoint({
    protocol: 'grpc',
    url: `http://127.0.0.1:${port}`,
    method: 'READ',
    endpoint: 'CatenaService.GetPopulatedSlots',
    slot: null,
    body: {}
  });

  assert.deepEqual(requestReceived, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.response.slots, [0, 4]);
  assert.equal(result.validation.schema, 'slot_list');
  assert.equal(result.validation.ok, true);
  assert.deepEqual(authorizationReceived, []);
  const metadataInput = {
    protocol: 'grpc', url: `http://127.0.0.1:${port}`, method: 'READ',
    endpoint: 'CatenaService.ParamInfoRequest', slot: 0,
    knownParamOids: ['audio', 'audio/meter']
  };
  const off = await runManualEndpoint({ ...metadataInput, body: { oid_prefix: 'audio', recursive: false } });
  assert.equal(off.ok, false);
  assert.match(off.validation.results.at(-1).stdout, /Out-of-scope OIDs: audio\/meter/);
  const on = await runManualEndpoint({ ...metadataInput, body: { oid_prefix: 'audio', recursive: true } });
  assert.equal(on.ok, true);
  const staleReport = await runManualEndpoint({ ...metadataInput, knownParamOids: undefined });
  assert.equal(staleReport.ok, false);
  assert.match(staleReport.error, /Refresh the page and run a new scan/);

  const component = await runManualEndpoint({
    protocol: 'grpc', url: `http://127.0.0.1:${port}`, method: 'READ',
    endpoint: 'CatenaService.GetComponent', slot: 0, body: { kind: 'COMMAND', oid: 'play' }
  });
  assert.equal(component.ok, true);
  assert.equal(component.validation.schema, 'component_response');
  const constraint = await runManualEndpoint({
    protocol: 'grpc', url: `http://127.0.0.1:${port}`, method: 'READ',
    endpoint: 'CatenaService.GetComponent', slot: 0, body: { kind: 2, oid: 'range' }
  });
  assert.equal(constraint.ok, true);
  const wrongKind = await runManualEndpoint({
    protocol: 'grpc', url: `http://127.0.0.1:${port}`, method: 'READ',
    endpoint: 'CatenaService.GetComponent', slot: 0, body: { kind: 'PARAM', oid: 'play' }
  });
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.validation.results.at(-1).stdout, /Expected PARAM component play/);

  configureDeviceTransport('synthetic.payload.signature');
  context.after(() => configureDeviceTransport());
  const authenticated = await runManualEndpoint({
    protocol: 'grpc', url: `http://127.0.0.1:${port}`, method: 'READ',
    endpoint: 'CatenaService.GetPopulatedSlots', slot: null, body: {}
  });
  assert.equal(authenticated.ok, true);
  assert.deepEqual(authorizationReceived, ['Bearer synthetic.payload.signature']);
});

test('REST discovery, model reads, API audits and commands retain optional JWT authorization', async context => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.includes('/command/')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/devices')) res.end(JSON.stringify({ slots: [1] }));
    else if (req.url.endsWith('/1')) res.end(JSON.stringify({ slot: 1, params: {}, commands: {} }));
    else if (req.url.endsWith('/languages')) res.end(JSON.stringify([]));
    else res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  configureDeviceTransport('synthetic.payload.signature');
  context.after(() => configureDeviceTransport());
  const url = `http://127.0.0.1:${server.address().port}`;
  const report = await scanRestDevice(url, { apiPrefix: '/st2138-api/v1', source: 'test',
    loadedAt: new Date().toISOString(), endpoints: [{ pathTemplate: '/devices', method: 'GET', isStream: false }] });
  const command = await executeDeviceCommand({ protocol: 'rest', url, slot: 1, oid: 'play' });
  assert.equal(command.ok, true);
  assert(requests.some(request => request.url.endsWith('/devices')));
  assert(requests.some(request => request.url.endsWith('/1')));
  assert(requests.some(request => request.url.includes('/command/')));
  assert(requests.every(request => request.authorization === 'Bearer synthetic.payload.signature'));
  assert.equal(JSON.stringify(report).includes('synthetic.payload.signature'), false);
});

test('REST scans and manual reruns exercise GetComponent even with a fallback specification', async context => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url.endsWith('/devices')) response.end(JSON.stringify({ slots: [1] }));
    else if (request.url.endsWith('/1')) response.end(JSON.stringify({
      slot: 1, params: {}, commands: { play: { type: 'EMPTY', response: false } }
    }));
    else if (request.url.endsWith('/languages')) response.end(JSON.stringify([]));
    else if (request.url.endsWith('/component/COMMAND/play')) {
      response.end(JSON.stringify({ command: { oid: 'play', command: { type: 'EMPTY', response: false } } }));
    } else response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const report = await scanRestDevice(url, {
    apiPrefix: '/st2138-api/v1', source: 'test', loadedAt: new Date().toISOString(), endpoints: []
  });
  const check = report.endpointAudit.find(item => item.endpoint.endsWith('/component/COMMAND/play'));
  assert(check);
  assert.equal(check.ok, true);
  assert.equal(check.validation.schema, 'component_response');
  assert.equal(check.componentCommandType, 'EMPTY');
  const manual = await runManualEndpoint({ protocol: 'rest', url, method: 'GET', endpoint: check.endpoint, slot: 1 });
  assert.equal(manual.ok, true);
  assert.equal(requests.filter(path => path.endsWith('/component/COMMAND/play')).length, 2);
});

test('gRPC scans retain the command type from GetComponent', async context => {
  const protoDirectory = path.resolve(__dirname, '../vendor/st2138-a/interface/proto');
  const definition = protoLoader.loadSync(path.join(protoDirectory, 'service.proto'), {
    includeDirs: [protoDirectory], keepCase: true, longs: String, enums: String, defaults: false, oneofs: false
  });
  const service = grpc.loadPackageDefinition(definition).st2138.CatenaService;
  const server = new grpc.Server();
  server.addService(service.service, {
    GetPopulatedSlots(_call, callback) { callback(null, { slots: [0] }); },
    Connect(call) { call.end(); },
    DeviceRequest(call) {
      call.write({ command: { oid: 'play', command: { type: 'EMPTY', response: false } } });
      call.end();
    },
    ParamInfoRequest(call) { call.end(); },
    ListLanguages(_call, callback) { callback(null, { languages: [] }); },
    GetComponent(call, callback) {
      callback(null, { command: { oid: call.request.oid, command: { type: 'EMPTY', response: false } } });
    }
  });
  const port = await new Promise((resolve, reject) => server.bindAsync(
    '127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => error ? reject(error) : resolve(boundPort)
  ));
  context.after(() => new Promise(resolve => server.tryShutdown(resolve)));
  const report = await scanGrpcDevice(`http://127.0.0.1:${port}`);
  const check = report.endpointAudit.find(item => item.endpoint === 'CatenaService.GetComponent' && item.oid === 'play');
  assert(check);
  assert.equal(check.ok, true);
  assert.equal(check.componentCommandType, 'EMPTY');
});

test('REST discovery reports a JWT-required error when the device returns unauthorized', async context => {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url.endsWith('/devices') ? 401 : 400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: request.url.endsWith('/devices') ? 'Unauthorized' : 'Bad Request' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  await assert.rejects(scanRestDevice(`http://127.0.0.1:${server.address().port}`), error => {
    assert.equal(error.code, 'jwt_required');
    assert.equal(error.message, 'JWT required for testing.');
    return true;
  });
});