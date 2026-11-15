import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/** Resolve workspace packages to their TypeScript sources (`source` export condition), no build needed. */
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions], externalConditions: ['source'] } },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
