import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Removes the files `fileOnDisk()` wrote for this run (up to ~700 MB), so nothing accumulates in TMPDIR. */
export default function globalTeardown() {
  rmSync(join(tmpdir(), 'upload-sdk-e2e'), { recursive: true, force: true });
}
