import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  // Boundary contract: src/memory/ is a self-contained library. It may
  // import node:*, better-sqlite3, src/foundation/paths, and src/constants
  // only. Importing from assistant/commands/api/workflow/runtime would
  // couple the library to lwr internals and block future extraction.
  {
    files: ['src/memory/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../assistant/*',
                '../assistant',
                '../commands/*',
                '../commands',
                '../api/*',
                '../api',
                '../mcp/*',
                '../mcp',
                '../workflow/*',
                '../workflow',
                '../foundation/run',
                '../foundation/config',
                '../foundation/errors',
                '../foundation/session',
                '../foundation/cf-resolver',
              ],
              message:
                'src/memory/ is a self-contained library — only node:*, better-sqlite3, src/foundation/paths, and src/constants are allowed.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'tests/'],
  },
];
