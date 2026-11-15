import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';

export default mergeConfig(
  shared,
  defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } }),
);
