import { uc } from '@open-upload/core';
import { minio, s3Storage } from '@open-upload/s3';
import { createUploadServer, implement } from '@open-upload/server';
import { memoryStorage } from '@open-upload/server/testing';
import { v } from 'convex/values';
import { OpenUpload } from '../../src/client/index.js';
import { components } from './_generated/api.js';
import { internalAction, query } from './_generated/server.js';

/** Shared contract (import it in the browser too). */
export const contract = uc.router({
  files: uc.upload().files({ maxFiles: 10, maxFileSize: '20GB' }),
});

export const openUpload = new OpenUpload(components.openUpload);

/**
 * Any S3-compatible bucket. Credentials stay in app code (component functions never see them). Without env vars
 * (tests, first run) an in-memory bucket is used.
 */
export const storage = process.env.S3_ENDPOINT
  ? s3Storage({
      provider: minio({ endpoint: process.env.S3_ENDPOINT }),
      bucket: process.env.S3_BUCKET ?? 'uploads',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    })
  : memoryStorage();

const t = implement(contract).$context<{ convex: any; userId: string | undefined }>();

export const uploads = createUploadServer({
  storage,
  secret: process.env.UPLOAD_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
  cors: { origin: (process.env.APP_ORIGINS ?? 'http://localhost:5173').split(',') },
  router: t.router({
    files: openUpload.tracked(t.files, { owner: ({ context }) => context.userId }).handler({
      onUploadRequested: ({ context, sessionId, file }) => ({
        key: `${context.userId ?? 'anonymous'}/${sessionId}/${file.name}`,
      }),
    }),
  }),
});

/** Reactive "your unfinished uploads" for the current user (pass tickets to `client.files.resume`). */
export const myPendingUploads = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return openUpload.listPending(ctx, { ...(identity ? { owner: identity.subject } : {}) });
  },
});

export const upload = query({
  args: { sessionId: v.string() },
  handler: (ctx, { sessionId }) => openUpload.get(ctx, sessionId),
});

/** Scheduled from crons.ts: abort expired multipart uploads so they stop costing money. */
export const cleanup = internalAction({
  args: {},
  handler: (ctx) => openUpload.cleanup(ctx, uploads, storage),
});
