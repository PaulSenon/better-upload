/// <reference types="vite/client" />

import type { GenericSchema, SchemaDefinition } from 'convex/server';
import { componentsGeneric } from 'convex/server';
import type { TestConvex } from 'convex-test';
import type { ComponentApi } from './component/_generated/component.js';
import schema from './component/schema.js';

const modules = import.meta.glob('./component/**/*.ts');

/** Registers the component in a `convex-test` instance (for apps testing their own functions). */
export function register(t: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name = 'openUpload') {
  t.registerComponent(name, schema, modules);
  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
