import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * One row per upload session. Written at start, completion and cancellation only (never per part), so it stays cheap.
 * Progress lives in the browser; the bucket is the source of truth for bytes.
 */
export default defineSchema({
  uploads: defineTable({
    sessionId: v.string(),
    endpoint: v.string(),
    /** Who started it (your user id), for "your unfinished uploads" lists across devices. */
    owner: v.optional(v.string()),
    /** Portable session ticket: `client.<endpoint>.resume(file, { ticket })` continues the upload on any device. */
    ticket: v.string(),
    key: v.string(),
    file: v.object({ name: v.string(), size: v.number(), type: v.string(), lastModified: v.number() }),
    status: v.union(v.literal('pending'), v.literal('completed'), v.literal('aborted'), v.literal('expired')),
    createdAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
    object: v.optional(v.object({ size: v.number(), etag: v.string(), contentType: v.optional(v.string()) })),
  })
    .index('by_session', ['sessionId'])
    .index('by_owner_status', ['owner', 'status'])
    .index('by_status_expires', ['status', 'expiresAt']),
});
