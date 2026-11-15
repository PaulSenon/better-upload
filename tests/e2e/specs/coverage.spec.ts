import { expect, type Page, test } from '@playwright/test';
import {
  bytes,
  expectStatus,
  faults,
  file,
  fileOnDisk,
  MiB,
  proxyLog,
  resetFaults,
  sha256,
  storedObject,
  task,
  waitForParts,
} from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await resetFaults(page);
});

async function uploadAndVerify(page: Page, f: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByTestId('file').setInputFiles(f);
  await expectStatus(page, 'completed');
  const key = (await task(page).getAttribute('data-key'))!;
  expect(await storedObject(page, key)).toEqual({ size: f.buffer.length, sha256: sha256(f.buffer) });
  return key;
}

for (const [label, size, parts] of [
  ['an empty file', 0, '1/1'],
  ['a 1-byte file', 1, '1/1'],
  ['exactly the single-PUT threshold (8 MiB)', 8 * MiB, '1/1'],
  ['one byte over the threshold (multipart, 2 parts)', 8 * MiB + 1, '2/2'],
] as const) {
  test(`uploads ${label}`, async ({ page }) => {
    await page.goto('/');
    await uploadAndVerify(page, file(size, 100 + (size % 97), `edge-${size}.bin`));
    await expect(task(page)).toHaveAttribute('data-parts', parts);
  });
}

test('uploads a 512 MiB file byte-exact while the page stays responsive (hashing in workers)', async ({
  page,
  browserName,
}) => {
  test.setTimeout(300_000);
  test.skip(browserName === 'webkit' && !!process.env.CI, 'covered on Chromium/Firefox in CI to keep the job fast');
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (window as any).__longTasks.push(e.duration);
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // longtask API unavailable (WebKit/Firefox): only the result is checked
    }
  });
  const f = fileOnDisk(512 * MiB, 200, 'big.bin');
  await page.getByTestId('file').setInputFiles(f.path);
  await expectStatus(page, 'completed', 0, 280_000);
  const key = (await task(page).getAttribute('data-key'))!;
  expect(await storedObject(page, key)).toEqual({ size: f.buffer.length, sha256: sha256(f.buffer) });
  const longTasks: number[] = await page.evaluate(() => (window as any).__longTasks);
  // No single main-thread task long enough to freeze the UI noticeably.
  expect(Math.max(0, ...longTasks)).toBeLessThan(250);
});

test('a small (single-PUT) upload interrupted by a reload completes after re-selecting the file', async ({ page }) => {
  await page.goto('/');
  await faults(page, { rate: 1, mode: 'none', block: true });
  const f = file(2 * MiB, 300, 'small.mp4');
  await page.getByTestId('file').setInputFiles(f);
  await expectStatus(page, 'uploading');
  await page.reload();
  await resetFaults(page);
  await page.getByTestId('reselect').setInputFiles(f);
  await expectStatus(page, 'completed');
  expect(await task(page).getAttribute('data-resumed')).toBe('true');
});

test('after a reload, uploading the same file again from the normal picker continues it (auto-match)', async ({
  page,
}) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 400 });
  const f = fileOnDisk(40 * MiB, 301, 'automatch.mp4');
  await page.getByTestId('file').setInputFiles(f.path);
  await waitForParts(page, 2);
  await page.reload();
  await resetFaults(page);
  await page.getByTestId('file').setInputFiles(f.path);
  await expect(page.locator('[data-testid=task][data-status=completed]')).toHaveCount(1, { timeout: 60_000 });
  const done = page.locator('[data-testid=task][data-status=completed]');
  expect(await done.getAttribute('data-resumed')).toBe('true');
  const puts = (await proxyLog(page)).filter((l) => l.method === 'PUT' && l.status === 200).length;
  expect(puts).toBeLessThanOrEqual(3);
});

test('a re-selected file with another name but the same bytes is verified in full and accepted', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 400 });
  const original = { name: 'IMG_0001.MOV', mimeType: 'video/quicktime', buffer: bytes(32 * MiB, 302) };
  await page.getByTestId('file').setInputFiles(original);
  await waitForParts(page, 2);
  await page.reload();
  await resetFaults(page);
  await page.getByTestId('reselect').setInputFiles({ ...original, name: 'renamed-copy.mov' });
  await expectStatus(page, 'completed');
  const key = (await task(page).getAttribute('data-key'))!;
  expect((await storedObject(page, key)).sha256).toBe(sha256(original.buffer));
});

test('cancel aborts the multipart upload on the storage', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 500 });
  await page.getByTestId('file').setInputFiles(file(30 * MiB, 303, 'cancel-me.mp4'));
  await waitForParts(page, 1);
  await task(page).getByRole('button', { name: 'cancel' }).click();
  await expectStatus(page, 'canceled');
  await resetFaults(page);
  await expect
    .poll(async () =>
      (
        (await (await page.request.get('/__test/multipart?prefix=e2e/')).json()) as { uploads: string[] }
      ).uploads.filter((k) => k.endsWith('cancel-me.mp4')),
    )
    .toEqual([]);
});

test('two tabs never upload the same session at once (Web Locks)', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Web Locks across tabs is checked once');
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 3000 });
  const f = file(40 * MiB, 304, 'tabs.mp4');
  await page.getByTestId('file').setInputFiles(f);
  await waitForParts(page, 1);
  const second = await context.newPage();
  await second.goto('/?concurrency=1');
  await second.getByTestId('reselect').setInputFiles(f);
  await expect(second.getByTestId('task').first()).toHaveAttribute('data-error', 'SESSION_CONFLICT', {
    timeout: 30_000,
  });
  await resetFaults(page);
  await expectStatus(page, 'completed');
});
