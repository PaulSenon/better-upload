import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/hash-worker.ts'],
  format: 'esm',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
});
