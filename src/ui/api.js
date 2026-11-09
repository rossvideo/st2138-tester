async function apiRequest(path, input, onProgress) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
    return readProgressResponse(response, onProgress);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Request failed (${response.status}).`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function readProgressResponse(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let result;
  let failure;

  function handleLine(line) {
    if (!line) return;
    const message = JSON.parse(line);
    if (message.type === 'progress') onProgress?.(message.message);
    else if (message.type === 'result') result = message.result;
    else if (message.type === 'error') {
      failure = new Error(message.message || 'Device scan failed.');
      failure.code = message.code;
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop();
    lines.forEach(handleLine);
    if (done) break;
  }
  handleLine(buffered);
  if (failure) throw failure;
  if (result === undefined) throw new Error(`Device scan ended without a report (HTTP ${response.status}).`);
  return result;
}

export function scanDevice(protocol, url, jwt, allowInsecureTls = false, onProgress) {
  return apiRequest(`/api/v2/scan/${protocol}`, { url, allowInsecureTls, ...(jwt ? { jwt } : {}) }, onProgress);
}

export function executeCommand(command) {
  return apiRequest('/api/v2/command', command);
}

export function runEndpoint(endpoint) {
  return apiRequest('/api/v2/endpoint/run', endpoint);
}