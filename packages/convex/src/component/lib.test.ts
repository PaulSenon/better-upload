// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api.js';
import schema from './schema.js';

const modules = import.meta.glob('./**/*.ts');
const file = { name: 'a.mp4', size: 10, type: 'video/mp4', lastModified: 1 };

describe('open-upload component', () => {
  it('records the lifecycle and lists pending uploads per owner', async () => {
    const t = convexTest(schema, modules);
    const base = { endpoint: 'files', ticket: 't1', key: 'k1', file, expiresAt: Date.now() + 60_000 };
    await t.mutation(api.lib.recordStarted, { ...base, sessionId: 's1', owner: 'u1' });
    await t.mutation(api.lib.recordStarted, { ...base, sessionId: 's1', owner: 'u1' }); // idempotent
    await t.mutation(api.lib.recordStarted, { ...base, sessionId: 's2', owner: 'u2' });
    expect((await t.query(api.lib.listPending, { owner: 'u1' })).map((r) => r.sessionId)).toEqual(['s1']);
    await t.mutation(api.lib.recordCompleted, { sessionId: 's1', object: { size: 10, etag: '"e"' } });
    expect(await t.query(api.lib.listPending, { owner: 'u1' })).toEqual([]);
    expect(await t.query(api.lib.get, { sessionId: 's1' })).toMatchObject({
      status: 'completed',
      object: { size: 10 },
    });
    await t.mutation(api.lib.recordAborted, { sessionId: 's2' });
    expect(await t.query(api.lib.get, { sessionId: 's2' })).toMatchObject({ status: 'aborted' });
  });

  it('expires stale uploads and hands their tickets back for cleanup', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.recordStarted, {
      sessionId: 'old',
      endpoint: 'files',
      ticket: 'tk',
      key: 'k',
      file,
      expiresAt: Date.now() - 1,
    });
    await t.mutation(api.lib.recordStarted, {
      sessionId: 'new',
      endpoint: 'files',
      ticket: 'tk2',
      key: 'k2',
      file,
      expiresAt: Date.now() + 60_000,
    });
    expect(await t.mutation(api.lib.expireStale, {})).toEqual([{ sessionId: 'old', ticket: 'tk' }]);
    expect(await t.query(api.lib.get, { sessionId: 'old' })).toMatchObject({ status: 'expired' });
    expect(await t.mutation(api.lib.expireStale, {})).toEqual([]);
  });
});
