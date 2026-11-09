const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('node:path');
const { Readable } = require('node:stream');
const { runEndpointAudit } = require('../src/openapi/endpoint-audit');
const { executeEndpoint } = require('../src/openapi/endpoint-audit');
const { runManualEndpoint } = require('../src/services/manual-endpoint');
const { validateEndpointResponse } = require('../src/services/response-validation');
const { scanRestDevice, grpcComponentsToDeviceModel, validateGrpcComponents } = require('../src/services/device-scan');
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
        data: { oid: 'audio/meter', param: { type: 'FLOAT32' } },
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
});

test('uses the protobuf ParamInfo shape for gRPC but the OpenAPI schema for REST', async () => {
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
  assert.equal(restResult.ok, false);
  assert.equal(restResult.schema, 'param_info_response');
  assert.match(restResult.results[0].stdout, /required property 'param'/);
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