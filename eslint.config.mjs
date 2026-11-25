import { realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { workspaceDependencies, workspaceDirectory, workspaceName } from './scripts/lib/workspace-dag.mjs';

const BANNED_IMPORTS = ['bombadil', '@antithesishq/bombadil'];
const BANNED_SYNTAX = [];
const RUNTIME_FILES = ['apps/server/src/runtime/**/*.{js,mjs,cjs,ts,mts,cts}'];
const root = fileURLToPath(new URL('.', import.meta.url));
const physicalRoot = realpathSync.native(root);
const serverSource = resolve(root, 'apps/server/src');
const physicalServerSource = resolve(physicalRoot, 'apps/server/src');
const relativeImport = /^\.\.?(?:[/\\]|$)/;

function visitImports(check) {
  return {
    ImportDeclaration: (node) => check(node.source),
    ExportNamedDeclaration: (node) => check(node.source),
    ExportAllDeclaration: (node) => check(node.source),
    ImportExpression: (node) => check(node.source),
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        check(node.arguments[0]);
      }
    },
  };
}

function literalSpecifier(source) {
  if (typeof source?.value === 'string') return source.value;
  if (source?.type === 'TemplateLiteral' && source.expressions.length === 0) {
    return source.quasis[0]?.value.cooked;
  }
}

function resolveImport(filename, specifier) {
  if (specifier.startsWith('file:')) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return;
    }
  }
  if (relativeImport.test(specifier) || isAbsolute(specifier)) return resolve(dirname(filename), specifier);
}

function physicalPath(path) {
  const suffix = [];
  let entry = path;

  // TypeScript can resolve an unbuilt .js specifier through its source directory.
  // Resolve that directory's links even when the final file is absent.
  while (true) {
    try {
      return resolve(realpathSync.native(entry), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(entry);
    if (entry === parent) return path;
    suffix.push(basename(entry));
    entry = parent;
  }
}

function repoPath(path, base = root) {
  const normalized = relative(base, path).split(sep).join('/');
  return sep === '\\' ? normalized.toLowerCase() : normalized;
}

function isServerInfrastructure(path, source) {
  const directory = repoPath(path, source).split('/', 1)[0];
  return directory === 'db' || directory === 'config';
}

const runtimeBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { injection: 'Inject runtime dependencies through interfaces.' },
  },
  create(context) {
    return visitImports((source) => {
      const specifier = literalSpecifier(source);
      if (!specifier || (!relativeImport.test(specifier) && !specifier.startsWith('file:'))) return;

      const target = resolveImport(context.physicalFilename, specifier);
      if (!target) return;
      if (isServerInfrastructure(target, serverSource)
        || isServerInfrastructure(physicalPath(target), physicalServerSource)) {
        context.report({ node: source, messageId: 'injection' });
      }
    });
  },
};

const packageDag = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { boundary: '{{from}} cannot import from {{target}}.' },
  },
  create(context) {
    const file = context.physicalFilename;
    const from = workspaceDirectory(repoPath(file));
    const allowed = workspaceDependencies[from];
    if (!allowed) return {};
    const isDenied = (target) => target && target !== from && !allowed.includes(target);

    return visitImports((source) => {
      const specifier = literalSpecifier(source);
      if (!specifier) return;

      const path = resolveImport(file, specifier);
      if (!path) return;
      const logicalWorkspace = workspaceDirectory(repoPath(path));
      const target = isDenied(logicalWorkspace) ? logicalWorkspace
        : workspaceDirectory(repoPath(physicalPath(path), physicalRoot));
      if (!isDenied(target)) return;

      context.report({ node: source, messageId: 'boundary', data: { from, target } });
    });
  },
};

function importPatterns(packages, paths = []) {
  const packageNames = [...BANNED_IMPORTS, ...packages]
    .map((name) => name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  const packagePattern = packageNames.length ? ['^(?:' + packageNames.join('|') + ')(?:/|$)'] : [];
  return [...packagePattern, ...paths];
}

function boundary(files, packages, paths, message) {
  const patterns = importPatterns(packages, paths);
  const indirect = '/' + patterns.join('|').replaceAll('/', '\\/') + '/i';
  const restricted = [
    ['ImportExpression', 'source'],
    ['CallExpression[callee.name="require"]', 'arguments.0'],
  ].flatMap(([node, field]) => [
    { selector: node + '[' + field + '.value=' + indirect + ']', message },
    { selector: node + '[' + field + '.expressions.length=0]['
        + field + '.quasis.0.value.cooked=' + indirect + ']', message },
  ]);

  return {
    files,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: patterns.map((regex) => ({ regex, message })),
      }],
      'no-restricted-syntax': ['error', ...BANNED_SYNTAX, ...restricted],
    },
  };
}

const externalRestrictions = {
  'packages/shared': ['fastify', 'better-sqlite3', 'vue', 'openai', 'dotenv', ...builtinModules],
  'packages/ai': ['fastify', 'better-sqlite3', 'vue', 'dotenv'],
  'packages/agent': ['fastify', 'better-sqlite3', 'vue', 'openai', 'dotenv'],
  'packages/tools': ['fastify', 'better-sqlite3', 'vue', 'openai', 'dotenv'],
  'packages/debug-agent': ['fastify', 'better-sqlite3', 'vue', 'openai', 'dotenv'],
  'apps/server': ['vue'],
  'apps/web': ['fastify', 'better-sqlite3', 'dotenv', ...builtinModules],
};

const workspaces = Object.keys(workspaceDependencies);
const workspaceFiles = (name) => name + '/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue}';

function blockedWorkspaceImports(name) {
  return workspaces.filter((target) => target !== name && !workspaceDependencies[name].includes(target))
    .map(workspaceName);
}

const legacyPaths = {
  'packages/shared': ['^node:', '(?:^|/)apps(?:/|$)'],
  'apps/web': ['^node:', '(?:^|/)apps/server(?:/|$)', '^(?:\\.\\./)+server(?:/|$)'],
};

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', '**/coverage/**', '**/.vite/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.{js,mjs,cjs}', 'apps/server/**/*.{ts,js}', 'scripts/**/*.ts', '*.config.ts',
      'packages/{ai,agent,tools,debug-agent}/**/*.{ts,mts,cts,tsx}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'vue/no-v-html': 'error',
    },
  },
  {
    files: ['packages/shared/**/*.{ts,mts,cts,tsx}'],
    rules: { 'no-restricted-globals': ['error', 'process', 'Buffer'] },
  },
  boundary(['**/*.{js,mjs,cjs,ts,mts,cts,vue}'], [], [],
    'Use the supported local UI exploration tooling.'),
  ...workspaces.map((name) => boundary(
    [workspaceFiles(name)],
    [...externalRestrictions[name], ...blockedWorkspaceImports(name)],
    legacyPaths[name] ?? [],
    'Use dependencies permitted by the workspace DAG.',
  )),
  boundary(
    [workspaceFiles('packages/tools/src')],
    [...externalRestrictions['packages/tools'], ...blockedWorkspaceImports('packages/tools'), 'fs', 'node:fs'],
    [],
    'Access trace files through TraceWorkspacePort and use dependencies permitted by the workspace DAG.',
  ),
  {
    files: workspaces.map(workspaceFiles),
    plugins: { workspace: { rules: { 'runtime-boundary': runtimeBoundary, 'package-dag': packageDag } } },
    rules: { 'workspace/package-dag': 'error' },
  },
  boundary(
    RUNTIME_FILES,
    [...externalRestrictions['apps/server'], ...blockedWorkspaceImports('apps/server'),
      'fastify', 'better-sqlite3', 'openai', 'dotenv'],
    ['^(?:[A-Za-z]:)?/(?:[^/]+/)*server/src/(?:db|config)(?:/|$)'],
    'Inject runtime dependencies through interfaces.',
  ),
  {
    files: RUNTIME_FILES,
    rules: { 'workspace/runtime-boundary': 'error' },
  },
];
