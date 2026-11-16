import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SIZE = Number(process.env.HEAVY_SIZE ?? 10 * GiB + 12_345);
const SEED = Number(process.env.HEAVY_SEED ?? 20_261_116);
const NAME = `synthetic-${SIZE}.bin`;
const PART = 8 * MiB;
const PARTS = Math.ceil(SIZE / PART);
const PREFIX = 'heavy/';

const task = (page: Page) => page.getByTestId('task').first();
const partsConfirmed = async (page: Page) =>
  Number(
    (
      await task(page)
        .getAttribute('data-parts')
        .catch(() => '0/0')
    )?.split('/')[0] ?? 0,
  );
const stats = async (page: Page) =>
  (await page.request.get('/__test/stats')).json() as Promise<{
    proxy: { putBytesIn: number; putOk: number; putFailed: number; getBytesOut: number };
    control: Record<string, number>;
  }>;

async function waitParts(page: Page, n: number, timeout: number) {
  await expect.poll(() => partsConfirmed(page), { timeout, intervals: [1000] }).toBeGreaterThanOrEqual(n);
}

test(`uploads a ${(SIZE / GiB).toFixed(2)} GiB synthetic file through the browser with cuts, offline and a reload`, async ({
  page,
  context,
}) => {
  const timeline: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (name: string) => {
    timeline[name] = Math.round((Date.now() - t0) / 1000);
    console.log(`[heavy] +${timeline[name]}s ${name} (${(SIZE / GiB).toFixed(2)} GiB, ${PARTS} parts)`);
  };
  const report: Record<string, unknown> = { size: SIZE, seed: SEED, parts: PARTS, timeline };
  const write = () =>
    process.env.HEAVY_REPORT && writeFileSync(process.env.HEAVY_REPORT, JSON.stringify(report, null, 2));

  await page.request.get(`/__test/cleanup?prefix=${PREFIX}`);
  await page.request.post('/__test/reset');

  // Main-thread JS heap of the page (workers excluded; the runner samples whole-browser RSS separately).
  let heapMax = 0;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const sampler = setInterval(async () => {
    try {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
      heapMax = Math.max(heapMax, heap);
    } catch {}
  }, 2000);

  try {
    await page.goto('/?concurrency=4&stall=30000&attempts=50');
    const build = await page.evaluate(([s, seed, name]) => (window as any).__startSynthetic(s, seed, name), [
      SIZE,
      SEED,
      NAME,
    ] as const);
    report.buildMs = Math.round(build.buildMs);
    expect(build.size).toBe(SIZE);
    mark('started');

    // 1) Connection resets on 3 part uploads (around 15 %).
    await waitParts(page, Math.floor(PARTS * 0.15), 10 * 60_000);
    await page.request.post('/__test/faults', { data: { rate: 1, mode: 'reset', limit: 3 } });
    await expect.poll(async () => (await stats(page)).proxy.putFailed, { timeout: 120_000 }).toBeGreaterThanOrEqual(3);
    await page.request.post('/__test/faults', { data: { rate: 0, mode: 'none' } });
    mark('3 resets injected');

    // 2) Browser offline for 5 s (around 45 %): the engine waits, then continues.
    await waitParts(page, Math.floor(PARTS * 0.45), 10 * 60_000);
    await context.setOffline(true);
    await page.waitForTimeout(5000);
    report.statusWhileOffline = await task(page).getAttribute('data-status');
    await context.setOffline(false);
    mark('offline 5 s');

    // 3) Reload after more than 1,000 parts: resume lists >1000 parts (paginated ListParts on MinIO).
    const reloadAt = PARTS > 1100 ? Math.max(1050, Math.floor(PARTS * 0.8)) : Math.floor(PARTS * 0.8);
    await waitParts(page, reloadAt, 10 * 60_000);
    const beforeReload = await partsConfirmed(page);
    const bytesBeforeReload = (await stats(page)).proxy.putBytesIn;
    await page.reload();
    await expect(page.getByTestId('pending-count')).toHaveText('1', { timeout: 30_000 });
    mark(`reloaded at ${beforeReload} parts`);
    await page.evaluate(([s, seed, name]) => (window as any).__startSynthetic(s, seed, name), [
      SIZE,
      SEED,
      NAME,
    ] as const);
    await expect(task(page)).toHaveAttribute('data-resumed', 'true', { timeout: 120_000 });
    // Progress restored from the storage (ListParts), before anything new is sent.
    await expect.poll(() => partsConfirmed(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(beforeReload);
    report.reload = { partsConfirmedBefore: beforeReload, partsConfirmedAfterResume: await partsConfirmed(page) };

    await expect(task(page)).toHaveAttribute('data-status', 'completed', { timeout: 20 * 60_000 });
    mark('completed');
    const key = (await task(page).getAttribute('data-key'))!;
    const s = await stats(page);
    report.transfer = {
      putBytesIn: s.proxy.putBytesIn,
      overheadBytes: s.proxy.putBytesIn - SIZE,
      overheadPercent: Number((((s.proxy.putBytesIn - SIZE) / SIZE) * 100).toFixed(3)),
      bytesAfterReload: s.proxy.putBytesIn - bytesBeforeReload,
      bytesMissingAtReload: SIZE - beforeReload * PART,
      putOk: s.proxy.putOk,
      putFailed: s.proxy.putFailed,
      control: s.control,
    };
    const uploadSeconds = timeline.completed! - timeline.started!;
    report.uploadSeconds = uploadSeconds;
    report.averageMiBps = Number((SIZE / MiB / uploadSeconds).toFixed(1));

    // 4) Byte-exact check of what MinIO stored, streamed once (no download to the browser).
    const verify = await (
      await page.request.get(`/__test/verify-synthetic?key=${encodeURIComponent(key)}&size=${SIZE}&seed=${SEED}`, {
        timeout: 10 * 60_000,
      })
    ).json();
    report.verify = verify;
    mark('verified');
    expect(verify).toMatchObject({ identical: true, size: SIZE });
    expect(verify.sha256).toBe(verify.expectedSha256);
    // After the reload only the parts missing from the storage are sent. The counter was read just before the
    // reload, so the (at most 4) parts still in flight until the page closed are counted too.
    const remaining = SIZE - beforeReload * PART;
    expect(s.proxy.putBytesIn - bytesBeforeReload).toBeLessThanOrEqual(remaining + 4 * PART);
    // Wasted bytes come from parts cut mid-flight (3 resets, offline, reload): bounded by a few parts each.
    expect(s.proxy.putBytesIn - SIZE).toBeLessThan(40 * PART);
  } finally {
    clearInterval(sampler);
    report.pageJsHeapMaxMiB = Number((heapMax / MiB).toFixed(1));
    const cleanup = await page.request.get(`/__test/cleanup?prefix=${PREFIX}`).catch(() => null);
    report.cleanup = cleanup ? await cleanup.json() : 'failed';
    write();
  }
});
