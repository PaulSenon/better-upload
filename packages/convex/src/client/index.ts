import type { ContractRouter, FileDescriptor, StorageAdapter } from '@open-upload/core';
import type { UploadServer, UploadSession } from '@open-upload/server';
import {
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type HttpRouter,
  httpActionGeneric,
} from 'convex/server';
import type { ComponentApi } from '../component/_generated/component.js';

type RunMutationCtx =
  | Pick<GenericMutationCtx<GenericDataModel>, 'runMutation'>
  | Pick<GenericActionCtx<GenericDataModel>, 'runMutation'>;
type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, 'runQuery'>;

/** What hooks receive when the upload server runs in a Convex HTTP action through {@link OpenUpload.registerRoutes}. */
export interface ConvexUploadContext {
  readonly convex: GenericActionCtx<GenericDataModel>;
}

export interface PendingUpload {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly owner?: string;
  readonly ticket: string;
  readonly key: string;
  readonly file: FileDescriptor;
  readonly status: 'pending' | 'completed' | 'aborted' | 'expired';
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Open Upload for Convex. Bytes go from the browser straight to your bucket (any S3-compatible provider, multipart,
 * resumable); Convex runs the small control requests in an HTTP action and keeps a reactive list of uploads in the
 * component's tables, so "your unfinished uploads" shows on every device.
 *
 * ```ts
 * // convex/uploads.ts
 * export const openUpload = new OpenUpload(components.openUpload);
 * export const uploads = createUploadServer({ storage, secret, router: t.router({
 *   videos: t.videos.handler(openUpload.track({
 *     owner: ({ context }) => context.userId,
 *     onUploadRequested: ...,
 *   })),
 * }) });
 * // convex/http.ts
 * openUpload.registerRoutes(http, uploads, { context: async (ctx) => ({ userId: (await ctx.auth.getUserIdentity())?.subject }) });
 * ```
 */
export class OpenUpload {
  constructor(public readonly component: ComponentApi) {}

  /**
   * Tracks an endpoint: every upload is recorded in the component (started → completed / aborted). Use it in place of
   * the endpoint implementer; your own hooks keep their exact types and still run, after the record is written.
   *
   * ```ts
   * files: openUpload.tracked(t.files, { owner: ({ context }) => context.userId }).handler({ onUploadRequested: ... })
   * ```
   */
  tracked<I extends { handler(hooks: any): any; use(mw: any): any }>(
    implementer: I,
    options: { owner?: (args: { context: any; session: UploadSession<any> }) => string | undefined } = {},
  ): I {
    return {
      ...implementer,
      use: (mw: any) => this.tracked(implementer.use(mw), options),
      handler: (hooks: TrackableHooks) => implementer.handler(this.#wrap(hooks, options.owner)),
    } as I;
  }

  #wrap(
    hooks: TrackableHooks,
    owner?: (args: { context: any; session: UploadSession<any> }) => string | undefined,
  ): TrackableHooks {
    const component = this.component;
    const convexOf = (context: any): RunMutationCtx => {
      const ctx = context?.convex;
      if (!ctx?.runMutation)
        throw new TypeError('OpenUpload.tracked(): the server context needs `convex` (use registerRoutes)');
      return ctx;
    };
    return {
      ...hooks,
      onUploadStarted: async (args: any) => {
        const ownerId = owner?.({ context: args.context, session: args.session });
        await convexOf(args.context).runMutation(component.lib.recordStarted, {
          sessionId: args.session.id,
          endpoint: args.session.endpoint,
          ticket: args.ticket,
          key: args.session.key,
          file: args.session.file,
          expiresAt: args.session.expiresAt,
          ...(ownerId ? { owner: ownerId } : {}),
        });
        await hooks.onUploadStarted?.(args);
      },
      onUploadCompleted: async (args: any) => {
        await convexOf(args.context).runMutation(component.lib.recordCompleted, {
          sessionId: args.session.id,
          object: {
            size: args.object.size,
            etag: args.object.etag,
            ...(args.object.contentType ? { contentType: args.object.contentType } : {}),
          },
        });
        return hooks.onUploadCompleted?.(args);
      },
      onUploadAborted: async (args: any) => {
        await convexOf(args.context).runMutation(component.lib.recordAborted, { sessionId: args.session.id });
        await hooks.onUploadAborted?.(args);
      },
    };
  }

  /**
   * Mounts the upload server on the app's HTTP router (`convex/http.ts`). Hooks receive `{ convex: ctx, ...yours }`.
   * Set the server's `cors` option to your app's origin: browsers call `https://<deployment>.convex.site`.
   */
  registerRoutes<T extends ContractRouter, TCtx extends ConvexUploadContext>(
    http: HttpRouter,
    server: UploadServer<T, TCtx>,
    options: {
      /** Extra context for hooks (e.g. the user from `ctx.auth`). */
      context?: (
        ctx: GenericActionCtx<GenericDataModel>,
        request: Request,
      ) => Omit<TCtx, 'convex'> | Promise<Omit<TCtx, 'convex'>>;
    } = {},
  ): void {
    const handler = httpActionGeneric(async (ctx, request) => {
      const extra = (await options.context?.(ctx, request)) ?? {};
      return server.fetch(request, { ...extra, convex: ctx } as TCtx);
    });
    const pathPrefix = `${server.basePath}/`;
    for (const method of ['GET', 'POST', 'OPTIONS'] as const) http.route({ pathPrefix, method, handler });
  }

  /** Unfinished uploads (newest first). Call it from your own query: the list is reactive. */
  listPending(
    ctx: RunQueryCtx,
    args: { owner?: string; endpoint?: string; limit?: number } = {},
  ): Promise<PendingUpload[]> {
    return ctx.runQuery(this.component.lib.listPending, args) as Promise<PendingUpload[]>;
  }

  get(ctx: RunQueryCtx, sessionId: string): Promise<PendingUpload | null> {
    return ctx.runQuery(this.component.lib.get, { sessionId }) as Promise<PendingUpload | null>;
  }

  /**
   * Marks expired uploads and aborts their multipart uploads in the bucket so they stop costing money. Run it from an
   * action on a cron (e.g. hourly). The component never sees storage credentials: the app passes its server/storage.
   */
  async cleanup(
    ctx: Pick<GenericActionCtx<GenericDataModel>, 'runMutation'>,
    server: Pick<UploadServer<any, any>, 'readTicket'>,
    storage: Pick<StorageAdapter, 'abortMultipartUpload'>,
  ): Promise<{ expired: number }> {
    const expired = (await ctx.runMutation(this.component.lib.expireStale, {})) as {
      sessionId: string;
      ticket: string;
    }[];
    for (const { ticket } of expired) {
      const session = await server.readTicket(ticket);
      if (session?.uploadId)
        await storage.abortMultipartUpload({ key: session.key, uploadId: session.uploadId }).catch(() => {});
    }
    return { expired: expired.length };
  }
}

interface TrackableHooks {
  onUploadStarted?(args: any): void | Promise<void>;
  onUploadCompleted?(args: any): any;
  onUploadAborted?(args: any): void | Promise<void>;
}

export type { ComponentApi, FunctionReference };
