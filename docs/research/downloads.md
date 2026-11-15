# Research: download UX, resilience and cost

> Status: research notes, **not a decision**. Checked 2026-11-15. Browser support comes from MDN browser-compat-data 8.1.9 (2026-11-12).
> **[unverified]** marks claims that could not be confirmed from official sources. This answers owner requirement D3 / Q8.

## 1. How browser download managers resume

- **S3** checks presigned-URL expiry only when a request starts. A transfer already running finishes. A resume or retry after expiry fails with 403 ([AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)).
- **S3 header signing:** if `Range` is signed, `If-Range` must be signed too. **Never sign `Range` in download URLs**, because browsers add `If-Range` when they resume (same page).
- **Chromium:**
  - Resumes with `If-Range` plus a strong validator.
  - **Resume uses only the final URL after redirects** ([commit 6ac869d](https://chromium.googlesource.com/chromium/src/+/6ac869dac34c217329d8a23c8cb4f5472e0758df)).
  - A redirect seen during resume interrupts the download ([CL 1544603003](https://codereview.chromium.org/1544603003)).
  - So with `/d/:id` → 302 → presigned URL, resume after expiry = 403. A manual re-click restarts from `/d/:id`.
- **Firefox:** keeps a `.part` file and resumes with Range. It restarts from zero if the resume fails ([bug 1525243](https://bugzil.la/1525243)).
- **Safari (macOS and iOS):** downloads run on NSURLSession, and resume needs Range support ([Apple](https://developer.apple.com/documentation/foundation/pausing-and-resuming-downloads.md)). The iOS download manager has existed since iOS 13 and saves to Files. Behaviour after expiry or redirect is **[unverified]**.

## 2. Making "retry" work after expiry

| Strategy | Retry (restart) | Resume after expiry | Cost / notes |
|---|---|---|---|
| (a) Long presigned URL | ✅ until expiry | ✅ until expiry | ≤ 7 days with IAM-user keys. URLs signed with STS or role credentials die when the credentials expire (often 1 h). It is a bearer link. |
| (b) Stable `/d/:id` → 302 → fresh presigned URL | ✅ | ❌ in Chromium; Safari and Firefox **[unverified]** | Zero compute, and bytes go straight from the bucket. |
| (b′) Stable `/d/:id` **streams the bytes** (edge proxy, Range/If-Range pass-through) | ✅ | ✅ in every browser's manager | Needs an edge proxy. Cloudflare Worker + R2 means zero egress and cheap compute. |
| (c) CloudFront signed cookies | ✅ | ✅ if the cookie stays valid **[unverified]** | The URL stays clean. Requires CloudFront ([AWS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html)). |
| (c′) Cloudflare HMAC token auth | ✅ | ✅ within the token lifetime | Pro plan or higher ([CF](https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/)). |

Egress costs:
- **S3:** about $0.09/GB **[unverified tier]**. S3 → CloudFront transfer is free ([S3 pricing](https://aws.amazon.com/s3/pricing/)).
- **R2:** egress is **free** ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

**Key insight:** to resume natively, the *final* URL must stay valid. "Unique per user" should therefore come from auth attached to a stable URL (a cookie, or a long revocable token), not from a short-lived URL.

## 3. Managed (in-browser) download sinks

| API | Chrome/Edge | Chrome Android | Firefox | Safari macOS / iOS |
|---|---|---|---|---|
| `showSaveFilePicker` (stream straight to the user's file) | 86 | 132 | ❌ | ❌ |
| OPFS + `createSyncAccessHandle` (worker) | 86/102 | 109 | 111 | 15.2 |
| `createWritable` | 86 | 109 | 111 | 26 (OPFS only) |
| Service-worker-generated download | ✅ | ✅ | ✅ | 15.4 |
| `navigator.share({ files })` | partial | ✅ | ❌ | 14 |
| Background Fetch | 74 | 74 | ❌ | ❌ |

- **Memory Blob:** limited by RAM, and tabs crash on large files. Small files only.
- **File System Access:** writes straight to disk, with no double disk use. It resumes if the handle is kept in IndexedDB. **Chromium only.** This is the best sink for tens of GB.
- **OPFS:**
  - Quota is about 60 % of the disk (Chromium, Safari 17+). Firefox gives 10 % or 10 GiB unless storage is persisted ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
  - Safari evicts it after 7 days without interaction.
  - Export is `getFile()` → blob URL → `<a download>`, which **temporarily doubles disk use** **[unverified, implied]**.
- **Service-worker stream (StreamSaver, Proton Drive):** constant memory, but **not resumable** (it breaks when the user leaves the page). Firefox may kill the service worker. On iOS the download shows 0 KB until it finishes ([WebKit 258412](https://bugs.webkit.org/show_bug.cgi?id=258412)).
- **What other products do:**
  - **Proton Drive:** a worker decrypts, then streams through a service worker, with no full buffering and no mention of resume ([Proton](https://proton.me/blog/proton-drive-web-encryption-technique)).
  - **Mega:** buffers in browser storage (2–3× disk) and pushes Firefox users to its desktop app (forums **[unofficial]**).
  - **Drive, Dropbox, WeTransfer:** native downloads via signed CDN URLs and server-side zips **[unverified]**.

## 4. Multiple files

- **client-zip:** a client-side STORE + Zip64 stream with an exact predicted length. It is cheap and compatible with E2EE, but not resumable.
- **Server/edge zip:** costs compute and egress. It is resumable only if built deterministically **[design idea]**.
- **Per-file links:** simplest, and each is resumable.

## 5. Proposal (feeds SPEC §14, D-021)

- **Tier 0, default:** a stable per-user link handed to the **native download manager**.
  - **Mode R (redirect):** zero infra. Presigned TTL is sized to the expected download time and capped by the credential type. Retry works; resume works until the TTL expires.
  - **Mode P (pass-through):** an optional edge proxy that serves Range. Resume works everywhere, including iOS Safari. Recommended for very large files when the host can run an edge function.
- **Tier 1, opt-in managed:** parallel Range chunks in a worker, validators, re-resolve on 403. The sink is chosen by capability: FS Access → OPFS (+ export; check `estimate()`, call `persist()`) → service-worker stream (not resumable) → memory.
- **E2EE:** forces Tier 1, because the native manager can't decrypt. On iOS and Firefox, tens of GB is best-effort.
