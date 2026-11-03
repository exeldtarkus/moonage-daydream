// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'test-extention/**', 'docs/**', '.claude/**', 'graphify-out/**', 'media/**', 'scripts/**', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // aturan project: log lewat LogOutputChannel / driverLog, bukan console
      'no-console': 'error',
      // aturan project: catch tidak boleh kosong (wajib log ERROR)
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-irregular-whitespace': ['error', { skipStrings: false, skipTemplates: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // test real dijalankan di jendela VS Code: modul extension dimuat lazy lewat require
    files: ['src/test/real/**/*.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
