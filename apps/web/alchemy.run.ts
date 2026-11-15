/**
 * Infrastructure of the docs + registry site: one Cloudflare Worker serving the TanStack Start app
 * (prerendered docs pages, static `/r/*.json` registry files, server routes for search and llms.txt).
 *
 *   pnpm --filter @open-upload/web deploy -- --stage prod
 *   pnpm --filter @open-upload/web destroy -- --stage pr-42
 *
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. State is kept in Cloudflare (Secrets Store), so CI and
 * laptops share it.
 */
import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Alchemy from 'alchemy';
import * as Effect from 'effect/Effect';

export const Website = Cloudflare.Website.Vite('Website', {});

export default Alchemy.Stack(
  'UploadSdkSite',
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const website = yield* Website;
    return { url: website.url.as<string>() };
  }),
);
