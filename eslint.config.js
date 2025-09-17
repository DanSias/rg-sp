// eslint.config.js
import js from '@eslint/js';
import pluginImport from 'eslint-plugin-import';
import pluginN from 'eslint-plugin-n';
import prettier from 'eslint-plugin-prettier';
import pluginPromise from 'eslint-plugin-promise';
import pluginUnused from 'eslint-plugin-unused-imports';
import vitest from 'eslint-plugin-vitest';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'coverage', 'dist', 'build', '.env'] },

  js.configs.recommended,

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: pluginImport,
      'unused-imports': pluginUnused,
      n: pluginN,
      promise: pluginPromise,
      prettier,
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js', '.mjs'] },
      },
    },
    rules: {
      // ✅ App-friendly defaults
      'no-console': 'off',

      // ✅ Many teams prefer import order warnings only (auto-fixable)
      'import/order': [
        'warn',
        {
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // ✅ If you see false positives for ESM path resolution, temporarily relax:
      // 'import/no-unresolved': 'off',

      // ✅ Let us use process.env freely in a Node service
      'n/no-process-env': 'off',

      // ✅ If you see “unsupported Node features” warnings, set a target or turn off:
      // 'n/no-unsupported-features/es-syntax': 'off',
      // 'n/no-unsupported-features/node-builtins': 'off',

      // ✅ Aggressively remove unused imports (auto-fixable)
      'unused-imports/no-unused-imports': 'error',

      // ✅ Be lenient on unused vars (but allow _underscore to intentionally ignore)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // ✅ Prettier integration: formatting issues show up as ESLint errors
      'prettier/prettier': 'error',
    },
  },

  // Tests (Vitest)
  {
    files: ['tests/**/*.{js,mjs}'],
    plugins: { vitest },
    languageOptions: {
      globals: {
        ...globals.node,
        ...vitest.environments.env.globals,
      },
    },
    rules: {
      'no-console': 'off',
      // Optional test hygiene:
      // 'vitest/no-focused-tests': 'error',
      // 'vitest/no-disabled-tests': 'warn',
    },
  },
];
