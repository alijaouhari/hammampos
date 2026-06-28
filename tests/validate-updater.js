/**
 * HammamPOS UpdateManager v2.3.1 — Validation Suite
 * Run: node tests/validate-updater.js
 */

const fs = require('fs');
const path = require('path');

const results = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    passed++;
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message });
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// Fresh instance for each test
function createManager() {
  // Clear require cache
  delete require.cache[require.resolve('../src/services/UpdateManager.js')];
  return new (require('../src/services/UpdateManager.js'))();
}

// ─── TESTS ────────────────────────────────────────────────────────────

test('Module loads without error', () => {
  const u = createManager();
  assert(u.currentVersion === '2.3.1', `Version mismatch: ${u.currentVersion}`);
});

test('Install dir resolves to C:\\HammamPOS in dev mode', () => {
  const u = createManager();
  assert(u.installDir === 'C:\\HammamPOS', `Got: ${u.installDir}`);
});

test('All directories are configured', () => {
  const u = createManager();
  assert(u.stagingDir === 'C:\\HammamPOS-update', `staging: ${u.stagingDir}`);
  assert(u.oldDir === 'C:\\HammamPOS-old', `old: ${u.oldDir}`);
  assert(u.oldPreviousDir === 'C:\\HammamPOS-old-previous', `oldPrev: ${u.oldPreviousDir}`);
});

test('Logs directory exists', () => {
  const u = createManager();
  assert(fs.existsSync(u.logsDir), 'Logs dir missing');
});

test('Updates directory exists', () => {
  const u = createManager();
  assert(fs.existsSync(u.updatesDir), 'Updates dir missing');
});

test('Logging works', () => {
  const u = createManager();
  u._log('TEST', 'Validation test entry', { suite: true });
  const logFile = path.join(u.logsDir, 'Updater.log');
  assert(fs.existsSync(logFile), 'Log file not created');
  const content = fs.readFileSync(logFile, 'utf8');
  assert(content.includes('Validation test entry'), 'Log entry not found');
});

test('Success handshake flag write/read', () => {
  const u = createManager();
  u.signalStartupSuccess();
  assert(fs.existsSync(u.flagPath), 'Flag not created');
  const data = JSON.parse(fs.readFileSync(u.flagPath, 'utf8'));
  assert(data.version === '2.3.1', `Flag version: ${data.version}`);
  assert(data.pid === process.pid, 'PID mismatch');
  fs.unlinkSync(u.flagPath);
});

test('Version comparison: newer', () => {
  const u = createManager();
  assert(u._isNewer('2.3.2', '2.3.1') === true, '2.3.2 > 2.3.1');
  assert(u._isNewer('2.4.0', '2.3.9') === true, '2.4.0 > 2.3.9');
  assert(u._isNewer('3.0.0', '2.9.9') === true, '3.0.0 > 2.9.9');
});

test('Version comparison: not newer', () => {
  const u = createManager();
  assert(u._isNewer('2.3.0', '2.3.1') === false, '2.3.0 not > 2.3.1');
  assert(u._isNewer('2.3.1', '2.3.1') === false, 'same version');
  assert(u._isNewer('1.0.0', '2.0.0') === false, '1.0.0 not > 2.0.0');
});

test('Staging cleanup on startup', () => {
  const u = createManager();
  // Create fake staging
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'test.txt'), 'test');
  assert(fs.existsSync(u.stagingDir), 'Setup failed');
  // Re-create (triggers _startupRecovery)
  const u2 = createManager();
  assert(!fs.existsSync(u.stagingDir), 'Staging not cleaned');
});

test('Integrity: missing exe detected', () => {
  const u = createManager();
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.mkdirSync(path.join(u.stagingDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'resources', 'app.asar'), 'data');
  let threw = false;
  try { u._verifyStaging(); } catch (e) { threw = true; }
  assert(threw, 'Should throw for missing exe');
  fs.rmSync(u.stagingDir, { recursive: true, force: true });
});

test('Integrity: empty exe detected', () => {
  const u = createManager();
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.mkdirSync(path.join(u.stagingDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'HammamPOS.exe'), '');
  fs.writeFileSync(path.join(u.stagingDir, 'resources', 'app.asar'), 'data');
  let threw = false;
  try { u._verifyStaging(); } catch (e) { threw = true; }
  assert(threw, 'Should throw for empty exe');
  fs.rmSync(u.stagingDir, { recursive: true, force: true });
});

test('Integrity: missing app.asar detected', () => {
  const u = createManager();
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.mkdirSync(path.join(u.stagingDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'HammamPOS.exe'), 'exe-data');
  let threw = false;
  try { u._verifyStaging(); } catch (e) { threw = true; }
  assert(threw, 'Should throw for missing app.asar');
  fs.rmSync(u.stagingDir, { recursive: true, force: true });
});

test('Integrity: valid staging passes', () => {
  const u = createManager();
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.mkdirSync(path.join(u.stagingDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'HammamPOS.exe'), 'valid-exe');
  fs.writeFileSync(path.join(u.stagingDir, 'resources', 'app.asar'), 'valid-asar');
  u._verifyStaging(); // Should not throw
  fs.rmSync(u.stagingDir, { recursive: true, force: true });
});

test('Apply without staging throws', () => {
  const u = createManager();
  let threw = false;
  try { u.applyAndRestart(); } catch (e) { threw = true; }
  assert(threw, 'Should throw');
});

test('Revert without backup throws', () => {
  const u = createManager();
  let threw = false;
  try { u.revertAndRestart(); } catch (e) { threw = true; }
  assert(threw, 'Should throw');
});

test('No internet returns null', async () => {
  const u = createManager();
  const original = u._fetchLatestRelease.bind(u);
  u._fetchLatestRelease = () => Promise.reject(new Error('ENETUNREACH'));
  const result = await u.checkForUpdate();
  assert(result === null, 'Should return null');
});

test('getStatus returns correct structure', () => {
  const u = createManager();
  const status = u.getStatus();
  assert(status.currentVersion === '2.3.1', 'version');
  assert(status.latestRelease === null, 'no release checked yet');
  assert(status.isDownloading === false, 'not downloading');
  assert(status.downloadProgress === 0, 'no progress');
  assert(Array.isArray(status.availableBackups), 'backups is array');
});

test('getBackups returns empty when no old dir', () => {
  const u = createManager();
  const backups = u._getBackups();
  assert(backups.length === 0, 'Should be empty');
});

test('Stale ZIP cleanup (7 day policy)', () => {
  const u = createManager();
  // Create a "stale" zip with old mtime
  const staleZip = path.join(u.updatesDir, 'update-v0.0.1.zip');
  fs.writeFileSync(staleZip, 'old-data');
  // Set mtime to 8 days ago
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleZip, eightDaysAgo, eightDaysAgo);
  // Create a "fresh" zip
  const freshZip = path.join(u.updatesDir, 'update-v9.9.9.zip');
  fs.writeFileSync(freshZip, 'new-data');
  // Trigger cleanup
  u._cleanStaleZips();
  assert(!fs.existsSync(staleZip), 'Stale zip should be deleted');
  assert(fs.existsSync(freshZip), 'Fresh zip should remain');
  fs.unlinkSync(freshZip);
});

// ─── REPORT ───────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('VALIDATION REPORT — HammamPOS UpdateManager v2.3.1');
console.log('='.repeat(60) + '\n');

results.forEach(r => {
  const icon = r.status === 'PASS' ? '✓' : '✗';
  const line = `  ${icon} ${r.name}`;
  console.log(line);
  if (r.error) console.log(`      Error: ${r.error}`);
});

console.log('\n' + '-'.repeat(60));
console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  TOTAL: ${passed + failed}`);
console.log('-'.repeat(60));

if (failed === 0) {
  console.log('\n  ALL TESTS PASSED.\n');
} else {
  console.log('\n  SOME TESTS FAILED. See errors above.\n');
  process.exit(1);
}
