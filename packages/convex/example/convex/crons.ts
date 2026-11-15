import { cronJobs } from 'convex/server';
import { internal } from './_generated/api.js';

const crons = cronJobs();
crons.hourly('abort expired uploads', { minuteUTC: 7 }, internal.uploads.cleanup, {});

export default crons;
