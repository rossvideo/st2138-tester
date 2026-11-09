const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const axios = require('axios');
const grpc = require('@grpc/grpc-js');
const { configureDeviceTransport, restTransportOptions, grpcTransport } = require('../src/security/device-transport');

test('invalid device certificates fail by default and work only with explicit opt-in for REST and gRPC', async context => {
  context.after(() => configureDeviceTransport());
  const key = fs.readFileSync(path.join(__dirname, 'fixtures/test-device-key.pem'));
  const cert = fs.readFileSync(path.join(__dirname, 'fixtures/test-device-cert.pem'));
  const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const url = `https://127.0.0.1:${server.address().port}`;
  configureDeviceTransport();
  await assert.rejects(axios.get(url, { ...restTransportOptions(), timeout: 3000 }), /certificate/);
  configureDeviceTransport('synthetic.payload.signature', true);
  assert.equal((await axios.get(url, { ...restTransportOptions(), timeout: 3000 })).data, 'ok');

  const rpcServer = new grpc.Server();
  const identity = value => value;
  rpcServer.addService({ ping: { path: '/test/Ping', requestStream: false, responseStream: false,
    requestSerialize: identity, requestDeserialize: identity, responseSerialize: identity, responseDeserialize: identity } },
  { ping: (call, callback) => callback(null, Buffer.from('ok')) });
  const port = await new Promise((resolve, reject) => rpcServer.bindAsync('127.0.0.1:0',
    grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }], false),
    (error, port) => error ? reject(error) : resolve(port)));
  context.after(() => rpcServer.forceShutdown());
  async function ping() {
    const transport = grpcTransport(`127.0.0.1:${port}`, true);
    transport.options['grpc.ssl_target_name_override'] = 'localhost';
    const client = new grpc.Client(transport.target, transport.credentials, transport.options);
    try {
      return await new Promise((resolve, reject) => client.makeUnaryRequest('/test/Ping', identity, identity,
        Buffer.alloc(0), new grpc.Metadata(), { deadline: Date.now() + 2000 },
        (error, response) => error ? reject(error) : resolve(response)));
    } finally {
      client.close();
    }
  }
  assert.equal((await ping()).toString(), 'ok');
  configureDeviceTransport();
  assert.equal(restTransportOptions().httpsAgent, undefined);
  await assert.rejects(ping);
  await assert.rejects(axios.get(url, { ...restTransportOptions(), timeout: 3000 }), /certificate/);
  for (const invalid of ['true', 1, null]) {
    assert.throws(() => configureDeviceTransport(undefined, invalid), /boolean/);
  }
});
