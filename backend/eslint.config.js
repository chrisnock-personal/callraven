const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      // catch (e) {} is a deliberate best-effort-cleanup idiom throughout
      // this codebase (e.g. non-critical unlink/close calls) — not a bug.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
