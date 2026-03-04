#!/usr/bin/env node

const { loadConfig, printHelp, parseArgs } = require('./config');
const { startServer } = require('./server');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

let config;
try {
  config = loadConfig(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

startServer(config);

if (!config.noOpen) {
  import('open').then(mod => {
    mod.default(`http://localhost:${config.port}`);
  }).catch(() => {});
}
