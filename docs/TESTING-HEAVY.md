# Large-file testing

How Open Upload is tested for very large files, what each test proves, and what stays unproven.

The tests come in three layers, each with an honest scope:

| Layer | Volume really moved | Proves | Does not prove |
|---|---|---|---|
| Planning and limits (`packages/core`) | none | Part plans for 10 GiB → 5 TiB and up to the provider ceilings; ≤ 10,000 parts; exact tiling; limit errors raised up front | anything at runtime |
| Engine at scale (`packages/client/src/scale.test.ts`) | none (virtual 1 TiB file, the bytes are never read) | real client engine + real server: 9,987 parts, cut at part 6,000, reload, resume, completion; batched signing; only missing parts resent | real bytes, a real S3 |
| ListParts pagination (`packages/s3/src/s3.test.ts`) | none (mocked S3 responses) | 10,000 parts read across 10 pages | a real provider's pagination quirks |
| **Heavy browser run** (`tests/e2e/heavy`) | **10 GiB + 12,345 B into MinIO** | real Chromium, real `@open-upload/client` (worker hashing, XHR, IndexedDB), real server, real S3 API (MinIO) with CRC32C checked on every part; network resets, offline, reload and resume; stored bytes identical | Firefox/WebKit at this size; disk-backed source files at this size; R2/AWS (see below) |

The fast suites (unit, integration, e2e) run on every PR. **The heavy run never runs in CI or on a schedule.** You start
it by hand, one run at a time.

## Running the heavy test

```bash
docker info >/dev/null && pnpm --filter @open-upload/e2e test:heavy
```

Options (environment variables):

| Variable | Default | |
|---|---|---|
| `HEAVY_SIZE` | `10737430585` (10 GiB + 12,345 B, odd tail) | bytes |
| `HEAVY_MAX_BPS` | 200 MiB/s | global cap on upload throughput (in the proxy) |
| `HEAVY_TIMEOUT_MIN` | 30 | hard deadline; everything is stopped and cleaned after it |
| `HEAVY_RESERVE_BYTES` | 15 GiB | free space that must remain after the run |
| `HEAVY_DATA_ROOT` | `$TMPDIR/open-upload-heavy` | where MinIO writes (a fresh per-run directory) |

### Safety protocol (built into `heavy/run.mjs`)

1. **Preflight.** The script refuses to start, and touches nothing, in any of these cases:
   - free disk < size × 1.05 + 1 GiB of temporaries + the reserve;
   - one of the ports 9300, 9301 or 5299 is busy;
   - Docker is down;
   - another heavy run holds the lock.
2. **Source: synthetic, no file on disk.** The browser builds the file as a `Blob` composed of references to 61
   pseudo-random 1 MiB bodies, plus a 32-byte header per segment (about 61 MiB in total). Uploading it reads memory.
3. **Destination: one dedicated MinIO.**
   - It runs in a container named `open-upload-heavy-<pid>`, labelled `open-upload-heavy`.
   - Its data goes to a per-run directory on the host, bind-mounted. The bytes land on the host disk, where they can be
     measured and removed, and never inside Docker's disk image.
   - It has its own bucket (`open-upload-heavy`) and prefix (`heavy/`).
4. **Bounded load.**
   - Throughput is capped (200 MiB/s by default).
   - Browser concurrency is fixed at 4 parts.
   - There is one browser, one test, a 30 min deadline and no retries.
   - An emergency brake aborts the run if free disk falls below half the reserve.
5. **Verification by streaming.**
   - The server reads the stored object once, directly from MinIO (not through the proxy).
   - It compares the object byte by byte with the generator, in 4 MiB windows, and computes SHA-256.
   - Nothing is downloaded to the browser.
6. **Cleanup, on success, failure, Ctrl-C or deadline.**
   - It deletes the objects and aborts the uploads under `heavy/` in the dedicated bucket.
   - It stops the harness and the browser.
   - It removes the container and the run directory. Removal happens only if the directory carries the run's marker
     file.
   - It releases the lock and checks that no labelled container remains.
   - Only a small `last-report.json` stays in `$TMPDIR/open-upload-heavy`.

### Scenario

1. Start the upload: 10 GiB + 12,345 B is 1,281 parts of 8 MiB, with a 12,345 B tail.
2. At 15 %, three part uploads get their connection reset by the proxy.
3. At 45 %, the browser goes offline (Playwright) for 5 s. The engine waits (`waiting-network`), then continues.
4. After more than 1,050 parts, the page reloads. The page re-selects the same synthetic file through `upload()`
   (auto-match).
   - The engine checks a sample of parts against MinIO's CRC32C.
   - It restores progress from `ListParts`. With more than 1,000 parts, that takes two pages on real MinIO.
   - It sends only the missing parts.
5. Completion, then the byte-exact check described in step 5 of the safety protocol.

### Synthetic data: what is representative and what isn't

- Every 1 MiB segment is unique: its header encodes its index. A duplicated, swapped, shifted or truncated part
  therefore fails the comparison.
- Bodies are pseudo-random: neither zeros nor compressible patterns. CRC32C and the byte comparison are meaningful.
- But bodies repeat, with 61 distinct ones. A storage that deduplicated or compressed would see less data than with a
  real file. MinIO, as run here, does neither, so the transfer and the stored bytes were real.
- The source is memory-backed. Reading a disk-backed `File` (a user's actual file) is covered at 512 MiB by the
  regular e2e suite, not at 10 GiB.

## Results — 2026-11-16, MacBook (10 cores, 16 GB), Chromium (Playwright 1.65), MinIO `RELEASE.2026-08-04`

Size **10,737,430,585 B** (10 GiB + 12,345 B), **1,281 parts**, cap 200 MiB/s, concurrency 4.

| Measure | Value |
|---|---|
| Upload time (start → completed) | **64 s**, i.e. **160 MiB/s** average, including the injected incidents |
| Bytes received from the browser | 10,771,965,805 B: **+34.5 MB (0.32 %)** wasted by parts cut by the 3 resets, the offline period and the reload |
| After the reload | 1,058 parts confirmed before → 1,067 restored from MinIO (in-flight parts had landed); 1.87 GB sent for 1.86 GB missing (+ the ≤ 4 parts in flight when the page closed) |
| Control requests | init 1, **sign 140** (≈ 9 parts per request), status 1, complete 1 |
| Integrity | **identical** byte for byte; SHA-256 `a56fb0e8…cf8444` = expected; check took 33 s for 10 GiB |
| Page JS heap (main thread, max) | **8.1 MiB** |
| Whole browser RSS (all Chromium processes, max) | 640 MiB (699 MiB on a 600 MiB pilot run: it does not grow with file size) |
| Synthetic file build in the page | 264 ms |
| MinIO data directory, max | 10.78 GB, removed at the end |
| MinIO container memory | 272 MiB |
| Cleanup | object deleted, no multipart upload left, container removed, run directory removed, no labelled container left |

The only assertion that failed in that run was a bound in the test itself. I sampled the byte counter just before the
reload, without counting the ≤ 4 parts still in flight. I fixed the bound to "missing bytes + 4 parts" (the run is
within it: 1,867,853,881 ≤ 1,895,837,753) and re-validated it with a 600 MiB run that passed. I did not repeat the
10 GiB run, to avoid writing another 10 GB while macOS was preparing a system update and using disk space.

**Disk note.** Host free space moved by ±10 GB during the session independently of these runs: macOS
`mobileassetd` / software-update staging and Time Machine were active. The run's own footprint was measured
directly: the data directory peaked at 10.78 GB and was then deleted. Docker's disk use was unchanged (12.9 GB before
and after).

## Bugs found by these tests (fixed)

- **One sign round-trip per part.** Parts that started together each signed their own URL. A virtual 1 TiB upload made
  9,989 `sign` requests for 9,987 parts. Now, parts in flight share one batch, and the batch grew from 6 to 10. CRC
  hashing looks ahead far enough to fill a batch (constant memory). Result: 1,001 requests (virtual 1 TiB) and 140 for
  1,281 real parts.
- **Advertised limit above what multipart can store.** AWS and MinIO declare 50 TiB objects, but 10,000 parts × 5 GiB
  is only 48.8 TiB. A file in between passed the first check and failed with a confusing part-size error. The limit is
  now `min(object limit, maxParts × maxPartSize)` (`maxUploadSize()`), and the error says 48.8 TiB.
- **SHA memory.** SHA-256/SHA-1 per part (opt-in; CRC32C is the default) buffers a whole part, because WebCrypto has
  no streaming digest. Hash-ahead is now limited to a 128 MiB budget for SHA. CRC32C streams in 1 MiB slices whatever
  the part size; the unit tests check both paths.
- **E2E temp files accumulating.** The regular suite left about 680 MB in `$TMPDIR/upload-sdk-e2e`. A Playwright
  global teardown now removes it after every run.

## Still unproven

- **R2 and AWS at this size.** Not run (no credentials, paid egress or storage). MinIO implements the same S3 API, but
  provider-specific limits, throttling (`SlowDown` under load) and latency are untested. Runbook step 8 enables the
  small conformance checks against them; a large run there would need an explicit decision on cost.
- **Firefox and WebKit at 10 GiB.** Only Chromium ran this size. The other browsers run the regular suite: up to 512
  MiB on Chromium/Firefox, smaller on WebKit in CI.
- **Real disk-backed files at 10 GiB**, i.e. a real user file read from disk at that size.
- **Very long uploads (hours), mobile devices, background tabs or sleep.**
- **Sizes beyond 10 GiB in a real browser.** Thousands of parts and TiB sizes are covered only by the virtual
  engine test and the planning tests.
- **Memory in the hash workers.** The page heap and total browser RSS were measured; worker heaps were not measured
  separately (they are part of the RSS).
