import { createFileRoute, Link } from '@tanstack/react-router';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { RefreshCw, Shield, ShieldCheck, Smartphone, Unplug, Waypoints } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { UploadDemo } from '@/demo/upload-demo';
import { baseOptions } from '@/lib/layout.shared';

export const Route = createFileRoute('/')({
  component: Home,
  head: () => ({
    meta: [
      { title: 'Upload SDK — type-safe, resumable uploads to your own bucket' },
      {
        name: 'description',
        content:
          'Contract-first, type-safe uploads and downloads for S3, R2 and any S3-compatible storage. Resumable for days, no database.',
      },
    ],
  }),
});

const features = [
  {
    icon: Waypoints,
    title: 'One contract, end-to-end types',
    text: 'Declare an endpoint once. The server implements it, the client is derived: input, output and errors are inferred.',
  },
  {
    icon: RefreshCw,
    title: 'Resumable for days',
    text: 'Presigned multipart with retries, adaptive concurrency and URL renewal. After a reload, re-select the file and it continues.',
  },
  {
    icon: ShieldCheck,
    title: 'Never mixes files',
    text: 'A re-selected file is re-checksummed against what the bucket stores before a single byte is appended.',
  },
  {
    icon: Unplug,
    title: 'No database, no lock-in',
    text: 'State lives in a sealed ticket and in your bucket. Your auth, your framework, your storage.',
  },
  {
    icon: Smartphone,
    title: 'Built for bad networks',
    text: 'Tested on WebKit and iPhone emulation with dropped connections, throttling, offline periods and expired URLs.',
  },
  {
    icon: Shield,
    title: 'Copy-in UI',
    text: 'shadcn registry components on a headless engine. Own the markup, keep the reliability.',
  },
];

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 py-16 md:py-24">
        <section className="flex flex-col items-center gap-6 text-center">
          <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
            Early preview · provisional name · not on npm yet
          </span>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">
            Uploads that survive the real world.
          </h1>
          <p className="max-w-2xl text-balance text-lg text-muted-foreground">
            Type-safe, resumable uploads and downloads straight to your own S3, R2 or MinIO bucket. Multi-gigabyte files
            on a phone, on a train, over several days.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link to="/docs/$" params={{ _splat: '' }} className={buttonVariants({ size: 'lg' })}>
              Get started
            </Link>
            <Link
              to="/docs/$"
              params={{ _splat: 'components' }}
              className={buttonVariants({ size: 'lg', variant: 'outline' })}
            >
              Components
            </Link>
          </div>
          <code className="rounded-md border bg-muted px-4 py-2 font-mono text-sm">
            npx shadcn@latest add {'<site>'}/r/upload.json
          </code>
        </section>

        <section className="mx-auto w-full max-w-2xl">
          <UploadDemo />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Live: the real engine and server run in this tab against an in-memory bucket. Try a big file, go offline,
            reload.
          </p>
        </section>

        <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex flex-col gap-2 rounded-xl border p-5">
              <Icon className="size-5" aria-hidden />
              <h2 className="font-medium">{title}</h2>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
      </main>
    </HomeLayout>
  );
}
