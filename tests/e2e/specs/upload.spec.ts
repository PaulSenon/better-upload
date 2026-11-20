import { expect, test } from '@playwright/test';
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

test('uploads a multipart file and stores it byte-exact', async ({ page }) => {
  await page.goto('/');
  const f = file(20 * MiB + 321, 1);
  await page.getByTestId('file').setInputFiles(f);
  await expectStatus(page, 'completed');
  const key = (await task(page).getAttribute('data-key'))!;
  expect(await storedObject(page, key)).toEqual({ size: f.buffer.length, sha256: sha256(f.buffer) });
});

test('uploads several files in one batch, small ones with a single PUT', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file').setInputFiles([file(1000, 2, 'small.mp4'), file(9 * MiB, 3, 'big.mp4')]);
  await expectStatus(page, 'completed', 0);
  await expectStatus(page, 'completed', 1);
  await expect(page.getByTestId('aggregate')).toHaveText('100%');
});

test('survives connections reset mid-part', async ({ page }) => {
  await page.goto('/');
  await faults(page, { rate: 1, mode: 'reset', limit: 4 });
  const f = file(30 * MiB, 4);
  await page.getByTestId('file').setInputFiles(f);
  await expectStatus(page, 'completed');
  const key = (await task(page).getAttribute('data-key'))!;
  expect((await storedObject(page, key)).sha256).toBe(sha256(f.buffer));
  expect((await proxyLog(page)).some((l) => l.faulted === 'reset')).toBe(true);
});

test('backs off on storage throttling (503 SlowDown) and completes', async ({ page }) => {
  await page.goto('/');
  await faults(page, { rate: 1, mode: '503', limit: 4 });
  await page.getByTestId('file').setInputFiles(file(17 * MiB, 5));
  await expectStatus(page, 'completed');
});

test('waits while offline and continues when the network returns', async ({ page, context }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 500 });
  await page.getByTestId('file').setInputFiles(fileOnDisk(64 * MiB, 6).path);
  await waitForParts(page, 1);
  await context.setOffline(true);
  await expectStatus(page, /waiting-network|retrying/);
  await page.waitForTimeout(1500);
  await context.setOffline(false);
  await resetFaults(page);
  await expectStatus(page, 'completed');
});

test('pause stops traffic; resume completes', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 500 });
  await page.getByTestId('file').setInputFiles(file(40 * MiB, 7));
  await waitForParts(page, 1);
  await task(page).getByRole('button', { name: 'pause' }).click();
  await expectStatus(page, 'paused');
  const before = (await proxyLog(page)).length;
  await page.waitForTimeout(1500);
  expect((await proxyLog(page)).length).toBe(before);
  await resetFaults(page);
  await task(page).getByRole('button', { name: 'resume' }).click();
  await expectStatus(page, 'completed');
});

test('re-signs expired part URLs transparently', async ({ page }) => {
  await page.goto('/?base=/api/upload-short');
  // Parts wait 3 s at the proxy while URLs live 2 s: the storage answers "Request has expired".
  await faults(page, { rate: 1, mode: 'delay', delayMs: 3000, limit: 2 });
  await page.getByTestId('file').setInputFiles(file(12 * MiB, 8));
  await expectStatus(page, 'completed');
});

test('after a reload, re-selecting the file continues where it stopped', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 400 });
  const f = fileOnDisk(64 * MiB, 9);
  await page.getByTestId('file').setInputFiles(f.path);
  await waitForParts(page, 2);
  await page.reload();
  await resetFaults(page);
  await expect(page.getByTestId('pending')).toHaveCount(1);
  const putsBefore = (await proxyLog(page)).length;
  expect(putsBefore).toBe(0);
  await page.getByTestId('reselect').setInputFiles(f.path);
  await expectStatus(page, 'completed');
  expect(await task(page).getAttribute('data-resumed')).toBe('true');
  const puts = (await proxyLog(page)).filter((l) => l.method === 'PUT' && l.status === 200);
  expect(puts.length).toBeLessThanOrEqual(6);
  const key = (await task(page).getAttribute('data-key'))!;
  expect((await storedObject(page, key)).sha256).toBe(sha256(f.buffer));
});

test('a different file with the same name and size is refused for a pending upload', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 400 });
  await page.getByTestId('file').setInputFiles(file(40 * MiB, 10, 'same.mp4'));
  await waitForParts(page, 1);
  await page.reload();
  await resetFaults(page);
  await page
    .getByTestId('reselect')
    .setInputFiles({ name: 'same.mp4', mimeType: 'video/mp4', buffer: bytes(40 * MiB, 11) });
  await expect(page.getByTestId('reselect-error')).toHaveText('FILE_MISMATCH');
  await expect(page.getByTestId('pending')).toHaveCount(1);
});

test('an upload discarded by the bucket is reported as expired and restarts only on request', async ({ page }) => {
  await page.goto('/?concurrency=1');
  await faults(page, { rate: 1, mode: 'delay', delayMs: 400 });
  await page.getByTestId('file').setInputFiles(file(40 * MiB, 12));
  await waitForParts(page, 1);
  await task(page).getByRole('button', { name: 'pause' }).click();
  const ticket = (await task(page).getAttribute('data-ticket'))!;
  await page.request.post('/__test/expire', { data: { ticket } });
  await resetFaults(page);
  await task(page).getByRole('button', { name: 'resume' }).click();
  await expectStatus(page, 'expired');
  await expect(task(page)).toHaveAttribute('data-error', 'SESSION_NOT_FOUND');
  await task(page).getByRole('button', { name: 'restart' }).click();
  await expectStatus(page, 'completed');
});

test('the stable download link hands the file to the browser download manager', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit' && !!process.env.CI, 'WebKit download events are flaky on Linux CI');
  await page.goto('/');
  const f = file(6 * MiB, 13, 'clip.mp4');
  await page.getByTestId('file').setInputFiles(f);
  await expectStatus(page, 'completed');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  expect(download.suggestedFilename()).toBe('clip.mp4');
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  expect(sha256(await readFile(path!))).toBe(sha256(f.buffer));
});
