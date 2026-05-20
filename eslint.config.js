// ESLint flat config (ESLint v9+).
//
// Primary purpose: enforce the "local-first, no network" promise at the
// build gate. T12 from .notes/security.md — until this rule was added the
// promise was a convention, not an enforced contract.
//
// Secondary purpose: catch the small set of rules where tsc isn't enough
// (no unused variables, no console.log left in production code).

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Modules banned from `src/`. The product promise is that nothing leaves
 * the user's machine — that's only true if there's no networking code
 * anywhere in the runtime path.
 */
const BANNED_NETWORK_IMPORTS = [
  { name: 'http', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'https', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'node:http', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'node:https', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'undici', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'axios', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'node-fetch', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'cross-fetch', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'got', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'request', message: 'No network in src/. See .notes/security.md T12.' },
  { name: 'superagent', message: 'No network in src/. See .notes/security.md T12.' },
];

/**
 * Modules where shelling out to a child process would create injection
 * surface. T6 mitigation, enforced at the build gate.
 */
const BANNED_SHELL_IMPORTS = [
  { name: 'child_process', message: 'No child_process in src/. See .notes/security.md T6.' },
  { name: 'node:child_process', message: 'No child_process in src/. See .notes/security.md T6.' },
];

export default [
  // ---------------------------------------------------------------------
  // src/ — production code
  // ---------------------------------------------------------------------
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...BANNED_NETWORK_IMPORTS, ...BANNED_SHELL_IMPORTS],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },

  // ---------------------------------------------------------------------
  // tests/ and scripts/ — looser rules
  // ---------------------------------------------------------------------
  {
    files: ['tests/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Tests + scripts ARE allowed to use child_process (subprocess test,
      // smoke runner, future bench harness).
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // tests/fixtures — these files deliberately contain "unused" symbols
  // because they exist for parser tests to detect. This block must come
  // AFTER the broader tests/ block so its override wins (ESLint flat
  // configs cascade — later matches override earlier ones).
  // ---------------------------------------------------------------------
  {
    files: ['tests/fixtures/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Things to ignore
  // ---------------------------------------------------------------------
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.notes/**', 'pnpm-lock.yaml'],
  },
];
