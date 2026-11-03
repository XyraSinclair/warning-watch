#!/usr/bin/env node
// Daily SQLite backups: VACUUM INTO a dated directory, verify each backup
// with integrity_check, prune old days. Online-safe (VACUUM INTO takes a
// consistent snapshot without blocking writers under WAL).
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { DATA_DIR } = require("../server/config");

const BACKUP_ROOT = process.env.EWS_BACKUP_DIR
  ? path.resolve(process.env.EWS_BACKUP_DIR)
  : path.join(DATA_DIR, "backups");
const KEEP_DAYS = Number(process.env.EWS_BACKUP_KEEP_DAYS || 14);
const DB_NAMES = ["ews-main.sqlite", "ews-military.sqlite", "ews-untracked.sqlite"];

function backupOne(sourcePath, destDir) {
  const name = path.basename(sourcePath);
  const destPath = path.join(destDir, name);
  fs.rmSync(destPath, { force: true });
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    db.prepare("VACUUM INTO ?").run(destPath);
  } finally {
    db.close();
  }
  const check = new Database(destPath, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`integrity_check failed for ${destPath}: ${result}`);
    }
  } finally {
    check.close();
  }
  return { name, bytes: fs.statSync(destPath).size, integrity: "ok" };
}

function pruneOldDays() {
  if (!fs.existsSync(BACKUP_ROOT)) {
    return [];
  }
  const dayDirs = fs
    .readdirSync(BACKUP_ROOT)
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
    .sort();
  const excess = dayDirs.slice(0, Math.max(0, dayDirs.length - KEEP_DAYS));
  for (const day of excess) {
    fs.rmSync(path.join(BACKUP_ROOT, day), { recursive: true, force: true });
  }
  return excess;
}

function main() {
  const day = new Date().toISOString().slice(0, 10);
  const destDir = path.join(BACKUP_ROOT, day);
  fs.mkdirSync(destDir, { recursive: true });

  const backups = [];
  const missing = [];
  for (const name of DB_NAMES) {
    const sourcePath = path.join(DATA_DIR, name);
    if (!fs.existsSync(sourcePath)) {
      missing.push(name);
      continue;
    }
    backups.push(backupOne(sourcePath, destDir));
  }

  if (backups.length === 0) {
    console.error(JSON.stringify({ ok: false, error: "no databases found", missing }));
    process.exit(1);
  }

  const pruned = pruneOldDays();
  console.log(JSON.stringify({ ok: true, day, destDir, backups, missing, pruned, keepDays: KEEP_DAYS }));
}

main();
