import { createUploadClient } from '@bu-draft/client';
import { usePendingUploads, useStore, useUpload, useUploadTask } from '@bu-draft/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { contract } from '../contract.ts';

const params = new URLSearchParams(location.search);
const client = createUploadClient<typeof contract>({
  baseUrl: params.get('base') ?? '/api/upload',
  contract,
  retry: { baseDelayMs: 200, maxDelayMs: 2000, maxAttempts: Number(params.get('attempts') ?? 20) },
  stallTimeoutMs: Number(params.get('stall') ?? 10_000),
  ...(params.get('concurrency')
    ? {
        concurrency: {
          initial: Number(params.get('concurrency')),
          max: Number(params.get('concurrency')),
          mode: 'fixed' as const,
        },
      }
    : {}),
});
(window as any).__client = client;

function TaskRow({ task }: { task: ReturnType<typeof client.videos.upload> }) {
  const s = useUploadTask(task)!;
  return (
    <li
      data-testid="task"
      data-status={s.status}
      data-resumed={String(s.resumed)}
      data-error={s.error?.code ?? ''}
      data-key={s.output?.key ?? ''}
      data-ticket={s.ticket ?? ''}
      data-parts={`${s.progress.partsConfirmed}/${s.progress.partsTotal}`}
    >
      {s.file.name} — {s.status} — {Math.round(s.progress.fraction * 100)}% — {s.progress.partsConfirmed}/
      {s.progress.partsTotal} parts
      {s.error ? ` — ${s.error.code}: ${s.error.message}` : ''}
      <button type="button" onClick={() => task.pause()}>
        pause
      </button>
      <button type="button" onClick={() => task.resume()}>
        resume
      </button>
      <button type="button" onClick={() => task.retry()}>
        retry
      </button>
      <button type="button" onClick={() => task.restart()}>
        restart
      </button>
      <button type="button" onClick={() => void task.cancel()}>
        cancel
      </button>
      {s.output ? (
        <a data-testid="download" href={client.files.get.link({ input: { key: s.output.key } })} download>
          download
        </a>
      ) : null}
    </li>
  );
}

function PendingRow({ task }: { task: any }) {
  const s = useUploadTask(task)!;
  return (
    <li data-testid="pending" data-status={s.status}>
      Resume “{s.file.name}”: select it again
      <input
        type="file"
        data-testid="reselect"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) task.attachFile(f).catch(() => {});
        }}
      />
      {/* The snapshot keeps the error: this row unmounts while the file is being checked. */}
      <span data-testid="reselect-error">{s.error?.code ?? ''}</span>
    </li>
  );
}

function App() {
  const videos = useUpload(client.videos);
  const pending = usePendingUploads(client);
  // Every task of the client: new ones and restored ones (they stay listed once their file is re-selected).
  const all = useStore(client.$tasks);
  const control = videos.control({ input: { albumId: 'e2e' } });
  return (
    <main>
      <h1>Upload SDK e2e</h1>
      <input
        type="file"
        data-testid="file"
        multiple={control.multiple}
        accept={control.accept}
        onChange={(e) => e.target.files && control.onFiles(e.target.files)}
      />
      <p data-testid="aggregate">{Math.round(videos.progress * 100)}%</p>
      <ul>
        {all.map((t) => (
          <TaskRow key={t.id} task={t as any} />
        ))}
      </ul>
      <h2>Unfinished uploads</h2>
      <ul>
        {pending.map((t) => (
          <PendingRow key={t.id} task={t} />
        ))}
      </ul>
      <p data-testid="pending-count">{pending.length}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
