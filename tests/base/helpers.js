'use strict';
/**
 * Shared test helpers for the base-product regression suite.
 *
 * Isolation guarantees:
 * - Every StorageManager is created with an explicit temp dbPath under the OS temp dir.
 * - We NEVER use %APPDATA%\HammamPOS\hammampos.db or the repo's data/hammampos.db.
 * - StorageManager's constructor has a legacy-migration step that copies
 *   process.cwd()/data/hammampos.db into the target IF the target does not exist.
 *   To defeat that, newStorage() creates the temp DB path and, before initialize(),
 *   re-asserts storage.dbPath to the temp path. Additionally the suite's package.json
 *   "test" script and the runner change the working directory to an isolated temp dir
 *   so process.cwd()/data/hammampos.db cannot resolve to the developer DB.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const StorageManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'StorageManager'));
const ExpenseTemplateManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'ExpenseTemplateManager'));

const createdDirs = new Set();

function freshTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hammampos_test_'));
  createdDirs.add(dir);
  return path.join(dir, 'hammampos.db');
}

async function newStorage() {
  const dbPath = freshTempDbPath();
  const storage = new StorageManager(dbPath);
  // Defensive: force the temp path in case any migration touched it.
  storage.dbPath = dbPath;
  await storage.initialize();
  return storage;
}

function cleanup(storage) {
  try { if (storage && typeof storage.close === 'function') storage.close(); } catch (_) {}
}

function cleanupAll() {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  createdDirs.clear();
}

module.exports = { PROJECT_ROOT, StorageManager, ExpenseTemplateManager, newStorage, cleanup, cleanupAll };
