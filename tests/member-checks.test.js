const assert = require('node:assert/strict');
const test = require('node:test');
const { runRestMemberChecks } = require('../src/services/member-checks');
const { executeDeviceCommand } = require('../src/services/command-execution');
const { runGrpcMemberChecks } = require('../src/services/member-checks');
const { restoreGrpcDescriptorDefaults } = require('../src/services/device-scan');
const http = require('node:http');

const writableModel = {
  params: {
    level: { type: 'INT32', read_only: false }
  }
};

function response(status, data = null) {
  return { status, data };
}

test('does not write when the initial value cannot be read', async () => {
  let writes = 0;
  const client = {
    async get() { return response(503, { error: 'offline' }); },
    async put() { writes += 1; return response(204); }
  };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, writableModel);

  assert.equal(writes, 0);
  assert.equal(result.checks[0].ok, false);
  assert.equal(result.checks[0].steps.length, 1);
});

test('sets a different writable value and restores the original', async () => {
  const original = { int32_value: 12 };
  let currentValue = { ...original };
  let reads = 0;
  let writes = 0;
  const client = {
    async get() { reads += 1; return response(200, { ...currentValue }); },
    async put(_url, value) { writes += 1; currentValue = { ...value }; return response(204); }
  };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, writableModel);

  assert.equal(result.checks[0].ok, true);
  assert.deepEqual(result.checks[0].steps[1].request.body, { int32_value: 13 });
  assert.deepEqual(currentValue, original);
  assert.equal(reads, 3);
  assert.equal(writes, 2);
});

test('treats omitted gRPC proto3 read_only as false and restores the changed value', async () => {
  const original = { int32_value: 8 };
  let currentValue = { ...original };
  const setValues = [];
  const model = { params: { counter: { type: 'INT32', value: original } }, commands: {} };
  restoreGrpcDescriptorDefaults(model);
  const client = {
    GetValue(_request, _options, callback) { callback(null, { ...currentValue }); },
    SetValue(request, _options, callback) {
      setValues.push(request.value.value);
      currentValue = { ...request.value.value };
      callback(null, {});
    }
  };

  const result = await runGrpcMemberChecks(client, 0, model);

  assert.equal(model.params.counter.read_only, false);
  assert.equal(result.checks[0].readOnly, false);
  assert.equal(result.checks[0].ok, true);
  assert.deepEqual(setValues, [{ int32_value: 9 }, original]);
  assert.deepEqual(currentValue, original);
});

test('changes nested protobuf array values and restores each original array', async () => {
  const originals = {
    ints: { int32_array_values: { ints: [1, 2] } },
    floats: { float32_array_values: { floats: [1.5, 2.5] } }
  };
  const current = structuredClone(originals);
  const writes = [];
  const client = {
    async get(url) {
      const key = url.endsWith('/ints') ? 'ints' : 'floats';
      return response(200, structuredClone(current[key]));
    },
    async put(url, value) {
      const key = url.endsWith('/ints') ? 'ints' : 'floats';
      writes.push({ key, value: structuredClone(value) });
      current[key] = structuredClone(value);
      return response(204);
    }
  };
  const model = {
    params: {
      ints: { type: 'INT32_ARRAY', read_only: false },
      floats: { type: 'FLOAT32_ARRAY', read_only: false }
    }
  };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, model);

  assert.equal(result.summary.passed, 2);
  assert.deepEqual(current, originals);
  assert.deepEqual(writes[0].value, { int32_array_values: { ints: [2, 2] } });
  assert.deepEqual(writes[1].value, originals.ints);
  assert.deepEqual(writes[2].value, { float32_array_values: { floats: [2, 2.5] } });
  assert.deepEqual(writes[3].value, originals.floats);
});

test('restores and verifies a value changed by a failed setter', async () => {
  let currentValue = { int32_value: 12 };
  let writes = 0;
  const client = {
    async get() { return response(200, { ...currentValue }); },
    async put(_url, value) {
      writes += 1;
      currentValue = writes === 1 ? { int32_value: 99 } : { ...value };
      return writes === 1
        ? response(500, { type: 'PermissionDenied', details: 'write rejected after mutation' })
        : response(204);
    }
  };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, writableModel);
  const check = result.checks[0];

  assert.equal(check.ok, false);
  assert.deepEqual(currentValue, { int32_value: 12 });
  assert.equal(writes, 2);
  assert.equal(check.steps.at(-1).name, 'confirm-restore');
  assert.deepEqual(check.steps.at(-1).value, { int32_value: 12 });
  assert.match(check.reason, /restored and verified/);
});

test('passes a read-only member when SET is rejected and its value is unchanged', async () => {
  const original = { int32_value: 12 };
  let reads = 0;
  let writes = 0;
  const client = {
    async get() { reads += 1; return response(200, { ...original }); },
    async put() { writes += 1; return response(403, { type: 'PermissionDenied', details: 'read only' }); }
  };
  const model = { params: { locked: { type: 'INT32', read_only: true } } };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, model);

  assert.equal(result.checks[0].ok, true);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(result.checks[0].steps[1].validation.ok, true);
});

test('restores a read-only member if the device unexpectedly accepts and applies SET', async () => {
  let currentValue = { int32_value: 12 };
  let writes = 0;
  const client = {
    async get() { return response(200, { ...currentValue }); },
    async put(_url, value) {
      writes += 1;
      currentValue = writes === 1 ? { int32_value: 13 } : { ...value };
      return response(204);
    }
  };
  const model = { params: { locked: { type: 'INT32', read_only: true } } };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, model);

  assert.equal(result.checks[0].ok, false);
  assert.deepEqual(currentValue, { int32_value: 12 });
  assert.equal(writes, 2);
  assert.equal(result.checks[0].steps.at(-1).name, 'confirm-restore');
  assert.match(result.checks[0].reason, /original value was restored/);
});

test('attempts restoration and warns after a failed post-write read', async () => {
  let reads = 0;
  let writes = 0;
  const client = {
    async get() {
      reads += 1;
      if (reads === 2) return response(503, { error: 'temporary read failure' });
      return response(200, { int32_value: 12 });
    },
    async put(_url, value) { writes += 1; return response(204, value); }
  };

  const result = await runRestMemberChecks(client, 'http://device.test', 1, writableModel);
  const check = result.checks[0];

  assert.equal(check.ok, false);
  assert.equal(reads, 3);
  assert.equal(writes, 2);
  assert.match(check.steps[3].warning, /best-effort restore/);
  assert.equal(check.steps.at(-1).name, 'confirm-restore');
});

test('runs a REST command only through the explicit command executor', async (context) => {
  let received = null;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received = { method: request.method, url: request.url, body: body ? JSON.parse(body) : null };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ response: { string_value: 'command completed' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const port = server.address().port;
  const result = await executeDeviceCommand({
    protocol: 'rest',
    url: `http://127.0.0.1:${port}`,
    slot: 4,
    oid: 'start',
    body: { int32_value: 2 }
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.response.string_value, 'command completed');
  assert.deepEqual(received, {
    method: 'POST',
    url: '/st2138-api/v1/4/command/start?respond=true',
    body: { int32_value: 2 }
  });
});