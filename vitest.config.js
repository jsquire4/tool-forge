import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['cli/**/*.test.js', 'tests/**/*.test.js'],
    exclude: ['node_modules/**', '.claude/**']
  }
});
