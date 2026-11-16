import { defineConfig, devices } from '@playwright/test';

/**
 * Opt-in heavy suite (>= 10 GiB through a real browser into MinIO). Never part of the regular run or CI:
 * start it with `pnpm test:heavy` (heavy/run.mjs), which checks disk space, starts a dedicated MinIO and the
 * harness, and cleans everything up afterwards.
 */
const PORT = Number(process.env.E2E_PORT ?? 5299);
export default defineConfig({
  testDir: './heavy',
  testMatch: /.*\.heavy\.ts$/,
  timeout: Number(process.env.HEAVY_TIMEOUT_MS ?? 30 * 60_000),
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: process.env.HEAVY_OUTPUT_DIR ?? 'test-results-heavy',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
