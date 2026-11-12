# Research — storage protocols, provider limits, browser constraints

> Status: research notes, **not decisions**. Checked 2026-11-12 on official docs (links inline).
> **[UNVERIFIED]** = third-party / forum / inference. Browser support from MDN browser-compat-data 8.1.8 (2026-11-02).

## Design-shaping findings

1. **Default incomplete-upload cleanup windows break multi-day resume on some providers:** R2 **7 days** default, MinIO AIStor **24 h** (`stale_uploads_expiry`), Supabase tus URLs **24 h**, Azure uncommitted blocks **1 week** without activity, Wasabi ~31 d, DO Spaces 30 d. AWS S3 & GCS keep incomplete uploads **forever and bill them** unless a lifecycle rule exists.
2. **Presigned URLs ≤ 7 days, less with STS/role creds** (AssumeRole default 1 h, instance profiles ~6 h). ⇒ sign parts lazily, on demand; never pre-sign a whole multi-day upload.
3. **iOS Safari: no `showOpenFilePicker`, no persistent user-file handle** ⇒ the user must re-select. **Photo-library picks may be transcoded** (HEIC→JPEG, video compression unless "Current" format) ⇒ bytes may differ between picks; `(name,size,lastModified)` is a hint, never proof.
4. **Safari: no fetch upload streaming, no Background Fetch, no freeze/resume events**; uploads stop on screen lock ⇒ XHR + `Blob.slice()` parts, "foreground-only, resume on visible".
5. **AWS 2025–26:** max object **50 TB** (2025-12-02; user guide table 48.8 TiB); new checksum algorithms (MD5, SHA-512, XXHash64/3/128); `CompleteMultipartUpload` accepts `x-amz-mp-object-size` and `If-None-Match`/`If-Match`.
6. **WebKit bug 319985** (Safari/iOS 26.5.x): XHR/fetch of a disk-backed or IndexedDB-restored `File` sent `Content-Length: 0`; fixed 2026-10-17 on the 26 branch. Workaround: send `File.slice()`. ⇒ **always verify storage-reported part size equals bytes sent.**

## A. AWS S3 multipart

| Item | Value | Source |
|---|---|---|
| Max object | 48.8 TiB (announced "50 TB", 2025-12-02) | [qfacts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), [what's new](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-maximum-object-size-50-tb) |
| Parts | 1–10,000 | qfacts |
| Part size | 5 MiB – 5 GiB, last part exempt | qfacts |
| ListParts / ListMultipartUploads page | 1,000 | qfacts |

- **CreateMultipartUpload** → `UploadId`; `x-amz-checksum-algorithm`, `x-amz-checksum-type: COMPOSITE|FULL_OBJECT`; returns `x-amz-abort-date` when a lifecycle rule matches; metadata must be set here ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html)).
- **UploadPart** — same part number overwrites (idempotent, last ETag wins); `NoSuchUpload` 404 after abort/complete; checksum algorithm must match the one declared at create ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html)).
- **ListParts** — paginated (`part-number-marker`); returns PartNumber, ETag, Size, LastModified, Checksum*. AWS: *"Do not use the result of this listing when sending a complete multipart upload request… maintain your own list"*; in-flight parts are not listed ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html)). Uppy resumes via ListParts anyway.
- **CompleteMultipartUpload** — ascending parts with ETag (+ per-part checksums for composite); `200 OK` **may embed an `<Error>`** (parse body); may take minutes (whitespace keep-alive); `x-amz-mp-object-size` mismatch → 400; after success the parts no longer exist ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)).
- **AbortMultipartUpload** — 204; in-flight parts may still land; may need repeating, confirm via ListParts ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)).
- **Multipart ETag** = MD5(concat part MD5s) + `-N` — not a content MD5 ([integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)).
- **Checksums** ([integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)): CRC64NVME (default) FULL_OBJECT only; CRC32/CRC32C both; SHA1/SHA256/MD5/XXHASH*/SHA512 COMPOSITE only. Composite requires consecutive part numbers from 1.
- **Presigned checksum headers** — SigV4 presign supports them; with AWS SDK v3 `getSignedUrl`, use `unhoistableHeaders` so the header is signed and must be sent; CORS `AllowedHeaders` must include it ([presign](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [presigner README](https://cdn.jsdelivr.net/npm/@aws-sdk/s3-request-presigner@3.1075.0/README.md)). **[UNVERIFIED]** whether S3 validates a checksum hoisted into the query string.
- **Conditional writes** — `If-None-Match: *` / `If-Match` on PutObject, CompleteMultipartUpload, CopyObject; 412 on failure; 409 `ConditionalRequestConflict` on concurrent delete ⇒ multipart must be recreated ([doc](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)).
- **Presign expiry** — IAM user ≤ 7 d; STS/role: dies with the session; checked at request start (running transfer finishes) ([doc](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)).
- **Lifecycle** — `AbortIncompleteMultipartUpload/DaysAfterInitiation`; without it no expiry and parts billed ([doc](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)).
- **CORS** — `ExposeHeaders: ETag` needed if the client reads part ETags ([Uppy](https://uppy.io/docs/aws-s3/)).

## B. Provider comparison

| Provider | Parts / part size | Max object | Equal parts? | Default incomplete cleanup | Presign max | Checksums / conditionals | Source |
|---|---|---|---|---|---|---|---|
| AWS S3 | 10k; 5 MiB–5 GiB | 48.8 TiB | no | **none (billed)** | 7 d (less w/ STS) | all; FULL_OBJECT + COMPOSITE; If-(None-)Match on Complete | above |
| Cloudflare R2 | 10k; 5 MiB–5 GiB | 4.995 TiB | **yes** (all but last) | **7 d** default, configurable | 7 d, S3 API domain only | CRC64NVME FULL_OBJECT only; CRC32/CRC32C/SHA1/SHA256 COMPOSITE only; If-(None-)Match on Complete | [multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/), [api](https://developers.cloudflare.com/r2/api/s3/api/), [presign](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| Backblaze B2 (S3) | ≥2 parts; 5 MB–5 GB; count **[UNVERIFIED]** | 10 TB | no | not documented | supported, max **[UNVERIFIED]** | not documented | [large files](https://www.backblaze.com/docs/cloud-storage-large-files), [S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api) |
| GCS XML API | 5 MiB–5 GiB | 5 TiB **[UNVERIFIED]** | no | **none**; lifecycle by age | 7 d (V4) | **no preconditions on MPU**, no MD5 on MPU objects | [mpu](https://docs.cloud.google.com/storage/docs/multipart-uploads), [signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls) |
| MinIO AIStor | 10k; 5 MiB–5 TiB | ~48 PiB | no | **24 h** `stale_uploads_expiry` | 7 d | S3-compatible | [thresholds](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/thresholds/) |
| MinIO community | — | — | — | assume 24 h **[UNVERIFIED]** | — | repo in maintenance mode since 2025-12-03 **[secondary]** | [InfoQ](https://www.infoq.com/news/2025/12/minio-s3-api-alternatives) |
| Wasabi | 5 MB–5 GB | — | no | **~31 d**, billed 30 d | 7 d **[UNVERIFIED]** | lifecycle abort | [mpu](https://docs.wasabi.com/docs/how-does-wasabi-handle-multipart-uploads) |
| Tigris | — | — | — | lifecycle API; abort rule undocumented | presigned UploadPart supported | SHA256 on Put | [s3 compat](https://www.tigrisdata.com/docs/api/s3/) |
| Scaleway | **1,000 parts [UNVERIFIED]** | 5 TB | — | lifecycle abort | — | docs 403 to fetcher | [rclone forum](https://forum.rclone.org/t/configure-the-10-000-chunks-limit/17059) |
| OVHcloud | 10k; 5 MiB–5 GiB | 48 TiB | — | lifecycle | presign GET/PUT/HEAD/DELETE | 300 PUT/s/bucket | [limits](https://docs.ovhcloud.com/en/guides/storage-and-backup/object-storage/s3-limitations.md) |
| DO Spaces | 10k; 5 MiB–5 GB | 5 TB | no | **30 d** | undocumented | presigned PUT via CDN ≤ 8100 KiB; 800 op/s | [limits](https://docs.digitalocean.com/products/spaces/details/limits/) |
| Supabase S3 | multipart supported | plan | — | — | SigV4 | **no Content-MD5, no checksums, no conditional Put** | [compat](https://supabase.com/docs/guides/storage/s3/compatibility) |
| Supabase tus | chunks **must be 6 MB** | — | yes | **URL valid 24 h** | `x-signature` | 409 on concurrent clients | [resumable](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) |
| Azure Block Blob (not S3) | **50,000 blocks** ≤ 4,000 MiB; 100k uncommitted | ~190.7 TiB | no (equal-length block IDs) | **uncommitted GC after 1 week idle** | user-delegation SAS ≤ 7 d | Content-MD5 / CRC64 per block | [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block) |

## C. Downloads

- **If-Range** (RFC 9110 §13.1.5): mismatch → **200 with the full body**, not 412; strong ETag only ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-range)). ⇒ SDK must detect 200-instead-of-206. Alternative `If-Match` → 412 on change.
- **S3 GetObject**: single range only; `partNumber` GET returns `x-amz-mp-parts-count`; `response-content-disposition` requires a signed request; `versionId` pins the version; if `Range` is signed, `If-Range` must be too ([API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)). Object changed mid-resume without pin/validator ⇒ silent corruption.
- **Client persistence of partial downloads:**

| API | Chrome | Safari / iOS |
|---|---|---|
| OPFS `navigator.storage.getDirectory` | 86 | 15.2 |
| `createSyncAccessHandle` (worker) | 102 | 15.2 |
| `FileSystemWritableFileStream` | 86 | 26 |
| `showSaveFilePicker` / `showOpenFilePicker` | 86 | **no** |
| Background Fetch | 74 | **no** |

- StreamSaver (service worker + iframe) needs a secure context; leaving the page breaks it ([README](https://raw.githubusercontent.com/jimmywarting/StreamSaver.js/master/README.md)). Practical iOS path **[inference]**: ranges into OPFS → `getFile()` → `<a download>` blob URL / share sheet.

## D. Browser constraints (iOS Safari 18 / 26)

- **Identity:** only `name`, `size`, `type`, `lastModified`; no path; no `showOpenFilePicker` / `queryPermission` on Safari. `FileSystemFileHandle` in IndexedDB only for OPFS files.
- **Photo-library transcoding:** picks usually arrive as JPEG even with `accept=image/heic` ([dev.to 2026](https://dev.to/heicnow/handling-heic-uploads-from-iphones-in-2026-what-breaks-and-how-to-fix-it-58a2)); videos may be compressed unless "Current" format ([Apple forum](https://developer.apple.com/forums/thread/731042)). Picking via **Files** avoids it. **[UNVERIFIED]** stability of `lastModified`/size across re-picks — must be tested on device.
- **Storage:** Safari 17+ up to 60 % disk per origin / 80 % total; `estimate()` 17+; `persist()` heuristic (home-screen apps) ([WebKit 2023](https://webkit.org/blog/14403/updates-to-storage-policy/)). **ITP 7-day cap**: script-writable storage deleted after "seven days of Safari use without user interaction on the site"; home-screen web apps exempt-ish ([WebKit 2020](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). ⇒ authoritative resume state should be recoverable **server-side**.
- **Hashing:** Web Crypto `digest()` not incremental; **hash-wasm 4.13.0** streaming CRC32/CRC32C/CRC64 (NVME polynomial must be configured **[verify]**)/SHA-256/BLAKE3/xxHash, with **`save()`/`load()` of hasher state**; README benchmarks (1 MB, env unstated) SHA-256 ~426 MB/s, xxHash64 ~16 GB/s ([README](https://raw.githubusercontent.com/Daninet/hash-wasm/master/README.md)); iPhone throughput **[UNVERIFIED]**.
- **Network:** fetch has no upload progress (whatwg/fetch#607); request streaming Safari **no** ⇒ XHR `upload.onprogress`. No Background Fetch, no `freeze` events; `visibilitychange` + `pagehide`. WebKit drops background assertion on screen lock ([WebKit 185333](https://bugs.webkit.org/show_bug.cgi?id=185333)). Wake Lock on iOS 18.4+. ~6 connections/host on HTTP/1.1; S3 regional endpoints likely HTTP/1.1 only **[UNVERIFIED]** ⇒ 3–4 parallel parts on cellular.

## E. Fingerprinting in prior art

- **tus-js-client 4.3.1**: `['tus-br', name, type, size, lastModified, endpoint].join('-')` in localStorage ([source](https://github.com/tus/tus-js-client/blob/main/lib/browser/fileSignature.ts)); resume via `HEAD` → `Upload-Offset`.
- **Uppy** `generateFileID`: name/type/relativePath/size/lastModified, **no content hash**; Golden Retriever IndexedDB, 24 h expiry, "ghost" files ([docs](https://uppy.io/docs/golden-retriever/)).
- ⇒ neither proves content identity (vulnerable to iOS re-pick transcoding), and both keep resume state client-only (vulnerable to ITP eviction).

## Not confirmed

B2/Spaces presign max, B2 part count, Scaleway limits, `lastModified` stability on iOS re-picks, iPhone WASM hash throughput, S3 validation of query-hoisted checksums, HTTP/2 on S3 endpoints, MinIO community stale-upload default.
