// Browser: imports only the contract (type, plus optionally the value for pre-validation).
import { createUploadClient, indexedDBStore } from '@bu-draft/client';
import { contract, type Contract } from './contract.js';

export const client = createUploadClient<Contract>({
  baseUrl: '/api/upload',
  contract, // optional: enables client.avatar.validate(file) and .rules
  persistence: indexedDBStore(),
});

export async function uploadTrip(files: File[], albumId: string) {
  const tasks = client.travelVideos.uploadMany(files, { input: { albumId } });
  for (const task of tasks) {
    task.subscribe(() => {
      const s = task.getSnapshot();
      console.log(s.file.name, s.status, s.progress.confirmedBytes, '/', s.progress.totalBytes);
      if (s.error?.code === 'QUOTA_EXCEEDED') console.log('remaining', s.error.data.remainingBytes);
    });
  }
  return Promise.all(tasks.map((t) => t.result)); // { mediaId: string }[]
}

// After a reload, days later: list unfinished uploads, ask the user to re-pick each file.
export async function resumeAfterReload(pickFile: (name: string) => Promise<File>) {
  const pending = await client.travelVideos.pending();
  for (const task of pending) {
    const file = await pickFile(task.getSnapshot().file.name);
    await task.attachFile(file); // rejects with FILE_MISMATCH if the bytes differ
  }
}
