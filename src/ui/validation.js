function describeCheck(result, target, ok = result.ok, schema = result.schema) {
  const kind = result.chunk !== undefined ? ' schema rule'
    : result.test?.kind === 'Tester rule' ? ' tester rule' : ' schema';
  const lines = result.stdout?.split('\n') || [];
  const application = lines.find(line => /^Applying (schema|tester rule) '/.test(line));
  const heading = result.test?.name ? `Applying${kind} "${result.test.name}" to ${target}`
    : application || (schema ? `Applying schema "${schema}" to ${target}` : undefined);
  const status = result.ran === false ? 'Not run' : ok ? '✅ Passed' : '❌ Failed';
  const details = [
    ...lines.filter(line => line && line !== application &&
      !['✅ Schema validation succeeded.', '❌ Validation failed.', 'Shape check passed.'].includes(line)),
    result.stderr,
    result.error,
    result.ran === false ? result.note : undefined
  ].filter(Boolean);
  return [heading, status, ...details].filter(Boolean).join('\n');
}

function chunkDiagnostics(results) {
  const blocks = [];
  for (const result of results) {
    if (result.chunk !== undefined) blocks.push([]);
    blocks.at(-1).push(result);
  }
  return blocks.map(([chunk, ...submembers]) => ({
    chunk: chunk.chunk,
    result: describeCheck(chunk, `response chunk ${chunk.chunk}`, chunk.ok && submembers.every(check => check.ok)),
    submembers: submembers.map(check => ({
      member: check.submember,
      result: describeCheck(check, `submember ${check.submember}`)
    }))
  }));
}

export function validationDiagnostics(validation) {
  if (validation.results?.[0]?.chunk !== undefined) {
    return chunkDiagnostics(validation.results).map(({ result, submembers }) => [
      result,
      ...submembers.map(check => check.result.split('\n').map(line => `  ${line}`).join('\n'))
    ].join('\n\n'));
  }
  if (validation.results?.length) {
    return validation.results.map(result => describeCheck(result, 'response', result.ok, validation.schema));
  }
  if (validation.test || validation.stdout || validation.stderr || validation.error || validation.note) {
    return [describeCheck(validation, 'response')];
  }
  return [];
}

export function responseValidationOutput(validation) {
  if (!validation) return null;
  const { schema, ran, ok, note } = validation;
  const diagnostics = validation.results?.[0]?.chunk !== undefined
    ? chunkDiagnostics(validation.results)
    : validationDiagnostics(validation);
  return { schema, ran, ok, note, diagnostics };
}
