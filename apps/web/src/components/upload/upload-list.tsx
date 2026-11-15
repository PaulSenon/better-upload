'use client';

import type { UploadTask } from '@bu-draft/client';
import { cn } from '@/lib/utils';
import { UploadItem } from './upload-item';

export interface UploadListProps {
  tasks: readonly UploadTask<any, any>[];
  className?: string;
  /** Shown when there is nothing to list. */
  empty?: React.ReactNode;
}

export function UploadList({ tasks, className, empty = null }: UploadListProps) {
  if (tasks.length === 0) return <>{empty}</>;
  return (
    <ul className={cn('flex flex-col gap-2', className)} aria-label="Uploads">
      {tasks.map((task) => (
        <li key={task.id}>
          <UploadItem task={task} />
        </li>
      ))}
    </ul>
  );
}
