'use client';

import type { UploadClient } from '@open-upload/client';
import { usePendingUploads } from '@open-upload/react';
import { History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UploadItem } from './upload-item';

export interface UploadResumeBannerProps {
  client: UploadClient<any>;
  className?: string;
}

/**
 * Lists uploads that were interrupted (tab closed, reload, days ago) and can continue once the user selects the
 * same file again. The file is verified before any byte is sent; a different file is refused.
 */
export function UploadResumeBanner({ client, className }: UploadResumeBannerProps) {
  const pending = usePendingUploads(client);
  if (pending.length === 0) return null;
  return (
    <section
      className={cn('flex flex-col gap-3 rounded-lg border bg-muted/40 p-4', className)}
      aria-label="Unfinished uploads"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="size-4" aria-hidden />
        {pending.length === 1 ? 'You have an unfinished upload' : `You have ${pending.length} unfinished uploads`}
      </div>
      <p className="text-xs text-muted-foreground">
        Select the same file again to continue where it stopped. Nothing is sent twice.
      </p>
      {pending.map((task) => (
        <UploadItem key={task.id} task={task} />
      ))}
    </section>
  );
}
