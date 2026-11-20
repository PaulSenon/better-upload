/** Tracks connectivity. In browsers it listens to `online`/`offline`; elsewhere it always reports online. */
export interface NetworkMonitor {
  isOffline(): boolean;
  waitOnline(signal: AbortSignal): Promise<void>;
  dispose(): void;
}

export function createNetworkMonitor(): NetworkMonitor {
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
  const waiters = new Set<() => void>();
  const onOnline = () => {
    for (const w of [...waiters]) w();
  };
  if (hasWindow) window.addEventListener('online', onOnline);
  return {
    isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
    waitOnline(signal) {
      return new Promise<void>((resolve, reject) => {
        if (!(typeof navigator !== 'undefined' && navigator.onLine === false)) return resolve();
        const done = () => {
          waiters.delete(done);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          waiters.delete(done);
          reject(signal.reason);
        };
        waiters.add(done);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    dispose() {
      if (hasWindow) window.removeEventListener('online', onOnline);
      waiters.clear();
    },
  };
}
