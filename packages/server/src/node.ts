import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContractRouter } from '@bu-draft/core';
import type { UploadServer } from './server.js';

/**
 * Adapts the Fetch handler to Node's `http` (and Express / Connect, which pass the same objects).
 * Mount it on the server's `basePath`, or anywhere: the original URL is used.
 */
export function toNodeHandler<T extends ContractRouter, TCtx extends object>(
  server: UploadServer<T, TCtx>,
  options: { context: (req: IncomingMessage) => TCtx | Promise<TCtx>; origin?: string },
): (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => Promise<void> {
  return async (req, res, next) => {
    try {
      const request = await toRequest(req, options.origin);
      const response = await server.fetch(request, await options.context(req));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        res.setHeader(name, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (next) next(error);
      else {
        res.statusCode = 500;
        res.end();
      }
    }
  };
}

async function toRequest(req: IncomingMessage, origin?: string): Promise<Request> {
  const host = req.headers.host ?? 'localhost';
  const base = origin ?? `${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${host}`;
  // Express rewrites `req.url` for mounted routers; `originalUrl` keeps the full path.
  const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) throw new Error('Request body too large');
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(new URL(path, base), { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
}
