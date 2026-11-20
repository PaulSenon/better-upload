'use client';

import { useEffect, useState } from 'react';

/** Install command for a registry item, using this site's real origin (works on previews and production alike). */
export function RegistryInstall({ item }: { item: string }) {
  const [origin, setOrigin] = useState(import.meta.env.VITE_SITE_URL ?? 'https://<this-site>');
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <pre className="not-prose my-6 overflow-x-auto rounded-lg border bg-muted px-4 py-3 text-sm">
      <code>
        npx shadcn@latest add {origin}/r/{item}.json
      </code>
    </pre>
  );
}
