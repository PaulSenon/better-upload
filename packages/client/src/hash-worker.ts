/**
 * Entry for apps whose Content-Security-Policy forbids `blob:` workers: serve this module as a worker file and pass
 * `workerHasher({ createWorker: () => new Worker(new URL('@open-upload/client/hash-worker', import.meta.url), { type: 'module' }) })`.
 */
import { workerMain } from './worker-hasher.js';

workerMain();
