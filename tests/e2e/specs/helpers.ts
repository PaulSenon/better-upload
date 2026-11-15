import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { FaultConfig, ProxyLog } from '../fault-proxy.ts';

export const MiB = 1024 * 1024;

const cache = new Map<string, Buffer>();
/** Deterministic pseudo-random bytes (same seed → same file, like re-selecting it from disk). */
export function bytes(size: number, seed: number): Buffer {
  const id = `${size}:${seed}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const out = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  let i = 0;
  for (; i + 4 <= size; i += 4) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out.writeUInt32LE(x, i);
  }
  for (; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  cache.set(id, out);
  return out;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function file(size: number, seed: number, name = `video-${seed}.mp4`) {
  return { name, mimeType: 'video/mp4', buffer: bytes(size, seed) };
}

/** Same as {@link file} but written to disk (Playwright caps in-memory buffers at 50 MB). */
export function fileOnDisk(size: number, seed: number, name = `video-${seed}.mp4`): { path: string; buffer: Buffer } {
  const dir = join(tmpdir(), 'upload-sdk-e2e', `${size}-${seed}`);
  const path = join(dir, name);
  const buffer = bytes(size, seed);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buffer);
  }
  return { path, buffer };
}

export async function faults(page: Page, config: FaultConfig) {
  await page.request.post('/__test/faults', { data: config });
}
export async function resetFaults(page: Page) {
  await page.request.post('/__test/reset');
}
export async function proxyLog(page: Page): Promise<ProxyLog[]> {
  return (await page.request.get('/__test/log')).json();
}
export async function storedObject(page: Page, key: string): Promise<{ size: number; sha256: string }> {
  return (await page.request.get(`/__test/object?key=${encodeURIComponent(key)}`)).json();
}

export const task = (page: Page, nth = 0) => page.getByTestId('task').nth(nth);

export async function expectStatus(page: Page, status: string | RegExp, nth = 0, timeout = 90_000) {
  await expect(task(page, nth)).toHaveAttribute('data-status', status, { timeout });
}

/** Waits until at least `n` parts are confirmed by the storage. */
export async function waitForParts(page: Page, n: number, nth = 0) {
  await expect
    .poll(async () => Number((await task(page, nth).getAttribute('data-parts'))?.split('/')[0] ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(n);
}
