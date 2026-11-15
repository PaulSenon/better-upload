'use client';

import type { UploadTask } from '@bu-draft/client';
import { useUploadTask } from '@bu-draft/react';
import { Check, FileIcon, Pause, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatBytes, statusLabel } from './format';

export interface UploadItemProps {
  task: UploadTask<any, any>;
  className?: string;
}

/**
 * One upload: name, size, progress, a human status line and the actions that make sense right now
 * (pause / resume / retry / restart / re-select / cancel).
 */
export function UploadItem({ task, className }: UploadItemProps) {
  const s = useUploadTask(task);
  const reselect = useRef<HTMLInputElement>(null);
  if (!s) return null;
  const { status, progress, file, error } = s;
  const active =
    status === 'uploading' ||
    status === 'preparing' ||
    status === 'initializing' ||
    status === 'completing' ||
    status === 'retrying' ||
    status === 'waiting-network';
  const problem = status === 'failed' || status === 'expired' || (status === 'needs-file' && error);

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-3', className)} data-status={status}>
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          {status === 'completed' ? (
            <Check className="size-4 text-primary" aria-hidden />
          ) : (
            <FileIcon className="size-4 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p
            className={cn('truncate text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}
            role={problem ? 'alert' : undefined}
          >
            {formatBytes(progress.totalBytes)} · {status === 'needs-file' && error ? error.message : statusLabel(s)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {active && status !== 'completing' ? (
            <Button size="icon" variant="ghost" aria-label="Pause" onClick={() => task.pause()}>
              <Pause className="size-4" />
            </Button>
          ) : null}
          {status === 'paused' ? (
            <Button size="icon" variant="ghost" aria-label="Resume" onClick={() => task.resume()}>
              <Play className="size-4" />
            </Button>
          ) : null}
          {status === 'failed' && error?.retryable ? (
            <Button size="icon" variant="ghost" aria-label="Retry" onClick={() => task.retry()}>
              <RefreshCw className="size-4" />
            </Button>
          ) : null}
          {status === 'expired' ? (
            <Button size="sm" variant="outline" onClick={() => task.restart()}>
              <RotateCcw className="size-4" /> Start over
            </Button>
          ) : null}
          {status === 'needs-file' ? (
            <>
              <Button size="sm" variant="outline" onClick={() => reselect.current?.click()}>
                Select file
              </Button>
              <input
                ref={reselect}
                type="file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) task.attachFile(f).catch(() => {});
                  e.target.value = '';
                }}
              />
            </>
          ) : null}
          {status !== 'completed' && status !== 'canceled' ? (
            <Button size="icon" variant="ghost" aria-label="Cancel" onClick={() => void task.cancel()}>
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      {status !== 'completed' && status !== 'canceled' && status !== 'needs-file' ? (
        <Progress value={Math.round(progress.fraction * 100)} aria-label={`${file.name} upload progress`} />
      ) : null}
    </div>
  );
}
