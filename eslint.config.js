const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'build/**', 'dist/**', 'desktop/**', 'server/public/**'] },
  {
    files: ['**/*.js', '**/*.cjs'],
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
