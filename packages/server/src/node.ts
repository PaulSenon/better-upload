/**
 * @bu-draft/server/node — DESIGN DRAFT (types only).
 * Adapter from Node `http` (and therefore Express / Connect / Fastify raw) to the Fetch handler.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContractRouter } from '@bu-draft/core';
import type { UploadServer } from './index.js';

export interface NodeAdapterOptions<TCtx extends object> {
  /** Build the typed context from the raw request (session cookie, auth header, ...). */
  context: (req: IncomingMessage) => TCtx | Promise<TCtx>;
  /** When mounted under a prefix (Express `app.use('/api/upload', ...)`), strip it. */
  mountPath?: string;
}

/** `app.use('/api/upload', toNodeHandler(server, { context }))` */
export declare function toNodeHandler<T extends ContractRouter, TCtx extends object>(
  server: UploadServer<T, TCtx>,
  options: NodeAdapterOptions<TCtx>,
): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;
