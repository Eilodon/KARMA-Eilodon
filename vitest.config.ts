import { defineConfig } from "vitest/config";

/**
 * Vitest is configured to ignore the compiled output `dist/` and other build artefacts.
 *
 * Without this exclusion, `vitest run` (no argument) double-counts every source test against
 * its compiled twin under `dist/__tests__/`, and the dist versions fail at runtime because
 * a handful of tests read source files by relative `.ts` path — paths that don't exist when
 * the same code runs from `dist/`. This is a build artefact, not a real test target.
 *
 * `pnpm test` (which is `vitest run src`) was already correct; this config makes the bare
 * `pnpm vitest run` invocation give the same answer.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cache/**",
      "**/out/**",
      "**/broadcast/**",
      "**/lib/**",
      "**/contracts-odra/target/**",
      "**/.git/**",
      // circuits/test/*.test.mjs are plain Node scripts run via `node` (see
      // circuits/package.json's `dummy:test` / `credential:test` scripts) — they exit non-
      // zero on failure but don't use vitest's API. Excluding them here so vitest doesn't
      // confuse "couldn't import snarkjs" with an actual test failure.
      "**/circuits/test/**",
    ],
  },
});
