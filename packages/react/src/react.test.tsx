import { createUploadClient, fetchTransport, memoryStore } from '@bu-draft/client';
import { uc } from '@bu-draft/core';
import { createUploadServer, implement } from '@bu-draft/server';
import { memoryStorage } from '@bu-draft/server/testing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { usePendingUploads, useUpload, useUploadTask } from './index.js';

const contract = uc.router({
  photos: uc
    .upload()
    .files({ accept: ['image/*'], maxFiles: 4 })
    .output(z.object({ url: z.string() })),
});

function setup() {
  const storage = memoryStorage();
  const t = implement(contract);
  const server = createUploadServer({
    storage,
    secret: 'r'.repeat(32),
    router: t.router({
      photos: t.photos.handler({
        onUploadRequested: ({ sessionId }) => ({ key: sessionId }),
        onUploadCompleted: ({ object }) => ({ url: `/${object.key}` }),
      }),
    }),
  });
  return createUploadClient<typeof contract>({
    baseUrl: 'http://app.test/api/upload',
    contract,
    fetch: (i, init) => server.fetch(new Request(i, init), {}),
    transport: fetchTransport(storage.fetch),
    persistence: memoryStore(),
  });
}

const png = (size: number, name = 'a.png') =>
  new File([new Uint8Array(size)], name, { type: 'image/png', lastModified: 1 });

describe('react bindings', () => {
  it('useUpload tracks tasks, aggregate progress and typed callbacks', async () => {
    const client = setup();
    const onCompleted = vi.fn();
    const { result } = renderHook(() => useUpload(client.photos, { onCompleted }));
    const control = result.current.control();
    expect(control).toMatchObject({ accept: 'image/*', multiple: true });
    act(() => {
      control.onFiles([png(1000), png(2000, 'b.png')]);
    });
    expect(result.current.tasks).toHaveLength(2);
    await waitFor(() => expect(result.current.progress).toBe(1));
    expect(result.current.isUploading).toBe(false);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(2));
    expect(onCompleted.mock.calls[0]![0]).toMatchObject({ url: expect.stringMatching(/^\//) });
    act(() => result.current.clearFinished());
    expect(result.current.tasks).toHaveLength(0);
  });

  it('reports client-side validation errors through onFailed', () => {
    const client = setup();
    const onFailed = vi.fn();
    const { result } = renderHook(() => useUpload(client.photos, { onFailed }));
    act(() => {
      result.current.upload(new File(['x'], 'a.txt', { type: 'text/plain' }));
    });
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }), undefined);
  });

  it('useUploadTask follows one task; usePendingUploads lists restorable ones', async () => {
    const client = setup();
    const task = client.photos.upload(png(10));
    const { result } = renderHook(() => useUploadTask(task));
    await waitFor(() => expect(result.current?.status).toBe('completed'));
    const pending = renderHook(() => usePendingUploads(client));
    expect(pending.result.current).toEqual([]);
  });
});
