import { type S3Preset, s3Storage } from '@open-upload/s3';

/**
 * Storage targets. MinIO (docker compose) is always on; real providers run only when their credentials are set:
 *   R2:  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   AWS: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET
 */
export interface Target {
  readonly name: string;
  readonly preset: S3Preset;
  readonly create: (prefix: string) => ReturnType<typeof s3Storage>;
  readonly setup?: () => Promise<void>;
}

const env = process.env;
export const MINIO_ENDPOINT = env.MINIO_ENDPOINT ?? 'http://localhost:9000';
export const MINIO_BUCKET = 'uploads-test';

export const targets: Target[] = [
  {
    name: 'minio',
    preset: 'minio',
    create: (prefix) =>
      s3Storage({
        preset: 'minio',
        endpoint: MINIO_ENDPOINT,
        bucket: MINIO_BUCKET,
        keyPrefix: prefix,
        credentials: {
          accessKeyId: env.MINIO_USER ?? 'minioadmin',
          secretAccessKey: env.MINIO_PASSWORD ?? 'minioadmin',
        },
      }),
    setup: async () => {
      const s = s3Storage({
        preset: 'minio',
        endpoint: MINIO_ENDPOINT,
        bucket: MINIO_BUCKET,
        credentials: {
          accessKeyId: env.MINIO_USER ?? 'minioadmin',
          secretAccessKey: env.MINIO_PASSWORD ?? 'minioadmin',
        },
      });
      await s.client.request({ method: 'PUT', allow: [409] });
    },
  },
];

if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
  targets.push({
    name: 'cloudflare-r2',
    preset: 'cloudflare-r2',
    create: (prefix) =>
      s3Storage({
        preset: 'cloudflare-r2',
        accountId: env.R2_ACCOUNT_ID!,
        bucket: env.R2_BUCKET!,
        keyPrefix: prefix,
        credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
      }),
  });
}
if (env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_BUCKET) {
  targets.push({
    name: 'aws',
    preset: 'aws',
    create: (prefix) =>
      s3Storage({
        preset: 'aws',
        region: env.AWS_REGION!,
        bucket: env.AWS_BUCKET!,
        keyPrefix: prefix,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        },
      }),
  });
}

export const runId = `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}/`;
