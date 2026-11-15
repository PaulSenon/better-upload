import { checkStorageConformance } from '@open-upload/server/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { runId, targets } from './env.js';

for (const target of targets) {
  describe(`storage conformance: ${target.name}`, () => {
    beforeAll(async () => target.setup?.());
    it('passes every check the upload flow relies on', async () => {
      const results = await checkStorageConformance(target.create(''), { prefix: `${runId}conformance/` });
      console.table(results);
      for (const r of results) expect(r.ok, `${r.name}: ${r.error}`).toBe(true);
    });
  });
}
