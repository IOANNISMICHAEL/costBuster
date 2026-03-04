const express = require('express');
const path = require('path');
const { createApiRouter } = require('./routes/api');

function createServer(config) {
  const app = express();

  app.use('/api', createApiRouter(config));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

function startServer(config) {
  const app = createServer(config);

  const server = app.listen(config.port, '127.0.0.1', () => {
    const url = `http://localhost:${config.port}`;
    console.log(`\n  CostBuster running at ${url}\n`);
    console.log(`  Anthropic data:  ${config.anthropicDataDir}`);
    if (config.anthropicAdminKeys && config.anthropicAdminKeys.length > 0) {
      console.log(`  Anthropic API:   ${config.anthropicAdminKeys.length} admin key(s), ${config.anthropicApiSyncDays}d sync`);
    }
    if (config.openaiUsageFile) console.log(`  OpenAI file:     ${config.openaiUsageFile}`);
    if (config.openaiLogsDir) console.log(`  OpenAI logs:     ${config.openaiLogsDir}`);
    console.log('');
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server };
}

module.exports = { createServer, startServer };
