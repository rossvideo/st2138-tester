process.env.OPERATION_IDLE_TIMEOUT_MS = '3000';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createLocalAccess } = require('../src/security/local-access');
const { createScanRoutes } = require('../src/routes/scan');

test('device operations time out only after a period with no progress', { timeout: 60000 }, async context => {
  let resolveModelRequest;
  const modelRequestStarted = new Promise(resolve => { resolveModelRequest = resolve; });
  const device = http.createServer((req, res) => {
    if (req.url === '/st2138-api/v1/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"slots":[1]}');
    } else if (req.url === '/st2138-api/v1/1') {
      resolveModelRequest();
    }
  });
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  context.after(() => { device.closeAllConnections(); device.close(); });
  const app = express();
  app.use(express.json());
  app.use('/api/v2', createScanRoutes(createLocalAccess()));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/scan/rest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${device.address().port}` })
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readNextEvent = async () => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) return JSON.parse(line);
        continue;
      }

      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };

  let modelProgress;
  while (!modelProgress) {
    const event = await readNextEvent();
    assert.ok(event, 'scan stream ended before loading the device model');
    if (event.type === 'progress' && event.message.startsWith('Loading device model for slot 1')) {
      modelProgress = event;
    } else if (event.type === 'error') {
      assert.fail(`scan timed out before loading the model: ${event.message}`);
    }
  }
  const progressObservedAt = Date.now();
  await modelRequestStarted;

  let error;
  while (!error) {
    const event = await readNextEvent();
    assert.ok(event, 'scan stream ended without a timeout error');
    if (event.type === 'error') error = event;
  }
  const elapsed = Date.now() - progressObservedAt;
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'operation_timeout');
  assert.match(error.message, /No progress .* for 3 seconds.*Last reported step: Loading device model for slot 1/);
  assert.ok(elapsed >= 2500, `idle timer should restart after model progress (elapsed ${elapsed}ms)`);
});
