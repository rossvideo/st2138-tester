import { runEndpoint } from './api.js';

function parseOptionalJson(text, label) {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

export function bindEndpointRunner(getConnection) {
  const container = document.getElementById('endpointAudit');

  container.addEventListener('submit', async (event) => {
    const form = event.target.closest('.endpoint-manual-form');
    if (!form) return;
    event.preventDefault();

    const connection = getConnection();
    const method = form.dataset.method;
    const endpoint = form.dataset.endpoint;
    const protocol = form.dataset.protocol || connection.protocol;
    const status = form.querySelector('.endpoint-manual-status');
    const output = form.querySelector('.endpoint-manual-response');
    const button = form.querySelector('button[type="submit"]');
    const bodyEditor = form.querySelector('textarea');
    let body;

    try {
      body = bodyEditor ? parseOptionalJson(bodyEditor.value, 'Request body') : undefined;
      if (body === undefined && form.dataset.manualRequest) {
        body = JSON.parse(form.dataset.manualRequest);
      }
      if (protocol === 'grpc') {
        const defaultRequest = form.dataset.manualRequest ? JSON.parse(form.dataset.manualRequest) : {};
        const editedRequest = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        body = { ...defaultRequest, ...editedRequest };
        if (form.dataset.slot !== '') body.slot = Number(form.dataset.slot);
      }
    } catch (error) {
      status.textContent = error.message;
      status.dataset.tone = 'error';
      return;
    }

    if (form.dataset.mutating === 'true'
      && !window.confirm(`This endpoint may change device state. Run ${method} ${endpoint}?`)) return;

    button.disabled = true;
    status.textContent = 'Running endpoint…';
    status.dataset.tone = 'working';
    output.hidden = false;

    try {
      const result = await runEndpoint({
        protocol,
        url: connection.url,
        allowInsecureTls: connection.allowInsecureTls,
        ...(connection.jwt ? { jwt: connection.jwt } : {}),
        method,
        endpoint,
        slot: form.dataset.slot === '' ? null : Number(form.dataset.slot),
        body,
        isStream: form.dataset.stream === 'true'
      });
      const validation = result.validation;
      output.textContent = JSON.stringify({
        response: result.response,
        validation: validation ? {
          schema: validation.schema,
          ran: validation.ran,
          ok: validation.ok,
          note: validation.note,
          diagnostics: validation.stdout
            ? [validation.stdout]
            : validation.results?.map((item) => item.stdout || item.error)
        } : null
      }, null, 2);
      output.dataset.outcome = result.ok ? 'pass' : 'fail';
      status.textContent = result.ok
        ? 'Endpoint response passed'
        : `Endpoint failed${result.status ? ` · ${result.status}` : ''}`;
      status.dataset.tone = result.ok ? 'success' : 'error';
    } catch (error) {
      output.textContent = error.message;
      output.dataset.outcome = 'fail';
      status.textContent = 'Endpoint request failed';
      status.dataset.tone = 'error';
    } finally {
      button.disabled = false;
    }
  });
}