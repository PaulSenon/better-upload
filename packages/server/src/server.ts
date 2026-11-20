import {
  type AbortRequest,
  type CompleteRequest,
  type CompleteResponse,
  type ContractRouter,
  checkFiles,
  type DownloadContract,
  type Duration,
  type EpochMs,
  encodeLinkInput,
  type FileDescriptor,
  formatIssues,
  type InitRequest,
  type InitResponse,
  type InitSession,
  isChecksumValue,
  isValidPartNumber,
  type PartChecksumAlgorithm,
  type PartPlan,
  type PartSizePolicy,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  parseDuration,
  partLength,
  planParts,
  type ResolveResponse,
  type RouterPaths,
  type SignRequest,
  type SignResponse,
  type StatusRequest,
  type StatusResponse,
  type StorageAdapter,
  type StoredObject,
  type UploadContract,
  UploadError,
  type UploadErrorShape,
  validateSchema,
} from '@open-upload/core';
import {
  type AnyMiddleware,
  createErrorFactory,
  type DownloadTarget,
  type ImplementedDownload,
  type ImplementedRouter,
  type ImplementedUpload,
  type ServerOp,
  type UploadSession,
} from './implement.js';
import { createSealer } from './seal.js';

/** Metadata key written on every object, so a retried `complete` can recognise its own object. */
export const SESSION_METADATA_KEY = 'upload-session';

export interface UploadServerOptions<T extends ContractRouter, TCtx extends object> {
  readonly router: ImplementedRouter<T, TCtx>;
  readonly storage: StorageAdapter;
  /**
   * Secret sealing session tickets and receipts (≥ 32 random characters, e.g. `openssl rand -base64 32`).
   * Rotation: pass an array; the first seals, all open. Not a storage credential.
   */
  readonly secret: string | readonly string[];
  /** Path prefix the handler is mounted on. Must match the client `baseUrl` path. Default `/api/upload`. */
  readonly basePath?: string;
  /** Validity of presigned part URLs. Default 15 min. Short on purpose: the client re-signs transparently. */
  readonly signedUrlTtl?: Duration;
  /** Max part URLs per `sign` call. Default 20. */
  readonly maxSignBatch?: number;
  /** Default part sizing for every endpoint. */
  readonly partSize?: Partial<PartSizePolicy>;
  /** How long a completion receipt stays verifiable. Default 24 h. */
  readonly receiptTtl?: Duration;
  /** Called for every error before it is serialized (logging / metrics). Internal details never reach the client. */
  readonly onError?: (error: unknown, info: { endpoint: string; op: string }) => void;
  /**
   * CORS for apps whose upload server lives on another origin (e.g. a Convex `.convex.site` URL, an API subdomain).
   * Same-origin setups need nothing. Preflights (OPTIONS) are answered without running any hook.
   */
  readonly cors?: {
    /** Allowed origins, or a function deciding per request. */
    readonly origin: readonly string[] | ((origin: string) => boolean);
    /** Allow cookies (`credentials: 'include'` on the client). Default false. */
    readonly credentials?: boolean;
    /** Extra request headers your client sends (e.g. `authorization`). */
    readonly allowHeaders?: readonly string[];
  };
}

export interface UploadReceipt<TMeta = unknown> {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly object: StoredObject;
  readonly file: FileDescriptor;
  readonly meta: TMeta;
  readonly issuedAt: EpochMs;
  readonly expiresAt: EpochMs;
}

export interface UploadServer<T extends ContractRouter, TCtx extends object> {
  /** Fetch-standard handler. Works as-is on Bun, Deno, Cloudflare Workers, Hono, Next.js route handlers, Convex HTTP actions. */
  fetch(request: Request, context: TCtx): Promise<Response>;
  /**
   * Verifies a completion receipt (returned to the client by `complete`), e.g. when your CMS creates its record
   * in a separate request. `null` if forged, expired, or issued for another endpoint.
   */
  verifyReceipt<TMeta = unknown>(
    receipt: string,
    options?: { endpoint?: RouterPaths<T> },
  ): Promise<UploadReceipt<TMeta> | null>;
  /** Decodes a session ticket (e.g. one your app stored) without contacting the storage. */
  readTicket<TMeta = unknown>(ticket: string): Promise<UploadSession<TMeta> | null>;
  readonly basePath: string;
  readonly '~contract': T;
}

interface TicketPayload {
  readonly v: 1;
  readonly sid: string;
  readonly ep: string;
  readonly key: string;
  readonly uid?: string;
  readonly plan: PartPlan;
  readonly file: FileDescriptor;
  readonly meta: unknown;
  readonly iat: EpochMs;
  readonly exp: EpochMs;
}

const HOUR = 3_600_000;

/** Creates the upload server. Mount `server.fetch` (or `toNodeHandler(server)`) on `basePath`. */
export function createUploadServer<T extends ContractRouter, TCtx extends object>(
  options: UploadServerOptions<T, TCtx>,
): UploadServer<T, TCtx> {
  const { router, storage } = options;
  const sealer = createSealer(options.secret);
  const basePath = `/${(options.basePath ?? '/api/upload').replace(/^\/+|\/+$/g, '')}`;
  const signedUrlTtl = Math.floor(parseDuration(options.signedUrlTtl ?? '15m') / 1000);
  const maxSignBatch = options.maxSignBatch ?? 20;
  const receiptTtl = parseDuration(options.receiptTtl ?? '24h');
  const endpoints = router['~endpoints'];
  const caps = storage.capabilities;

  const report = (error: unknown, endpoint: string, op: string) => {
    try {
      options.onError?.(error, { endpoint, op });
    } catch {
      // never let logging break a response
    }
  };

  async function runMiddleware(
    chain: readonly AnyMiddleware[],
    baseContext: object,
    endpoint: string,
    op: ServerOp,
  ): Promise<any> {
    let context: any = baseContext;
    const run = async (i: number): Promise<any> => {
      const mw = chain[i];
      if (!mw) return { added: {} };
      return mw({
        context,
        endpoint,
        op,
        next: async (added?: object) => {
          context = { ...context, ...added };
          await run(i + 1);
          return { added };
        },
      });
    };
    await run(0);
    return context;
  }

  // -------------------------------------------------------------------------
  // tickets
  // -------------------------------------------------------------------------

  function sessionTtl(contract: UploadContract): number {
    const def = contract['~def'];
    let ttl = def.resume.enabled ? parseDuration(def.resume.ttl) : 24 * HOUR;
    // Stay safely inside the provider's own cleanup window for incomplete uploads.
    if (caps.incompleteUploadExpiry !== null) ttl = Math.min(ttl, caps.incompleteUploadExpiry - HOUR);
    return Math.max(ttl, HOUR);
  }

  async function openTicket(ticket: unknown, endpoint: string, allowExpired = false): Promise<TicketPayload> {
    if (typeof ticket !== 'string') throw UploadError.builtin('BAD_REQUEST', { message: 'Missing ticket' });
    const payload = await sealer.open<TicketPayload>('ticket', ticket);
    if (payload?.v !== 1) throw UploadError.builtin('SESSION_INVALID');
    if (payload.ep !== endpoint) {
      throw UploadError.builtin('SESSION_INVALID', { message: `This ticket belongs to endpoint "${payload.ep}"` });
    }
    if (!allowExpired && payload.exp < Date.now()) throw UploadError.builtin('SESSION_EXPIRED');
    return payload;
  }

  const toSession = (t: TicketPayload): UploadSession => ({
    id: t.sid,
    endpoint: t.ep,
    key: t.key,
    ...(t.uid ? { uploadId: t.uid } : {}),
    file: t.file,
    plan: t.plan,
    meta: t.meta,
    createdAt: t.iat,
    expiresAt: t.exp,
  });

  // -------------------------------------------------------------------------
  // upload ops
  // -------------------------------------------------------------------------

  function pickChecksum(contract: UploadContract): PartChecksumAlgorithm {
    const wanted = contract['~def'].integrity.partChecksum;
    if (wanted === 'none') return 'none';
    if (wanted === 'auto') return caps.checksums[0] ?? 'none';
    if (!caps.checksums.includes(wanted)) {
      throw new TypeError(`Checksum "${wanted}" is not supported by storage ${storage.name}`);
    }
    return wanted;
  }

  async function init(impl: ImplementedUpload<any, any, any>, endpoint: string, body: InitRequest, context: any) {
    const contract = impl['~contract'] as UploadContract;
    const def = contract['~def'];
    const files = parseFiles(body.files);
    const fileError = checkFiles(files, def.files);
    if (fileError) throw fileError;
    const parsed = await validateSchema(def.input, body.input);
    if (!parsed.ok) throw UploadError.builtin('INPUT_INVALID', { message: formatIssues(parsed.issues) });
    const input = parsed.value;
    const errors = createErrorFactory(def.errors);
    const hooks = impl['~hooks'];
    const checksum = pickChecksum(contract);
    const ttl = sessionTtl(contract);

    const sessions: InitSession[] = [];
    for (const file of files) {
      const plan = planParts(file.size, caps, checksum, { ...options.partSize, ...hooks.partSize });
      const sessionId = randomId();
      const decision = await hooks.onUploadRequested({ context, input, file, files, sessionId, errors });
      if (!decision || typeof decision.key !== 'string' || decision.key.length === 0 || decision.key.length > 900) {
        throw new TypeError(`onUploadRequested (${endpoint}) must return { key } with a non-empty key`);
      }
      const now = Date.now();
      let uploadId: string | undefined;
      if (plan.strategy === 'multipart') {
        const ref = await storage.createMultipartUpload({
          key: decision.key,
          ...(file.type ? { contentType: file.type } : {}),
          checksumAlgorithm: checksum,
          metadata: { [SESSION_METADATA_KEY]: sessionId },
        });
        uploadId = ref.uploadId;
      }
      const payload: TicketPayload = {
        v: 1,
        sid: sessionId,
        ep: endpoint,
        key: decision.key,
        ...(uploadId ? { uid: uploadId } : {}),
        plan,
        file,
        meta: decision.meta,
        iat: now,
        exp: now + ttl,
      };
      const ticket = await sealer.seal('ticket', payload);
      await hooks.onUploadStarted?.({ context, input, session: toSession(payload), ticket });
      sessions.push({
        sessionId,
        ticket,
        key: decision.key,
        plan,
        expiresAt: payload.exp,
        resume: resumePolicy(contract),
      });
    }
    return { sessions } satisfies InitResponse;
  }

  async function sign(impl: ImplementedUpload<any, any, any>, endpoint: string, body: SignRequest, context: any) {
    const t = await openTicket(body.ticket, endpoint);
    await impl['~hooks'].reauthorize?.({
      context,
      session: toSession(t),
      op: 'sign',
      errors: createErrorFactory(impl['~contract']['~def'].errors),
    });
    if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > maxSignBatch) {
      throw UploadError.builtin('BAD_REQUEST', { message: `Sign between 1 and ${maxSignBatch} parts per request` });
    }
    const expiresIn = Math.min(signedUrlTtl, caps.maxPresignExpiry);
    const parts = await Promise.all(
      body.parts.map(async ({ partNumber, checksum }) => {
        if (!isValidPartNumber(t.plan, partNumber)) {
          throw UploadError.builtin('BAD_REQUEST', { message: `Invalid part number ${partNumber}` });
        }
        const algorithm = t.plan.checksum;
        if (algorithm !== 'none' && !isChecksumValue(algorithm, checksum)) {
          throw UploadError.builtin('BAD_REQUEST', {
            message: `Part ${partNumber}: a ${algorithm} checksum is required`,
          });
        }
        const contentLength = partLength(t.plan, partNumber);
        const checksumArg = algorithm !== 'none' && checksum ? { checksum: { algorithm, value: checksum } } : {};
        const request =
          t.plan.strategy === 'single'
            ? await storage.signPutObject({
                key: t.key,
                contentLength,
                ...(t.file.type ? { contentType: t.file.type } : {}),
                metadata: { [SESSION_METADATA_KEY]: t.sid },
                expiresIn,
                ...checksumArg,
              })
            : await storage.signUploadPart({
                key: t.key,
                uploadId: t.uid!,
                partNumber,
                contentLength,
                expiresIn,
                ...checksumArg,
              });
        return { partNumber, request };
      }),
    );
    return { parts } satisfies SignResponse;
  }

  async function findCompletedObject(t: TicketPayload): Promise<StoredObject | null> {
    const object = await storage.headObject({ key: t.key });
    if (object && object.metadata[SESSION_METADATA_KEY] === t.sid && object.size === t.plan.fileSize) return object;
    return null;
  }

  async function status(impl: ImplementedUpload<any, any, any>, endpoint: string, body: StatusRequest, context: any) {
    const t = await openTicket(body.ticket, endpoint);
    await impl['~hooks'].reauthorize?.({
      context,
      session: toSession(t),
      op: 'status',
      errors: createErrorFactory(impl['~contract']['~def'].errors),
    });
    const base = {
      ticket: body.ticket,
      expiresAt: t.exp,
      sessionId: t.sid,
      file: t.file,
      key: t.key,
      plan: t.plan,
      resume: resumePolicy(impl['~contract']),
    };
    if (t.plan.strategy === 'single') {
      const object = await findCompletedObject(t);
      return {
        ...base,
        state: 'uploading',
        uploadedParts: object ? [{ partNumber: 1, size: object.size }] : [],
      } satisfies StatusResponse;
    }
    const parts = await storage.listParts({ key: t.key, uploadId: t.uid!, checksumAlgorithm: t.plan.checksum });
    if (parts === null) {
      if (await findCompletedObject(t))
        return { ...base, state: 'completed', uploadedParts: [] } satisfies StatusResponse;
      throw UploadError.builtin('SESSION_NOT_FOUND');
    }
    return {
      ...base,
      state: 'uploading',
      uploadedParts: parts.map((p) => ({
        partNumber: p.partNumber,
        size: p.size,
        ...(p.checksum ? { checksum: p.checksum } : {}),
      })),
    } satisfies StatusResponse;
  }

  async function complete(
    impl: ImplementedUpload<any, any, any>,
    endpoint: string,
    body: CompleteRequest,
    context: any,
  ) {
    const t = await openTicket(body.ticket, endpoint);
    const contract = impl['~contract'] as UploadContract;
    const errors = createErrorFactory(contract['~def'].errors);
    const hooks = impl['~hooks'];
    const session = toSession(t);
    await hooks.reauthorize?.({ context, session, op: 'complete', errors });

    let object: StoredObject | null = null;
    let alreadyCompleted = false;
    if (t.plan.strategy === 'single') {
      object = await findCompletedObject(t);
      if (!object)
        throw UploadError.builtin('INTEGRITY_MISMATCH', {
          message: 'The file is not in the storage yet',
          data: { partNumber: 1 },
        });
    } else {
      const parts = await storage.listParts({ key: t.key, uploadId: t.uid!, checksumAlgorithm: t.plan.checksum });
      if (parts === null) {
        object = await findCompletedObject(t);
        if (!object) throw UploadError.builtin('SESSION_NOT_FOUND');
        alreadyCompleted = true;
      } else {
        verifyParts(t.plan, parts);
        const done = await storage.completeMultipartUpload({
          key: t.key,
          uploadId: t.uid!,
          parts,
          checksumAlgorithm: t.plan.checksum,
        });
        if (done === null) alreadyCompleted = true;
        object = await findCompletedObject(t);
        if (!object) throw UploadError.builtin('STORAGE_ERROR', { message: 'The completed object is not visible yet' });
      }
    }

    let output: unknown;
    if (hooks.onUploadCompleted) {
      output = await hooks.onUploadCompleted({ context, session, object, alreadyCompleted, errors });
    }
    const checked = await validateSchema(contract['~def'].output, output);
    if (!checked.ok) {
      throw new Error(`onUploadCompleted (${endpoint}) returned an invalid output: ${formatIssues(checked.issues)}`);
    }
    const now = Date.now();
    const receipt = await sealer.seal('receipt', {
      endpoint,
      sessionId: t.sid,
      object,
      file: t.file,
      meta: t.meta,
      issuedAt: now,
      expiresAt: now + receiptTtl,
    } satisfies UploadReceipt);
    return { output: checked.value, receipt, alreadyCompleted } satisfies CompleteResponse;
  }

  async function abort(impl: ImplementedUpload<any, any, any>, endpoint: string, body: AbortRequest, context: any) {
    const t = await openTicket(body.ticket, endpoint, true);
    const hooks = impl['~hooks'];
    const session = toSession(t);
    await hooks.reauthorize?.({
      context,
      session,
      op: 'abort',
      errors: createErrorFactory(impl['~contract']['~def'].errors),
    });
    if (t.uid) await storage.abortMultipartUpload({ key: t.key, uploadId: t.uid });
    await hooks.onUploadAborted?.({ context, session });
    return { aborted: true };
  }

  // -------------------------------------------------------------------------
  // download ops
  // -------------------------------------------------------------------------

  async function resolveDownload(
    impl: ImplementedDownload<any, any>,
    input: unknown,
    context: any,
  ): Promise<DownloadTarget> {
    const contract = impl['~contract'] as DownloadContract;
    const parsed = await validateSchema(contract['~def'].input, input);
    if (!parsed.ok) throw UploadError.builtin('INPUT_INVALID', { message: formatIssues(parsed.issues) });
    const target = await impl['~hooks'].onDownloadRequested({
      context,
      input: parsed.value,
      errors: createErrorFactory(contract['~def'].errors),
    });
    if (!target || typeof target.key !== 'string' || !target.key) {
      throw new TypeError('onDownloadRequested must return { key }');
    }
    return target;
  }

  async function signDownload(target: DownloadTarget) {
    const expiresIn = Math.min(Math.floor(parseDuration(target.expiresIn ?? '1h') / 1000), caps.maxPresignExpiry);
    const disposition = target.disposition ?? 'attachment';
    return storage.signGetObject({
      key: target.key,
      expiresIn,
      ...(target.versionId ? { versionId: target.versionId } : {}),
      responseContentDisposition: target.fileName ? contentDisposition(disposition, target.fileName) : disposition,
      ...(target.contentType ? { responseContentType: target.contentType } : {}),
    });
  }

  async function proxyDownload(target: DownloadTarget, request: Request): Promise<Response> {
    if (!storage.getObject) {
      throw new TypeError(
        `delivery: 'proxy' needs a storage with getObject (e.g. withR2Binding on Cloudflare); ${storage.name} has none`,
      );
    }
    const forwarded = new Headers();
    for (const name of ['range', 'if-range', 'if-none-match', 'if-match', 'if-modified-since']) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    const upstream = await storage.getObject({
      key: target.key,
      ...(target.versionId ? { versionId: target.versionId } : {}),
      headers: forwarded,
    });
    const headers = new Headers(upstream.headers);
    const disposition = target.disposition ?? 'attachment';
    headers.set(
      'content-disposition',
      target.fileName ? contentDisposition(disposition, target.fileName) : disposition,
    );
    if (target.contentType) headers.set('content-type', target.contentType);
    headers.set('cache-control', 'private, no-store');
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  async function handle(request: Request, appContext: TCtx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`))
      return json({ error: errorBody(UploadError.builtin('NOT_FOUND')) }, 404);
    const rest = url.pathname.slice(basePath.length + 1).replace(/\/+$/, '');
    let endpoint = rest;
    let op = 'download';
    let impl = endpoints.get(rest);
    if (!impl || request.method === 'POST') {
      const slash = rest.lastIndexOf('/');
      endpoint = rest.slice(0, slash);
      op = rest.slice(slash + 1);
      impl = endpoints.get(endpoint);
    }
    const baseContext = { ...appContext, request };
    try {
      if (!impl) throw UploadError.builtin('NOT_FOUND', { message: `Unknown endpoint "${rest}"` });

      // Download link: GET {base}/{endpoint}?input=… → 302 to a fresh presigned URL.
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (impl['~kind'] !== 'implemented-download' || op !== 'download') throw UploadError.builtin('NOT_FOUND');
        const raw = url.searchParams.get('input');
        let input: unknown;
        try {
          input = raw === null ? undefined : JSON.parse(raw);
        } catch {
          throw UploadError.builtin('INPUT_INVALID', { message: 'Malformed input query parameter' });
        }
        const context = await runMiddleware(impl['~middleware'], baseContext, endpoint, 'download');
        const target = await resolveDownload(impl, input, context);
        if (target.delivery === 'proxy') return await proxyDownload(target, request);
        const signed = await signDownload(target);
        return new Response(null, {
          status: 302,
          headers: { location: signed.url, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' },
        });
      }

      if (request.method !== 'POST') throw UploadError.builtin('BAD_REQUEST', { message: 'Method not allowed' });
      // A custom header forces a CORS preflight, which protects cookie-authenticated apps against CSRF.
      if (request.headers.get(PROTOCOL_HEADER) !== String(PROTOCOL_VERSION)) {
        throw UploadError.builtin('BAD_REQUEST', { message: `Missing or unsupported ${PROTOCOL_HEADER} header` });
      }
      const body = await readJson(request);

      if (impl['~kind'] === 'implemented-download') {
        if (op !== 'resolve') throw UploadError.builtin('NOT_FOUND', { message: `Unknown operation "${op}"` });
        const context = await runMiddleware(impl['~middleware'], baseContext, endpoint, 'download');
        const target = await resolveDownload(impl, body.input, context);
        const [signed, head] = await Promise.all([
          signDownload(target),
          storage.headObject({ key: target.key, ...(target.versionId ? { versionId: target.versionId } : {}) }),
        ]);
        if (!head) throw UploadError.builtin('NOT_FOUND', { message: 'Object not found' });
        const response: ResolveResponse = {
          link: `${basePath}/${endpoint}${encodeLinkInput(body.input)}`,
          request: signed,
          object: {
            key: target.key,
            size: head.size,
            etag: head.etag,
            ...(head.versionId ? { versionId: head.versionId } : {}),
            ...(head.contentType ? { contentType: head.contentType } : {}),
            ...(target.fileName ? { fileName: target.fileName } : {}),
          },
        };
        return json(response, 200);
      }

      const handlers = { init, sign, status, complete, abort } as const;
      const handler = handlers[op as keyof typeof handlers];
      if (!handler) throw UploadError.builtin('NOT_FOUND', { message: `Unknown operation "${op}"` });
      const context = await runMiddleware(impl['~middleware'], baseContext, endpoint, op as ServerOp);
      return json(await handler(impl, endpoint, body, context), 200);
    } catch (error) {
      report(error, endpoint, op);
      const uploadError = toPublicError(error);
      return json(
        { error: errorBody(uploadError) },
        uploadError.status && uploadError.status >= 400 ? uploadError.status : 500,
      );
    }
  }

  function corsHeaders(request: Request): Record<string, string> | undefined {
    const cors = options.cors;
    const origin = request.headers.get('origin');
    if (!cors || !origin) return undefined;
    const allowed =
      typeof cors.origin === 'function'
        ? cors.origin(origin)
        : cors.origin.includes(origin) || cors.origin.includes('*');
    if (!allowed) return undefined;
    return {
      'access-control-allow-origin': origin,
      vary: 'origin',
      ...(cors.credentials ? { 'access-control-allow-credentials': 'true' } : {}),
    };
  }

  async function handleWithCors(request: Request, appContext: TCtx): Promise<Response> {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      if (!cors) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
          'access-control-allow-headers': ['content-type', PROTOCOL_HEADER, ...(options.cors?.allowHeaders ?? [])].join(
            ', ',
          ),
          'access-control-max-age': '86400',
        },
      });
    }
    const response = await handle(request, appContext);
    if (!cors) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  return {
    fetch: handleWithCors,
    basePath,
    '~contract': router['~contract'],
    async verifyReceipt<TMeta>(receipt: string, opts?: { endpoint?: string }) {
      const payload = await sealer.open<UploadReceipt<TMeta>>('receipt', receipt);
      if (!payload || payload.expiresAt < Date.now()) return null;
      if (opts?.endpoint && payload.endpoint !== opts.endpoint) return null;
      return payload;
    },
    async readTicket<TMeta>(ticket: string) {
      const payload = await sealer.open<TicketPayload>('ticket', ticket);
      return payload ? (toSession(payload) as UploadSession<TMeta>) : null;
    },
  } as UploadServer<T, TCtx>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resumePolicy(contract: UploadContract): { enabled: boolean; verify: 'auto' | 'metadata' | 'sample' | 'full' } {
  const { enabled, verify } = contract['~def'].resume;
  return { enabled, verify };
}

function verifyParts(plan: PartPlan, parts: readonly { partNumber: number; size: number; checksum?: string }[]): void {
  const byNumber = new Map(parts.map((p) => [p.partNumber, p]));
  for (let n = 1; n <= plan.partCount; n++) {
    const part = byNumber.get(n);
    if (!part)
      throw UploadError.builtin('INTEGRITY_MISMATCH', { message: `Part ${n} is missing`, data: { partNumber: n } });
    if (part.size !== partLength(plan, n)) {
      throw UploadError.builtin('INTEGRITY_MISMATCH', {
        message: `Part ${n} has ${part.size} bytes instead of ${partLength(plan, n)}`,
        data: { partNumber: n, actual: part.size, limit: partLength(plan, n) },
      });
    }
    if (plan.checksum !== 'none' && !part.checksum) {
      throw UploadError.builtin('INTEGRITY_MISMATCH', {
        message: `Part ${n} has no checksum`,
        data: { partNumber: n },
      });
    }
  }
  if (parts.length !== plan.partCount) {
    throw UploadError.builtin('INTEGRITY_MISMATCH', { message: 'Unexpected extra parts' });
  }
}

function parseFiles(value: unknown): FileDescriptor[] {
  if (!Array.isArray(value)) throw UploadError.builtin('BAD_REQUEST', { message: '`files` must be an array' });
  return value.map((f) => {
    if (
      typeof f !== 'object' ||
      f === null ||
      typeof f.name !== 'string' ||
      f.name.length > 1024 ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      typeof f.type !== 'string' ||
      f.type.length > 255 ||
      !Number.isFinite(f.lastModified)
    ) {
      throw UploadError.builtin('BAD_REQUEST', { message: 'Invalid file descriptor' });
    }
    return { name: f.name, size: f.size, type: f.type, lastModified: f.lastModified };
  });
}

async function readJson(request: Request): Promise<any> {
  const text = await request.text();
  if (text.length > 256 * 1024) throw UploadError.builtin('BAD_REQUEST', { message: 'Request body too large' });
  try {
    const value = JSON.parse(text || '{}');
    if (typeof value !== 'object' || value === null) throw new Error();
    return value;
  } catch {
    throw UploadError.builtin('BAD_REQUEST', { message: 'Invalid JSON body' });
  }
}

function toPublicError(error: unknown): UploadError {
  if (error instanceof UploadError) {
    // Storage details stay server-side.
    if (error.code === 'STORAGE_ERROR' && !error.retryable)
      return UploadError.builtin('STORAGE_ERROR', { retryable: false });
    return error;
  }
  return UploadError.builtin('INTERNAL_ERROR');
}

function errorBody(error: UploadError): Omit<UploadErrorShape, 'cause'> {
  return error.toJSON();
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 6266 / 5987 `Content-Disposition` with a UTF-8 file name and an ASCII fallback. */
export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
