/**
 * Builds the site for Cloudflare Workers WITHOUT any credential: the same Vite build `Cloudflare.Website.Vite` runs
 * inside `alchemy deploy` (Alchemy's Cloudflare Vite plugin, in-process), but on its own, so CI can build untrusted PR
 * code in an unprivileged job and the deploy job only uploads the output (`infra/site`, `bundle: false`).
 *
 *   node scripts/build-worker.ts      → dist/deploy/assets (static assets) + dist/deploy/server (Worker modules, entry server.js)
 *
 * dist/deploy holds only what is uploaded (server/: .js modules only, no source maps): it is the CI artifact.
 *
 * Keep COMPATIBILITY_DATE in sync with infra/site/src/stage.ts.
 */
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cloudflare from '@alchemy.run/cloudflare-runtime/vite';
import { createBuilder, type Plugin } from 'vite';

export const COMPATIBILITY_DATE = '2026-11-01';

// The stage URL from CI ends with "/": the install commands append "/r/<item>.json".
if (process.env.VITE_SITE_URL) process.env.VITE_SITE_URL = process.env.VITE_SITE_URL.replace(/\/+$/, '');

// Tells Alchemy's plugin it is the injected one (and disables a second Cloudflare plugin from the config).
process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED = '1';
const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Alchemy's Cloudflare plugin resolves the Worker environment with `workerd, worker, module, browser` (Cloudflare's
 * defaults), and Vite concatenates condition arrays, so a config override cannot drop one. `browser` makes packages
 * with a server/browser split ship their BROWSER build in the Worker: fumadocs-core's `./server` resolves to a stub
 * that throws "renderToMarkdown is only available on the server", so /api/search fails at request time (500).
 * This removes `browser` from the server environment only; the client build is untouched.
 */
function serverConditions(): Plugin {
  return {
    name: 'open-upload:worker-without-browser-condition',
    enforce: 'post',
    configEnvironment(name, config) {
      if (name === 'client' || !config.resolve?.conditions) return;
      config.resolve.conditions = config.resolve.conditions.filter((c) => c !== 'browser');
    },
  };
}

// Start from an empty dist/: a previous build's chunks must never end up in the Worker.
rmSync(join(root, 'dist'), { recursive: true, force: true });
const builder = await createBuilder(
  {
    root,
    // nodejs_compat is on by default from 2026-08-04; the build tooling still needs it spelled out for unenv.
    plugins: [
      cloudflare({ compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ['nodejs_compat'] }),
      serverConditions(),
    ],
  },
  null,
);
await builder.buildApp();

const dist = join(root, 'dist');
const deploy = join(dist, 'deploy');
cpSync(join(dist, 'client'), join(deploy, 'assets'), { recursive: true });
cpSync(join(dist, 'server'), join(deploy, 'server'), {
  recursive: true,
  filter: (src) => !src.includes('/.vite') && (!/\.[a-z0-9]+$/.test(src) || /\.m?js$/.test(src)),
});
console.log(`site built for Workers: ${deploy}`);
