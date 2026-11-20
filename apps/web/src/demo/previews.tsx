'use client';

import type { UploadTask } from '@open-upload/client';
import { useStore, useUpload } from '@open-upload/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/upload/download-button';
import { UploadDropzone } from '@/components/upload/upload-dropzone';
import { UploadItem } from '@/components/upload/upload-item';
import { UploadList } from '@/components/upload/upload-list';
import { UploadResumeBanner } from '@/components/upload/upload-resume-banner';
import { getDemo } from './demo-client';

/** Client-only wrapper: previews use browser APIs and the in-tab demo stack. */
function Preview({ children, height = 'h-40' }: { children: () => React.ReactNode; height?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="not-prose my-6 rounded-xl border bg-card p-4 shadow-sm">
      {mounted ? children() : <div className={`${height} animate-pulse rounded-lg bg-muted`} />}
    </div>
  );
}

function sampleFile(megabytes: number, name: string) {
  const bytes = new Uint8Array(megabytes * 1024 * 1024);
  crypto.getRandomValues(bytes.subarray(0, 65_536));
  return new File([bytes], name, { type: 'video/mp4', lastModified: Date.now() });
}

export function DropzonePreview() {
  return (
    <Preview>
      {() => {
        const Inner = () => {
          const upload = useUpload(getDemo().client.files);
          return (
            <div className="flex flex-col gap-3">
              <UploadDropzone control={upload.control()} hint="Any file — it stays in this tab" />
              <p className="text-xs text-muted-foreground">
                {upload.tasks.length === 0
                  ? 'No upload yet.'
                  : `${upload.tasks.length} upload(s), ${Math.round(upload.progress * 100)}% overall`}
              </p>
            </div>
          );
        };
        return <Inner />;
      }}
    </Preview>
  );
}

export function ItemPreview() {
  return (
    <Preview height="h-24">
      {() => {
        const Inner = () => {
          const [task, setTask] = useState<UploadTask<any, any>>();
          return (
            <div className="flex flex-col gap-3">
              {task ? <UploadItem task={task} /> : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTask(getDemo().client.files.upload(sampleFile(96, 'holiday-video.mp4')))}
              >
                {task ? 'Start another sample upload' : 'Start a sample 96 MB upload'}
              </Button>
            </div>
          );
        };
        return <Inner />;
      }}
    </Preview>
  );
}

export function ListPreview() {
  return (
    <Preview>
      {() => {
        const Inner = () => {
          const tasks = useStore(getDemo().client.$tasks);
          return (
            <div className="flex flex-col gap-3">
              <UploadList
                tasks={tasks}
                empty={<p className="text-sm text-muted-foreground">Nothing uploaded in this tab yet.</p>}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  getDemo().client.files.uploadMany([
                    sampleFile(24, 'a.mp4'),
                    sampleFile(48, 'b.mp4'),
                    sampleFile(8, 'c.mp4'),
                  ])
                }
              >
                Upload three sample files
              </Button>
            </div>
          );
        };
        return <Inner />;
      }}
    </Preview>
  );
}

export function ResumeBannerPreview() {
  return (
    <Preview height="h-24">
      {() => (
        <div className="flex flex-col gap-3">
          <UploadResumeBanner client={getDemo().client} />
          <p className="text-xs text-muted-foreground">
            Start an upload (any preview on this site), reload the page before it finishes: the banner lists it here.
            Selecting the same file continues it; another file is refused.
          </p>
        </div>
      )}
    </Preview>
  );
}

export function DownloadButtonPreview() {
  return (
    <Preview height="h-16">
      {() => {
        const Inner = () => {
          const [key, setKey] = useState<string>();
          useEffect(() => {
            const task = getDemo().client.files.upload(sampleFile(64, 'report.bin'));
            void task.result.then(() => setKey(task.getSnapshot().key));
          }, []);
          if (!key) return <p className="text-sm text-muted-foreground">Preparing a 64 MB sample file…</p>;
          return (
            <DownloadButton
              href="#"
              managed={() => getDemo().client.download.download({ input: { key, name: 'report.bin' }, sink: 'memory' })}
            >
              Download report.bin
            </DownloadButton>
          );
        };
        return <Inner />;
      }}
    </Preview>
  );
}
