import { scanDevice } from './api.js';
import { bindCommandRunner } from './commands.js';
import { bindEndpointRunner } from './endpoints.js';
import { renderReport } from './render.js';

const form = document.getElementById('connectionForm');
const urlInput = document.getElementById('deviceUrl');
const useJwtCheckbox = document.getElementById('useJwt');
const insecureTlsCheckbox = document.getElementById('allowInsecureTls');
const insecureTlsWarning = document.getElementById('insecureTlsWarning');
const jwtField = document.getElementById('jwtField');
const jwtTokenInput = document.getElementById('jwtToken');
const scanButton = document.getElementById('scanButton');
const statusLine = document.getElementById('connectionStatus');
const connectView = document.getElementById('connectView');
const workspace = document.getElementById('workspace');
const connectionSummary = document.getElementById('connectionSummary');
const connectedHost = document.getElementById('connectedHost');
const connectedProtocol = document.getElementById('connectedProtocol');
const changeDeviceButton = document.getElementById('changeDeviceButton');
const rescanButton = document.getElementById('rescanButton');
let lastRequest = null;

bindCommandRunner(() => lastRequest);
bindEndpointRunner(() => lastRequest);

useJwtCheckbox.addEventListener('change', () => {
  jwtField.hidden = !useJwtCheckbox.checked;
  jwtTokenInput.disabled = !useJwtCheckbox.checked;
});
insecureTlsCheckbox.addEventListener('change', () => {
  insecureTlsWarning.hidden = !insecureTlsCheckbox.checked;
});

function selectedProtocol() {
  return document.querySelector('input[name="protocol"]:checked').value;
}

function setStatus(message, tone = '') {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

function hostLabel(rawUrl) {
  try {
    const value = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(value).host;
  } catch {
    return rawUrl;
  }
}

function fullUrlLabel(rawUrl) {
  try {
    const value = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

async function runScan() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Enter a device URL to begin.', 'error');
    urlInput.focus();
    return;
  }

  const jwt = useJwtCheckbox.checked ? jwtTokenInput.value.trim() : undefined;
  if (useJwtCheckbox.checked && !jwt) {
    setStatus('Paste a JWT token or uncheck Use JWT.', 'error');
    jwtTokenInput.focus();
    return;
  }
  lastRequest = { url, protocol: selectedProtocol(), allowInsecureTls: insecureTlsCheckbox.checked, ...(jwt ? { jwt } : {}) };
  const connectionLed = document.getElementById('connectionLed');
  connectionLed.classList.remove('is-failed');
  connectionLed.classList.add('is-working');
  connectionLed.setAttribute('aria-label', 'Connecting');
  connectionLed.title = 'Connecting';
  scanButton.disabled = true;
  scanButton.querySelector('span').textContent = 'Scanning…';
  setStatus(`Connecting to ${hostLabel(url)}…`, 'working');

  try {
    const report = await scanDevice(lastRequest.protocol, url, lastRequest.jwt, lastRequest.allowInsecureTls,
      (progress) => setStatus(progress, 'working'));
    renderReport(report, url);
    connectedHost.textContent = fullUrlLabel(url);
    connectedProtocol.textContent = `${lastRequest.protocol.toUpperCase()}${lastRequest.allowInsecureTls ? ' · TLS unverified' : ''}`;
    connectionLed.classList.remove('is-working', 'is-failed');
    connectionLed.setAttribute('aria-label', 'Connected');
    connectionLed.title = 'Connected';
    connectionSummary.hidden = false;
    connectView.hidden = true;
    workspace.hidden = false;
    setStatus('');
  } catch (error) {
    connectionLed.classList.remove('is-working');
    connectionLed.classList.add('is-failed');
    connectionLed.setAttribute('aria-label', 'Connection failed');
    connectionLed.title = 'Connection failed';
    if (error.code === 'jwt_required') {
      useJwtCheckbox.checked = true;
      jwtField.hidden = false;
      jwtTokenInput.disabled = false;
      setStatus('JWT required for testing. Paste your token and start the scan again.', 'error');
      jwtTokenInput.focus();
      return;
    }
    setStatus(error.message, 'error');
  } finally {
    scanButton.disabled = false;
    scanButton.querySelector('span').textContent = 'Start scan';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runScan();
});

rescanButton.addEventListener('click', async () => {
  if (!lastRequest) return;
  urlInput.value = lastRequest.url;
  insecureTlsCheckbox.checked = lastRequest.allowInsecureTls;
  insecureTlsWarning.hidden = !lastRequest.allowInsecureTls;
  document.querySelector(`input[name="protocol"][value="${lastRequest.protocol}"]`).checked = true;
  connectView.hidden = false;
  workspace.hidden = true;
  await runScan();
});

changeDeviceButton.addEventListener('click', () => {
  lastRequest = null;
  jwtTokenInput.value = '';
  useJwtCheckbox.checked = false;
  insecureTlsCheckbox.checked = false;
  insecureTlsWarning.hidden = true;
  jwtField.hidden = true;
  jwtTokenInput.disabled = true;
  workspace.hidden = true;
  connectionSummary.hidden = true;
  connectView.hidden = false;
  setStatus('');
  urlInput.focus();
  urlInput.select();
});

document.querySelectorAll('.report-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.report-tab').forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle('is-active', active);
      candidate.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.report-panel').forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.panel;
    });
  });
});