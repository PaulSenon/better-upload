/**
 * @bu-draft/react — DESIGN DRAFT (types only, no runtime).
 * Thin bindings over the client stores (`useSyncExternalStore`). No markup: UI ships
 * separately as copy-in shadcn registry items (dropzone, progress, list, resume banner).
 */
import type { ReactNode } from 'react';
import type { ReadableStore, UploadContract, UploadSnapshot, UploadTask, DownloadContract, DownloadSnapshot, DownloadTask, BuiltinError, ContractRouter } from '@bu-draft/core';
import type { EndpointUploadTask, UploadClient, UploadEndpointClient, UploadOptions, UploadableFile, DownloadEndpointClient, DownloadOptions } from '@bu-draft/client';

/** Subscribe to any SDK store with an optional selector (re-renders only when the selection changes). */
export declare function useStoreSnapshot<T, S = T>(store: ReadableStore<T>, selector?: (value: T) => S): S;

/** Snapshot of a single task. */
export declare function useUploadTask<TOutput, TError extends { code: string }>(
  task: UploadTask<TOutput, any> | undefined,
): UploadSnapshot<TOutput, any> | undefined;

export interface UseUploadResult<C extends UploadContract<any>> {
  /** Start uploads; returns the created tasks. */
  upload(files: readonly UploadableFile[] | FileList, options: UploadOptions<C>): readonly EndpointUploadTask<C>[];
  /** Tasks of this endpoint in this component (+ restored ones if `includeRestored`). */
  readonly tasks: readonly EndpointUploadTask<C>[];
  readonly snapshots: readonly ReturnType<EndpointUploadTask<C>['getSnapshot']>[];
  readonly isUploading: boolean;
  /** Aggregate progress 0..1 over confirmed bytes. */
  readonly progress: number;
  pauseAll(): void;
  resumeAll(): void;
  cancelAll(): Promise<void>;
  /** Headless control object for registry components (`<UploadDropzone control={...} />`). */
  readonly control: UploadControl;
}

export interface UploadControl {
  readonly accept?: string;
  readonly multiple: boolean;
  readonly disabled: boolean;
  onFiles(files: readonly UploadableFile[]): void;
}

export declare function useUpload<C extends UploadContract<any>>(
  endpoint: UploadEndpointClient<C>,
  options?: {
    includeRestored?: boolean;
    onComplete?: (output: ReturnType<EndpointUploadTask<C>['getSnapshot']>['output'], task: EndpointUploadTask<C>) => void;
    onError?: (error: NonNullable<ReturnType<EndpointUploadTask<C>['getSnapshot']>['error']>, task: EndpointUploadTask<C>) => void;
  },
): UseUploadResult<C>;

/** Unfinished uploads restored from local persistence, typically shown as "Re-select file to continue". */
export declare function usePendingUploads<T extends ContractRouter>(client: UploadClient<T>): readonly UploadTask<unknown, BuiltinError>[];

export declare function useDownload<C extends DownloadContract<any>>(
  endpoint: DownloadEndpointClient<C>,
): {
  start(options: DownloadOptions<C>): DownloadTask;
  readonly snapshot: DownloadSnapshot | undefined;
};

/** Optional provider: calls `$restore()` once and disposes on unmount. */
export declare function UploadClientProvider<T extends ContractRouter>(props: { client: UploadClient<T>; children?: ReactNode }): ReactNode;
