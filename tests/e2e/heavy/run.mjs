#!/usr/bin/env node
/**
 * Heavy, opt-in test: one >= 10 GiB upload through a real browser into a dedicated MinIO. Never run in a loop or in CI.
 *
 *   pnpm --filter @open-upload/e2e test:heavy            # 10 GiB + 12,345 B
 *   HEAVY_SIZE=$((20*1024**3)) pnpm ... test:heavy       # any size
 *
 * Safety (see docs/TESTING-HEAVY.md):
 * - preflight: refuses to start unless the disk keeps a reserve after the run (size + temporaries + reserve);
 * - the source is synthetic (built in the browser from ~61 MiB of Blob references): no source file on disk;
 * - the only large write is MinIO's copy of the object, in a dedicated directory removed at the end;
 * - throughput is capped (HEAVY_MAX_BPS, default 200 MiB/s) and the run has a hard deadline (HEAVY_TIMEOUT_MIN);
 * - a lock file prevents two heavy runs at once; cleanup also runs on Ctrl-C, errors and the deadline;
 * - only artifacts created by this run are deleted (named container, run directory, `heavy/` prefix of its bucket).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = resolve(here, '..');

const SIZE = Number(process.env.HEAVY_SIZE ?? 10 * GiB + 12_345);
const MAX_BPS = Number(process.env.HEAVY_MAX_BPS ?? 200 * MiB);
const TIMEOUT_MIN = Number(process.env.HEAVY_TIMEOUT_MIN ?? 30);
const RESERVE = Number(process.env.HEAVY_RESERVE_BYTES ?? 15 * GiB);
const ROOT = resolve(process.env.HEAVY_DATA_ROOT ?? join(tmpdir(), 'open-upload-heavy'));
const IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z';
const PORTS = { minio: 9300, proxy: 9301, harness: 5299 };
const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = join(ROOT, runId);
const dataDir = join(runDir, 'minio');
const container = `open-upload-heavy-${process.pid}`;
const lock = join(ROOT, '.lock');
const reportPath = join(ROOT, 'last-report.json');
const browserReport = join(runDir, 'browser-report.json');

const fmt = (b) => `${(b / GiB).toFixed(2)} GiB`;
const log = (...a) => console.log('[heavy]', ...a);
const free = (path) => {
  const s = statfsSync(path);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
};
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
let cleaned = false;
let lockOwned = false;
const samples = { dataDirMaxBytes: 0, browserRssMaxBytes: 0, harnessRssMaxBytes: 0, minioMemMax: '', points: [] };

function dirBytes(path) {
  try {
    return Number(sh('du', ['-sk', path]).split('\t')[0]) * 1024;
  } catch {
    return 0;
  }
}
function rssOf(predicate) {
  let total = 0;
  for (const line of sh('ps', ['-axo', 'rss=,command=']).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && predicate(m[2])) total += Number(m[1]) * 1024;
  }
  return total;
}

async function cleanup(reason) {
  if (cleaned) return;
  cleaned = true;
  log(`cleanup (${reason})`);
  const steps = {};
  try {
    const r = await fetch(`http://localhost:${PORTS.harness}/__test/cleanup?prefix=heavy/`, {
      signal: AbortSignal.timeout(60_000),
    });
    steps.bucket = r.ok ? await r.json() : `HTTP ${r.status}`;
  } catch (e) {
    steps.bucket = `skipped: ${e.message}`;
  }
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {}
  }
  try {
    sh('docker', ['rm', '-f', container]);
    steps.container = 'removed';
  } catch (e) {
    steps.container = `rm failed: ${e.message.split('\n')[0]}`;
  }
  // Delete only this run's directory, and only if it is where we created it.
  if (dirname(runDir) === ROOT && basename(runDir) === runId && existsSync(join(runDir, '.open-upload-heavy'))) {
    rmSync(runDir, { recursive: true, force: true });
    steps.runDir = existsSync(runDir) ? 'still present' : 'removed';
  }
  if (lockOwned) rmSync(lock, { force: true });
  const leftovers = sh('docker', ['ps', '-a', '--filter', 'label=open-upload-heavy', '--format', '{{.Names}}']).trim();
  steps.leftoverContainers = leftovers || 'none';
  return steps;
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, async () => {
    await cleanup(sig);
    process.exit(130);
  });

async function main() {
  mkdirSync(ROOT, { recursive: true });
  // One heavy run at a time.
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`another heavy run is in progress (pid ${pid}, lock ${lock})`);
    rmSync(lock);
  }
  writeFileSync(lock, String(process.pid));
  lockOwned = true;

  // Disk budget: MinIO's copy of the object (+5 % metadata/fs slack) + 1 GiB temporaries, and a reserve kept free.
  const before = free(ROOT);
  const need = Math.ceil(SIZE * 1.05) + GiB;
  log(`size ${fmt(SIZE)}, disk free ${fmt(before.free)} / ${fmt(before.total)} at ${ROOT}`);
  log(`budget: needs ${fmt(need)}, keeps a reserve of ${fmt(RESERVE)} → requires ${fmt(need + RESERVE)} free`);
  if (before.free < need + RESERVE) {
    throw new Error(
      `not enough disk space: ${fmt(before.free)} free, ${fmt(need + RESERVE)} required. Nothing was started.`,
    );
  }
  for (const [name, port] of Object.entries(PORTS))
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is busy. Nothing was started.`);
  sh('docker', ['info'], { timeout: 20_000 });

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(runDir, '.open-upload-heavy'), runId);
  log(`MinIO ${container} → ${dataDir}`);
  sh('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'open-upload-heavy=1',
    '-p',
    `127.0.0.1:${PORTS.minio}:9000`,
    '-v',
    `${dataDir}:/data`,
    '-e',
    'MINIO_ROOT_USER=minioadmin',
    '-e',
    'MINIO_ROOT_PASSWORD=minioadmin',
    '-e',
    'MINIO_API_CORS_ALLOW_ORIGIN=*',
    IMAGE,
    'server',
    '/data',
  ]);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${PORTS.minio}/minio/health/live`)).ok) break;
    } catch {}
    if (i > 60) throw new Error('MinIO did not start');
    await sleep(500);
  }

  const env = {
    ...process.env,
    E2E_PORT: String(PORTS.harness),
    E2E_PROXY_PORT: String(PORTS.proxy),
    MINIO_ENDPOINT: `http://localhost:${PORTS.minio}`,
    E2E_BUCKET: 'open-upload-heavy',
    E2E_PROXY_MAX_BPS: String(MAX_BPS),
    E2E_PROXY_LOG: '0',
    HEAVY_SIZE: String(SIZE),
    HEAVY_REPORT: browserReport,
    HEAVY_TIMEOUT_MS: String(TIMEOUT_MIN * 60_000),
    HEAVY_OUTPUT_DIR: join(runDir, 'playwright'),
  };
  const harness = spawn('pnpm', ['exec', 'tsx', '--conditions=source', 'server.ts'], {
    cwd: e2eDir,
    env,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(harness);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${PORTS.harness}/`)).ok) break;
    } catch {}
    if (i > 120) throw new Error('harness did not start');
    await sleep(500);
  }

  const sampler = setInterval(() => {
    const point = {
      t: Math.round(process.uptime()),
      dataDir: dirBytes(dataDir),
      browserRss: rssOf((c) => c.includes('ms-playwright') && /chrom/i.test(c)),
      harnessRss: rssOf((c) => c.includes('server.ts') && c.includes('tsx')),
      diskFree: free(ROOT).free,
    };
    samples.points.push(point);
    samples.dataDirMaxBytes = Math.max(samples.dataDirMaxBytes, point.dataDir);
    samples.browserRssMaxBytes = Math.max(samples.browserRssMaxBytes, point.browserRss);
    samples.harnessRssMaxBytes = Math.max(samples.harnessRssMaxBytes, point.harnessRss);
    samples.diskFreeMin = Math.min(samples.diskFreeMin ?? Infinity, point.diskFree);
    try {
      samples.minioMemMax = sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container]).trim();
    } catch {}
    // Emergency brake: never let the disk drop under half the reserve.
    if (point.diskFree < RESERVE / 2) {
      log(`disk free fell to ${fmt(point.diskFree)}: aborting`);
      void cleanup('disk reserve').then(() => process.exit(2));
    }
  }, 5000);

  const started = Date.now();
  const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.heavy.config.ts'], {
    cwd: e2eDir,
    env,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(pw);
  const deadline = setTimeout(
    () => {
      log(`deadline of ${TIMEOUT_MIN} min reached: stopping`);
      try {
        process.kill(-pw.pid, 'SIGTERM');
      } catch {}
    },
    (TIMEOUT_MIN + 2) * 60_000,
  );
  const code = await new Promise((r) => pw.on('exit', (c) => r(c ?? 1)));
  clearTimeout(deadline);
  clearInterval(sampler);
  return { code, wallSeconds: Math.round((Date.now() - started) / 1000), before };
}

let result;
let error;
try {
  result = await main();
} catch (e) {
  error = e;
}
const browser = existsSync(browserReport) ? JSON.parse(readFileSync(browserReport, 'utf8')) : null;
const steps = await cleanup(error ? 'error' : 'done');
const after = existsSync(ROOT) ? free(ROOT) : null;
const report = {
  runId,
  ok: !error && result?.code === 0,
  error: error ? String(error.message ?? error) : undefined,
  size: SIZE,
  maxBytesPerSecond: MAX_BPS,
  wallSeconds: result?.wallSeconds,
  browser,
  resources: {
    minioDataDirMaxBytes: samples.dataDirMaxBytes,
    browserRssMaxMiB: Math.round(samples.browserRssMaxBytes / MiB),
    harnessRssMaxMiB: Math.round(samples.harnessRssMaxBytes / MiB),
    minioMemLast: samples.minioMemMax,
    diskFreeBefore: result?.before?.free,
    diskFreeMin: samples.diskFreeMin,
    diskFreeAfter: after?.free,
  },
  cleanup: steps,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
log(`report: ${reportPath}`);
process.exit(report.ok ? 0 : 1);
