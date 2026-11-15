import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';

const fileValidator = v.object({ name: v.string(), size: v.number(), type: v.string(), lastModified: v.number() });
const uploadDoc = v.object({
  _id: v.id('uploads'),
  _creationTime: v.number(),
  sessionId: v.string(),
  endpoint: v.string(),
  owner: v.optional(v.string()),
  ticket: v.string(),
  key: v.string(),
  file: fileValidator,
  status: v.union(v.literal('pending'), v.literal('completed'), v.literal('aborted'), v.literal('expired')),
  createdAt: v.number(),
  expiresAt: v.number(),
  completedAt: v.optional(v.number()),
  object: v.optional(v.object({ size: v.number(), etag: v.string(), contentType: v.optional(v.string()) })),
});

/** Records a started upload (idempotent on `sessionId`). */
export const recordStarted = mutation({
  args: {
    sessionId: v.string(),
    endpoint: v.string(),
    owner: v.optional(v.string()),
    ticket: v.string(),
    key: v.string(),
    file: fileValidator,
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('uploads')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique();
    if (existing) return null;
    await ctx.db.insert('uploads', { ...args, status: 'pending', createdAt: Date.now() });
    return null;
  },
});

/** Marks an upload completed (at-least-once safe). */
export const recordCompleted = mutation({
  args: {
    sessionId: v.string(),
    object: v.object({ size: v.number(), etag: v.string(), contentType: v.optional(v.string()) }),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, object }) => {
    const row = await ctx.db
      .query('uploads')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique();
    if (!row || row.status === 'completed') return null;
    await ctx.db.patch(row._id, { status: 'completed', completedAt: Date.now(), object });
    return null;
  },
});

export const recordAborted = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const row = await ctx.db
      .query('uploads')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique();
    if (row && row.status === 'pending') await ctx.db.patch(row._id, { status: 'aborted' });
    return null;
  },
});

/** Unfinished uploads of a user, newest first (reactive: use it from your own query). */
export const listPending = query({
  args: { owner: v.optional(v.string()), endpoint: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(uploadDoc),
  handler: async (ctx, { owner, endpoint, limit }) => {
    const now = Date.now();
    const rows = await ctx.db
      .query('uploads')
      .withIndex('by_owner_status', (q) => q.eq('owner', owner).eq('status', 'pending'))
      .order('desc')
      .take(limit ?? 50);
    return rows.filter((r) => r.expiresAt > now && (endpoint === undefined || r.endpoint === endpoint));
  },
});

export const get = query({
  args: { sessionId: v.string() },
  returns: v.union(uploadDoc, v.null()),
  handler: async (ctx, { sessionId }) =>
    ctx.db
      .query('uploads')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique(),
});

/**
 * Marks pending uploads past their expiry as `expired` and returns their tickets, so an app action can abort the
 * multipart uploads in the bucket (the component holds no storage credentials).
 */
export const expireStale = mutation({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({ sessionId: v.string(), ticket: v.string() })),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('uploads')
      .withIndex('by_status_expires', (q) => q.eq('status', 'pending').lt('expiresAt', Date.now()))
      .take(limit ?? 100);
    for (const row of rows) await ctx.db.patch(row._id, { status: 'expired' });
    return rows.map((r) => ({ sessionId: r.sessionId, ticket: r.ticket }));
  },
});
