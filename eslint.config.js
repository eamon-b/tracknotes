import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // ignoreRestSiblings: `const { pois: _pois, ...rest } = x` is how a field is left out
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // Plain-JS build scripts run on Node (TypeScript files get their globals from @types/node)
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
);
