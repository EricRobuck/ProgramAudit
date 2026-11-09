import { createApp } from './app.js';
import { getConfig } from './config.js';
import { closeDb } from './db.js';

const config = getConfig();
const app = createApp();
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`ProgramAudit API listening on http://${config.HOST}:${config.PORT}`);
});

const shutdown = () => {
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
