#!/usr/bin/env node
/**
 * Publishes every public workspace package whose current version is not on npm yet.
 *
 * `pnpm pack` rewrites `workspace:` dependencies to real versions; `npm publish <tarball>` then publishes with npm's
 * native trusted publishing (OIDC, no token) and provenance when run in GitHub Actions. Prints `New tag: name@version`
 * lines, which changesets/action turns into git tags and GitHub releases.
 *
 *   node scripts/publish.mjs            # publish what is missing
 *   node scripts/publish.mjs --dry-run  # show what would be published
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = new URL('..', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'open-upload-publish-'));

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => ({ dir: join(root, 'packages', dir), pkg: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private);

const published = (name, version) => {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
};

let failures = 0;
for (const { dir, pkg } of packages) {
  const id = `${pkg.name}@${pkg.version}`;
  if (published(pkg.name, pkg.version)) {
    console.log(`skip ${id} (already on npm)`);
    continue;
  }
  if (dryRun) {
    console.log(`would publish ${id}`);
    continue;
  }
  const before = new Set(readdirSync(out));
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'inherit' });
  const tarball = readdirSync(out).find((f) => !before.has(f));
  const tag = pkg.version.includes('-') ? pkg.version.split('-')[1].split('.')[0] : 'latest';
  try {
    execFileSync('npm', ['publish', join(out, tarball), '--access', 'public', '--tag', tag, ...(process.env.CI ? ['--provenance'] : [])], {
      stdio: 'inherit',
    });
    console.log(`New tag: ${id}`);
  } catch {
    failures++;
    console.error(`failed: ${id}`);
  }
}
process.exit(failures ? 1 : 0);
