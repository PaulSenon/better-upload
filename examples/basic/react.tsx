import { useUpload, usePendingUploads } from '@bu-draft/react';
import { client } from './client.js';

export function TripUploader({ albumId }: { albumId: string }) {
  const { upload, snapshots, progress, pauseAll, resumeAll } = useUpload(client.travelVideos, {
    onComplete: (output) => console.log('stored', output?.mediaId),
  });
  const pending = usePendingUploads(client);

  return (
    <div>
      {pending.length > 0 && <p>{pending.length} upload(s) can be resumed — re-select the files.</p>}
      <input type="file" multiple accept="video/*" onChange={(e) => e.target.files && upload(e.target.files, { input: { albumId } })} />
      <progress value={progress} max={1} />
      <button onClick={pauseAll}>Pause</button>
      <button onClick={resumeAll}>Resume</button>
      <ul>
        {snapshots.map((s) => (
          <li key={s.id}>
            {s.file.name} — {s.status}
            {s.error && ` (${s.error.code}: ${s.error.userAction})`}
          </li>
        ))}
      </ul>
    </div>
  );
}
