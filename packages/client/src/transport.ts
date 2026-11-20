import type { Transport, TransportResponse } from './types.js';

/**
 * XHR transport: the only browser API with upload progress events (fetch has none, and Safari has no
 * streaming request bodies). Aborts when no byte moved for `stallTimeoutMs`.
 */
export function xhrTransport(): Transport {
  return {
    send({ request, body, signal, onProgress, stallTimeoutMs }) {
      return new Promise<TransportResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let stall: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(stall);
          stall = setTimeout(() => {
            xhr.abort();
            reject(Object.assign(new Error('Upload stalled'), { name: 'TimeoutError' }));
          }, stallTimeoutMs);
        };
        const cleanup = () => {
          clearTimeout(stall);
          signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          xhr.abort();
          cleanup();
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        xhr.open(request.method, request.url);
        for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (event) => {
          arm();
          onProgress?.(event.loaded);
        };
        xhr.onload = () => {
          cleanup();
          const headers: Record<string, string> = {};
          for (const line of xhr
            .getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/)) {
            const i = line.indexOf(':');
            if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          }
          resolve({ status: xhr.status, headers, body: typeof xhr.responseText === 'string' ? xhr.responseText : '' });
        };
        xhr.onerror = () => {
          cleanup();
          reject(Object.assign(new Error('Network error'), { name: 'NetworkError' }));
        };
        xhr.ontimeout = xhr.onerror;
        arm();
        xhr.send(body);
      });
    },
  };
}

/** fetch transport (Node, React Native, tests). No upload progress: reports completion only. */
export function fetchTransport(fetchImpl?: typeof fetch): Transport {
  return {
    async send({ request, body, signal, onProgress, stallTimeoutMs }) {
      const timeout = AbortSignal.timeout(Math.ceil(Math.max(stallTimeoutMs, (body.size / 50_000) * 1000)));
      const combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await (fetchImpl ?? fetch)(request.url, {
          method: request.method,
          headers: request.headers,
          body,
          signal: combined,
        });
      } catch (error) {
        if (timeout.aborted && !signal.aborted)
          throw Object.assign(new Error('Upload stalled'), { name: 'TimeoutError' });
        throw error;
      }
      const text = await response.text();
      if (response.ok) onProgress?.(body.size);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: response.status, headers, body: text };
    },
  };
}

export function defaultTransport(): Transport {
  return typeof XMLHttpRequest !== 'undefined' ? xhrTransport() : fetchTransport();
}
