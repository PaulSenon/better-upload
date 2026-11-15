import { isUploadErrorShape, PROTOCOL_HEADER, PROTOCOL_VERSION, UploadError } from '@bu-draft/core';

/** Calls the upload server (small JSON control requests). */
export interface ControlTransport {
  call<T>(path: string, op: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

export function createControlTransport(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  credentials?: RequestCredentials;
}): ControlTransport {
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async call<T>(path: string, op: string, body: unknown, signal?: AbortSignal): Promise<T> {
      const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
      let response: Response;
      try {
        response = await fetchImpl(`${base}/${path}/${op}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
            ...(await options.headers?.()),
          },
          body: JSON.stringify(body),
          ...(options.credentials ? { credentials: options.credentials } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw UploadError.builtin('CANCELED', { cause: error });
        throw UploadError.builtin(isOffline() ? 'OFFLINE' : 'NETWORK_ERROR', { cause: error });
      }
      let payload: any;
      try {
        payload = await response.json();
      } catch (error) {
        throw UploadError.builtin(response.status >= 500 ? 'STORAGE_ERROR' : 'INTERNAL_ERROR', {
          message: `Unexpected response from the upload server (HTTP ${response.status})`,
          retryable: response.status >= 500 || response.status === 429,
          cause: error,
        });
      }
      if (!response.ok) {
        if (isUploadErrorShape(payload?.error)) throw new UploadError(payload.error);
        throw UploadError.builtin('INTERNAL_ERROR', {
          message: `HTTP ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return payload as T;
    },
  };
}

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
