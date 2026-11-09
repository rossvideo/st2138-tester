const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { app } = require('../src/server');

test('all routes share the exact 10,000 requests per minute limit before doing work',
  { timeout: 45000 }, async context => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const agent = new http.Agent({ keepAlive: true });
    context.after(() => {
      agent.destroy();
      server.closeAllConnections();
      server.close();
    });

    function request(path, { method = 'GET', body, headers = {}, localAddress } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: server.address().port, path, method, agent,
          localAddress, headers
        }, res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
      });
    }

    const routes = [
      ['/', {}, 200],
      ['/app.js', {}, 200],
      ['/health', {}, 200],
      ['/missing', {}, 404],
      ...['scan/rest', 'scan/grpc', 'command', 'endpoint/run'].map(endpoint => [
        `/api/v2/${endpoint}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        400
      ])
    ];
    for (const [path, options, status] of routes) {
      const response = await request(path, options);
      assert.equal(response.status, status, path);
    }

    for (let count = routes.length; count < 10000; count++) {
      const response = await request('/health');
      assert.equal(response.status, 200, `request ${count + 1} must be allowed`);
      if (count === 9999) {
        assert.match(response.headers.ratelimit, /limit=10000, remaining=0, reset=\d+/);
        assert.equal(response.headers['ratelimit-policy'], '10000;w=60');
        assert.equal(response.headers['x-ratelimit-limit'], undefined);
      }
    }

    for (const [path, options] of routes) {
      const response = await request(path, {
        ...options,
        ...(options.body ? { body: '{invalid JSON' } : {}),
        headers: {
          ...options.headers,
          // A forwarded address must not bypass the limit without trusted proxy configuration.
          'X-Forwarded-For': '192.0.2.1'
        }
      });
      assert.equal(response.status, 429, path);
      assert.deepEqual(JSON.parse(response.body), {
        message: 'Too many requests. Please try again later.'
      });
      const retryAfter = Number(response.headers['retry-after']);
      assert.ok(retryAfter > 0 && retryAfter <= 60);
    }

    const otherClient = await request('/health', { localAddress: '127.0.0.2' });
    assert.equal(otherClient.status, 200);
    assert.match(otherClient.headers.ratelimit, /remaining=9999/);
  });
