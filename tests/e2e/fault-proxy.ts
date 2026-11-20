import http from 'node:http';
import { Transform } from 'node:stream';

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
  /** Methods to fault. Default `['PUT']` (part uploads). Add `'GET'` for ranged downloads. */
  methods?: string[];
}

export interface ProxyLog {
  method: string;
  partNumber: number | null;
  uploadId: string | null;
  status: number;
  faulted: string | null;
}

export interface ProxyStats {
  /** Request body bytes received from the browser on PUTs (including parts that were later cut or retried). */
  putBytesIn: number;
  putOk: number;
  putFailed: number;
  /** Response bytes sent back on GETs. */
  getBytesOut: number;
}

export function startFaultProxy(options: {
  port: number;
  target: { host: string; port: number };
  /** Global cap on PUT body throughput (bytes/s), shared by all connections. Default: none. */
  maxBytesPerSecond?: number;
  /** Keep a per-request log (disable for very long runs). Default true. */
  log?: boolean;
}) {
  let config: FaultConfig = { rate: 0, mode: 'none' };
  let faultedCount = 0;
  const log: ProxyLog[] = [];
  const stats: ProxyStats = { putBytesIn: 0, putOk: 0, putFailed: 0, getBytesOut: 0 };
  const keepLog = options.log ?? true;
  // Token bucket shared by every connection: `next` is when the budget allows the next byte.
  let next = 0;
  const throttle = () =>
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        const bps = options.maxBytesPerSecond;
        if (!bps) return done(null, chunk);
        const now = Date.now();
        next = Math.max(next, now) + (chunk.length / bps) * 1000;
        const wait = next - now - 50; // 50 ms burst
        if (wait > 0) setTimeout(() => done(null, chunk), wait);
        else done(null, chunk);
      },
    });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const partNumber = url.searchParams.has('partNumber') ? Number(url.searchParams.get('partNumber')) : null;
    const methods = config.methods ?? ['PUT'];
    const isUpload =
      methods.includes(req.method ?? '') && (partNumber !== null || url.searchParams.has('X-Amz-Signature'));
    const entry: ProxyLog = {
      method: req.method ?? '',
      partNumber,
      uploadId: url.searchParams.get('uploadId'),
      status: 0,
      faulted: null,
    };
    if (keepLog && (req.method === 'PUT' || req.method === 'GET')) log.push(entry);
    if (req.method === 'PUT') req.on('data', (c: Buffer) => (stats.putBytesIn += c.length));
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
    if (eligible && config.mode === 'reset' && req.method === 'GET') {
      faultedCount++;
      entry.faulted = 'reset';
      const upstream = http.request(
        {
          host: options.target.host,
          port: options.target.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          let sent = 0;
          up.on('data', (chunk: Buffer) => {
            sent += chunk.length;
            if (sent > 512 * 1024) {
              res.destroy();
              up.destroy();
            } else res.write(chunk);
          });
          up.on('end', () => res.end());
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
      return;
    }
    if (eligible && config.mode === 'reset') {
      faultedCount++;
      entry.faulted = 'reset';
      stats.putFailed++;
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
      let counted = false;
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
          if (req.method === 'PUT' && !counted) {
            counted = true;
            if (entry.status >= 200 && entry.status < 300) stats.putOk++;
            else stats.putFailed++;
          }
          if (req.method === 'GET') up.on('data', (c: Buffer) => (stats.getBytesOut += c.length));
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      res.on('close', () => {
        if (res.writableFinished) return;
        if (req.method === 'PUT' && !counted) {
          counted = true;
          stats.putFailed++;
        }
        upstream.destroy();
      });
      if (req.method === 'PUT' && options.maxBytesPerSecond) req.pipe(throttle()).pipe(upstream);
      else req.pipe(upstream);
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
    stats,
    reset() {
      config = { rate: 0, mode: 'none' };
      faultedCount = 0;
      log.length = 0;
      Object.assign(stats, { putBytesIn: 0, putOk: 0, putFailed: 0, getBytesOut: 0 });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
