import {
  acceptAttribute,
  type BuiltinError,
  type ContractRouter,
  checkFiles,
  encodeLinkInput,
  type FileRules,
  flattenRouter,
  type InitSession,
  isUploadContract,
  type ResolveResponse,
  type UploadContract,
} from '@bu-draft/core';
import { createControlTransport } from './control.js';
import { chunkedHasher } from './hasher.js';
import { createNetworkMonitor } from './network.js';
import { defaultStore } from './persistence.js';
import { describeFile, type EngineDeps, type TaskSource, UploadTaskImpl } from './task.js';
import { defaultTransport } from './transport.js';
import type {
  PersistedUpload,
  ReadableStore,
  UploadableFile,
  UploadClient,
  UploadClientOptions,
  UploadTask,
} from './types.js';

const RESERVED = new Set(['$tasks', '$restore', '$pauseAll', '$resumeAll', '$dispose', 'then', 'toJSON']);

/**
 * Creates the typed client. Pass the contract *type* (`createUploadClient<typeof contract>()`) for types only,
 * or the contract value too for client-side file validation.
 */
export function createUploadClient<T extends ContractRouter>(options: UploadClientOptions<T>): UploadClient<T> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const endpoints = options.contract ? flattenRouter(options.contract) : undefined;
  const network = createNetworkMonitor();
  const control = createControlTransport({
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  const tasks = new Set<UploadTaskImpl<any>>();
  let tasksSnapshot: readonly UploadTask<unknown, BuiltinError>[] = [];
  const taskListeners = new Set<() => void>();
  const notifyTasks = () => {
    tasksSnapshot = [...tasks];
    for (const l of [...taskListeners]) l();
  };
  const store = options.persistence === false ? undefined : (options.persistence ?? defaultStore());
  const deps: EngineDeps = {
    baseUrl,
    control,
    transport: options.transport ?? defaultTransport(),
    hasher: options.hasher ?? chunkedHasher(),
    store,
    network,
    retry: { maxAttempts: 10, baseDelayMs: 500, maxDelayMs: 30_000, ...options.retry },
    concurrency: { initial: 3, min: 1, max: 6, mode: 'adaptive', ...options.concurrency },
    stallTimeoutMs: options.stallTimeoutMs ?? 30_000,
    onTasksChanged: notifyTasks,
  };
  const track = <X extends UploadTaskImpl<any>>(task: X): X => {
    tasks.add(task);
    notifyTasks();
    return task;
  };

  const rulesOf = (path: string): FileRules | undefined => {
    const c = endpoints?.get(path);
    return c && isUploadContract(c) ? (c as UploadContract)['~def'].files : undefined;
  };

  const records = async (path: string): Promise<PersistedUpload[]> => {
    if (!store) return [];
    const all = await store.list().catch(() => []);
    const now = Date.now();
    const live: PersistedUpload[] = [];
    for (const r of all) {
      if (r.baseUrl !== baseUrl || r.endpoint !== path) continue;
      if (r.expiresAt < now) {
        void store.delete(r.id).catch(() => {});
        continue;
      }
      live.push(r);
    }
    return live;
  };

  /** Persisted records already attached to a live task (restored, or matched by `upload()`). */
  const claimed = new Set<string>();

  function uploadEndpoint(path: string) {
    const rules = rulesOf(path);
    const validate = (files: readonly UploadableFile[]) =>
      rules ? checkFiles(files.map(describeFile), rules) : undefined;

    const startBatch = (
      files: UploadableFile[],
      opts: { input?: unknown; signal?: AbortSignal; paused?: boolean } = {},
    ) => {
      const error = validate(files);
      if (error) throw error;
      // One `init` request for the whole batch (one authorization), one task per file.
      let batch: Promise<InitSession[]> | undefined;
      const initAll = () => {
        batch ??= control
          .call<{ sessions: InitSession[] }>(
            path,
            'init',
            { input: opts.input, files: files.map(describeFile) },
            opts.signal,
          )
          .then((r) => r.sessions);
        return batch;
      };
      const initOne = (file: UploadableFile) => async () => {
        const index = files.indexOf(file);
        try {
          return (await initAll())[index]!;
        } catch (error) {
          batch = undefined; // allow the retry loop to re-init
          throw error;
        }
      };
      return files.map((file) => {
        const task = new UploadTaskImpl(deps, {
          endpoint: path,
          file,
          input: opts.input,
          ...(opts.paused ? { paused: opts.paused } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          source: {
            kind: 'new',
            init: initOne(file),
            // A single upload() transparently continues an unfinished upload of the same file on this device
            // (verified against the storage before any byte is sent; a different file just starts fresh).
            ...(files.length === 1
              ? {
                  match: async () => {
                    const match = (await records(path)).find(
                      (r) => r.file.size === file.size && r.file.name === file.name && !claimed.has(r.id),
                    );
                    if (match) claimed.add(match.id);
                    return match;
                  },
                }
              : {}),
          },
        });
        return track(task);
      });
    };

    return {
      path,
      rules,
      accept: acceptAttribute(rules),
      validate: (file: UploadableFile | readonly UploadableFile[]) =>
        validate(Array.isArray(file) ? file : [file as UploadableFile]),
      upload: (file: UploadableFile, opts?: { input?: unknown; signal?: AbortSignal; paused?: boolean }) =>
        startBatch([file], opts)[0]!,
      uploadMany: (
        files: readonly UploadableFile[] | FileList,
        opts?: { input?: unknown; signal?: AbortSignal; paused?: boolean },
      ) => {
        const list = Array.from(files as ArrayLike<UploadableFile>);
        return startBatch(list, opts);
      },
      resume: (file: UploadableFile, opts: { ticket: string; signal?: AbortSignal }) =>
        track(
          new UploadTaskImpl(deps, {
            endpoint: path,
            file,
            input: undefined,
            source: { kind: 'ticket', ticket: opts.ticket },
            ...(opts.signal ? { signal: opts.signal } : {}),
          }),
        ),
      pending: async () => (await restore()).filter((t) => t.getSnapshot().endpoint === path),
    };
  }

  function downloadEndpoint(path: string) {
    return {
      path,
      link: (opts?: { input?: unknown }) => `${baseUrl}/${path}${encodeLinkInput(opts?.input)}`,
      resolve: (opts?: { input?: unknown; signal?: AbortSignal }) =>
        control.call<ResolveResponse>(path, 'resolve', { input: opts?.input }, opts?.signal),
    };
  }

  async function restore(): Promise<UploadTask<unknown, BuiltinError>[]> {
    if (!store) return [];
    const all = await store.list().catch(() => []);
    const now = Date.now();
    const restored: UploadTask<unknown, BuiltinError>[] = [];
    for (const record of all) {
      if (record.baseUrl !== baseUrl) continue;
      if (record.expiresAt < now) {
        void store.delete(record.id).catch(() => {});
        continue;
      }
      const existing = [...tasks].find((t) => t.getSnapshot().id === record.id);
      if (existing) {
        restored.push(existing);
        continue;
      }
      if (claimed.has(record.id)) continue;
      claimed.add(record.id);
      restored.push(
        track(
          new UploadTaskImpl(deps, {
            endpoint: record.endpoint,
            file: undefined,
            input: record.input,
            source: { kind: 'record', record },
          }),
        ),
      );
    }
    return restored;
  }

  const tasksStore: ReadableStore<readonly UploadTask<unknown, BuiltinError>[]> = {
    getSnapshot: () => tasksSnapshot,
    subscribe: (l) => {
      taskListeners.add(l);
      return () => taskListeners.delete(l);
    },
  };

  const root = {
    $tasks: tasksStore,
    $restore: restore,
    $pauseAll: () => {
      for (const t of tasks) t.pause();
    },
    $resumeAll: () => {
      for (const t of tasks) t.resume();
    },
    $dispose: () => {
      for (const t of tasks) t.pause();
      network.dispose();
    },
  };

  const cache = new Map<string, unknown>();
  const node = (path: string): any => {
    const cached = cache.get(path);
    if (cached) return cached;
    const known = endpoints?.get(path);
    let target: any = {};
    if (known) target = isUploadContract(known) ? uploadEndpoint(path) : downloadEndpoint(path);
    const proxy = new Proxy(target, {
      get(obj, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in obj) return obj[prop];
        if (!known) {
          // Without the contract value, the endpoint kind is inferred from the method called.
          if (
            prop === 'upload' ||
            prop === 'uploadMany' ||
            prop === 'resume' ||
            prop === 'pending' ||
            prop === 'validate' ||
            prop === 'rules' ||
            prop === 'accept'
          ) {
            Object.assign(obj, uploadEndpoint(path));
            return obj[prop];
          }
          if (prop === 'link' || prop === 'resolve') {
            Object.assign(obj, downloadEndpoint(path));
            return obj[prop];
          }
        }
        if (prop === 'then') return undefined;
        return node(path ? `${path}/${prop}` : prop);
      },
    });
    cache.set(path, proxy);
    return proxy;
  };

  return new Proxy(root, {
    get(obj, prop) {
      if (typeof prop !== 'string') return undefined;
      if (RESERVED.has(prop)) return (obj as any)[prop];
      return node(prop);
    },
  }) as unknown as UploadClient<T>;
}

export type { TaskSource };
