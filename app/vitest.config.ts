import viteTsConfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Test runner configuration kept separate from vite.config.ts.
// The application plugins (Nitro, TanStack Start) are build/dev concerns;
// under vitest 4 they evaluate CommonJS packages through the SSR module
// runner, which the unit tests do not need.
export default defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
  ],
  test: {
    environment: 'node',
  },
})
