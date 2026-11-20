import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { defineDocs } from 'fumadocs-mdx/macro';
import { docsRoute } from './shared';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});

const text = (body: string) => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** Serves `llms.txt`, `llms-full.txt` and per-page Markdown (`/docs/<page>.md`, `.txt`) for AI agents. */
export async function serveLlms(pathname: string): Promise<Response> {
  if (pathname === '/llms.txt') return text(await docsLlms.index());
  if (pathname === '/llms-full.txt') return text(await docsLlms.full());
  const match = /^\/docs(?:\/(.*))?\.(?:md|txt)$/.exec(pathname) ?? /^\/(.*)\.md$/.exec(pathname);
  if (match) {
    const slugs = (match[1] ?? '').split('/').filter((s) => s && s !== 'docs');
    const page = source.getPage(slugs);
    if (page) return text(await docsLlms.page(page));
  }
  return new Response(null, { status: 404 });
}
