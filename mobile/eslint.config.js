// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const { designTokenRestrictions } = require('./lint/design-token-restrictions');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'],
  },
  // jest.setup.js runs inside Jest, where `jest` is a global.
  {
    files: ['jest.setup.js'],
    languageOptions: {
      globals: { jest: 'readonly' },
    },
  },
  // Design-token enforcement: no raw colors / numeric font sizes in styles.
  // Disabling requires a justification comment, e.g.
  //   // eslint-disable-next-line no-restricted-syntax -- MapLibre expression, not an RN style
  {
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: ['src/tokens/**', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': ['error', ...designTokenRestrictions],
      // The raw palette is private to src/tokens — components go through
      // useTheme().colors so every color is theme-resolved.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tokens/colors', '**/tokens/colors.*'],
              message: 'The raw palette is private to src/tokens. Use useTheme().colors instead.',
            },
          ],
        },
      ],
    },
  },
  // A screen's scroll view runs under the Android navigation bar (edge-to-edge),
  // so a bare one stops its last rows behind it. Each screen used to opt in to
  // the bottom-inset padding by hand, and new screens kept forgetting (the
  // Today screen). Screens and full-screen panes use the padded versions.
  {
    files: [
      'app/**/*.{ts,tsx}',
      'src/features/guide/WaypointListPane.tsx',
      'src/features/plan/ResupplySelectList.tsx',
    ],
    ignores: ['**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['ScrollView', 'FlatList', 'SectionList'],
              allowTypeImports: true,
              message:
                'Use ScreenScrollView / ScreenFlatList / ScreenSectionList (src/navigation/ScreenScrollView) or KeyboardAwareScrollView, which pad for the bottom system bar.',
            },
          ],
        },
      ],
    },
  },
]);
