import { defineConfig } from 'vitest/config';

/** The evaluation harness, kept out of the normal test run: `npm run eval`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/eval/**/*.eval.ts'],
  },
});
