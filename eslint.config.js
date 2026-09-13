import eslintJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  eslintJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { module: true },
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.ts', '.json', '.mjs', '.cjs'],
        },
      },
    },
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
      'import/no-unused-modules': 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'no-console': 'error',
      'no-debugger': 'error',
      'no-unused-vars': 'off',
    },
  },
  prettierConfig,
  {
    files: ['src/review/pipeline.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/review/schema.ts'],
    rules: {
      'no-misleading-character-class': 'off',
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist', 'node_modules', '.git', 'data', '.env', '*.pem', '.kilo', 'coverage'],
  },
);
