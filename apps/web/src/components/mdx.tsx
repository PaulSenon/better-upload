import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { DownloadButtonPreview, DropzonePreview, ItemPreview, ListPreview, ResumeBannerPreview } from '@/demo/previews';
import { RegistryInstall } from '@/demo/registry-install';
import { UploadDemo } from '@/demo/upload-demo';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    UploadDemo,
    DropzonePreview,
    ItemPreview,
    ListPreview,
    ResumeBannerPreview,
    DownloadButtonPreview,
    RegistryInstall,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
