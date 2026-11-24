import { basename } from 'node:path';

const ENV_EXAMPLE = '.env.example';
const WAIVER_FILE = 'scripts/guardrail-waivers.json';
const GRAPH_FILE = 'docs/feature-graph.json';
const LOCKFILES = new Set(['pnpm-lock.yaml', 'yarn.lock']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|css|jsonc?|html|ya?ml|toml|ini|sql|sh|ps1)$/i;
const TEST_FILE = /^(?:(?:apps|packages)\/[^/]+\/tests|scripts\/tests)\/.+\.test\.ts$/;

const TOKEN_RULES = [
  { rule: 'G-04a', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, message: 'Possible hardcoded API key.' },
  { rule: 'G-05a', pattern: /@ts-(?:ignore|expect-error|nocheck)\b|\beslint-(?:disable(?:-next-line|-line)?)\b/g,
    message: 'Unregistered suppression directive.' },
  { rule: 'G-05b', pattern: /\b(?:it|test|describe|suite)(?:\s*\.\s*(?:concurrent|sequential))*\s*\.\s*(?:skip|only)(?=\s*[.(])/g,
    message: 'Unregistered focused or skipped test.' },
];

export function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

export function isScannablePath(file) {
  return file === ENV_EXAMPLE || SOURCE_FILE.test(file);
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

function scanTokens(file, source, waivers) {
  const violations = [];

  for (const { rule, pattern, message } of TOKEN_RULES) {
    if (rule !== 'G-04a' && !/^(?:(?:apps|packages|scripts)\/|[^/]+\.config\.)/.test(file)) continue;
    if (rule !== 'G-04a' && file === WAIVER_FILE) continue;

    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      const token = match[0].replace(/\s+/g, '');
      const waived = rule !== 'G-04a' && waivers.some((entry) =>
        entry.rule === rule && entry.file === file && entry.line === line && entry.token === token);

      if (!waived) violations.push(issue(rule, file, message, line));
    }
  }

  return violations;
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

export function scanGuardrails({ envKeys, files, trackedPaths, indexFiles, presentPaths }) {
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
  const graph = files.get(GRAPH_FILE);
  if (graph === undefined) {
    skipped.push('G-06');
  } else {
    violations.push(...checkFeatureGraph(graph, files));
  }

  return { ok: violations.length === 0, violations, skipped };
}
