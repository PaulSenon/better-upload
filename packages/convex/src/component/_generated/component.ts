/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      expireStale: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        Array<{ sessionId: string; ticket: string }>,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        {
          _creationTime: number;
          _id: string;
          completedAt?: number;
          createdAt: number;
          endpoint: string;
          expiresAt: number;
          file: {
            lastModified: number;
            name: string;
            size: number;
            type: string;
          };
          key: string;
          object?: { contentType?: string; etag: string; size: number };
          owner?: string;
          sessionId: string;
          status: "pending" | "completed" | "aborted" | "expired";
          ticket: string;
        } | null,
        Name
      >;
      listPending: FunctionReference<
        "query",
        "internal",
        { endpoint?: string; limit?: number; owner?: string },
        Array<{
          _creationTime: number;
          _id: string;
          completedAt?: number;
          createdAt: number;
          endpoint: string;
          expiresAt: number;
          file: {
            lastModified: number;
            name: string;
            size: number;
            type: string;
          };
          key: string;
          object?: { contentType?: string; etag: string; size: number };
          owner?: string;
          sessionId: string;
          status: "pending" | "completed" | "aborted" | "expired";
          ticket: string;
        }>,
        Name
      >;
      recordAborted: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string },
        null,
        Name
      >;
      recordCompleted: FunctionReference<
        "mutation",
        "internal",
        {
          object: { contentType?: string; etag: string; size: number };
          sessionId: string;
        },
        null,
        Name
      >;
      recordStarted: FunctionReference<
        "mutation",
        "internal",
        {
          endpoint: string;
          expiresAt: number;
          file: {
            lastModified: number;
            name: string;
            size: number;
            type: string;
          };
          key: string;
          owner?: string;
          sessionId: string;
          ticket: string;
        },
        null,
        Name
      >;
    };
  };
