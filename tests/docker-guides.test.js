const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const uiPath = path.join(__dirname, '../src/ui');
const html = fs.readFileSync(path.join(uiPath, 'index.html'), 'utf8');
const appScript = fs.readFileSync(path.join(uiPath, 'app.js'), 'utf8');
const serverScript = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
const packageScripts = require('../package.json').scripts;
const copyUiScript = fs.readFileSync(path.join(__dirname, '../scripts/copy-ui.mjs'), 'utf8');

test('connection page does not include host-network setup guides', () => {
  assert.doesNotMatch(html, /localDeviceGuide|dockerWslGuide|host\.docker\.internal/);
  assert.doesNotMatch(appScript, /runtime-config|localDeviceGuide|dockerWslGuide/);
  assert.doesNotMatch(serverScript, /runtime-config\.js/);
});

test('Docker package download and archive generation are removed', () => {
  assert.doesNotMatch(html, /\/downloads\/|\bdownload\b/i);
  assert.equal(packageScripts['package:deployment'], undefined);
  assert.match(packageScripts.build, /scripts\/copy-ui\.mjs/);
  assert.doesNotMatch(copyUiScript, /tar|\.tar\.gz|downloads/);
});