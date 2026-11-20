import { defineApp } from 'convex/server';
import openUpload from '../../src/component/convex.config.js';

const app = defineApp();
app.use(openUpload);

export default app;
