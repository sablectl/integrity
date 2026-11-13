// Flat ESLint configuration.
//
// Type-aware linting is enabled for source and tests: the rules that matter
// most here — no floating promises, no unsafe member access on `any` — cannot
// be enforced without type information.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The benchmark is a plain ES module that imports the compiled output
    // rather than the sources, so it is not part of the TypeScript program
    // and type-aware linting has nothing to work from.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tests/fixtures/**',
      'scripts/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The CLI's entire purpose is writing to stdout and stderr.
      'no-console': 'off',

      // External data is parsed, never asserted. Angle-bracket assertions and
      // assertions onto object literals are refused outright; the few
      // remaining `as` uses are const assertions and narrowing of values this
      // code produced itself.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // This configuration file is plain JavaScript and is not part of the
    // TypeScript program, so type-aware rules cannot apply to it.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
