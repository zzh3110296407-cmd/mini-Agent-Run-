import { builtinModules } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const BANNED_IMPORTS = [];
const BANNED_SYNTAX = [];
const RUNTIME_FILES = ['apps/server/src/runtime/**/*.{js,mjs,cjs,ts,mts,cts}'];
const serverSource = fileURLToPath(new URL('./apps/server/src/', import.meta.url));
const runtimeBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { injection: 'Inject runtime dependencies through interfaces.' },
  },
  create(context) {
    function check(source) {
      if (typeof source?.value !== 'string' || !/^\.\.?(?:[/\\]|$)/.test(source.value)) return;

      const target = resolve(dirname(context.physicalFilename), source.value);
      const directory = relative(serverSource, target).split(sep, 1)[0];
      const normalized = sep === '\\' ? directory.toLowerCase() : directory;
      if (normalized === 'db' || normalized === 'config') {
        context.report({ node: source, messageId: 'injection' });
      }
    }

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

  return {
    files,
    rules: {
      'no-restricted-imports': ['error', {
        patterns: patterns.map((regex) => ({ regex, message })),
      }],
      'no-restricted-syntax': [
        'error',
        ...BANNED_SYNTAX,
        { selector: 'ImportExpression[source.value=' + indirect + ']', message },
        { selector: 'CallExpression[callee.name="require"][arguments.0.value=' + indirect + ']', message },
      ],
    },
  };
}

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', '**/coverage/**', '**/.vite/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.{js,mjs,cjs}', 'apps/server/**/*.{ts,js}', 'scripts/**/*.ts', '*.config.ts'],
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
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,vue}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: importPatterns([]).map((regex) => ({ regex })),
      }],
      'no-restricted-syntax': ['error', ...BANNED_SYNTAX],
    },
  },
  boundary(
    ['apps/web/**/*.{js,mjs,cjs,ts,mts,cts,vue}'],
    ['fastify', 'better-sqlite3', 'dotenv', '@mini-agent-run/server', ...builtinModules],
    ['^node:', '(?:^|/)apps/server(?:/|$)', '^(?:\\.\\./)+server(?:/|$)'],
    'Use browser dependencies and the shared workspace in web code.',
  ),
  boundary(
    ['packages/shared/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ['fastify', 'better-sqlite3', 'vue', 'dotenv', '@mini-agent-run/server', '@mini-agent-run/web'],
    ['(?:^|/)apps(?:/|$)'],
    'Keep application dependencies out of the shared workspace.',
  ),
  boundary(
    RUNTIME_FILES,
    ['fastify', 'better-sqlite3', 'openai', 'dotenv'],
    ['^(?:[A-Za-z]:)?/(?:[^/]+/)*server/src/(?:db|config)(?:/|$)'],
    'Inject runtime dependencies through interfaces.',
  ),
  {
    files: RUNTIME_FILES,
    plugins: { workspace: { rules: { 'runtime-boundary': runtimeBoundary } } },
    rules: { 'workspace/runtime-boundary': 'error' },
  },
];
