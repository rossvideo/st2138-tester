import { validationDiagnostics } from './validation.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2) ?? 'No model was returned.');
}

function validatorDetails(validations) {
  const diagnostics = validations.flatMap(validationDiagnostics).join('\n\n');
  return diagnostics ? `<details><summary>Validator details</summary><pre>${escapeHtml(diagnostics)}</pre></details>` : '';
}

function validationMarkup(validation, expandable = false) {
  if (!validation) return '<p class="quiet-text">Validation was not run.</p>';
  const tone = validation.ran ? (validation.ok ? 'pass-text' : 'fail-text') : 'quiet-text';
  const label = validation.ran ? (validation.ok ? 'PASSED' : 'FAILED') : 'NOT RUN';
  const summary = `<div class="diagnostic-line"><span>ST 2138 validation</span><strong class="${tone}">${label}</strong></div>`;
  if (expandable) return summary + validatorDetails([validation]);
  const details = validationDiagnostics(validation).join('\n\n');
  return summary + (details ? `<pre>${escapeHtml(details)}</pre>` : '');
}

function componentCheck(entries, memberType, oid) {
  return entries.find(entry => entry.memberType === memberType && entry.oid === oid
    && (entry.pathTemplate === '/{slot}/component/{kind}/{fqoid}'
      || entry.endpoint === 'CatenaService.GetComponent'));
}

function componentStatusMarkup(check) {
  const state = !check?.tested ? 'not-run' : check.ok ? 'pass' : 'fail';
  const label = state === 'not-run' ? 'NOT RUN' : state === 'pass' ? 'PASS' : 'FAIL';
  const heading = `<span>GetComponent</span><strong>${label}</strong>`;
  if (!check?.tested) return `<div class="component-status ${state}">${heading}</div>`;
  const validations = (Array.isArray(check.validation) ? check.validation : [check.validation]).filter(Boolean);
  return `<details class="component-status ${state}">
    <summary>${heading}</summary>
    <div class="component-status-details">
      ${check.note ? `<p>${escapeHtml(check.note)}</p>` : ''}
      ${validatorDetails(validations)}
      <div class="endpoint-previews"><div><h3>Request</h3><pre>${escapeHtml(check.requestPreview || '(not sent)')}</pre></div><div><h3>Response</h3><pre>${escapeHtml(check.responsePreview || '(not returned)')}</pre></div></div>
    </div>
  </details>`;
}

function memberCheckMarkup(check, slotEndpoints) {
  const steps = (check.steps || []).map((step) => {
    const requestMethod = String(step.request?.method || '');
    const grpcMethod = requestMethod.match(/CatenaService\.([^.]+)/)?.[1];
    const isValueRequest = /\/value(?:\/|$)/i.test(String(step.request?.url || ''));
    const restMethod = isValueRequest
      ? requestMethod.toUpperCase() === 'PUT' ? 'SetValue' : requestMethod.toUpperCase() === 'GET' ? 'GetValue' : ''
      : '';
    const operation = grpcMethod || restMethod;
    const phase = String(step.name || '').replaceAll('-', ' ');
    const label = operation ? `${operation}${phase ? ` · ${phase}` : ''}` : phase;
    return `<details class="member-step">
    <summary><span>${escapeHtml(label)}</span><span class="${step.ok ? 'pass-text' : 'fail-text'}">${step.ok ? 'PASS' : 'FAIL'}</span></summary>
    ${step.error || step.warning ? `<p>${escapeHtml(step.error || step.warning)}</p>` : ''}
    <pre>${formatJson({ status: step.status, request: step.request, response: step.response })}</pre>
    ${step.validation ? validationMarkup(step.validation, true) : ''}
  </details>`;
  }).join('');
  return `<details class="member-check ${check.readOnly ? 'is-read-only' : ''}">
    <summary><span class="member-path">${escapeHtml(check.path)}</span><span class="member-labels">${check.readOnly ? '<span class="readonly-tag">READ ONLY</span>' : ''}<span class="${check.ok ? 'pass-text' : 'fail-text'}">${escapeHtml(String(check.outcome || '').toUpperCase())}</span></span></summary>
    <div class="member-check-details">${componentStatusMarkup(componentCheck(slotEndpoints, 'Parameter', check.path))}<p>${escapeHtml(check.reason || '')}</p>${steps}</div>
  </details>`;
}

function recursionLabel(endpoint) {
  return `Recursive: ${endpoint.recursive ? 'on' : 'off'}`;
}

function apiEndpointCheckMarkup(endpoint, variant = false) {
  const isNotRun = !endpoint.tested;
  const statusLabel = isNotRun ? 'NOT RUN' : endpoint.ok ? (endpoint.warning ? 'WARN' : 'PASSED') : 'FAILED';
  const statusTone = isNotRun ? '' : endpoint.ok ? 'pass-text' : 'fail-text';
  const grpcMethod = endpoint.protocol === 'grpc'
    ? endpoint.endpoint?.match(/CatenaService\.([^.]+)/)?.[1] || endpoint.method
    : endpoint.method;
  const restMethod = endpoint.pathTemplate?.includes('/param-info')
    ? 'GetParamInfo'
    : endpoint.pathTemplate?.includes('/component/{kind}/')
      ? 'GetComponent'
    : endpoint.pathTemplate?.includes('/param/{fqoid}')
      ? 'GetParam'
      : endpoint.pathTemplate?.includes('/value/{fqoid}')
        ? endpoint.method === 'PUT' ? 'SetValue' : 'GetValue'
        : '';
  const restMethodLabel = restMethod ? `${restMethod}${endpoint.isStream ? ' (stream)' : ''}` : '';
  const restPath = String(endpoint.endpoint || endpoint.pathTemplate || '')
    .replace(/^\/st2138-api\/v1(?:\/\d+)?(?=\/|$)/i, '') || '/';
  const restTargetLabel = endpoint.oid
    ? `${endpoint.oid} - ${restMethodLabel || restPath}`
    : restMethodLabel || restPath;
  const rowLabel = endpoint.protocol === 'grpc'
    ? (endpoint.oid ? `${endpoint.oid} - ${grpcMethod}` : grpcMethod)
    : `${endpoint.method} · ${restTargetLabel}`;
  const validation = (Array.isArray(endpoint.validation) ? endpoint.validation : [endpoint.validation]).filter(Boolean);
  const validationText = validation.map((item) => {
    if (!item) return '';
    return `${item.schema || 'Response'}: ${item.ran === false ? 'not run' : item.ok ? 'passed' : 'failed'}${item.note ? ` (${item.note})` : ''}`;
  }).filter(Boolean).join('\n');
  return `<details class="member-check api-endpoint-check">
    <summary><span class="member-path">${escapeHtml(variant ? recursionLabel(endpoint) : rowLabel)}</span><span class="member-labels"><span class="${statusTone}">${statusLabel}</span></span></summary>
    <div class="member-check-details">
      ${endpoint.note ? `<p>${escapeHtml(endpoint.note)}</p>` : ''}
      <div class="diagnostic-line"><span>Status</span><strong class="${statusTone}">${isNotRun ? 'Not run' : escapeHtml(endpoint.status)}</strong></div>
      ${validationText ? `<pre class="api-validation-summary">${escapeHtml(validationText)}</pre>` : ''}
      ${validatorDetails(validation)}
      <div class="endpoint-previews"><div><h3>Request</h3><pre>${escapeHtml(endpoint.requestPreview || '(not sent)')}</pre></div><div><h3>Response</h3><pre>${escapeHtml(endpoint.responsePreview || '(not returned)')}</pre></div></div>
    </div>
  </details>`;
}

function slotResultMarkup(slot, slotEndpoints) {
  const validation = slot.validation || slot.componentValidation;
  const memberSummary = slot.memberChecks?.summary;
  const endpointSummary = slot.endpointSummary || { passed: 0, failed: 0 };
  const checks = slot.memberChecks?.checks || [];
  const apiChecks = slotEndpoints.filter((endpoint) => !endpoint.memberDataType);
  const apiCounts = endpointTotals(apiChecks);
  const apiSummary = `<span class="${apiCounts.failed ? 'fail-text' : 'pass-text'}">${apiCounts.passed} passed · ${apiCounts.failed} failed · ${apiCounts.skipped} not run</span>`;
  return `<article class="slot-result ${slot.ok ? 'pass' : 'fail'}">
    <span class="result-marker" aria-hidden="true">${slot.ok ? '✓' : '!'}</span>
    <div class="result-main"><div class="result-title-row"><h3>${escapeHtml(slotDeviceTitle(slot))}</h3><span class="result-state">${slot.ok ? 'PASSED' : 'FAILED'}</span></div>
      <p>${slot.fetched ? 'Device model retrieved and checked.' : 'Device model could not be retrieved.'}</p>
      <section class="diagnostic-details"><h4>Validation details</h4><div class="diagnostic-content">
        ${validationMarkup(validation)}
        ${slot.error ? `<p class="fail-text">${escapeHtml(slot.error)}</p>` : ''}
        <details class="validation-group parameter-validation-group"><summary><span>Parameter checks</span><span>${memberSummary ? `${memberSummary.passed} passed · ${memberSummary.failed} failed` : `${checks.length} checks`}</span></summary>
          <div class="validation-group-content">${checks.length ? checks.map(check => memberCheckMarkup(check, slotEndpoints)).join('') : '<p class="quiet-text">No parameter checks were returned.</p>'}</div>
        </details>
        <details class="validation-group api-validation-group"><summary><span>API endpoints</span>${apiSummary}</summary>
          <div class="validation-group-content">${apiChecks.length ? endpointListMarkup(apiChecks, true) : `<p class="quiet-text">No API endpoint checks were returned. ${endpointSummary.passed} tested endpoint checks passed; ${endpointSummary.failed} failed.</p>`}</div>
        </details>
      </div></section>
    </div>
  </article>`;
}

function modelMarkup(slot) {
  const model = slot.model;
  const validation = slot.validation || slot.componentValidation;
  return `<details class="model-entry"><summary><span>Slot ${escapeHtml(slot.slot)} device model</span><span class="model-state ${slot.ok ? 'pass-text' : 'fail-text'}">${slot.ok ? 'VALID' : 'REVIEW'}</span></summary>
    ${model ? `<pre class="model-json">${formatJson(model)}</pre>` : '<p class="model-diagnostic">No device model was returned.</p>'}
    ${validation ? `<div class="model-diagnostic">${validationMarkup(validation)}</div>` : ''}
  </details>`;
}

function unwrapProductValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  for (const key of ['string_value', 'int32_value', 'float32_value', 'bool_value', 'oid_value']) {
    if (value[key] !== undefined) return String(value[key]);
  }
  const displayStrings = value.display_strings;
  if (displayStrings && typeof displayStrings === 'object') return String(displayStrings.en || Object.values(displayStrings)[0] || '');
  return '';
}

function slotProductSummary(slot) {
  const product = slot.model?.params?.product;
  const get = (key) => unwrapProductValue(product?.params?.[key]?.value ?? product?.value?.struct_value?.fields?.[key]);
  const name = get('name');
  return {
    name,
    product: `${get('vendor') || 'Unknown vendor'}'s ${name || 'Unnamed device'}`,
    version: get('version') || '—',
    serial: get('serial_number') || '—'
  };
}

function slotDeviceTitle(slot) {
  const { name } = slotProductSummary(slot);
  return name ? `Slot ${slot.slot} · ${name}` : `Slot ${slot.slot}`;
}

function endpointTitle(endpoint) {
  if (endpoint.title) return endpoint.title;
  const path = endpoint.pathTemplate || endpoint.endpoint || '';
  const action = ({ GET: 'Read', POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete' })[endpoint.method];
  if (path.includes('/component/')) return 'Read component descriptor';
  if (path.includes('/param-info/')) return endpoint.isStream ? 'List parameter metadata (stream)' : 'Read parameter metadata';
  if (path.includes('/language-pack/')) return `${action || 'Read'} language pack`;
  if (path.endsWith('/languages')) return 'List supported languages';
  if (path.endsWith('/health')) return 'Check node health';
  if (/\/devices?$/.test(path)) return 'Discover populated slots';
  if (path.endsWith('/connect')) return 'Open update stream';
  const rpc = endpoint.endpoint?.match(/^CatenaService\.([A-Za-z]+)/)?.[1];
  return rpc ? rpc.replace(/([a-z])([A-Z])/g, '$1 $2') : `${action || endpoint.method} endpoint`;
}

function endpointHeaderMarkup(endpoint, title, label) {
  return `<span class="endpoint-method">${escapeHtml(endpoint.operation || endpoint.method)}</span><span class="endpoint-path">${escapeHtml(title)}<small>${escapeHtml(endpoint.endpoint)}</small>${endpoint.readOnly ? '<small class="readonly-tag">READ ONLY</small>' : ''}</span><strong>${label}</strong>`;
}

function endpointMarkup(endpoint, variant = false) {
  const title = variant ? recursionLabel(endpoint) : endpointTitle(endpoint);
  const status = !endpoint.tested ? 'not-run' : endpoint.ok ? 'pass' : 'fail';
  const label = !endpoint.tested ? 'NOT RUN' : endpoint.ok ? (endpoint.warning ? 'WARN' : 'PASS') : 'FAIL';
  const bodyCapable = endpoint.protocol === 'grpc' || ['POST', 'PUT', 'PATCH'].includes(endpoint.method);
  const body = endpoint.manualBody !== undefined ? JSON.stringify(endpoint.manualBody, null, 2)
    : endpoint.manualRequest !== undefined ? JSON.stringify(endpoint.manualRequest, null, 2) : '';
  const manualRequest = endpoint.manualRequest === undefined ? '' : JSON.stringify(endpoint.manualRequest);
  const validations = (Array.isArray(endpoint.validation) ? endpoint.validation : [endpoint.validation]).filter(Boolean);
  const executedValidations = validations.filter((validation) => validation?.ran !== false);
  const validationRan = executedValidations.length > 0;
  const validationOk = validationRan && executedValidations.every((validation) => validation?.ok);
  const validationFailed = executedValidations.some((validation) => !validation?.ok);
  const validationStatus = validations.length === 0 ? '' : validationFailed ? 'invalid response' : validationOk
    ? 'valid response'
    : validations.find((validation) => validation?.note)?.note || 'response not validated';
  const manualForm = `<form class="endpoint-manual-form" data-protocol="${escapeHtml(endpoint.protocol || '')}" data-method="${escapeHtml(endpoint.method)}" data-endpoint="${escapeHtml(endpoint.endpoint)}" data-slot="${endpoint.slot === null ? '' : escapeHtml(endpoint.slot)}" data-stream="${Boolean(endpoint.isStream)}" data-mutating="${Boolean(endpoint.mutating)}" data-manual-request="${escapeHtml(manualRequest)}"${typeof endpoint.recursive === 'boolean' ? ' data-param-info-stream' : ''}>
      ${bodyCapable ? `<label class="field-label">Request body <span class="label-optional">(optional JSON)</span></label><textarea class="endpoint-manual-body" spellcheck="false" placeholder="{}">${escapeHtml(body)}</textarea>` : ''}
      <div class="endpoint-manual-actions"><button class="outline-button" type="submit">Run manually <span aria-hidden="true">↗</span></button><span class="endpoint-manual-status" role="status" aria-live="polite"></span></div><pre class="endpoint-manual-response" hidden></pre>
    </form>`;
  return `<details class="endpoint-result ${status}"><summary>${endpointHeaderMarkup(endpoint, title, label)}</summary>
    <div class="endpoint-diagnostics">${endpoint.note ? `<p>${escapeHtml(endpoint.note)}</p>` : ''}
      <div class="endpoint-previews"><div><h3>Request</h3><pre>${escapeHtml(endpoint.requestPreview)}</pre></div><div><h3>Response</h3><pre>${escapeHtml(endpoint.responsePreview)}</pre></div></div>
      ${validationStatus ? `<div class="endpoint-validation ${validationOk ? 'pass-text' : validationRan ? 'fail-text' : 'quiet-text'}">ST 2138: ${escapeHtml(validationStatus)}${validatorDetails(validations)}</div>` : ''}${manualForm}
    </div></details>`;
}

function endpointTotals(entries) {
  const tested = entries.filter((entry) => entry.tested);
  return { passed: tested.filter((entry) => entry.ok).length, failed: tested.filter((entry) => !entry.ok).length, skipped: entries.length - tested.length };
}

function memberEndpointOrder(endpoint) {
  const method = String(endpoint.method || '').replace(/^CatenaService\./, '');
  const path = endpoint.pathTemplate || '';
  if (method === 'GetComponent' || path.includes('/component/')) return 0;
  if (method === 'ParamInfoRequest' || path.includes('/param-info/')) return endpoint.isStream ? 2 : 1;
  if (method === 'GetParam' || path.includes('/param/')) return 3;
  if (method === 'GetValue' || (path.includes('/value/') && method === 'GET')) return 4;
  if (method === 'SetValue' || (path.includes('/value/') && method === 'PUT')) return 5;
  return 6;
}

function endpointListMarkup(entries, diagnosticsOnly = false) {
  const groups = new Map();
  for (const entry of entries) {
    const key = typeof entry.recursive === 'boolean'
      ? JSON.stringify([entry.protocol, entry.slot, entry.method, entry.endpoint.split('?')[0], entry.oid])
      : entry;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const render = diagnosticsOnly ? apiEndpointCheckMarkup : endpointMarkup;
  return Array.from(groups.values(), group => {
    const [endpoint] = group;
    if (typeof endpoint.recursive !== 'boolean') return render(endpoint);
    const title = endpointTitle(endpoint);
    const totals = endpointTotals(group);
    const status = totals.failed ? 'fail' : totals.skipped ? 'not-run' : 'pass';
    const label = totals.failed ? 'FAIL' : totals.skipped ? 'NOT RUN' : group.some(entry => entry.warning) ? 'WARN' : 'PASS';
    const header = diagnosticsOnly
      ? `<span class="member-path">${escapeHtml(title)}</span><strong class="${totals.failed ? 'fail-text' : totals.skipped ? 'quiet-text' : 'pass-text'}">${label}</strong>`
      : endpointHeaderMarkup({ ...endpoint, endpoint: endpoint.endpoint.split('?')[0] }, title, label);
    return `<details class="${diagnosticsOnly ? 'member-check' : `endpoint-result ${status}`} param-info-stream-group"><summary>${header}</summary><div class="param-info-stream-variants">${group.map(entry => render(entry, true)).join('')}</div></details>`;
  }).join('');
}

function endpointCountsMarkup(entries) {
  const totals = endpointTotals(entries);
  return `<span class="endpoint-counts"><strong class="pass-text">${totals.passed} passed</strong><strong class="${totals.failed ? 'fail-text' : 'pass-text'}">${totals.failed} failed</strong><span>${totals.skipped} not run</span></span>`;
}

function memberTypeMarkup(memberType, entries) {
  const byOid = new Map();
  for (const entry of entries) {
    const group = byOid.get(entry.oid) || [];
    group.push(entry);
    byOid.set(entry.oid, group);
  }
  return `<details class="endpoint-member-type" open><summary><span>${escapeHtml(memberType)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-member-oids">${Array.from(byOid, ([oid, operations]) => `<details class="endpoint-member-oid" open><summary><span class="member-path">${escapeHtml(oid)}</span>${endpointCountsMarkup(operations)}</summary><div class="member-crud-list">${endpointListMarkup([...operations].sort((a, b) => memberEndpointOrder(a) - memberEndpointOrder(b)))}</div></details>`).join('')}</div></details>`;
}

function resourceGroupMarkup(title, entries) {
  return `<details class="endpoint-resource-group" open><summary><span>${escapeHtml(title)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-resource-entries">${entries.map(entry => endpointMarkup(entry)).join('')}</div></details>`;
}

function languagePackGroupMarkup(entries) {
  const languages = entries.filter((entry) => entry.resourceKind === 'languages' || /\/languages(?:\?|$)/.test(entry.endpoint));
  const packs = entries.filter((entry) => entry.memberType === 'Language pack' || entry.resourceKind === 'language-pack' || /\/language-pack(?:\/|$)/.test(entry.endpoint));
  const packsByLanguage = new Map();
  for (const entry of packs) {
    const match = entry.endpoint.match(/\/language-pack\/([^/?]+)/);
    const language = entry.resourceKey || (entry.memberType === 'Language pack' ? entry.oid : undefined) || match?.[1] || 'No language advertised';
    const group = packsByLanguage.get(language) || [];
    group.push(entry);
    packsByLanguage.set(language, group);
  }
  const children = [
    ...(languages.length ? [`<section class="endpoint-resource-subgroup"><h3>Supported languages</h3><div class="endpoint-resource-entries">${languages.map(entry => endpointMarkup(entry)).join('')}</div></section>`] : []),
    ...Array.from(packsByLanguage, ([language, operations]) => `<details class="endpoint-language-group" open><summary><span>${escapeHtml(language)}</span>${endpointCountsMarkup(operations)}</summary><div class="endpoint-resource-entries">${operations.map(entry => endpointMarkup(entry)).join('')}</div></details>`)
  ].join('');
  return `<details class="endpoint-resource-group" open><summary><span>Language packs</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-resource-entries">${children}</div></details>`;
}

function scopeGroupMarkup(title, entries) {
  const subscriptionEntries = entries.filter((entry) => entry.resourceGroup === 'Subscriptions' || entry.pathTemplate.includes('/subscriptions'));
  const languageEntries = entries.filter((entry) => entry.memberType === 'Language pack' || entry.resourceGroup === 'Language packs' || entry.pathTemplate.includes('/language-pack/') || entry.pathTemplate.endsWith('/languages'));
  const members = entries.filter((entry) => entry.memberType && !languageEntries.includes(entry));
  const general = entries.filter((entry) => !entry.memberType && !subscriptionEntries.includes(entry) && !languageEntries.includes(entry));
  const byType = new Map();
  for (const entry of members) {
    const group = byType.get(entry.memberType) || [];
    group.push(entry);
    byType.set(entry.memberType, group);
  }
  return `<details class="endpoint-scope-group" open><summary><span>${escapeHtml(title)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-scope-content">
    ${general.length ? `<section class="endpoint-general-group"><h3>Core endpoints</h3><div class="endpoint-general-list">${endpointListMarkup(general)}</div></section>` : ''}
    ${subscriptionEntries.length ? resourceGroupMarkup('Subscriptions', subscriptionEntries) : ''}
    ${languageEntries.length ? languagePackGroupMarkup(languageEntries) : ''}
    ${Array.from(byType, ([type, typeEntries]) => memberTypeMarkup(type, typeEntries)).join('')}
  </div></details>`;
}

function commandSlotMarkup(slot, slotEndpoints) {
  const commands = Object.entries(slot.model?.commands || {});
  if (commands.length === 0) return '';
  return `<details class="command-slot-group" open><summary><span>Slot ${escapeHtml(slot.slot)}</span><span>${commands.length} command${commands.length === 1 ? '' : 's'}</span></summary><div class="command-list">
    ${commands.map(([oid, descriptor]) => {
      const component = componentCheck(slotEndpoints, 'Command', oid);
      const componentType = component?.ok ? component.componentCommandType : undefined;
      const commandType = componentType === 1 ? 'EMPTY' : String(componentType ?? descriptor?.type ?? 'COMMAND').toUpperCase();
      const needsBody = componentType !== 1 && !(typeof componentType === 'string' && componentType.toUpperCase() === 'EMPTY');
      const initialBody = needsBody && descriptor?.value && Object.keys(descriptor.value).length ? JSON.stringify(descriptor.value, null, 2) : '';
      return `<form class="command-form" data-slot="${escapeHtml(slot.slot)}" data-oid="${escapeHtml(oid)}"><div class="command-heading"><div><h3>${escapeHtml(oid)}</h3><span>${escapeHtml(commandType)}</span></div><span class="command-scope">${escapeHtml(descriptor?.access_scope || 'default scope')}</span></div>
        ${componentStatusMarkup(component)}
        ${needsBody ? `<label class="field-label" for="command-body-${escapeHtml(slot.slot)}-${escapeHtml(oid).replaceAll('/', '-')}">Command body <span class="label-optional">(optional JSON)</span></label><textarea id="command-body-${escapeHtml(slot.slot)}-${escapeHtml(oid).replaceAll('/', '-')}" class="command-body" spellcheck="false" placeholder="{ &quot;int32_value&quot;: 1 }">${escapeHtml(initialBody)}</textarea>` : ''}
        <div class="command-actions"><button class="outline-button" type="submit">Run command <span aria-hidden="true">↗</span></button><span class="command-status" role="status" aria-live="polite"></span></div><pre class="command-response" hidden></pre></form>`;
    }).join('')}
  </div></details>`;
}

export function renderReport(report, requestedUrl = report.deviceUrl) {
  const { summary } = report;
  const slots = [...report.slots].sort((left, right) => Number(left.slot) - Number(right.slot));
  const target = /^https?:\/\//i.test(requestedUrl) ? requestedUrl : `https://${requestedUrl}`;
  const reportUrl = new URL(target);
  const fullUrl = `${reportUrl.protocol}//${reportUrl.host}${reportUrl.pathname === '/' ? '' : reportUrl.pathname}${reportUrl.search}`;
  document.getElementById('reportEndpoint').textContent = fullUrl;
  document.getElementById('totalCount').textContent = summary.total;
  document.getElementById('passedCount').textContent = summary.passed;
  document.getElementById('failedCount').textContent = summary.failed;
  document.getElementById('apiCheckCount').textContent = slots.reduce((total, slot) => total + (slot.memberChecks?.summary?.total || 0), 0);
  document.getElementById('scanTime').textContent = `Completed ${new Date(report.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const outcome = document.getElementById('scanOutcome');
  outcome.textContent = summary.total
    ? `${summary.passed} of ${summary.total} ${summary.total === 1 ? 'device' : 'devices'} passed`
    : 'No devices scanned';
  outcome.className = `outcome-tag${summary.total ? (summary.failed ? ' is-fail' : ' is-pass') : ''}`;
  const endpointAudit = (report.endpointAudit || []).map((endpoint) => ({ ...endpoint, protocol: report.protocol }));
  const schemaResults = slots
    .map((slot) => slot.validation || slot.componentValidation)
    .filter((validation) => validation?.ran === true);
  const completedEndpoints = endpointAudit.filter((endpoint) => endpoint.tested);
  const allTestsPassed = schemaResults.filter((validation) => validation.ok).length
    + completedEndpoints.filter((endpoint) => endpoint.ok).length;
  const allTestsFailed = schemaResults.filter((validation) => !validation.ok).length
    + completedEndpoints.filter((endpoint) => !endpoint.ok).length;
  const allTestsCount = allTestsPassed + allTestsFailed;
  document.getElementById('allTestsPassedPercent').textContent = allTestsCount
    ? `${Math.round(allTestsPassed / allTestsCount * 100)}%`
    : '—';
  document.getElementById('allTestsFailedPercent').textContent = allTestsCount
    ? `${Math.round(allTestsFailed / allTestsCount * 100)}% fail · ${allTestsPassed} passed / ${allTestsFailed} failed`
    : 'No completed tests';
  document.getElementById('slotResults').innerHTML = slots.map((slot) => slotResultMarkup(
    slot,
    endpointAudit.filter((endpoint) => endpoint.slot === slot.slot)
  )).join('');
  document.getElementById('deviceModels').innerHTML = slots.map(modelMarkup).join('');

  const endpointSummary = report.summary.endpoints || { tested: 0, passed: 0, failed: 0, skipped: 0 };
  const nodeEndpoints = endpointAudit.filter((endpoint) => endpoint.slot === null);
  const nodeCounts = endpointTotals(nodeEndpoints);
  const nodeTested = nodeCounts.passed + nodeCounts.failed;
  const nodeSummary = document.getElementById('deviceEndpointSummary');
  nodeSummary.textContent = [
    nodeTested ? `${nodeCounts.passed} of ${nodeTested} passed` : 'No checks run',
    ...(nodeCounts.failed ? [`${nodeCounts.failed} failed`] : []),
    ...(nodeCounts.skipped ? [`${nodeCounts.skipped} not run`] : [])
  ].join(' · ');
  nodeSummary.className = nodeCounts.failed ? 'fail-text' : '';
  document.getElementById('slotEndpointSummary').innerHTML = slots.map((slot) => {
    const entries = endpointAudit.filter((endpoint) => endpoint.slot === slot.slot);
    const counts = slot.endpointSummary || endpointTotals(entries);
    const product = slotProductSummary(slot);
    const schema = slot.validation || slot.componentValidation;
    const schemaLabel = schema?.ran !== true ? 'NOT RUN' : schema.ok ? 'PASS' : 'FAIL';
    const schemaTone = schema?.ran !== true ? 'quiet-text' : schema.ok ? 'pass-text' : 'fail-text';
    return `<div class="slot-endpoint-row ${slot.ok ? 'slot-summary-pass' : 'slot-summary-fail'}"><strong>Slot ${escapeHtml(slot.slot)}</strong><span class="slot-product-name" title="${escapeHtml(product.product)}">${escapeHtml(product.product)}</span><span title="${escapeHtml(product.version)}">${escapeHtml(product.version)}</span><span title="${escapeHtml(product.serial)}">${escapeHtml(product.serial)}</span><span class="slot-schema-status ${schemaTone}">${schemaLabel}</span><span class="slot-count-passed">${counts.passed} passed</span><span class="slot-count-failed">${counts.failed} failed</span></div>`;
  }).join('');

  const endpointTag = document.getElementById('endpointAuditSummary');
  endpointTag.textContent = `${endpointSummary.passed} passed · ${endpointSummary.failed} failed · ${endpointSummary.skipped} not run`;
  endpointTag.className = `outcome-tag ${endpointSummary.failed === 0 ? 'is-pass' : 'is-fail'}`;
  const slotGroups = slots.map((slot) => ({ title: slotDeviceTitle(slot), entries: endpointAudit.filter((endpoint) => endpoint.slot === slot.slot) }));
  document.getElementById('endpointAudit').innerHTML = [
    ...(nodeEndpoints.length ? [scopeGroupMarkup('Node-wide endpoints', nodeEndpoints)] : []),
    ...slotGroups.filter((group) => group.entries.length).map((group) => scopeGroupMarkup(group.title, group.entries))
  ].join('') || '<p class="quiet-text">No endpoint checks were returned.</p>';

  const commandGroups = slots.map(slot => commandSlotMarkup(slot, endpointAudit.filter(endpoint => endpoint.slot === slot.slot))).filter(Boolean);
  document.getElementById('commandGroups').innerHTML = commandGroups.length ? commandGroups.join('') : '<p class="quiet-text">No devices on this node advertise commands.</p>';
}
