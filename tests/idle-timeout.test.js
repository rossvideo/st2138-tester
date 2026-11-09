process.env.OPERATION_IDLE_TIMEOUT_MS = '3000';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createLocalAccess } = require('../src/security/local-access');
const { createScanRoutes } = require('../src/routes/scan');

test('device operations time out only after a period with no progress', { timeout: 60000 }, async context => {
  const device = http.createServer((req, res) => {
    if (req.url === '/st2138-api/v1/devices') {
      setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"slots":[1]}'), 2000);
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

  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/scan/rest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${device.address().port}` })
  });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const elapsed = Date.now() - started;
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.equal(error.code, 'operation_timeout');
  assert.match(error.message, /No progress .* for 3 seconds.*Last reported step: Loading device model for slot 1/);
  assert.ok(elapsed >= 4500, `idle timer should restart after progress (elapsed ${elapsed}ms)`);
});
