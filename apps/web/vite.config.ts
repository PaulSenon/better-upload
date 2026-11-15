import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';

const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// Deployed to Cloudflare Workers by Alchemy (`alchemy.run.ts`), which adds the Workers runtime integration.
export default defineConfig({
  server: { port: 3000 },
  plugins: [fumadocsMdx(), tailwindcss(), tanstackStart({ prerender: { enabled: true, crawlLinks: true } }), react()],
  resolve: {
    tsconfigPaths: true,
    // Workspace packages are consumed from source (no prior build): the site always shows the code of this commit.
    alias: [
      { find: 'tslib', replacement: 'tslib/tslib.es6.js' },
      { find: /^@bu-draft\/server\/testing$/, replacement: pkg('server/src/testing.ts') },
      { find: /^@bu-draft\/(core|client|react|server)$/, replacement: pkg('$1/src/index.ts') },
    ],
  },
});
