/**
 * E2E harness: one Node server hosting the test page (Vite middleware), two upload servers and test controls.
 * The browser reaches MinIO through a fault-injecting proxy.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { s3Storage } from '@open-upload/s3';
import { createUploadServer, implement } from '@open-upload/server';
import { toNodeHandler } from '@open-upload/server/node';
import react from '@vitejs/plugin-react';
import { createServer as createVite } from 'vite';
import { contract } from './contract.ts';
import { startFaultProxy } from './fault-proxy.ts';

const PORT = Number(process.env.E2E_PORT ?? 5199);
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT ?? 9100);
const MINIO = new URL(process.env.MINIO_ENDPOINT ?? 'http://localhost:9000');
const BUCKET = 'uploads-e2e';

const proxy = startFaultProxy({ port: PROXY_PORT, target: { host: MINIO.hostname, port: Number(MINIO.port || 80) } });
const credentials = {
  accessKeyId: process.env.MINIO_USER ?? 'minioadmin',
  secretAccessKey: process.env.MINIO_PASSWORD ?? 'minioadmin',
};
// The browser (and the server) talk to the storage through the proxy.
const storage = s3Storage({ preset: 'minio', endpoint: `http://localhost:${PROXY_PORT}`, bucket: BUCKET, credentials });
await storage.client.request({ method: 'PUT', allow: [409] });

const t = implement(contract);
const router = t.router({
  videos: t.videos.handler({
    onUploadRequested: ({ input, sessionId, file }) => ({ key: `${input.albumId}/${sessionId}/${file.name}` }),
    onUploadCompleted: ({ object }) => ({ key: object.key, size: object.size }),
  }),
  files: {
    get: t.files.get.handler({
      onDownloadRequested: ({ input }) => ({ key: input.key, fileName: input.key.split('/').pop()! }),
    }),
  },
});
const secret = 'e2e-secret-e2e-secret-e2e-secret-0001';
const uploads = createUploadServer({ router, storage, secret, basePath: '/api/upload' });
// Same contract, very short presigned URLs: exercises transparent re-signing.
const shortUrls = createUploadServer({ router, storage, secret, basePath: '/api/upload-short', signedUrlTtl: '2s' });

const vite = await createVite({
  root: new URL('./app', import.meta.url).pathname,
  plugins: [react()],
  resolve: { conditions: ['source'] },
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
  logLevel: 'warn',
});

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
};

const handleUploads = toNodeHandler(uploads, { context: () => ({}) });
const handleShort = toNodeHandler(shortUrls, { context: () => ({}) });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/upload-short/')) return void (await handleShort(req, res));
      if (url.pathname.startsWith('/api/upload/')) return void (await handleUploads(req, res));
      if (url.pathname === '/__test/faults') {
        proxy.set(await readBody(req));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/reset') {
        proxy.reset();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/log') return json(res, 200, proxy.log);
      if (url.pathname === '/__test/expire') {
        // Simulates the bucket's lifecycle rule discarding the incomplete upload.
        const { ticket } = await readBody(req);
        const session = await uploads.readTicket(ticket);
        if (!session) return json(res, 404, {});
        if (session.uploadId) await storage.abortMultipartUpload({ key: session.key, uploadId: session.uploadId });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/multipart') {
        // In-progress multipart uploads under a prefix (to check that cancel aborted them).
        const r = await storage.client.request({
          method: 'GET',
          query: { uploads: '', prefix: url.searchParams.get('prefix') ?? '' },
        });
        const xml = await r.text();
        return json(res, 200, { uploads: [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]) });
      }
      if (url.pathname === '/__test/object') {
        const key = url.searchParams.get('key')!;
        const signed = await storage.signGetObject({ key, expiresIn: 60 });
        const r = await fetch(signed.url);
        if (!r.ok) return json(res, 404, {});
        const body = Buffer.from(await r.arrayBuffer());
        return json(res, 200, { size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
      }
      vite.middlewares(req, res);
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.end();
    }
  })
  .listen(PORT, () => console.log(`e2e harness on http://localhost:${PORT}`));
