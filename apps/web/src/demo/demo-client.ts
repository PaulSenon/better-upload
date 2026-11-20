/**
 * A complete upload stack running in the browser tab, for live previews in the docs: the real client engine,
 * the real server router and an in-memory bucket. A simulated network adds latency, bandwidth and failures,
 * so retries, pause/resume and reload-resume behave as they would against S3.
 */
import { createUploadClient, indexedDBStore, type Transport } from '@open-upload/client';
import { uc } from '@open-upload/core';
import { createUploadServer, implement } from '@open-upload/server';
import { memoryStorage } from '@open-upload/server/testing';
import { z } from 'zod';

export const demoContract = uc.router({
  files: uc.upload().files({ maxFiles: 10, maxFileSize: '2GB' }),
  download: uc.download().input(z.object({ key: z.string(), name: z.string() })),
});

export interface NetworkSim {
  /** Bytes per second. */
  bandwidth: number;
  /** Probability that a part upload fails mid-way. */
  failureRate: number;
  offline: boolean;
}

export const network: NetworkSim = { bandwidth: 8 * 1024 * 1024, failureRate: 0, offline: false };

function createDemo() {
  const storage = memoryStorage();
  const t = implement(demoContract);
  const server = createUploadServer({
    storage,
    secret: 'demo-secret-demo-secret-demo-secret!',
    router: t.router({
      files: t.files.handler({ onUploadRequested: ({ sessionId, file }) => ({ key: `${sessionId}/${file.name}` }) }),
      download: t.download.handler({ onDownloadRequested: ({ input }) => ({ key: input.key, fileName: input.name }) }),
    }),
  });
  const transport: Transport = {
    async send({ request, body, signal, onProgress }) {
      const chunk = 256 * 1024;
      const fail = Math.random() < network.failureRate ? Math.random() * body.size : Number.POSITIVE_INFINITY;
      for (let sent = 0; sent < body.size; sent += chunk) {
        if (network.offline || sent > fail)
          throw Object.assign(new Error('Simulated network error'), { name: 'NetworkError' });
        await new Promise((r, reject) => {
          const timer = setTimeout(r, (chunk / network.bandwidth) * 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
        onProgress?.(Math.min(body.size, sent + chunk));
      }
      const response = await storage.fetch(request.url, { method: request.method, headers: request.headers, body });
      return { status: response.status, headers: {}, body: await response.text() };
    },
  };
  const client = createUploadClient<typeof demoContract>({
    baseUrl: 'http://demo.local/api/upload',
    contract: demoContract,
    fetch: (input, init) => server.fetch(new Request(input, init), {}),
    transport,
    storageFetch: (input, init) => storage.fetch(input, init),
    persistence: typeof indexedDB === 'undefined' ? false : indexedDBStore({ dbName: 'upload-sdk-docs-demo' }),
    retry: { baseDelayMs: 300, maxDelayMs: 3000 },
  });
  return { client, storage };
}

let demo: ReturnType<typeof createDemo> | undefined;
/** Lazily created on the client (never during SSR / prerender). */
export function getDemo() {
  demo ??= createDemo();
  return demo;
}
