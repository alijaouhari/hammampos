/**
 * HammamPOS UpdateManager v3.0.0 — Validation Suite
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

function createManager() {
  delete require.cache[require.resolve('../src/services/UpdateManager.js')];
  return new (require('../src/services/UpdateManager.js'))();
}

// ─── TESTS ────────────────────────────────────────────────────────────

test('Module loads without error', () => {
  const u = createManager();
  assert(u.currentVersion === '2.6.0', `Version mismatch: ${u.currentVersion}`);
});

test('Install dir resolves to C:\\HammamPOS in dev mode', () => {
  const u = createManager();
  assert(u.installDir === 'C:\\HammamPOS', `Got: ${u.installDir}`);
});

test('All directories configured correctly', () => {
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
  u._log('TEST', 'Validation test entry v3', { suite: true });
  const logFile = path.join(u.logsDir, 'Updater.log');
  assert(fs.existsSync(logFile), 'Log file not created');
  const content = fs.readFileSync(logFile, 'utf8');
  assert(content.includes('Validation test entry v3'), 'Log entry not found');
});

test('Success handshake flag write/read', () => {
  const u = createManager();
  u.signalStartupSuccess();
  assert(fs.existsSync(u.flagPath), 'Flag not created');
  const data = JSON.parse(fs.readFileSync(u.flagPath, 'utf8'));
  assert(data.version === '2.6.0', `Flag version: ${data.version}`);
  assert(data.pid === process.pid, 'PID mismatch');
  fs.unlinkSync(u.flagPath);
});

test('Version comparison: newer', () => {
  const u = createManager();
  assert(u._isNewer('2.5.2', '2.5.1') === true, '2.5.2 > 2.5.1');
  assert(u._isNewer('2.6.0', '2.5.9') === true, '2.6.0 > 2.5.9');
  assert(u._isNewer('3.0.0', '2.9.9') === true, '3.0.0 > 2.9.9');
});

test('Version comparison: not newer', () => {
  const u = createManager();
  assert(u._isNewer('2.5.0', '2.5.1') === false, '2.5.0 not > 2.5.1');
  assert(u._isNewer('2.5.1', '2.5.1') === false, 'same version');
  assert(u._isNewer('1.0.0', '2.0.0') === false, '1.0.0 not > 2.0.0');
});

test('VBS launcher generates valid VBScript', () => {
  const u = createManager();
  const vbs = u._buildVBS('C:\\test\\updater.ps1');
  assert(vbs.includes('CreateObject("WScript.Shell")'), 'Missing WScript.Shell');
  assert(vbs.includes('powershell.exe'), 'Missing powershell reference');
  assert(vbs.includes('-ExecutionPolicy Bypass'), 'Missing execution policy');
  assert(vbs.includes('-WindowStyle Hidden'), 'Missing window style');
  assert(vbs.includes('C:\\test\\updater.ps1'), 'Missing PS1 path');
  assert(vbs.includes(', 0, False'), 'Missing hidden + async params');
});

test('PS1 update script contains all required stages', () => {
  const u = createManager();
  u.latestRelease = { version: '3.0.0' };
  const lockPath = path.join(u.updatesDir, 'update.lock');
  const ps1 = u._buildUpdatePS1('C:\\test\\update.zip', lockPath);
  assert(ps1.includes("$installDir"), 'Missing installDir');
  assert(ps1.includes("$stagingDir"), 'Missing stagingDir');
  assert(ps1.includes("$oldDir"), 'Missing oldDir');
  assert(ps1.includes("$lockPath"), 'Missing lockPath');
  assert(ps1.includes("Step 1: Waiting for HammamPOS"), 'Missing wait step');
  assert(ps1.includes("Step 2: Verifying ZIP"), 'Missing verify step');
  assert(ps1.includes("Step 3: Extracting"), 'Missing extract step');
  assert(ps1.includes("Step 4: Verifying staging"), 'Missing integrity step');
  assert(ps1.includes("Step 5: Managing backups"), 'Missing backup step');
  assert(ps1.includes("Step 6: Rename install -> old"), 'Missing swap step 1');
  assert(ps1.includes("Step 7: Rename staging -> install"), 'Missing swap step 2');
  assert(ps1.includes("Step 8: Launching new version"), 'Missing launch step');
  assert(ps1.includes("Step 9: Waiting for handshake"), 'Missing handshake step');
  assert(ps1.includes("Abort"), 'Missing abort/rollback function');
  assert(ps1.includes("ROLLBACK"), 'Missing rollback logic');
  assert(ps1.includes("update.lock"), 'Missing lock file reference');
  assert(ps1.includes("AV scan"), 'Missing AV consideration');
});

test('PS1 revert script contains required logic', () => {
  const u = createManager();
  const ps1 = u._buildRevertPS1();
  assert(ps1.includes("REVERT STARTED"), 'Missing revert header');
  assert(ps1.includes("Rename"), 'Missing rename logic');
  assert(ps1.includes("HammamPOS.exe"), 'Missing exe reference');
  assert(ps1.includes("$oldDir"), 'Missing old dir reference');
  assert(ps1.includes("REVERT COMPLETE"), 'Missing completion marker');
});

test('Apply without download throws', () => {
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
  u._fetchLatestRelease = () => Promise.reject(new Error('ENETUNREACH'));
  const result = await u.checkForUpdate();
  assert(result === null, 'Should return null');
});

test('getStatus returns correct structure', () => {
  const u = createManager();
  const status = u.getStatus();
  assert(status.currentVersion === '2.6.0', 'version');
  assert(status.latestRelease === null, 'no release checked yet');
  assert(status.isDownloading === false, 'not downloading');
  assert(status.downloadProgress === 0, 'no progress');
  assert(Array.isArray(status.availableBackups), 'backups is array');
});

test('Startup cleanup removes stale VBS and PS1 files', () => {
  const u = createManager();
  // Create stale launcher files
  const staleVbs = path.join(u.updatesDir, 'launch-updater.vbs');
  const stalePs1 = path.join(u.updatesDir, 'hammampos-updater.ps1');
  fs.writeFileSync(staleVbs, 'stale', 'utf8');
  fs.writeFileSync(stalePs1, 'stale', 'utf8');
  // Re-create triggers _startupRecovery
  const u2 = createManager();
  assert(!fs.existsSync(staleVbs), 'VBS not cleaned');
  assert(!fs.existsSync(stalePs1), 'PS1 not cleaned');
});

test('Startup recovery does NOT write success flag', () => {
  const u = createManager();
  // If flag exists from a previous test, remove it
  try { fs.unlinkSync(u.flagPath); } catch (_) {}
  // Re-create manager (triggers _startupRecovery)
  const u2 = createManager();
  // Flag should NOT exist — only signalStartupSuccess() should create it
  assert(!fs.existsSync(u2.flagPath), 'Flag should NOT be written by _startupRecovery');
});

test('Concurrent update prevention via lock file', () => {
  const u = createManager();
  u.latestRelease = { version: '9.9.9' };
  // Create a fresh lock file (simulates active update)
  const lockPath = path.join(u.updatesDir, 'update.lock');
  fs.writeFileSync(lockPath, '12345', 'utf8');
  // Create fake ZIP so the initial checks pass
  const zipPath = path.join(u.updatesDir, 'update-v9.9.9.zip');
  fs.writeFileSync(zipPath, 'x'.repeat(100));
  let threw = false;
  try { u.applyAndRestart(); } catch (e) { threw = true; }
  assert(threw, 'Should throw when lock exists');
  // Cleanup
  fs.unlinkSync(lockPath);
  fs.unlinkSync(zipPath);
});

test('Stale lock file is cleaned on startup', () => {
  const u = createManager();
  const lockPath = path.join(u.updatesDir, 'update.lock');
  fs.writeFileSync(lockPath, '99999', 'utf8');
  // Set mtime to 15 minutes ago (stale)
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
  fs.utimesSync(lockPath, fifteenMinAgo, fifteenMinAgo);
  // Re-create triggers _startupRecovery which cleans stale locks
  const u2 = createManager();
  assert(!fs.existsSync(lockPath), 'Stale lock should be cleaned');
});

test('Log rotation works when log exceeds 1MB', () => {
  const u = createManager();
  const logFile = path.join(u.logsDir, 'Updater.log');
  // Write > 1MB of log data
  const bigData = 'x'.repeat(1.2 * 1024 * 1024);
  fs.writeFileSync(logFile, bigData, 'utf8');
  u._rotateLog();
  const newSize = fs.statSync(logFile).size;
  assert(newSize < 600 * 1024, `Log should be < 600KB after rotation, got ${newSize}`);
  assert(newSize > 400 * 1024, `Log should be > 400KB after rotation, got ${newSize}`);
  const content = fs.readFileSync(logFile, 'utf8');
  assert(content.includes('LOG ROTATED'), 'Should contain rotation marker');
});

test('Staging cleanup on startup', () => {
  const u = createManager();
  fs.mkdirSync(u.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(u.stagingDir, 'test.txt'), 'test');
  const u2 = createManager();
  assert(!fs.existsSync(u.stagingDir), 'Staging not cleaned');
});

test('Stale ZIP cleanup (7 day policy)', () => {
  const u = createManager();
  const staleZip = path.join(u.updatesDir, 'update-v0.0.1.zip');
  fs.writeFileSync(staleZip, 'old-data');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleZip, eightDaysAgo, eightDaysAgo);
  const freshZip = path.join(u.updatesDir, 'update-v9.9.9.zip');
  fs.writeFileSync(freshZip, 'new-data');
  u._cleanStaleZips();
  assert(!fs.existsSync(staleZip), 'Stale zip should be deleted');
  assert(fs.existsSync(freshZip), 'Fresh zip should remain');
  fs.unlinkSync(freshZip);
});

// ─── REPORT ───────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('VALIDATION REPORT — HammamPOS UpdateManager v3.0.0');
console.log('='.repeat(60) + '\n');

results.forEach(r => {
  const icon = r.status === 'PASS' ? '✓' : '✗';
  console.log(`  ${icon} ${r.name}`);
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
