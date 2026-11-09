import { executeCommand } from './api.js';

export function bindCommandRunner(getConnection) {
  const commandGroups = document.getElementById('commandGroups');

  commandGroups.addEventListener('submit', async (event) => {
    const form = event.target.closest('.command-form');
    if (!form) return;
    event.preventDefault();

    const connection = getConnection();
    const slot = Number(form.dataset.slot);
    const oid = form.dataset.oid;
    const bodyText = form.querySelector('textarea').value.trim();
    const status = form.querySelector('.command-status');
    const output = form.querySelector('.command-response');
    const button = form.querySelector('button[type="submit"]');
    let body;

    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        status.textContent = 'Body must be valid JSON.';
        status.dataset.tone = 'error';
        return;
      }
    }

    button.disabled = true;
    status.textContent = 'Sending command…';
    status.dataset.tone = 'working';
    output.hidden = false;

    try {
      const result = await executeCommand({
        protocol: connection.protocol,
        url: connection.url,
        allowInsecureTls: connection.allowInsecureTls,
        ...(connection.jwt ? { jwt: connection.jwt } : {}),
        slot,
        oid,
        body
      });
      output.textContent = JSON.stringify({
        response: result.response ?? null,
        validation: result.validation ? {
          schema: result.validation.schema,
          ran: result.validation.ran,
          ok: result.validation.ok,
          note: result.validation.note,
          diagnostics: result.validation.stdout
            ? [result.validation.stdout]
            : result.validation.results?.map((item) => item.stdout || item.error)
        } : null
      }, null, 2);
      output.dataset.outcome = result.ok ? 'pass' : 'fail';
      status.textContent = result.ok ? 'Command completed' : `Command failed${result.status ? ` · ${result.status}` : ''}`;
      status.dataset.tone = result.ok ? 'success' : 'error';
    } catch (error) {
      output.textContent = error.message;
      output.dataset.outcome = 'fail';
      status.textContent = 'Command request failed';
      status.dataset.tone = 'error';
    } finally {
      button.disabled = false;
    }
  });
}