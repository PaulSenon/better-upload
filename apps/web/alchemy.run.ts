/**
 * LOCAL DEVELOPMENT ONLY: `alchemy dev` runs the site in workerd through Alchemy's Vite integration, with local state.
 *
 * Deploys never use this file. CI builds the site without credentials (`pnpm build:worker`) and `infra/site` uploads
 * that prebuilt output (docs/SITE-DEPLOY.md). Remote state is refused here so a laptop cannot create or overwrite
 * cloud resources outside that pipeline.
 */
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import { localState } from 'alchemy/State';
import * as Effect from 'effect/Effect';

export const Website = Cloudflare.Website.Vite('Website', {});

export default Alchemy.Stack(
  'open-upload-web-dev',
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (!/^(dev|live)_/.test(stage) && stage !== 'local') {
      return yield* Effect.die(new Error(`apps/web/alchemy.run.ts is for local dev stages only (got "${stage}")`));
    }
    const website = yield* Website;
    return { url: website.url.as<string>() };
  }),
);
