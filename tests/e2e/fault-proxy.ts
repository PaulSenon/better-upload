import http from 'node:http';

/**
 * HTTP proxy between the browser and MinIO that injects faults on part uploads (PUT with partNumber, or single PUTs).
 * Presigned signatures cover the Host header; the proxy forwards it unchanged, so signatures stay valid.
 */
export interface FaultConfig {
  /** Probability (0..1) that a matching PUT is faulted. */
  rate: number;
  /** `reset`: destroy the socket after receiving part of the body. `503`: SlowDown. `delay`: wait then forward. */
  mode: 'none' | 'reset' | '503' | 'delay';
  delayMs?: number;
  /** Fault only the first N matching requests (then behave). */
  limit?: number;
  /** Fault only these part numbers. */
  parts?: number[];
  /** Block every matching PUT (hang until the client gives up / aborts). */
  block?: boolean;
}

export interface ProxyLog {
  method: string;
  partNumber: number | null;
  uploadId: string | null;
  status: number;
  faulted: string | null;
}

export function startFaultProxy(options: { port: number; target: { host: string; port: number } }) {
  let config: FaultConfig = { rate: 0, mode: 'none' };
  let faultedCount = 0;
  const log: ProxyLog[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const partNumber = url.searchParams.has('partNumber') ? Number(url.searchParams.get('partNumber')) : null;
    const isUpload = req.method === 'PUT' && (partNumber !== null || url.searchParams.has('X-Amz-Signature'));
    const entry: ProxyLog = {
      method: req.method ?? '',
      partNumber,
      uploadId: url.searchParams.get('uploadId'),
      status: 0,
      faulted: null,
    };
    if (req.method === 'PUT') log.push(entry);
    const eligible =
      isUpload &&
      config.mode !== 'none' &&
      (config.limit === undefined || faultedCount < config.limit) &&
      (!config.parts || (partNumber !== null && config.parts.includes(partNumber))) &&
      Math.random() < config.rate;

    if (isUpload && config.block) {
      entry.faulted = 'block';
      req.on('close', () => res.destroy());
      return;
    }
    if (eligible && config.mode === 'reset') {
      faultedCount++;
      entry.faulted = 'reset';
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > 256 * 1024) req.socket.destroy();
      });
      req.on('end', () => req.socket.destroy());
      return;
    }
    if (eligible && config.mode === '503') {
      faultedCount++;
      entry.faulted = '503';
      req.resume();
      req.on('end', () => {
        entry.status = 503;
        res.writeHead(503, { 'content-type': 'application/xml', 'access-control-allow-origin': '*' });
        res.end('<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>');
      });
      return;
    }
    const forward = () => {
      const upstream = http.request(
        {
          host: options.target.host,
          port: options.target.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (up) => {
          entry.status = up.statusCode ?? 0;
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    };
    if (eligible && config.mode === 'delay') {
      faultedCount++;
      entry.faulted = 'delay';
      req.pause();
      setTimeout(() => {
        req.resume();
        forward();
      }, config.delayMs ?? 1000);
      return;
    }
    forward();
  });
  server.listen(options.port);
  return {
    set(next: FaultConfig) {
      config = next;
      faultedCount = 0;
    },
    log,
    reset() {
      config = { rate: 0, mode: 'none' };
      faultedCount = 0;
      log.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
