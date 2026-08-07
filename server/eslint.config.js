// Phase 0 Task 11: server lint baseline (eslint flat config).
// See MASTER_ROADMAP.md Phase 1 for the expanded rule set / tsconfig.typecheck.json.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // Dead jest-style test file (jest is not installed); replaced in Phase 1
      // by the process-topology tests that run under the tsx harness.
      'test/infra/processBoot.test.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      // The codebase predates strict typing and uses `any` pervasively (~340
      // sites). Phase 1 (MASTER_ROADMAP.md) owns the strict-typing pass; the
      // baseline keeps this rule disabled so the rest of the set can gate CI.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
