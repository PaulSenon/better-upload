// Shared between server and client. No secrets, no bucket, no framework.
import { uc } from '@bu-draft/core';
import { z } from 'zod';

export const contract = uc.router({
  avatar: uc
    .upload()
    .files({ accept: ['image/*'], maxFileSize: '10MiB', maxFiles: 1 })
    .output(z.object({ url: z.string().url() })),

  travelVideos: uc
    .upload()
    .files({ accept: ['video/*', '.mov', '.mp4'], maxFiles: 20 }) // no size limit beyond provider limits
    .input(z.object({ albumId: z.string().uuid() }))
    .output(z.object({ mediaId: z.string() }))
    .errors({
      QUOTA_EXCEEDED: { status: 403, data: z.object({ remainingBytes: z.number() }), userAction: 'contact-support' },
    })
    .resume({ ttl: '7d', verify: 'sample' })
    .integrity({ partChecksum: 'crc32c' }),

  media: {
    download: uc
      .download()
      .input(z.object({ mediaId: z.string() }))
      .errors({ NOT_FOUND: { status: 404 } }),
  },
});

export type Contract = typeof contract;
