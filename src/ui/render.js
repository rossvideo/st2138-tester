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

function validationMarkup(validation) {
  if (!validation) return '<p class="quiet-text">Validation was not run.</p>';
  const tone = validation.ran ? (validation.ok ? 'pass-text' : 'fail-text') : 'quiet-text';
  const label = validation.ran ? (validation.ok ? 'PASSED' : 'FAILED') : 'NOT RUN';
  const details = [validation.stdout, validation.stderr, validation.error].filter(Boolean).join('\n\n');
  return `<div class="diagnostic-line"><span>ST 2138 validation</span><strong class="${tone}">${label}</strong></div>${details ? `<pre>${escapeHtml(details)}</pre>` : ''}`;
}

function memberCheckMarkup(check) {
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
    ${step.validation ? validationMarkup(step.validation) : ''}
  </details>`;
  }).join('');
  return `<details class="member-check ${check.readOnly ? 'is-read-only' : ''}">
    <summary><span class="member-path">${escapeHtml(check.path)}</span><span class="member-labels">${check.readOnly ? '<span class="readonly-tag">READ ONLY</span>' : ''}<span class="${check.ok ? 'pass-text' : 'fail-text'}">${escapeHtml(String(check.outcome || '').toUpperCase())}</span></span></summary>
    <div class="member-check-details"><p>${escapeHtml(check.reason || '')}</p>${steps}</div>
  </details>`;
}

function apiEndpointCheckMarkup(endpoint) {
  const isNotRun = !endpoint.tested;
  const statusLabel = isNotRun ? 'NOT RUN' : endpoint.ok ? (endpoint.warning ? 'WARN' : 'PASSED') : 'FAILED';
  const statusTone = isNotRun ? '' : endpoint.ok ? 'pass-text' : 'fail-text';
  const title = endpoint.title || endpoint.endpoint;
  const grpcMethod = endpoint.protocol === 'grpc'
    ? endpoint.endpoint?.match(/CatenaService\.([^.]+)/)?.[1] || endpoint.method
    : endpoint.method;
  const restMethod = endpoint.pathTemplate?.includes('/param-info')
    ? 'GetParamInfo'
    : endpoint.pathTemplate?.includes('/param/{fqoid}')
      ? 'GetParam'
      : endpoint.pathTemplate?.includes('/value/{fqoid}')
        ? endpoint.method === 'PUT' ? 'SetValue' : 'GetValue'
        : '';
  const restMethodLabel = restMethod ? `${restMethod}${endpoint.isStream ? ' (stream)' : ''}` : '';
  const methodLabel = endpoint.protocol === 'grpc' ? grpcMethod : restMethodLabel || endpoint.method;
  const restPath = String(endpoint.endpoint || endpoint.pathTemplate || '')
    .replace(/^\/st2138-api\/v1(?:\/\d+)?(?=\/|$)/i, '') || '/';
  const restTargetLabel = endpoint.oid
    ? `${endpoint.oid} - ${restMethodLabel || restPath}`
    : restMethodLabel || restPath;
  const rowLabel = endpoint.protocol === 'grpc'
    ? (endpoint.oid ? `${endpoint.oid} - ${grpcMethod}` : grpcMethod)
    : `${endpoint.method} · ${restTargetLabel}`;
  const validation = Array.isArray(endpoint.validation) ? endpoint.validation : endpoint.validation ? [endpoint.validation] : [];
  const validationText = validation.map((item) => {
    if (!item) return '';
    return `${item.schema || 'Response'}: ${item.ran === false ? 'not run' : item.ok ? 'passed' : 'failed'}${item.note ? ` (${item.note})` : ''}`;
  }).filter(Boolean).join('\n');
  return `<details class="member-check api-endpoint-check">
    <summary><span class="member-path">${escapeHtml(rowLabel)}</span><span class="member-labels"><span class="${statusTone}">${statusLabel}</span></span></summary>
    <div class="member-check-details">
      ${endpoint.note ? `<p>${escapeHtml(endpoint.note)}</p>` : ''}
      <div class="diagnostic-line"><span>Status</span><strong class="${statusTone}">${isNotRun ? 'Not run' : escapeHtml(endpoint.status)}</strong></div>
      ${validationText ? `<pre class="api-validation-summary">${escapeHtml(validationText)}</pre>` : ''}
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
    <div class="result-main"><div class="result-title-row"><h3>Slot ${escapeHtml(slot.slot)}</h3><span class="result-state">${slot.ok ? 'PASSED' : 'FAILED'}</span></div>
      <p>${slot.fetched ? 'Device model retrieved and checked.' : 'Device model could not be retrieved.'}</p>
      <section class="diagnostic-details"><h4>Validation details</h4><div class="diagnostic-content">
        ${validationMarkup(validation)}
        ${slot.error ? `<p class="fail-text">${escapeHtml(slot.error)}</p>` : ''}
        <details class="validation-group parameter-validation-group"><summary><span>Parameter checks</span><span>${memberSummary ? `${memberSummary.passed} passed · ${memberSummary.failed} failed` : `${checks.length} checks`}</span></summary>
          <div class="validation-group-content">${checks.length ? checks.map(memberCheckMarkup).join('') : '<p class="quiet-text">No parameter checks were returned.</p>'}</div>
        </details>
        <details class="validation-group api-validation-group"><summary><span>API endpoints</span>${apiSummary}</summary>
          <div class="validation-group-content">${apiChecks.length ? apiChecks.map(apiEndpointCheckMarkup).join('') : `<p class="quiet-text">No API endpoint checks were returned. ${endpointSummary.passed} tested endpoint checks passed; ${endpointSummary.failed} failed.</p>`}</div>
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
  return {
    product: `${get('vendor') || 'Unknown vendor'}'s ${get('name') || 'Unnamed device'}`,
    version: get('version') || '—',
    serial: get('serial_number') || '—'
  };
}

function endpointMarkup(endpoint) {
  const title = endpoint.title || endpoint.pathTemplate || endpoint.endpoint;
  const status = !endpoint.tested ? 'not-run' : endpoint.ok ? 'pass' : 'fail';
  const label = !endpoint.tested ? 'NOT RUN' : endpoint.ok ? (endpoint.warning ? 'WARN' : 'PASS') : 'FAIL';
  const bodyCapable = endpoint.protocol === 'grpc' || ['POST', 'PUT', 'PATCH'].includes(endpoint.method);
  const body = endpoint.manualBody !== undefined ? JSON.stringify(endpoint.manualBody, null, 2)
    : endpoint.manualRequest !== undefined ? JSON.stringify(endpoint.manualRequest, null, 2) : '';
  const manualRequest = endpoint.manualRequest === undefined ? '' : JSON.stringify(endpoint.manualRequest);
  const validations = Array.isArray(endpoint.validation) ? endpoint.validation : endpoint.validation ? [endpoint.validation] : [];
  const executedValidations = validations.filter((validation) => validation?.ran !== false);
  const validationRan = executedValidations.length > 0;
  const validationOk = validationRan && executedValidations.every((validation) => validation?.ok);
  const validationFailed = executedValidations.some((validation) => !validation?.ok);
  const validationStatus = validations.length === 0 ? '' : validationFailed ? 'invalid response' : validationOk ? 'valid response' : validations.find((validation) => validation?.note)?.note || 'response not validated';
  const validationDetails = validations.flatMap((validation) => validation?.stdout ? [validation.stdout] : validation?.results?.map((result) => result.stdout || result.error).filter(Boolean) || []).join('\n\n');
  const manualForm = `<form class="endpoint-manual-form" data-protocol="${escapeHtml(endpoint.protocol || '')}" data-method="${escapeHtml(endpoint.method)}" data-endpoint="${escapeHtml(endpoint.endpoint)}" data-slot="${endpoint.slot === null ? '' : escapeHtml(endpoint.slot)}" data-stream="${Boolean(endpoint.isStream)}" data-mutating="${Boolean(endpoint.mutating)}" data-manual-request="${escapeHtml(manualRequest)}">
      ${bodyCapable ? `<label class="field-label">Request body <span class="label-optional">(optional JSON)</span></label><textarea class="endpoint-manual-body" spellcheck="false" placeholder="{}">${escapeHtml(body)}</textarea>` : ''}
      <div class="endpoint-manual-actions"><button class="outline-button" type="submit">Run manually <span aria-hidden="true">↗</span></button><span class="endpoint-manual-status" role="status" aria-live="polite"></span></div><pre class="endpoint-manual-response" hidden></pre>
    </form>`;
  return `<details class="endpoint-result ${status}"><summary><span class="endpoint-method">${escapeHtml(endpoint.operation || endpoint.method)}</span><span class="endpoint-path">${escapeHtml(title)}${endpoint.title ? `<small>${escapeHtml(endpoint.endpoint)}</small>` : ''}${endpoint.readOnly ? '<small class="readonly-tag">READ ONLY</small>' : ''}</span><strong>${label}</strong></summary>
    <div class="endpoint-diagnostics">${endpoint.note ? `<p>${escapeHtml(endpoint.note)}</p>` : ''}
      <div class="endpoint-previews"><div><h3>Request</h3><pre>${escapeHtml(endpoint.requestPreview)}</pre></div><div><h3>Response</h3><pre>${escapeHtml(endpoint.responsePreview)}</pre></div></div>
      ${validationStatus ? `<div class="endpoint-validation ${validationOk ? 'pass-text' : validationRan ? 'fail-text' : 'quiet-text'}">ST 2138: ${escapeHtml(validationStatus)}${validationDetails ? `<details><summary>Validator details</summary><pre>${escapeHtml(validationDetails)}</pre></details>` : ''}</div>` : ''}${manualForm}
    </div></details>`;
}

function endpointTotals(entries) {
  const tested = entries.filter((entry) => entry.tested);
  return { passed: tested.filter((entry) => entry.ok).length, failed: tested.filter((entry) => !entry.ok).length, skipped: entries.length - tested.length };
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
  return `<details class="endpoint-member-type" open><summary><span>${escapeHtml(memberType)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-member-oids">${Array.from(byOid, ([oid, operations]) => `<details class="endpoint-member-oid" open><summary><span class="member-path">${escapeHtml(oid)}</span>${endpointCountsMarkup(operations)}</summary><div class="member-crud-list">${operations.map(endpointMarkup).join('')}</div></details>`).join('')}</div></details>`;
}

function resourceGroupMarkup(title, entries) {
  return `<details class="endpoint-resource-group" open><summary><span>${escapeHtml(title)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-resource-entries">${entries.map(endpointMarkup).join('')}</div></details>`;
}

function languagePackGroupMarkup(entries) {
  const languages = entries.filter((entry) => entry.resourceKind === 'languages' || /\/languages(?:\?|$)/.test(entry.endpoint));
  const packs = entries.filter((entry) => entry.resourceKind === 'language-pack' || /\/language-pack(?:\/|$)/.test(entry.endpoint));
  const packsByLanguage = new Map();
  for (const entry of packs) {
    const match = entry.endpoint.match(/\/language-pack\/([^/?]+)/);
    const language = entry.resourceKey || match?.[1] || 'No language advertised';
    const group = packsByLanguage.get(language) || [];
    group.push(entry);
    packsByLanguage.set(language, group);
  }
  const children = [
    ...(languages.length ? [`<section class="endpoint-resource-subgroup"><h3>Supported languages</h3><div class="endpoint-resource-entries">${languages.map(endpointMarkup).join('')}</div></section>`] : []),
    ...Array.from(packsByLanguage, ([language, operations]) => `<details class="endpoint-language-group" open><summary><span>${escapeHtml(language)}</span>${endpointCountsMarkup(operations)}</summary><div class="endpoint-resource-entries">${operations.map(endpointMarkup).join('')}</div></details>`)
  ].join('');
  return `<details class="endpoint-resource-group" open><summary><span>Language packs</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-resource-entries">${children}</div></details>`;
}

function scopeGroupMarkup(title, entries) {
  const members = entries.filter((entry) => entry.memberType);
  const subscriptionEntries = entries.filter((entry) => entry.resourceGroup === 'Subscriptions' || entry.pathTemplate.includes('/subscriptions'));
  const languageEntries = entries.filter((entry) => entry.resourceGroup === 'Language packs' || entry.pathTemplate.includes('/language-pack/') || entry.pathTemplate.endsWith('/languages'));
  const general = entries.filter((entry) => !entry.memberType && !subscriptionEntries.includes(entry) && !languageEntries.includes(entry));
  const byType = new Map();
  for (const entry of members) {
    const group = byType.get(entry.memberType) || [];
    group.push(entry);
    byType.set(entry.memberType, group);
  }
  return `<details class="endpoint-scope-group" open><summary><span>${escapeHtml(title)}</span>${endpointCountsMarkup(entries)}</summary><div class="endpoint-scope-content">
    ${general.length ? `<section class="endpoint-general-group"><h3>Device API</h3><div class="endpoint-general-list">${general.map(endpointMarkup).join('')}</div></section>` : ''}
    ${subscriptionEntries.length ? resourceGroupMarkup('Subscriptions', subscriptionEntries) : ''}
    ${languageEntries.length ? languagePackGroupMarkup(languageEntries) : ''}
    ${Array.from(byType, ([type, typeEntries]) => memberTypeMarkup(type, typeEntries)).join('')}
  </div></details>`;
}

function commandSlotMarkup(slot) {
  const commands = Object.entries(slot.model?.commands || {});
  if (commands.length === 0) return '';
  return `<details class="command-slot-group" open><summary><span>Slot ${escapeHtml(slot.slot)}</span><span>${commands.length} command${commands.length === 1 ? '' : 's'}</span></summary><div class="command-list">
    ${commands.map(([oid, descriptor]) => {
      const commandType = String(descriptor?.type || 'COMMAND').toUpperCase();
      const needsBody = commandType !== 'EMPTY';
      const initialBody = needsBody && descriptor?.value && Object.keys(descriptor.value).length ? JSON.stringify(descriptor.value, null, 2) : '';
      return `<form class="command-form" data-slot="${escapeHtml(slot.slot)}" data-oid="${escapeHtml(oid)}"><div class="command-heading"><div><h3>${escapeHtml(oid)}</h3><span>${escapeHtml(commandType)}</span></div><span class="command-scope">${escapeHtml(descriptor?.access_scope || 'default scope')}</span></div>
        <label class="field-label" for="command-body-${escapeHtml(slot.slot)}-${escapeHtml(oid).replaceAll('/', '-')}">Command body <span class="label-optional">(optional JSON)</span></label><textarea id="command-body-${escapeHtml(slot.slot)}-${escapeHtml(oid).replaceAll('/', '-')}" class="command-body" spellcheck="false" placeholder="${needsBody ? '{ &quot;int32_value&quot;: 1 }' : 'No body required'}">${escapeHtml(initialBody)}</textarea>
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
//   document.getElementById('reportTitle').textContent = reportUrl.hostname;
  document.getElementById('reportEndpoint').textContent = fullUrl;
  document.getElementById('totalCount').textContent = summary.total;
  document.getElementById('passedCount').textContent = summary.passed;
  document.getElementById('failedCount').textContent = summary.failed;
  document.getElementById('apiCheckCount').textContent = slots.reduce((total, slot) => total + (slot.memberChecks?.summary?.total || 0), 0);
  document.getElementById('scanTime').textContent = `Completed ${new Date(report.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const outcome = document.getElementById('scanOutcome');
  outcome.textContent = summary.failed === 0 ? 'ALL SLOTS PASSED' : `${summary.failed} SLOT${summary.failed === 1 ? '' : 'S'} NEED REVIEW`;
  outcome.className = `outcome-tag ${summary.failed === 0 ? 'is-pass' : 'is-fail'}`;
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
  const deviceEndpoints = endpointAudit.filter((endpoint) => endpoint.slot === null);
  document.getElementById('deviceEndpointSummary').innerHTML = endpointCountsMarkup(deviceEndpoints);
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
  const deviceGroup = endpointAudit.filter((endpoint) => endpoint.slot === null);
  const slotGroups = slots.map((slot) => ({ title: `Slot ${slot.slot}`, entries: endpointAudit.filter((endpoint) => endpoint.slot === slot.slot) }));
  document.getElementById('endpointAudit').innerHTML = [
    ...(deviceGroup.length ? [scopeGroupMarkup('Device-wide', deviceGroup)] : []),
    ...slotGroups.filter((group) => group.entries.length).map((group) => scopeGroupMarkup(group.title, group.entries))
  ].join('') || '<p class="quiet-text">No endpoint checks were returned.</p>';

  const commandGroups = slots.map(commandSlotMarkup).filter(Boolean);
  document.getElementById('commandGroups').innerHTML = commandGroups.length ? commandGroups.join('') : '<p class="quiet-text">No commands are advertised by this device.</p>';
}
