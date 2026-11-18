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
const { validateEndpointResponse } = require('../src/services/response-validation');
const { responseValidationOutput, validationDiagnostics } = require('../src/ui/validation.js');
const { renderReport } = require('../src/ui/render.js');
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