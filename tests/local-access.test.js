const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createLocalAccess } = require('../src/security/local-access');
const { createScanRoutes } = require('../src/routes/scan');

async function fixture(context) {
  const access = createLocalAccess();
  const app = express();
  app.use(express.json());
  app.use('/api/v2', createScanRoutes(access));
  const heldResponses = [];
  let resolveBothHeld;
  const bothHeld = new Promise(resolve => { resolveBothHeld = resolve; });
  app.post('/hold', access.sameOrigin, access.authorize, (req, res) => {
    heldResponses.push(res);
    if (heldResponses.length === 2) resolveBothHeld();
  });
  app.post('/operation', access.sameOrigin, access.authorize, (req, res) => {
    res.json({ reachedDevice: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json' };
  return {
    url,
    headers,
    bothHeld,
    releaseHeld: () => heldResponses.splice(0).forEach(res => res.json({ reachedDevice: true }))
  };
}

test('local mode requires no CAPTCHA or anonymous session and rejects cross-origin posts', async context => {
  const { url, headers } = await fixture(context);
  const response = await fetch(`${url}/api/v2/scan/rest`, {
    method: 'POST', headers, body: '{"url":"http://127.0.0.1:9"}'
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.match(events[0].message, /Checking populated device slots/);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /Couldn't find device at http:\/\/127\.0\.0\.1:9/);
  const crossOrigin = await fetch(`${url}/hold`, {
    method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}'
  });
  assert.equal(crossOrigin.status, 403);
});

test('local access permits concurrent device operations', async context => {
  const { url, headers, bothHeld, releaseHeld } = await fixture(context);
  const held = Array.from({ length: 2 }, () => fetch(`${url}/hold`, { method: 'POST', headers, body: '{}' }));
  await bothHeld;
  releaseHeld();
  const responses = await Promise.all(held);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(await Promise.all(responses.map(response => response.json())),
    [{ reachedDevice: true }, { reachedDevice: true }]);
});

test('device routes reject non-boolean insecure TLS options before starting a worker', async context => {
  const { url, headers } = await fixture(context);
  for (const endpoint of ['scan/rest', 'scan/grpc', 'command', 'endpoint/run']) {
    const response = await fetch(`${url}/api/v2/${endpoint}`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: 'https://127.0.0.1:9', allowInsecureTls: 'true' })
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /boolean/);
  }
});

test('insecure TLS opt-in reaches an isolated REST worker and does not leak to later operations', { timeout: 15000 }, async context => {
  const https = require('node:https');
  const fs = require('node:fs');
  const path = require('node:path');
  const device = https.createServer({
    key: fs.readFileSync(path.join(__dirname, 'fixtures/test-device-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'fixtures/test-device-cert.pem'))
  }, (req, res) => { res.writeHead(204); res.end(); });
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  context.after(() => { device.closeAllConnections(); device.close(); });
  const { url, headers } = await fixture(context);
  async function request(allowInsecureTls) {
    const response = await fetch(`${url}/api/v2/endpoint/run`, {
      method: 'POST', headers, body: JSON.stringify({
        protocol: 'rest', url: `https://127.0.0.1:${device.address().port}`,
        endpoint: '/st2138-api/v1/health', method: 'GET', slot: null,
        jwt: 'synthetic.payload.signature', allowInsecureTls
      })
    });
    return response.json();
  }
  assert.equal((await request(false)).ok, false);
  const accepted = await request(true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 204);
  assert.equal((await request(false)).ok, false);
});

test('local manual REST operations carry an optional JWT through the isolated worker', { timeout: 15000 }, async context => {
  const http = require('node:http');
  const authorization = [];
  const device = http.createServer((req, res) => {
    authorization.push(req.headers.authorization);
    res.writeHead(204);
    res.end();
  });
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  context.after(() => device.close());
  const { url, headers } = await fixture(context);
  const endpointUrl = `http://127.0.0.1:${device.address().port}`;
  const request = jwt => fetch(`${url}/api/v2/endpoint/run`, {
    method: 'POST', headers, body: JSON.stringify({ protocol: 'rest', ...(jwt ? { jwt } : {}),
      url: endpointUrl, endpoint: '/st2138-api/v1/health', method: 'GET', slot: null })
  });
  const anonymous = await request();
  assert.equal(anonymous.status, 200);
  assert.equal((await anonymous.json()).ok, true);
  const authenticated = await request('synthetic.payload.signature');
  assert.equal(authenticated.status, 200);
  const report = await authenticated.json();
  assert.equal(report.ok, true);
  assert.deepEqual(authorization, [undefined, 'Bearer synthetic.payload.signature']);
  assert.equal(JSON.stringify(report).includes('synthetic.payload.signature'), false);
});

test('an abandoned operation closes the worker device connection', { timeout: 15000 }, async context => {
  const http = require('node:http');
  let started;
  let closed;
  const deviceStarted = new Promise(resolve => { started = resolve; });
  const deviceClosed = new Promise(resolve => { closed = resolve; });
  const device = http.createServer((req, res) => { res.once('close', closed); started(); });
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  context.after(() => { device.closeAllConnections(); device.close(); });
  const { url, headers } = await fixture(context);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const operation = fetch(`${url}/api/v2/endpoint/run`, { method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ protocol: 'rest', url: `http://127.0.0.1:${device.address().port}`,
      endpoint: '/st2138-api/v1/health', method: 'GET', slot: null }) });
  await deviceStarted;
  controller.abort();
  await assert.rejects(operation, /aborted/i);
  await deviceClosed;
});

test('a slow device scan streams a progress heartbeat every five seconds', { timeout: 20000 }, async context => {
  const http = require('node:http');
  const device = http.createServer(() => {});
  await new Promise(resolve => device.listen(0, '127.0.0.1', resolve));
  context.after(() => { device.closeAllConnections(); device.close(); });
  const { url, headers } = await fixture(context);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const started = Date.now();
  const response = await fetch(`${url}/api/v2/scan/rest`, { method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ url: `http://127.0.0.1:${device.address().port}` }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let heartbeat;
  while (!heartbeat) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    buffer += decoder.decode(value, { stream: true });
    heartbeat = buffer.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(event => event.type === 'progress' && /\(\d+s elapsed\)/.test(event.message));
  }
  assert.match(heartbeat.message, /Checking populated device slots.*\(5s elapsed\)/);
  assert.ok(Date.now() - started < 8000);
  controller.abort();
});

test('an unreachable gRPC device reports that the device could not be found', { timeout: 20000 }, async context => {
  const { url, headers } = await fixture(context);
  const response = await fetch(`${url}/api/v2/scan/grpc`, {
    method: 'POST', headers, body: '{"url":"http://127.0.0.1:9"}'
  });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /^Couldn't find device at http:\/\/127\.0\.0\.1:9\.$/);
});
