import type {
  EndpointUploadTask,
  ReadableStore,
  UploadableFile,
  UploadClient,
  UploadContract,
  UploadEndpointClient,
  UploadOptions,
  UploadSnapshot,
  UploadTask,
} from '@bu-draft/client';
import type { BuiltinError, ContractRouter, EndpointError, FileRules, UploadErrorShape } from '@bu-draft/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

type AnyTask = UploadTask<any, any>;
const EMPTY: readonly never[] = [];
const noopStore: ReadableStore<undefined> = { getSnapshot: () => undefined, subscribe: () => () => {} };

/** Subscribes to any SDK store; with a selector, re-renders only when the selected value changes. */
export function useStore<T, S = T>(store: ReadableStore<T>, selector?: (value: T) => S): S {
  const select = selector ?? ((v: T) => v as unknown as S);
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getSnapshot()),
  );
}

/** Live snapshot of one task (`undefined` while there is no task). */
export function useUploadTask<TOutput, TError extends UploadErrorShape>(
  task: UploadTask<TOutput, TError> | undefined,
): UploadSnapshot<TOutput, TError> | undefined {
  return useStore((task ?? noopStore) as ReadableStore<UploadSnapshot<TOutput, TError> | undefined>);
}

type Snapshot<C extends UploadContract<any>> = ReturnType<EndpointUploadTask<C>['getSnapshot']>;

/** Props for a headless dropzone / file input (the registry components take this as `control`). */
export interface UploadControl {
  /** `accept` attribute derived from the contract's file rules (when the contract value was given). */
  readonly accept: string | undefined;
  readonly multiple: boolean;
  readonly rules: FileRules | undefined;
  /** Starts uploads for the given files (validated against the contract rules first). */
  onFiles(files: readonly UploadableFile[] | FileList): void;
}

export interface UseUploadOptions<C extends UploadContract<any>> {
  /** Called once per task when it completes, with the typed output. */
  onCompleted?: (output: NonNullable<Snapshot<C>['output']>, task: EndpointUploadTask<C>) => void;
  /** Called when a task stops on an error (including client-side validation errors). */
  onFailed?: (error: EndpointError<any>, task: EndpointUploadTask<C> | undefined) => void;
}

export interface UseUploadResult<C extends UploadContract<any>> {
  /** Starts uploads. One file uses `upload()`, several use one batched `uploadMany()`. */
  upload(
    files: UploadableFile | readonly UploadableFile[] | FileList,
    ...options: UploadArgs<C>
  ): EndpointUploadTask<C>[];
  /** Tasks started from this hook, oldest first. */
  readonly tasks: readonly EndpointUploadTask<C>[];
  readonly snapshots: readonly Snapshot<C>[];
  /** True while any task is moving bytes or waiting to. */
  readonly isUploading: boolean;
  /** Aggregate progress over every task, 0..1. */
  readonly progress: number;
  pauseAll(): void;
  resumeAll(): void;
  cancelAll(): Promise<void>;
  /** Forgets finished tasks (completed, canceled, expired, non-retryable failures). */
  clearFinished(): void;
  /** Headless props for a dropzone or `<input type="file">`, bound to `upload` with `options`. */
  control(...options: UploadArgs<C>): UploadControl;
}

type UploadArgs<C extends UploadContract<any>> =
  {} extends UploadOptions<C> ? [options?: UploadOptions<C>] : [options: UploadOptions<C>];

const ACTIVE = new Set(['preparing', 'initializing', 'uploading', 'waiting-network', 'retrying', 'completing']);
const FINISHED = new Set(['completed', 'canceled', 'expired']);

/** Upload state for one endpoint, scoped to the component. */
export function useUpload<C extends UploadContract<any>>(
  endpoint: UploadEndpointClient<C>,
  options: UseUploadOptions<C> = {},
): UseUploadResult<C> {
  const [tasks, setTasks] = useState<readonly EndpointUploadTask<C>[]>(EMPTY);
  const callbacks = useRef(options);
  callbacks.current = options;

  const store = useMemo<ReadableStore<readonly Snapshot<C>[]>>(() => {
    let cached: readonly Snapshot<C>[] = EMPTY;
    return {
      getSnapshot: () => {
        const next = tasks.map((t) => t.getSnapshot());
        if (next.length !== cached.length || next.some((s, i) => s !== cached[i])) cached = next;
        return cached;
      },
      subscribe: (listener) => {
        const offs = tasks.map((t) => t.subscribe(listener));
        return () => {
          for (const off of offs) off();
        };
      },
    };
  }, [tasks]);
  const snapshots = useStore(store);

  // Fire onCompleted / onFailed once per task.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    snapshots.forEach((s, i) => {
      const task = tasks[i]!;
      const id = `${task.id}:${s.status}`;
      if (reported.current.has(id)) return;
      if (s.status === 'completed') {
        reported.current.add(id);
        callbacks.current.onCompleted?.(s.output as NonNullable<Snapshot<C>['output']>, task);
      } else if (s.status === 'failed' || s.status === 'expired') {
        reported.current.add(id);
        if (s.error) callbacks.current.onFailed?.(s.error as EndpointError<any>, task);
      }
    });
  }, [snapshots, tasks]);

  const upload = useCallback(
    (files: UploadableFile | readonly UploadableFile[] | FileList, ...args: UploadArgs<C>) => {
      const list = isFileLike(files) ? [files] : Array.from(files as ArrayLike<UploadableFile>);
      if (list.length === 0) return [];
      try {
        const created =
          list.length === 1
            ? [endpoint.upload(list[0]!, ...(args as [any]))]
            : endpoint.uploadMany(list, ...(args as [any]));
        setTasks((prev) => [...prev, ...created]);
        return created;
      } catch (error) {
        callbacks.current.onFailed?.(error as EndpointError<any>, undefined);
        return [];
      }
    },
    [endpoint],
  );

  const totals = snapshots.reduce(
    (acc, s) => {
      acc.total += s.progress.totalBytes;
      acc.done +=
        s.status === 'completed' ? s.progress.totalBytes : s.progress.confirmedBytes + s.progress.inflightBytes;
      return acc;
    },
    { total: 0, done: 0 },
  );

  return {
    upload,
    tasks,
    snapshots,
    isUploading: snapshots.some((s) => ACTIVE.has(s.status)),
    progress:
      totals.total === 0
        ? snapshots.length > 0 && snapshots.every((s) => s.status === 'completed')
          ? 1
          : 0
        : totals.done / totals.total,
    pauseAll: () => {
      for (const t of tasks) t.pause();
    },
    resumeAll: () => {
      for (const t of tasks) t.resume();
    },
    cancelAll: async () => {
      await Promise.all(tasks.map((t) => t.cancel()));
    },
    clearFinished: () =>
      setTasks((prev) =>
        prev.filter((t) => {
          const s = t.getSnapshot();
          return !(FINISHED.has(s.status) || (s.status === 'failed' && !s.error?.retryable));
        }),
      ),
    control: (...args: UploadArgs<C>) => ({
      accept: endpoint.accept,
      multiple: (endpoint.rules?.maxFiles ?? 1) > 1,
      rules: endpoint.rules,
      onFiles: (files) => {
        upload(files, ...args);
      },
    }),
  };
}

/**
 * Unfinished uploads persisted on this device (after a reload or days later), usually shown as
 * "Select the file again to continue". Calls `client.$restore()` once.
 */
export function usePendingUploads<T extends ContractRouter>(
  client: UploadClient<T>,
): readonly UploadTask<unknown, BuiltinError>[] {
  const all = useStore(client.$tasks);
  useEffect(() => {
    void client.$restore();
  }, [client]);
  const statuses = useStore(
    useMemo<ReadableStore<string>>(
      () => ({
        getSnapshot: () => all.map((t: AnyTask) => t.getSnapshot().status).join(','),
        subscribe: (l) => {
          const offs = all.map((t: AnyTask) => t.subscribe(l));
          return () => {
            for (const off of offs) off();
          };
        },
      }),
      [all],
    ),
  );
  return useMemo(() => all.filter((t) => t.getSnapshot().status === 'needs-file'), [all, statuses]);
}

function isFileLike(value: unknown): value is UploadableFile {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export type { UploadClient, UploadEndpointClient, UploadSnapshot, UploadTask };
