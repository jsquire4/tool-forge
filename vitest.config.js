import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/**/*.test.js', 'tests/**/*.test.js', 'widget/**/*.test.js'],
    exclude: ['node_modules/**', '.claude/**']
  }
});
