import type { RouterPaths } from '@bu-draft/core';
import { client } from '../examples/basic/client.js';
import type { Contract } from '../examples/basic/contract.js';
import { file, type Equal, type Expect } from './utils.js';

// Endpoint paths are derived from the contract keys (nested routers → "a/b").
type _paths = Expect<Equal<RouterPaths<Contract>, 'avatar' | 'travelVideos' | 'media/download'>>;

// No input schema → `input` is optional.
client.avatar.upload(file, {});

// Input schema → `input` is required and typed.
// @ts-expect-error missing input
client.travelVideos.upload(file, {});
// @ts-expect-error wrong input type
client.travelVideos.upload(file, { input: { albumId: 42 } });
const task = client.travelVideos.upload(file, { input: { albumId: '0b7a…' } });

// Output is inferred from the contract output schema.
type _out = Expect<Equal<Awaited<typeof task.result>, { mediaId: string }>>;

// Errors: built-in codes + contract codes, with typed data.
const err = task.getSnapshot().error;
if (err?.code === 'QUOTA_EXCEEDED') {
  type _data = Expect<Equal<typeof err.data, { remainingBytes: number }>>;
}
if (err?.code === 'FILE_MISMATCH') {
  err.userAction satisfies 'wait' | 'retry' | 'reselect-file' | 'restart' | 'sign-in' | 'change-file' | 'contact-support';
}
// @ts-expect-error not a declared or built-in code
if (err?.code === 'NOPE') {}

// Downloads.
void client.media.download.url({ input: { mediaId: 'm1' } });
// @ts-expect-error download endpoints have no `upload`
client.media.download.upload;
// @ts-expect-error upload endpoints have no `url`
client.avatar.url;

// Native download link: synchronous, typed input.
const href: string = client.media.download.link({ input: { mediaId: 'm1' } });
void href;
// @ts-expect-error input required
client.media.download.link({});
