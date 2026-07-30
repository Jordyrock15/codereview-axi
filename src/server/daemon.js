import { startServer } from './index.js';

const port = process.env.CR_PORT === undefined ? undefined : Number(process.env.CR_PORT);
await startServer({ port });
