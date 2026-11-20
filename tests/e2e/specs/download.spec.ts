import { expect, test } from '@playwright/test';
import { expectStatus, faults, file, MiB, resetFaults, sha256, task } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await resetFaults(page);
});

for (const sink of ['memory', 'opfs'] as const) {
  test(`managed download (${sink}) is byte-exact through dropped connections`, async ({ page, browserName }) => {
    test.skip(
      sink === 'opfs' && browserName === 'webkit',
      'Safari < 26 has no writable OPFS stream (falls back automatically)',
    );
    await page.goto(`/?sink=${sink}`);
    const f = file(20 * MiB, 400 + (sink === 'opfs' ? 1 : 0), `dl-${sink}.bin`);
    await page.getByTestId('file').setInputFiles(f);
    await expectStatus(page, 'completed');
    await faults(page, { rate: 1, mode: 'reset', limit: 3, methods: ['GET'] });
    await task(page).getByRole('button', { name: 'managed download' }).click();
    const managed = task(page).getByTestId('managed');
    await expect(managed).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
    await expect(managed).toHaveAttribute('data-sink', sink);
    await expect(managed).toHaveAttribute('data-sha256', sha256(f.buffer));
  });
}
