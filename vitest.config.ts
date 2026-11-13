import { defineConfig } from 'vitest/config';

/**
 * Two projects with different characteristics:
 *
 * - `unit` exercises the hashing, traversal, comparison and reporting logic.
 *   Most of it runs against real temporary directories, because a file
 *   integrity tool whose filesystem behaviour is only ever tested against a
 *   fake filesystem proves very little.
 * - `integration` runs the compiled binary as a child process and asserts on
 *   its real output and exit codes. Its files run one at a time so concurrent
 *   fixtures cannot interfere through the process-wide working directory.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
