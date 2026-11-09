import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import YAML from 'yaml';

// The official SMPTE ST 2138 validator (st2138-a) is vendored as a git submodule
// under `vendor/st2138-a`. We run `tools/validate.js` from the submodule directly
// — no runtime downloads. validate.js performs full JSON-schema validation *and*
// the conformance checks in `tools/checks/`, so the JSON schema step the old
// implementation relied on is preserved.
//
// `__dirname` resolves to `<root>/src/validation` (ts-node) or
// `<root>/dist/validation` (compiled); both sit two levels below the repo root
// where `vendor/` lives. Overridable via env for non-standard layouts.
const SUBMODULE_ROOT =
  process.env.ST2138_SUBMODULE_ROOT || path.join(__dirname, '..', '..', 'vendor', 'st2138-a');
const TOOLS_DIR = path.join(SUBMODULE_ROOT, 'tools');
const DEVICE_SCHEMA_YAML = path.join(SUBMODULE_ROOT, 'interface', 'schema', 'device.yaml');
// validator.js does `require('./data/device.json')`, so the compiled schema must
// live at tools/data/device.json (git-ignored in the submodule — it is a build
// artifact normally produced by build-openapi.sh).
const DEVICE_SCHEMA_JSON = path.join(TOOLS_DIR, 'src', 'data', 'device.json');

export const VALIDATOR_SOURCE_URL =
  process.env.ST2138_VALIDATOR_SOURCE_URL ||
  'https://github.com/SMPTE/st2138-a/blob/develop/tools/bin/cli.js';

export type St2138ValidateResult = {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failingLine: number | null;
  failingLines: number[];
  failingLineContent: Array<{ line: number; content: string }>;
  error?: string;
};

function extractFailingLines(...sources: Array<string | undefined>): number[] {
  const found = new Set<number>();
  const combined = sources.filter((source): source is string => typeof source === 'string' && source.length > 0);

  for (const text of combined) {
    // validate.js commonly reports ranges like "on lines 75-75".
    const lineRangePattern = /\bon\s+lines?\s+(\d+)\s*-\s*(\d+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = lineRangePattern.exec(text)) !== null) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) continue;
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let line = min; line <= max; line += 1) {
        found.add(line);
      }
    }

    const explicitLinePattern = /\bline\s+(\d+)\b/gi;
    while ((match = explicitLinePattern.exec(text)) !== null) {
      const line = Number(match[1]);
      if (Number.isInteger(line) && line > 0) found.add(line);
    }

    const fileLineColPattern = /:[ \t]?(\d+):(\d+)\b/g;
    while ((match = fileLineColPattern.exec(text)) !== null) {
      const line = Number(match[1]);
      if (Number.isInteger(line) && line > 0) found.add(line);
    }
  }

  return Array.from(found).sort((a, b) => a - b);
}

function extractLineContent(text: string, lines: number[]): Array<{ line: number; content: string }> {
  if (!text || lines.length === 0) return [];
  const split = text.split(/\r?\n/);
  const results: Array<{ line: number; content: string }> = [];

  for (const lineNumber of lines) {
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > split.length) continue;
    results.push({
      line: lineNumber,
      content: split[lineNumber - 1]
    });
  }

  return results;
}

function stripKeysRecursive(value: any, isRoot = true): any {
  if (Array.isArray(value)) {
    return value.map((entry) => stripKeysRecursive(entry, false));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'x-anchors' || (key === '$id' && !isRoot)) continue;
      output[key] = stripKeysRecursive(child, false);
    }
    return output;
  }
  return value;
}

// Compile tools/data/device.json from the submodule's interface/schemata/device.yaml,
// mirroring build-openapi.sh: resolve YAML anchors/merge keys, then strip
// `x-anchors` and every `$id` (AJV runs in strict mode and chokes on stray $id).
// Regenerated once per process so a `git submodule update` is picked up on restart.
let schemaBuild: Promise<void> | null = null;
let validatorEngine: any;

function ensureDeviceSchemaJson(): Promise<void> {
  if (!schemaBuild) {
    schemaBuild = (async () => {
      const rawYaml = await fs.readFile(DEVICE_SCHEMA_YAML, 'utf8');
      const parsed = YAML.parseDocument(rawYaml, { merge: true }).toJS();
      const sanitized = stripKeysRecursive(parsed);
      await fs.mkdir(path.dirname(DEVICE_SCHEMA_JSON), { recursive: true });
      const temporarySchema = `${DEVICE_SCHEMA_JSON}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporarySchema, JSON.stringify(sanitized, null, 2), 'utf8');
        await fs.rename(temporarySchema, DEVICE_SCHEMA_JSON);
      } finally {
        await fs.rm(temporarySchema, { force: true });
      }
    })().catch((err) => {
      // Allow a retry on the next call if generation failed (e.g. submodule not
      // yet initialized when the first request landed).
      schemaBuild = null;
      throw err;
    });
  }
  return schemaBuild;
}

/**
 * Runs the vendored SMPTE st2138-a validator against one device model.
 * Performs schema validation and the package's conformance checks.
 */
export async function runSt2138ValidateJsOnModel(model: unknown): Promise<St2138ValidateResult> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-your-catena-st2138-'));
  let modelPath = '';

  try {
    await ensureDeviceSchemaJson();

    // The validator selects a schema from the filename before the first dot.
    modelPath = path.join(runDir, 'device.model.json');
    await fs.writeFile(modelPath, JSON.stringify(model, null, 2), 'utf8');

    const Validator = require(path.join(TOOLS_DIR, 'src', 'validator'));
    const { parse: parseSourceMap } = require(path.join(TOOLS_DIR, 'src', 'sourcemap')) as {
      parse: (text: string) => { sourceMap: { linesFor: (pointer: string) => { start: number; end: number } | null } };
    };
    validatorEngine ??= new Validator();
    const modelText = JSON.stringify(model, null, 2);
    const { sourceMap } = parseSourceMap(modelText);
    const validation = validatorEngine.validateData('device', model, sourceMap);
    const diagnostics = validation.diagnostics.map((diagnostic: any) => {
      const lines = diagnostic.lines ? ` on lines ${diagnostic.lines.start}-${diagnostic.lines.end}` : '';
      return `${diagnostic.level.toUpperCase()}: ${diagnostic.message} at ${diagnostic.instancePath}${lines}`;
    });
    const stdout = [
      `Applying schema 'device' to '${pathToFileURL(modelPath).toString()}'`,
      ...diagnostics,
      validation.valid ? '✅ Schema validation succeeded.' : '❌ Validation failed.'
    ].join('\n');
    const failingLines = extractFailingLines(stdout);
    const failingLineContent = extractLineContent(modelText, failingLines);

    return {
      ran: true,
      ok: validation.valid,
      exitCode: validation.valid ? 0 : 2,
      stdout: stdout.trim(),
      stderr: '',
      failingLine: failingLines.length ? failingLines[0] : null,
      failingLines,
      failingLineContent
    };
  } catch (error: any) {
    const exitCode = typeof error?.code === 'number' ? error.code : null;
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const errorMessage = error?.message || String(error);
    const failingLines = extractFailingLines(stdout, stderr, errorMessage);
    const modelText = modelPath ? await fs.readFile(modelPath, 'utf8').catch(() => '') : '';
    const failingLineContent = extractLineContent(modelText, failingLines);

    return {
      ran: true,
      ok: false,
      exitCode,
      stdout,
      stderr,
      failingLine: failingLines.length ? failingLines[0] : null,
      failingLines,
      failingLineContent,
      error: errorMessage
    };
  } finally {
    try {
      await fs.rm(runDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup issues
    }
  }
}

export async function runSt2138ValidateResponse(schemaName: string, value: unknown): Promise<St2138ValidateResult> {
  try {
    await ensureDeviceSchemaJson();
    const Validator = require(path.join(TOOLS_DIR, 'src', 'validator'));
    const { parse: parseSourceMap } = require(path.join(TOOLS_DIR, 'src', 'sourcemap')) as {
      parse: (text: string) => { sourceMap: { linesFor: (pointer: string) => { start: number; end: number } | null } };
    };
    validatorEngine ??= new Validator();
    const sourceText = JSON.stringify(value, null, 2);
    const { sourceMap } = parseSourceMap(sourceText);
    const validation = validatorEngine.validateData(schemaName, value, sourceMap);
    const diagnostics = validation.diagnostics.map((diagnostic: any) => {
      const lines = diagnostic.lines ? ` on lines ${diagnostic.lines.start}-${diagnostic.lines.end}` : '';
      return `${diagnostic.level.toUpperCase()}: ${diagnostic.message} at ${diagnostic.instancePath}${lines}`;
    });
    const stdout = [
      `Applying schema '${schemaName}' to response`,
      ...diagnostics,
      validation.valid ? '✅ Schema validation succeeded.' : '❌ Validation failed.'
    ].join('\n');
    const failingLines = extractFailingLines(stdout);

    return {
      ran: true,
      ok: validation.valid,
      exitCode: validation.valid ? 0 : 2,
      stdout,
      stderr: '',
      failingLine: failingLines.length ? failingLines[0] : null,
      failingLines,
      failingLineContent: extractLineContent(sourceText, failingLines)
    };
  } catch (error) {
    return {
      ran: true,
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      failingLine: null,
      failingLines: [],
      failingLineContent: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
