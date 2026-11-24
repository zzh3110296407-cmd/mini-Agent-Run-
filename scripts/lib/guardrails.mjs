import { basename } from 'node:path';
import ts from 'typescript';

export const ENV_EXAMPLE = '.env.example';
export const ENV_SCHEMA = 'apps/server/src/config/env.ts';
const WAIVER_FILE = 'scripts/guardrail-waivers.json';
const GRAPH_FILE = 'docs/feature-graph.json';
const LOCKFILES = new Set(['pnpm-lock.yaml', 'yarn.lock']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|css|jsonc?|html|ya?ml|toml|ini|sql|sh|ps1)$/i;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE = /^(?:(?:apps|packages)\/[^/]+\/tests|scripts\/tests)\/.+\.test\.ts$/;
const VITEST_RUNNERS = new Set(['it', 'test', 'describe', 'suite']);
const TEST_MODIFIERS = new Set(['skip', 'only']);

const TOKEN_RULES = [
  { rule: 'G-04a', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, message: 'Possible hardcoded API key.' },
  { rule: 'G-05a', pattern: /@ts-(?:ignore|expect-error|nocheck)\b|\beslint-(?:disable(?:-next-line|-line)?)\b/g,
    message: 'Unregistered suppression directive.' },
];

export function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

export function isScannablePath(file) {
  return file === ENV_EXAMPLE || basename(file).toLowerCase() === '.npmrc' || SOURCE_FILE.test(file);
}

function issue(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

function readWaivers(source, violations) {
  if (source === undefined) return [];

  try {
    const { waivers } = JSON.parse(source);
    if (!Array.isArray(waivers) || !waivers.every((entry) =>
      entry && ['G-05a', 'G-05b'].includes(entry.rule)
      && typeof entry.file === 'string' && entry.file.length > 0
      && Number.isInteger(entry.line) && entry.line > 0
      && typeof entry.token === 'string' && entry.token.length > 0
      && typeof entry.reason === 'string' && entry.reason.trim().length > 0)) {
      throw new Error('Invalid waiver entries');
    }

    return waivers;
  } catch {
    violations.push(issue('G-05', WAIVER_FILE, 'Waivers must have rule, file, line, token and reason.'));
    return [];
  }
}

function isVitestImport(clause) {
  const source = clause.parent.moduleSpecifier;
  return !clause.isTypeOnly && ts.isStringLiteral(source) && source.text === 'vitest';
}

function isVitestRunner(runner, checker) {
  if (ts.isPropertyAccessExpression(runner)) {
    const namespace = runner.expression;
    if (!ts.isIdentifier(namespace) || !VITEST_RUNNERS.has(runner.name.text)) return false;

    return checker.getSymbolAtLocation(namespace)?.declarations?.some((declaration) =>
      ts.isNamespaceImport(declaration) && isVitestImport(declaration.parent));
  }

  const symbol = checker.getSymbolAtLocation(runner);
  if (!symbol) return VITEST_RUNNERS.has(runner.text);

  return symbol.declarations?.some((declaration) =>
    ts.isImportSpecifier(declaration) && !declaration.isTypeOnly
    && isVitestImport(declaration.parent.parent)
    && VITEST_RUNNERS.has((declaration.propertyName ?? declaration.name).text));
}

function testModifierCalls(file, source) {
  if (!SCRIPT_FILE.test(file) || !/\b(?:skip|only)\b/.test(source)) return [];

  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const candidates = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      let modifier = node.expression;
      if (ts.isPropertyAccessExpression(modifier) && modifier.name.text === 'each') {
        modifier = modifier.expression;
      }
      if (ts.isPropertyAccessExpression(modifier) && TEST_MODIFIERS.has(modifier.name.text)) {
        let runner = modifier.expression;
        while (ts.isPropertyAccessExpression(runner) && ['concurrent', 'sequential'].includes(runner.name.text)) {
          runner = runner.expression;
        }
        if (ts.isIdentifier(runner) || ts.isPropertyAccessExpression(runner)) {
          candidates.push({ runner, modifier });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(syntax);
  if (candidates.length === 0) return [];

  const options = { allowJs: true, noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === file ? syntax : undefined;
  // Only local bindings are needed. Vitest itself does not need to be resolved.
  const checker = ts.createProgram([file], options, host).getTypeChecker();

  return candidates.filter(({ runner }) => isVitestRunner(runner, checker)).map(({ modifier }) => ({
    rule: 'G-05b',
    message: 'Unregistered focused or skipped test.',
    line: syntax.getLineAndCharacterOfPosition(modifier.getStart(syntax)).line + 1,
    token: modifier.getText(syntax).replace(/\s+/g, ''),
  }));
}

function scanTokens(file, source, waivers) {
  const antiBypassScope = file !== WAIVER_FILE && /^(?:(?:apps|packages|scripts)\/|[^/]+\.config\.)/.test(file);
  const matches = TOKEN_RULES.flatMap(({ rule, pattern, message }) => {
    if (rule !== 'G-04a' && !antiBypassScope) return [];
    return [...source.matchAll(pattern)].map((match) => ({
      rule,
      message,
      line: source.slice(0, match.index).split('\n').length,
      token: match[0].replace(/\s+/g, ''),
    }));
  });
  if (antiBypassScope) matches.push(...testModifierCalls(file, source));

  return matches.filter(({ rule, line, token }) =>
    rule === 'G-04a' || !waivers.some((entry) =>
      entry.rule === rule && entry.file === file && entry.line === line && entry.token === token),
  ).map(({ rule, line, message }) => issue(rule, file, message, line));
}

function checkRepositoryPaths(trackedPaths, presentPaths) {
  const violations = [];

  for (const file of trackedPaths) {
    const name = basename(file).toLowerCase();
    if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
      violations.push(issue('G-04b', file, 'Remove this environment file from the Git index.'));
    }
  }

  for (const file of new Set([...trackedPaths, ...presentPaths])) {
    const name = basename(file).toLowerCase();
    if (LOCKFILES.has(name) || name === '.husky' || file.toLowerCase().startsWith('.husky/')) {
      violations.push(issue('G-04b', file, 'Use npm workspaces and the repository verification scripts.'));
    }
  }

  return violations;
}

function checkEnvTemplate(source, envKeys) {
  if (source === undefined) return [issue('G-04c', ENV_EXAMPLE, 'Environment template is missing.')];
  if (!envKeys) return [issue('G-04c', ENV_SCHEMA, 'Unable to load environment schema keys.')];

  const violations = [];
  const seen = new Map();
  const schemaKeys = new Set(envKeys);

  for (const [index, text] of source.split('\n').entries()) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text)?.[1];
    if (!key) continue;

    if (seen.has(key)) {
      violations.push(issue('G-04c', ENV_EXAMPLE, 'Duplicate key: ' + key, index + 1));
    } else {
      seen.set(key, index + 1);
    }
  }

  for (const key of schemaKeys) {
    if (!seen.has(key)) violations.push(issue('G-04c', ENV_EXAMPLE, 'Missing schema key: ' + key));
  }
  for (const [key, line] of seen) {
    if (!schemaKeys.has(key)) violations.push(issue('G-04c', ENV_EXAMPLE, 'Unknown schema key: ' + key, line));
  }

  return violations;
}

function checkFeatureGraph(source, files) {
  let ids;

  try {
    const { nodes } = JSON.parse(source);
    ids = nodes.map((node) => node.id);
    if (!ids.every((id) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id))
      || new Set(ids).size !== ids.length) {
      throw new Error('Invalid node IDs');
    }
  } catch {
    return [issue('G-06', GRAPH_FILE, 'Expected a nodes array with unique feature IDs.')];
  }

  const tests = [...files].filter(([path]) => TEST_FILE.test(path)).map(([, text]) => text);
  return ids.flatMap((id) => {
    const reference = new RegExp('(?<![A-Za-z0-9_-])' + id + '(?![A-Za-z0-9_-])');
    return tests.some((text) => reference.test(text))
      ? []
      : [issue('G-06', GRAPH_FILE, 'No test references feature ID ' + id + '.')];
  });
}

export function scanGuardrails({ envKeys, files, trackedPaths, indexFiles, presentPaths, indexEnv }) {
  const violations = checkRepositoryPaths(trackedPaths, [...files.keys(), ...presentPaths]);
  const skipped = [];
  const waivers = readWaivers(files.get(WAIVER_FILE), violations);
  const indexWaivers = indexFiles.has(WAIVER_FILE)
    ? readWaivers(indexFiles.get(WAIVER_FILE), violations)
    : waivers;

  for (const [file, source] of files) {
    violations.push(...scanTokens(file, source, waivers));
  }
  for (const [file, source] of indexFiles) {
    violations.push(...scanTokens(file, source, indexWaivers).map((entry) => ({ ...entry, snapshot: 'index' })));
  }

  violations.push(...checkEnvTemplate(files.get(ENV_EXAMPLE), envKeys));
  if (indexEnv) {
    violations.push(...checkEnvTemplate(indexEnv.template, indexEnv.keys)
      .map((entry) => ({ ...entry, snapshot: 'index' })));
  }
  const graph = files.get(GRAPH_FILE);
  if (graph === undefined) {
    skipped.push('G-06');
  } else {
    violations.push(...checkFeatureGraph(graph, files));
  }

  return { ok: violations.length === 0, violations, skipped };
}
