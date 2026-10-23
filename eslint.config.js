const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'build/**', 'desktop/**', 'server/public/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
];
