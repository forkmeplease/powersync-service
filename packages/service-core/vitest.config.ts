import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    setupFiles: './test/src/setup.ts',
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    pool: 'threads'
  }
});
