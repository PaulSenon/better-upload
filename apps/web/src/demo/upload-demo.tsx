'use client';

import { useUpload } from '@bu-draft/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { UploadDropzone } from '@/components/upload/upload-dropzone';
import { UploadList } from '@/components/upload/upload-list';
import { getDemo, network } from './demo-client';

function DemoInner() {
  const { client } = getDemo();
  const upload = useUpload(client.files);
  const [failures, setFailures] = useState(network.failureRate > 0);
  const [offline, setOffline] = useState(network.offline);
  return (
    <div className="flex flex-col gap-4">
      <UploadDropzone
        control={upload.control()}
        hint="Runs entirely in this tab: in-memory bucket, simulated 8 MB/s network"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={failures ? 'default' : 'outline'}
          onClick={() => {
            network.failureRate = failures ? 0 : 0.35;
            setFailures(!failures);
          }}
        >
          {failures ? 'Flaky network: on' : 'Simulate a flaky network'}
        </Button>
        <Button
          size="sm"
          variant={offline ? 'default' : 'outline'}
          onClick={() => {
            network.offline = !offline;
            setOffline(!offline);
            window.dispatchEvent(new Event(offline ? 'online' : 'offline'));
          }}
        >
          {offline ? 'Offline: on' : 'Go offline'}
        </Button>
        {upload.tasks.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => upload.clearFinished()}>
            Clear finished
          </Button>
        ) : null}
      </div>
      <UploadList tasks={upload.tasks} />
    </div>
  );
}

/** Live demo of the registry components on the real engine (client-only). */
export function UploadDemo() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="not-prose rounded-xl border bg-card p-4 shadow-sm">
      {mounted ? <DemoInner /> : <div className="h-40 animate-pulse rounded-lg bg-muted" />}
    </div>
  );
}
