/**
 * HammamPOS — Release Pipeline Validation
 * ========================================
 * Single-command validation of the entire updater pipeline.
 * 
 * Run: node tests/validate-release-pipeline.js
 * 
 * What it validates:
 *   Stage 1: Source integrity (syntax, module loading, version consistency)
 *   Stage 2: Package validation (built artifacts, EXE, ASAR, sizes)
 *   Stage 3: ZIP artifact validation (structure, integrity, file checks)
 *   Stage 4: Updater logic (unit tests inline)
 *   Stage 5: VBS launcher mechanism (process independence)
 *   Stage 6: PS1 script generation & syntax validation
 *   Stage 7: Recovery & cleanup mechanisms
 *   Stage 8: Production state diagnostics (logs, state files, backups)
 * 
 * Output: Structured report with PASS / WARNING / FAIL per stage.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'win-unpacked');
const APPDATA_DIR = path.join(process.env.APPDATA, 'HammamPOS');
const LOGS_DIR = path.join(APPDATA_DIR, 'Logs');
const UPDATES_DIR = path.join(APPDATA_DIR, 'updates');

// Report accumulator
const report = [];
let passCount = 0, warnCount = 0, failCount = 0;

function pass(stage, msg) { report.push({ stage, status: 'PASS', msg }); passCount++; }
function warn(stage, msg) { report.push({ stage, status: 'WARN', msg }); warnCount++; }
function fail(stage, msg) { report.push({ stage, status: 'FAIL', msg }); failCount++; }

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 1: Source Integrity
// ═══════════════════════════════════════════════════════════════════════
function stage1_sourceIntegrity() {
  const S = '1-SOURCE';

  // Syntax check main files
  const files = [
    'src/services/UpdateManager.js',
    'src/main/main-working.js'
  ];
  for (const f of files) {
    try {
      execSync(`node --check "${path.join(ROOT, f)}"`, { timeout: 10000, windowsHide: true });
      pass(S, `Syntax OK: ${f}`);
    } catch (e) {
      fail(S, `Syntax ERROR: ${f} — ${e.message.substring(0, 100)}`);
    }
  }

  // Module loads
  try {
    delete require.cache[require.resolve('../src/services/UpdateManager.js')];
    const UM = require('../src/services/UpdateManager.js');
    const u = new UM();
    pass(S, `UpdateManager loads (v${u.currentVersion})`);
  } catch (e) {
    fail(S, `UpdateManager FAILED to load: ${e.message}`);
    return; // Cannot continue
  }

  // Version consistency
  const pkgVersion = getVersion();
  const UM = require('../src/services/UpdateManager.js');
  const u = new UM();
  if (u.currentVersion === pkgVersion) {
    pass(S, `Version consistent: package.json = UpdateManager = ${pkgVersion}`);
  } else {
    fail(S, `Version MISMATCH: package.json=${pkgVersion} UpdateManager=${u.currentVersion}`);
  }

  // Main entry point matches package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.main === 'src/main/main-working.js') {
    pass(S, 'Main entry point: src/main/main-working.js');
  } else {
    fail(S, `Unexpected main entry: ${pkg.main}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 2: Package Validation
// ═══════════════════════════════════════════════════════════════════════
function stage2_packageValidation() {
  const S = '2-PACKAGE';

  if (!fs.existsSync(DIST)) {
    warn(S, 'dist/win-unpacked not found — run build first. Skipping package validation.');
    return;
  }

  // Check critical files exist and are non-empty
  const checks = ['HammamPOS.exe', 'resources/app.asar'];
  for (const file of checks) {
    const fp = path.join(DIST, file);
    if (!fs.existsSync(fp)) {
      fail(S, `MISSING: ${file}`);
      continue;
    }
    const size = fs.statSync(fp).size;
    if (size === 0) {
      fail(S, `EMPTY: ${file} (0 bytes)`);
    } else {
      pass(S, `${file}: ${(size / 1024 / 1024).toFixed(1)} MB`);
    }
  }

  // Verify app.asar contains UpdateManager by inspecting the source that was packaged
  const srcUM = path.join(ROOT, 'src', 'services', 'UpdateManager.js');
  if (fs.existsSync(srcUM)) {
    const content = fs.readFileSync(srcUM, 'utf8');
    if (content.includes('_buildVBS') && content.includes('ShellExecuteEx')) {
      pass(S, 'UpdateManager source contains VBS launcher code');
    } else {
      fail(S, 'UpdateManager source MISSING VBS launcher code — stale build?');
    }
    // Verify the source modification time is BEFORE the app.asar build time
    const srcMtime = fs.statSync(srcUM).mtimeMs;
    const asarMtime = fs.statSync(path.join(DIST, 'resources', 'app.asar')).mtimeMs;
    if (asarMtime >= srcMtime) {
      pass(S, 'app.asar is newer than UpdateManager source (build is current)');
    } else {
      fail(S, 'app.asar is OLDER than UpdateManager source — REBUILD REQUIRED');
    }
  }

  // Check electron-builder config matches expectations
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.build && pkg.build.win && pkg.build.win.requestedExecutionLevel === 'requireAdministrator') {
    pass(S, 'Build config: requireAdministrator = true');
  } else {
    warn(S, 'Build config: requestedExecutionLevel is not requireAdministrator');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 3: ZIP Artifact Validation
// ═══════════════════════════════════════════════════════════════════════
function stage3_zipValidation() {
  const S = '3-ZIP';
  const version = getVersion();
  const zipPath = path.join(ROOT, 'dist', `HammamPOS-v${version}.zip`);

  if (!fs.existsSync(zipPath)) {
    warn(S, `Release ZIP not found: dist/HammamPOS-v${version}.zip — run build-release-zip.bat`);
    return;
  }

  const zipSize = fs.statSync(zipPath).size;
  if (zipSize === 0) {
    fail(S, 'ZIP is empty (0 bytes)');
    return;
  }
  pass(S, `ZIP size: ${(zipSize / 1024 / 1024).toFixed(1)} MB`);

  // SHA-256 hash
  try {
    const crypto = require('crypto');
    const zipHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    pass(S, `ZIP SHA-256: ${zipHash.substring(0, 16)}...`);
  } catch (e) {
    warn(S, `Cannot compute ZIP hash: ${e.message}`);
  }

  // Validate ZIP integrity and contents via PowerShell
  try {
    const result = execSync(
      `powershell -NoProfile -Command "` +
      `Add-Type -A 'System.IO.Compression.FileSystem'; ` +
      `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); ` +
      `$names = $z.Entries | ForEach-Object { $_.FullName }; ` +
      `$z.Dispose(); ` +
      `$names -join '|'"`,
      { timeout: 30000, windowsHide: true }
    ).toString().trim();

    const entries = result.split('|');
    const required = ['HammamPOS.exe', 'resources/app.asar'];
    for (const req of required) {
      if (entries.some(e => e.replace(/\\/g, '/').includes(req))) {
        pass(S, `ZIP contains: ${req}`);
      } else {
        fail(S, `ZIP MISSING: ${req}`);
      }
    }
    pass(S, `ZIP entry count: ${entries.length}`);
  } catch (e) {
    fail(S, `ZIP integrity check FAILED: ${e.message.substring(0, 100)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 4: Updater Logic (Core Unit Tests)
// ═══════════════════════════════════════════════════════════════════════
function stage4_updaterLogic() {
  const S = '4-LOGIC';

  delete require.cache[require.resolve('../src/services/UpdateManager.js')];
  const UM = require('../src/services/UpdateManager.js');

  // Version comparison
  const u = new UM();
  const vTests = [
    ['2.5.2', '2.5.1', true],
    ['2.5.1', '2.5.1', false],
    ['2.5.0', '2.5.1', false],
    ['3.0.0', '2.9.9', true],
  ];
  let vPass = true;
  for (const [r, l, expected] of vTests) {
    if (u._isNewer(r, l) !== expected) { vPass = false; break; }
  }
  if (vPass) pass(S, 'Version comparison logic correct');
  else fail(S, 'Version comparison logic BROKEN');

  // VBS generation
  const vbs = u._buildVBS('C:\\test\\script.ps1');
  if (vbs.includes('WScript.Shell') && vbs.includes('-ExecutionPolicy Bypass') && vbs.includes(', 0, False')) {
    pass(S, 'VBS launcher generation correct');
  } else {
    fail(S, 'VBS launcher generation BROKEN');
  }

  // PS1 generation
  const lockPath = path.join(u.updatesDir, 'update.lock');
  const ps1 = u._buildUpdatePS1('C:\\test\\update.zip', lockPath);
  const requiredPS1Sections = [
    '$ErrorActionPreference', '$installDir', '$lockPath',
    'Step 1:', 'Step 2:', 'Step 3:', 'Step 4:', 'Step 5:',
    'Step 6:', 'Step 7:', 'Step 8:', 'Step 9:',
    'Abort', 'ROLLBACK', 'Write-Log', 'Write-State'
  ];
  let ps1Pass = true;
  for (const section of requiredPS1Sections) {
    if (!ps1.includes(section)) { ps1Pass = false; break; }
  }
  if (ps1Pass) pass(S, 'PS1 update script contains all required sections');
  else fail(S, 'PS1 update script MISSING required sections');

  // Lock file prevention
  const u2 = new UM();
  u2.latestRelease = { version: '9.9.9' };
  const testLock = path.join(u2.updatesDir, 'update.lock');
  const testZip = path.join(u2.updatesDir, 'update-v9.9.9.zip');
  fs.writeFileSync(testLock, 'test', 'utf8');
  fs.writeFileSync(testZip, 'x'.repeat(100), 'utf8');
  let lockWorks = false;
  try { u2.applyAndRestart(); } catch (e) { lockWorks = e.message.includes('قيد التنفيذ'); }
  if (lockWorks) pass(S, 'Concurrent update lock works');
  else fail(S, 'Concurrent update lock BROKEN');
  try { fs.unlinkSync(testLock); } catch (_) {}
  try { fs.unlinkSync(testZip); } catch (_) {}

  // Handshake flag
  u.signalStartupSuccess();
  if (fs.existsSync(u.flagPath)) {
    const flag = JSON.parse(fs.readFileSync(u.flagPath, 'utf8'));
    if (flag.version === u.currentVersion && flag.pid === process.pid) {
      pass(S, 'Handshake flag mechanism correct');
    } else {
      fail(S, 'Handshake flag data incorrect');
    }
    fs.unlinkSync(u.flagPath);
  } else {
    fail(S, 'Handshake flag not created');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 5: VBS Launcher Mechanism
// ═══════════════════════════════════════════════════════════════════════
function stage5_vbsLauncher() {
  const S = '5-LAUNCHER';
  const testDir = path.join(APPDATA_DIR, 'tests');
  const marker = path.join(testDir, 'pipeline-vbs-proof.txt');

  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(marker)) fs.unlinkSync(marker);

  // Write a PS1 that creates a marker (runs in <1 second)
  const ps1 = path.join(testDir, 'pipeline-test.ps1');
  fs.writeFileSync(ps1, `Set-Content -Path '${marker}' -Value 'proven' -Encoding UTF8`, 'utf8');

  // Write VBS (same as production)
  const vbs = path.join(testDir, 'pipeline-launcher.vbs');
  const UM = require('../src/services/UpdateManager.js');
  const u = new UM();
  fs.writeFileSync(vbs, u._buildVBS(ps1), 'utf8');

  // Launch
  try {
    execSync(`cmd /c start "" /b wscript.exe "${vbs}"`, { windowsHide: true, timeout: 10000 });
  } catch (e) {
    fail(S, `VBS launch command failed: ${e.message.substring(0, 80)}`);
    return;
  }

  // Wait up to 5 seconds
  const deadline = Date.now() + 5000;
  let found = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) { found = true; break; }
    execSync('powershell -Command "Start-Sleep -Milliseconds 200"', { windowsHide: true });
  }

  if (found) {
    pass(S, 'VBS → PS1 launch works (ShellExecuteEx confirmed)');
  } else {
    fail(S, 'VBS launch FAILED — marker not created within 5 seconds');
  }

  // Cleanup
  try { fs.unlinkSync(marker); } catch (_) {}
  try { fs.unlinkSync(ps1); } catch (_) {}
  try { fs.unlinkSync(vbs); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 6: PS1 Script Syntax Validation
// ═══════════════════════════════════════════════════════════════════════
function stage6_ps1Syntax() {
  const S = '6-PS1';

  delete require.cache[require.resolve('../src/services/UpdateManager.js')];
  const UM = require('../src/services/UpdateManager.js');
  const u = new UM();
  u.latestRelease = { version: '9.9.9' };
  const lockPath = path.join(u.updatesDir, 'update.lock');

  // Generate scripts
  const updatePS1 = u._buildUpdatePS1('C:\\fake\\update.zip', lockPath);
  const revertPS1 = u._buildRevertPS1();

  const scripts = [
    { name: 'Update PS1', content: updatePS1 },
    { name: 'Revert PS1', content: revertPS1 },
  ];

  for (const s of scripts) {
    const tmpPS1 = path.join(UPDATES_DIR, `syntax-check-${Date.now()}.ps1`);
    // Write a checker script that parses the target and reports errors
    const checkerPath = path.join(UPDATES_DIR, `checker-${Date.now()}.ps1`);
    fs.writeFileSync(tmpPS1, s.content, 'utf8');
    const checkerCode = `$errors = $null\n[void][System.Management.Automation.Language.Parser]::ParseFile('${tmpPS1}', [ref]$null, [ref]$errors)\nif ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_.Message }; exit 1 } else { Write-Host 'VALID'; exit 0 }`;
    fs.writeFileSync(checkerPath, checkerCode, 'utf8');
    try {
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${checkerPath}"`,
        { timeout: 15000, windowsHide: true }
      ).toString().trim();
      if (result.includes('VALID')) {
        pass(S, `${s.name}: syntax valid`);
      } else {
        fail(S, `${s.name}: unexpected output — ${result.substring(0, 100)}`);
      }
    } catch (e) {
      const output = ((e.stdout || '') + (e.stderr || '')).toString().trim();
      fail(S, `${s.name}: SYNTAX ERROR — ${output.substring(0, 150)}`);
    }
    try { fs.unlinkSync(tmpPS1); } catch (_) {}
    try { fs.unlinkSync(checkerPath); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 7: Recovery & Cleanup Mechanisms
// ═══════════════════════════════════════════════════════════════════════
function stage7_recovery() {
  const S = '7-RECOVERY';

  delete require.cache[require.resolve('../src/services/UpdateManager.js')];
  const UM = require('../src/services/UpdateManager.js');

  // Test staging cleanup on startup
  const u1 = new UM();
  fs.mkdirSync(u1.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(u1.stagingDir, 'test.txt'), 'data');
  const u2 = new UM();
  if (!fs.existsSync(u1.stagingDir)) {
    pass(S, 'Staging dir cleaned on startup');
  } else {
    fail(S, 'Staging dir NOT cleaned on startup');
    fs.rmSync(u1.stagingDir, { recursive: true, force: true });
  }

  // Test stale ZIP cleanup
  const staleZip = path.join(u2.updatesDir, 'update-v0.0.0-stale.zip');
  fs.writeFileSync(staleZip, 'old');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleZip, eightDaysAgo, eightDaysAgo);
  u2._cleanStaleZips();
  if (!fs.existsSync(staleZip)) {
    pass(S, 'Stale ZIPs cleaned (7-day policy)');
  } else {
    fail(S, 'Stale ZIP NOT cleaned');
    try { fs.unlinkSync(staleZip); } catch (_) {}
  }

  // Test VBS/PS1 cleanup on startup
  const staleVbs = path.join(u2.updatesDir, 'launch-updater.vbs');
  const stalePs1 = path.join(u2.updatesDir, 'hammampos-updater.ps1');
  fs.writeFileSync(staleVbs, 'stale');
  fs.writeFileSync(stalePs1, 'stale');
  const u3 = new UM();
  if (!fs.existsSync(staleVbs) && !fs.existsSync(stalePs1)) {
    pass(S, 'Stale launcher files cleaned on startup');
  } else {
    fail(S, 'Stale launcher files NOT cleaned');
    try { fs.unlinkSync(staleVbs); } catch (_) {}
    try { fs.unlinkSync(stalePs1); } catch (_) {}
  }

  // Test log rotation
  const logFile = path.join(u3.logsDir, 'Updater.log');
  const bigLog = 'x'.repeat(1.2 * 1024 * 1024);
  fs.writeFileSync(logFile, bigLog);
  u3._rotateLog();
  const newSize = fs.statSync(logFile).size;
  if (newSize < 600 * 1024 && newSize > 400 * 1024) {
    pass(S, `Log rotation works (${(newSize/1024).toFixed(0)} KB after 1.2MB input)`);
  } else {
    fail(S, `Log rotation BROKEN: ${newSize} bytes after rotation`);
  }

  // Test startup recovery flag NOT written
  try { fs.unlinkSync(u3.flagPath); } catch (_) {}
  const u4 = new UM();
  if (!fs.existsSync(u4.flagPath)) {
    pass(S, 'Startup recovery does NOT write success flag (correct)');
  } else {
    fail(S, 'Startup recovery incorrectly writes success flag');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 8: Production State Diagnostics
// ═══════════════════════════════════════════════════════════════════════
function stage8_productionState() {
  const S = '8-PRODUCTION';

  // Check data directory exists
  if (fs.existsSync(APPDATA_DIR)) {
    pass(S, `AppData dir exists: ${APPDATA_DIR}`);
  } else {
    warn(S, `AppData dir not found (first run?): ${APPDATA_DIR}`);
  }

  // Check install dir
  const installDir = 'C:\\HammamPOS';
  if (fs.existsSync(installDir)) {
    pass(S, `Install dir exists: ${installDir}`);
    const exe = path.join(installDir, 'HammamPOS.exe');
    if (fs.existsSync(exe)) {
      const size = fs.statSync(exe).size;
      pass(S, `Production EXE: ${(size / 1024 / 1024).toFixed(1)} MB`);
    } else {
      warn(S, 'Production EXE not found (dev mode?)');
    }
  } else {
    warn(S, `Install dir not found: ${installDir} (dev environment)`);
  }

  // Check database preservation
  const dbPath = path.join(APPDATA_DIR, 'hammampos.db');
  if (fs.existsSync(dbPath)) {
    const dbSize = fs.statSync(dbPath).size;
    pass(S, `Database exists: ${(dbSize / 1024).toFixed(0)} KB`);
  } else {
    warn(S, 'Database not found (first install or dev mode)');
  }

  // Check logs
  const logFile = path.join(LOGS_DIR, 'Updater.log');
  if (fs.existsSync(logFile)) {
    const logSize = fs.statSync(logFile).size;
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    pass(S, `Updater log: ${lines.length} lines, ${(logSize / 1024).toFixed(0)} KB`);

    // Check for recent errors
    const errors = lines.filter(l => l.includes('[ERROR]') || l.includes('FATAL'));
    if (errors.length > 0) {
      const recent = errors.slice(-3);
      warn(S, `Log contains ${errors.length} error(s). Latest: ${recent[recent.length - 1].substring(0, 100)}`);
    }

    // Check for recent successful updates
    const successes = lines.filter(l => l.includes('HANDSHAKE RECEIVED'));
    if (successes.length > 0) {
      pass(S, `${successes.length} successful update(s) in history`);
    }
  } else {
    warn(S, 'No updater log found (no updates attempted yet)');
  }

  // Check for stale state
  const statePath = path.join(APPDATA_DIR, 'update-state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    warn(S, `Stale state file exists: stage=${state.stage} (should have been cleaned)`);
  } else {
    pass(S, 'No stale state file (clean)');
  }

  // Check for backup availability
  const oldDir = installDir + '-old';
  if (fs.existsSync(oldDir)) {
    pass(S, `Backup available at ${oldDir} (revert possible)`);
  } else {
    pass(S, 'No backup dir (no previous update to revert to)');
  }

  // Check for lock file
  const lockPath = path.join(UPDATES_DIR, 'update.lock');
  if (fs.existsSync(lockPath)) {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age > 10 * 60 * 1000) {
      warn(S, `Stale lock file exists (${(age / 60000).toFixed(0)} min old)`);
    } else {
      warn(S, `Active lock file exists — update may be in progress`);
    }
  } else {
    pass(S, 'No lock file (no active update)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════
function generateReport() {
  const version = getVersion();
  const timestamp = new Date().toISOString();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       HAMMAMPOS RELEASE PIPELINE VALIDATION REPORT          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Version:   ${version}`);
  console.log(`  Timestamp: ${timestamp}`);
  console.log(`  Machine:   ${process.env.COMPUTERNAME || 'unknown'}`);
  console.log('');
  console.log('─'.repeat(64));

  // Group by stage
  const stages = {};
  for (const r of report) {
    if (!stages[r.stage]) stages[r.stage] = [];
    stages[r.stage].push(r);
  }

  for (const [stage, items] of Object.entries(stages)) {
    console.log('');
    console.log(`  ┌─ ${stage} ${'─'.repeat(56 - stage.length)}`);
    for (const item of items) {
      const icon = item.status === 'PASS' ? '✓' : item.status === 'WARN' ? '⚠' : '✗';
      const tag = item.status === 'PASS' ? 'PASS' : item.status === 'WARN' ? 'WARN' : 'FAIL';
      console.log(`  │ ${icon} [${tag}] ${item.msg}`);
    }
    console.log('  └' + '─'.repeat(62));
  }

  console.log('');
  console.log('═'.repeat(64));
  console.log(`  RESULTS:  PASS=${passCount}  WARN=${warnCount}  FAIL=${failCount}  TOTAL=${report.length}`);
  console.log('═'.repeat(64));

  if (failCount === 0 && warnCount === 0) {
    console.log('');
    console.log('  ✓ ALL CHECKS PASSED — Release pipeline is healthy.');
  } else if (failCount === 0) {
    console.log('');
    console.log('  ⚠ PASSED with warnings. Review warnings above.');
  } else {
    console.log('');
    console.log('  ✗ FAILURES DETECTED. Do NOT release until failures are resolved.');
  }
  console.log('');

  // Write report to file
  const reportPath = path.join(ROOT, 'tests', 'pipeline-report.txt');
  const lines = [`HammamPOS Pipeline Report — ${timestamp}\nVersion: ${version}\n`];
  for (const r of report) {
    lines.push(`[${r.status}] ${r.stage}: ${r.msg}`);
  }
  lines.push(`\nRESULTS: PASS=${passCount} WARN=${warnCount} FAIL=${failCount}`);
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`  Report saved: tests/pipeline-report.txt`);
  console.log('');

  if (failCount > 0) process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════════════
try {
  stage1_sourceIntegrity();
  stage2_packageValidation();
  stage3_zipValidation();
  stage4_updaterLogic();
  stage5_vbsLauncher();
  stage6_ps1Syntax();
  stage7_recovery();
  stage8_productionState();
} catch (e) {
  fail('RUNTIME', `Unexpected error: ${e.message}`);
  console.error(e);
}

generateReport();
