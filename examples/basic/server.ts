// Server: the only place that knows the bucket and its credentials.
import { createServer } from 'node:http';
import { implement, createUploadServer } from '@bu-draft/server';
import { toNodeHandler } from '@bu-draft/server/node';
import { s3Storage } from '@bu-draft/s3';
import { contract } from './contract.js';

interface User { id: string; quotaBytes: number }
declare function getUserFromCookie(cookie: string | undefined): Promise<User | null>;
declare const db: {
  media: {
    insert(row: { id: string; ownerId: string; key: string; size: number }): Promise<{ id: string }>;
    find(id: string): Promise<{ key: string; ownerId: string; versionId?: string; name: string } | null>;
  };
};

const t = implement(contract).$context<{ user: User | null }>();

const requireUser = t.travelVideos.use(({ context, next, }) => {
  if (!context.user) throw new Error('UNAUTHORIZED');
  return next({ user: context.user });
});

export const router = t.router({
  avatar: t.avatar.handler({
    authorize: ({ context, errors }) => {
      if (!context.user) return errors('UNAUTHORIZED');
      return { ownerId: context.user.id };
    },
    key: ({ meta, sessionId }) => `avatars/${meta.ownerId}/${sessionId}`,
    onComplete: async ({ object }) => ({ url: `https://cdn.example.com/${object.key}` }),
  }),

  travelVideos: requireUser.handler({
    authorize: ({ context, files, errors }) => {
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > context.user.quotaBytes) {
        return errors('QUOTA_EXCEEDED', { data: { remainingBytes: context.user.quotaBytes } });
      }
      return { ownerId: context.user.id };
    },
    key: ({ meta, sessionId, input }) => `albums/${input.albumId}/${meta.ownerId}/${sessionId}`,
    onComplete: async ({ session, object }) => {
      // at-least-once: session.id is the idempotency key
      const row = await db.media.insert({ id: session.id, ownerId: session.meta.ownerId, key: object.key, size: object.size });
      return { mediaId: row.id };
    },
  }),

  media: {
    download: t.media.download.handler({
      resolve: async ({ context, input, errors }) => {
        const m = await db.media.find(input.mediaId);
        if (!m || m.ownerId !== context.user?.id) return errors('NOT_FOUND');
        return { key: m.key, ...(m.versionId ? { versionId: m.versionId } : {}), fileName: m.name, disposition: 'attachment' };
      },
    }),
  },
});

const uploads = createUploadServer({
  router,
  storage: s3Storage({
    preset: 'cloudflare-r2',
    bucket: process.env.BUCKET!,
    region: 'auto',
    endpoint: process.env.S3_ENDPOINT!,
    credentials: { accessKeyId: process.env.S3_KEY_ID!, secretAccessKey: process.env.S3_SECRET!, },
  }),
  secret: process.env.UPLOAD_TOKEN_SECRET!,
  basePath: '/api/upload',
});

// Node / Express-style mount. On Bun/Deno/Workers/Hono: `uploads.fetch(request, ctx)`.
createServer(
  toNodeHandler(uploads, { context: async (req) => ({ user: await getUserFromCookie(req.headers.cookie) }) }),
).listen(3000);
