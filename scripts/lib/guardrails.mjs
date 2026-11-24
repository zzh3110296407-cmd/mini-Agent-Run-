import { basename } from 'node:path';
import ts from 'typescript';

export const ENV_EXAMPLE = '.env.example';
export const ENV_SCHEMA = 'apps/server/src/config/env.ts';
const WAIVER_FILE = 'scripts/guardrail-waivers.json';
export const GRAPH_FILE = 'docs/feature-graph.json';
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

const GRAPH_TEXT_TOKENS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);
const FEATURE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MILESTONE_ID = /^[A-Za-z0-9_-]+$/;

export function isFeatureTestFile(file) {
  return TEST_FILE.test(file);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values, valid) {
  return Array.isArray(values) && values.length > 0 && values.every(valid)
    && new Set(values).size === values.length;
}

function graphNodeIds(nodes, staged, milestones, report) {
  const ids = new Set();
  if (!Array.isArray(nodes) || nodes.length === 0) {
    report('nodes must be a non-empty array.');
    return ids;
  }

  for (const [index, node] of nodes.entries()) {
    const field = 'nodes[' + index + ']';
    if (!isObject(node)) {
      report(field + ' must be an object.');
      continue;
    }

    if (typeof node.id !== 'string' || !FEATURE_ID.test(node.id)) {
      report(field + '.id must be a valid feature ID.');
    } else if (ids.has(node.id)) {
      report(field + '.id duplicates feature ID ' + node.id + '.');
    } else {
      ids.add(node.id);
    }

    if (!staged) continue;
    for (const name of ['name', 'summary']) {
      if (!nonblank(node[name])) report(field + '.' + name + ' must be a non-empty string.');
    }
    if (!milestones.has(node.milestone)) report(field + '.milestone must be listed in milestones.');
    if (!uniqueStrings(node.packages, nonblank)) {
      report(field + '.packages must be a non-empty array of unique nonblank strings.');
    }
  }

  return ids;
}

function graphAdjacency(edges, ids, report) {
  const adjacency = new Map([...ids].map((id) => [id, new Set()]));
  if (!Array.isArray(edges)) {
    report('edges must be an array.');
    return adjacency;
  }

  for (const [index, edge] of edges.entries()) {
    const field = 'edges[' + index + ']';
    if (!isObject(edge)) {
      report(field + ' must be an object.');
      continue;
    }

    const { from, to } = edge;
    if (Object.hasOwn(edge, 'relation') && !nonblank(edge.relation)) {
      report(field + '.relation must be a non-empty string.');
    }
    if (!ids.has(from)) report(field + '.from must reference a known feature ID.');
    if (!ids.has(to)) report(field + '.to must reference a known feature ID.');
    if (!ids.has(from) || !ids.has(to)) continue;

    const neighbors = adjacency.get(from);
    if (from === to) report('Self-loop at feature ' + from + '.');
    else if (neighbors.has(to)) report('Duplicate edge ' + from + ' -> ' + to + '.');
    else neighbors.add(to);
  }

  return adjacency;
}

function findGraphCycle(adjacency) {
  const finished = new Set();

  for (const id of adjacency.keys()) {
    if (finished.has(id)) continue;

    const stack = [{ id, remaining: adjacency.get(id).values() }];
    const active = new Map([[id, 0]]);
    while (stack.length > 0) {
      const current = stack.at(-1);
      const next = current.remaining.next();
      if (next.done) {
        stack.pop();
        active.delete(current.id);
        finished.add(current.id);
        continue;
      }

      const neighbor = next.value;
      if (active.has(neighbor)) {
        return [...stack.slice(active.get(neighbor)).map((entry) => entry.id), neighbor];
      }
      if (!finished.has(neighbor)) {
        active.set(neighbor, stack.length);
        stack.push({ id: neighbor, remaining: adjacency.get(neighbor).values() });
      }
    }
  }
}

function recordGraphReferences(file, source, references) {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);

  function visit(node) {
    // The parser supplies lexical context for template continuations and regex literals.
    if (GRAPH_TEXT_TOKENS.has(node.kind)) {
      scanner.setTextPos(node.getStart(syntax));
      let token = scanner.scan();
      if (node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
        token = scanner.reScanTemplateToken(false);
      }
      if (token === node.kind) {
        // IDs can contain letters, digits, underscores, and hyphens. A whole run is one token.
        for (const word of scanner.getTokenValue().match(/[A-Za-z0-9_-]+/g) ?? []) {
          references.get(word)?.add(file);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(syntax);
}

export function inspectFeatureGraph(source, files) {
  const present = source !== undefined;
  const result = {
    ok: true, present, skipped: !present, activeMilestone: null, milestones: [],
    summary: { total: 0, required: 0, covered: 0, missing: 0, deferred: 0 },
    nodes: [], edges: [], violations: [],
  };
  if (!present) return result;

  function report(message) {
    result.ok = false;
    result.violations.push(issue('G-06', GRAPH_FILE, message));
  }

  let graph;
  try {
    graph = JSON.parse(source);
  } catch {
    report('Feature Graph must be valid JSON.');
    return result;
  }
  if (!isObject(graph)) {
    report('Feature Graph root must be an object.');
    return result;
  }

  const staged = ['activeMilestone', 'milestones', 'edges'].some((field) => Object.hasOwn(graph, field));
  const milestones = staged && Array.isArray(graph.milestones) ? graph.milestones : [];
  const milestoneSet = new Set(milestones);
  if (staged) {
    if (Object.hasOwn(graph, 'version') && !nonblank(graph.version)) {
      report('version must be a non-empty string.');
    }
    if (!uniqueStrings(milestones, (value) => typeof value === 'string' && MILESTONE_ID.test(value))) {
      report('milestones must be a non-empty array of unique milestone IDs.');
    }
    if (typeof graph.activeMilestone !== 'string' || !milestoneSet.has(graph.activeMilestone)) {
      report('activeMilestone must be listed in milestones.');
    }
  }

  const ids = graphNodeIds(graph.nodes, staged, milestoneSet, report);
  const adjacency = staged ? graphAdjacency(graph.edges, ids, report) : undefined;
  if (!result.ok) return result;

  if (staged) {
    result.activeMilestone = graph.activeMilestone;
    result.milestones = milestones;
    result.edges = graph.edges.map(({ from, to, relation }) =>
      relation === undefined ? { from, to } : { from, to, relation });
    const cycle = findGraphCycle(adjacency);
    if (cycle) report('Cycle detected: ' + cycle.join(' -> ') + '.');
  }

  const references = new Map([...ids].map((id) => [id, new Set()]));
  for (const [file, text] of files) {
    if (isFeatureTestFile(file)) recordGraphReferences(file, text, references);
  }

  const stageOrder = new Map(milestones.map((milestone, index) => [milestone, index]));
  const activeIndex = stageOrder.get(graph.activeMilestone);
  for (const { id, name, milestone, packages } of graph.nodes) {
    const required = !staged || stageOrder.get(milestone) <= activeIndex;
    const testFiles = [...references.get(id)].sort();
    const covered = testFiles.length > 0;
    result.nodes.push({
      id, name: staged ? name : null, milestone: staged ? milestone : null,
      packages: staged ? packages : [], required, covered, testFiles,
    });

    result.summary.total += 1;
    if (!required) {
      result.summary.deferred += 1;
    } else {
      result.summary.required += 1;
      if (covered) {
        result.summary.covered += 1;
      } else {
        result.summary.missing += 1;
        report('No test references feature ID ' + id + '.');
      }
    }
  }

  return result;
}

export function inspectRepositoryGraph(files, indexGraphSnapshot) {
  const worktree = inspectFeatureGraph(files.get(GRAPH_FILE), files);
  if (!indexGraphSnapshot) return worktree;

  const index = inspectFeatureGraph(indexGraphSnapshot.source, indexGraphSnapshot.files);
  const violations = [
    ...worktree.violations,
    ...index.violations.map((entry) => ({ ...entry, snapshot: 'index' })),
  ];
  return { ...(worktree.present ? worktree : index), ok: violations.length === 0, violations };
}

export function scanGuardrails({ envKeys, files, trackedPaths, indexFiles, presentPaths, indexEnv, indexGraphSnapshot }) {
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
  const graph = inspectRepositoryGraph(files, indexGraphSnapshot);
  if (graph.skipped) skipped.push('G-06');
  violations.push(...graph.violations);

  return { ok: violations.length === 0, violations, skipped };
}
