import { uc } from '@bu-draft/core';
import { z } from 'zod';

/** Contract shared by the e2e page and server. */
export const contract = uc.router({
  videos: uc
    .upload()
    .files({ accept: ['video/*', 'application/octet-stream', '.bin'], maxFiles: 4 })
    .input(z.object({ albumId: z.string() }))
    .output(z.object({ key: z.string(), size: z.number() }))
    .resume({ ttl: '7d', verify: 'auto' }),
  files: { get: uc.download().input(z.object({ key: z.string() })) },
});
export type Contract = typeof contract;
