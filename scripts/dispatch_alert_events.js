#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dispatchPendingAlerts } = require('../server/local-notifications');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    return;
  }

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=');
    }
  }
}

loadEnvFile('/etc/warning-watch.env');
loadEnvFile(path.join(__dirname, '..', '.env'));

function parseArgs(argv) {
  const args = {
    db: process.env.EWS_DB_PATH || path.join(__dirname, '..', 'data', 'ews-main.sqlite'),
    limit: 25,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') {
      args.db = argv[++index];
    } else if (value === '--limit') {
      args.limit = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const dbPath = path.resolve(args.db);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 30000');
  try {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    const summary = await dispatchPendingAlerts(db, process.env, { limit: args.limit });
    console.log(JSON.stringify({ ok: true, db: dbPath, ...summary }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
