import type { UploadSnapshot } from '@bu-draft/client';

/** `1.5 MB`, decimal units like OS file managers. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Short, human label for a task status. Replace with your own copy / i18n. */
export function statusLabel(snapshot: UploadSnapshot<unknown, any>): string {
  switch (snapshot.status) {
    case 'needs-file':
      return 'Select the file again to continue';
    case 'preparing':
      return snapshot.resumed ? 'Checking the file…' : 'Preparing…';
    case 'initializing':
      return 'Starting…';
    case 'uploading': {
      const { bytesPerSecond, etaMs } = snapshot.progress;
      if (!bytesPerSecond) return 'Uploading…';
      return `${formatBytes(bytesPerSecond)}/s${etaMs ? ` · ${formatDuration(etaMs)} left` : ''}`;
    }
    case 'paused':
      return 'Paused';
    case 'waiting-network':
      return 'Waiting for the network…';
    case 'retrying':
      return 'Connection problem, retrying…';
    case 'completing':
      return 'Finishing…';
    case 'completed':
      return 'Uploaded';
    case 'expired':
      return 'This upload expired. It must start again from the beginning.';
    case 'canceled':
      return 'Canceled';
    case 'failed':
      return snapshot.error?.message ?? 'Upload failed';
  }
}
