'use strict';
/**
 * Base-product regression runner.
 *
 * Runs the node:test suite in tests/base/ from an ISOLATED temporary working
 * directory. This guarantees StorageManager's legacy-migration source
 * (process.cwd()/data/hammampos.db) cannot resolve to the developer database:
 * the temp cwd has no data/ folder, so no seed copy occurs.
 *
 * Exit code propagates from `node --test` (0 = all pass, non-zero = failure),
 * satisfying `npm test` semantics.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const testDir = path.join(PROJECT_ROOT, 'tests', 'base');

// Explicitly enumerate the *.test.js files (absolute paths) so `node --test`
// receives files rather than a directory. This is portable across Node versions
// and works regardless of the (isolated) working directory below.
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

if (testFiles.length === 0) {
  console.error('No test files found in', testDir);
  process.exit(1);
}

// Isolated working directory with NO data/ subfolder.
const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hammampos_testcwd_'));

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: isolatedCwd,
  stdio: 'inherit',
  env: process.env,
});

// Best-effort cleanup of the isolated cwd.
try { fs.rmSync(isolatedCwd, { recursive: true, force: true }); } catch (_) {}

process.exit(result.status === null ? 1 : result.status);
