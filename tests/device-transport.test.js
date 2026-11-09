const assert = require('node:assert/strict');
const test = require('node:test');
const { configureDeviceTransport, grpcTransport, restTransportOptions,
  assertValidSlots, mapDeviceSlots, normalizeDeviceJwt, redactDeviceJwt, streamCollector } = require('../src/security/device-transport');

test('device transports have no configured message-size limits', () => {
  assert.equal(restTransportOptions().maxRedirects, 0);
  assert.equal(restTransportOptions().proxy, false);
  assert.equal(restTransportOptions().maxContentLength, Infinity);
  assert.equal(restTransportOptions().maxBodyLength, Infinity);
  assert.equal(grpcTransport('device.example:443').options['grpc.max_receive_message_length'], Infinity);
  assert.equal(grpcTransport('device.example:443').options['grpc.max_send_message_length'], Infinity);
  assert.equal(grpcTransport('device.example:443').target, 'device.example:443');
  configureDeviceTransport();
});

test('stream and slot processing have no application work caps', async () => {
  assert.doesNotThrow(() => assertValidSlots(Array.from({ length: 10 }, (_, index) => index)));
  assert.throws(() => assertValidSlots([1, 1]), /unique/);
  const values = [];
  const collect = streamCollector(values);
  for (let index = 0; index < 10001; index += 1) collect(index);
  assert.equal(values.length, 10001);
  let active = 0;
  let maximum = 0;
  const slots = Array.from({ length: 10 }, (_, index) => index);
  const result = await mapDeviceSlots(slots, async slot => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return slot;
  });
  assert.deepEqual(result, slots);
  assert.equal(maximum, 10);
});

test('optional JWTs attach Bearer authorization, redact secrets, and reset between operations', () => {
  assert.equal(normalizeDeviceJwt(undefined), undefined);
  assert.equal(normalizeDeviceJwt(' synthetic.payload.signature '), 'synthetic.payload.signature');
  for (const value of [null, 123, 'Bearer synthetic.payload.signature', 'bad\r\nheader', 'token', 'a'.repeat(8193)]) {
    assert.throws(() => normalizeDeviceJwt(value));
  }
  configureDeviceTransport('synthetic.payload.signature');
  assert.equal(restTransportOptions().headers.Authorization, 'Bearer synthetic.payload.signature');
  assert.equal(grpcTransport('localhost:6254').options.interceptors.length, 1);
  assert.equal(redactDeviceJwt('Bearer synthetic.payload.signature'), 'Bearer [REDACTED]');
  configureDeviceTransport();
  assert.deepEqual(restTransportOptions().headers, {});
  assert.equal(grpcTransport('localhost:6254').options.interceptors, undefined);
});