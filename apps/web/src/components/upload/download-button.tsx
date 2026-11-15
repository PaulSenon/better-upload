'use client';

import type { DownloadTask } from '@open-upload/client';
import { useDownloadTask } from '@open-upload/react';
import { Download, Pause, Play, X } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatBytes } from './format';

export interface DownloadButtonProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** From `client.<endpoint>.link({ input })`: a stable link, re-authorized on every click. Always works, even without JS. */
  href: string;
  /**
   * Optional progressive enhancement: start a managed download instead (`() => client.<endpoint>.download({ input })`).
   * Shows progress with pause / resume / cancel; falls back to the link where no managed sink is available.
   */
  managed?: () => DownloadTask<any>;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
}

export function DownloadButton({
  href,
  managed,
  variant = 'outline',
  className,
  children,
  onClick,
  ...props
}: DownloadButtonProps) {
  const [task, setTask] = useState<DownloadTask<any>>();
  const s = useDownloadTask(task);
  const running = s && s.status !== 'completed' && s.status !== 'canceled' && s.status !== 'failed';

  if (running && task) {
    return (
      <div className={cn('flex min-w-64 flex-col gap-2 rounded-md border p-3', className)}>
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{s.fileName}</span>
          <span className="text-xs text-muted-foreground">
            {formatBytes(s.receivedBytes)} / {formatBytes(s.totalBytes)}
          </span>
          {s.status === 'paused' ? (
            <Button size="icon" variant="ghost" aria-label="Resume" onClick={() => task.resume()}>
              <Play className="size-4" />
            </Button>
          ) : (
            <Button size="icon" variant="ghost" aria-label="Pause" onClick={() => task.pause()}>
              <Pause className="size-4" />
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label="Cancel" onClick={() => task.cancel()}>
            <X className="size-4" />
          </Button>
        </div>
        <Progress value={Math.round(s.fraction * 100)} aria-label={`${s.fileName} download progress`} />
      </div>
    );
  }

  return (
    <a
      href={href}
      download
      className={cn(buttonVariants({ variant }), className)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || !managed) return;
        event.preventDefault();
        setTask(managed());
      }}
      {...props}
    >
      <Download className="size-4" aria-hidden />
      {children ?? 'Download'}
      {s?.status === 'failed' ? (
        <span className="text-xs text-destructive">· {s.error?.message ?? 'failed'}</span>
      ) : null}
    </a>
  );
}
