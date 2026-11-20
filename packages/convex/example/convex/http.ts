import { httpRouter } from 'convex/server';
import { openUpload, uploads } from './uploads.js';

const http = httpRouter();

openUpload.registerRoutes(http, uploads, {
  context: async (ctx) => ({ userId: (await ctx.auth.getUserIdentity())?.subject }),
});

export default http;
