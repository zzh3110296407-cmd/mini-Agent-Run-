import { builtinModules } from 'node:module';
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const BANNED_IMPORTS = [];
const BANNED_SYNTAX = [];

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
    ['apps/server/src/runtime/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ['fastify', 'better-sqlite3', 'openai', 'dotenv'],
    ['^(?:\\.\\./)+(?:src/)?(?:db|config)(?:/|$)', '(?:^|/)server/src/(?:db|config)(?:/|$)'],
    'Inject runtime dependencies through interfaces.',
  ),
];
