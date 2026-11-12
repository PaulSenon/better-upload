import { implement } from '@bu-draft/server';
import { contract } from '../examples/basic/contract.js';

const t = implement(contract).$context<{ userId?: string }>();

const avatar = t.avatar.handler({
  authorize: ({ context }) => ({ ownerId: context.userId ?? 'anon' }),
  key: ({ meta }) => `a/${meta.ownerId}`,
  onComplete: () => ({ url: 'https://x.test/a' }),
});

t.avatar.handler({
  authorize: () => ({}),
  key: () => 'k',
  // @ts-expect-error output must match the contract output schema
  onComplete: () => ({ wrong: true }),
});

t.travelVideos.handler({
  authorize: ({ errors }) => {
    // @ts-expect-error QUOTA_EXCEEDED requires typed `data`
    errors('QUOTA_EXCEEDED');
    // @ts-expect-error unknown code
    errors('NOT_DECLARED');
    return errors('QUOTA_EXCEEDED', { data: { remainingBytes: 0 } });
  },
  key: ({ input }) => `v/${input.albumId}`,
  onComplete: () => ({ mediaId: 'm' }),
});

const videos = t.travelVideos.handler({
  authorize: () => ({ ownerId: 'u' }),
  key: () => 'k',
  onComplete: ({ session }) => ({ mediaId: session.meta.ownerId }),
});
const download = t.media.download.handler({ resolve: () => ({ key: 'k' }) });

t.router({ avatar, travelVideos: videos, media: { download } });

// @ts-expect-error every contract endpoint must be implemented
t.router({ avatar, media: { download } });
