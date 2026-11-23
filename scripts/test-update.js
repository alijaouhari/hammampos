/**
 * Release gate: installs the freshly built zip with the REAL updater, the way it runs
 * on the hammam PCs, in a throw-away folder:
 *   - "installed" app = a copy of dist/win-unpacked in <temp>\HammamPOS
 *   - the updater is started from inside that folder (like the app opened from the
 *     desktop shortcut), without Administrator rights
 *   - the new version must start and answer the handshake; the folders must swap
 * Nothing on this PC's real HammamPOS data is touched (own APPDATA, own install folder).
 *
 *   node scripts/test-update.js dist\HammamPOS-v2.8.44.zip
 * Exit code 0 = the update installed and started; 1 = it failed (do not release).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const zip = path.resolve(process.argv[2] || '');
const version = (/v(\d+\.\d+\.\d+)\.zip$/i.exec(zip) || [])[1];
if (!version || !fs.existsSync(zip)) { console.error('usage: node scripts/test-update.js dist\\HammamPOS-vX.Y.Z.zip'); process.exit(1); }
const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
if (!fs.existsSync(path.join(unpacked, 'HammamPOS.exe'))) { console.error('dist/win-unpacked is missing (build first)'); process.exit(1); }

const T = path.join(os.tmpdir(), 'hpos-update-test-' + Date.now());
const inst = path.join(T, 'HammamPOS');
const appdata = path.join(T, 'appdata');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const killTestApps = () => {
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${T}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"`, { stdio: 'ignore' });
  } catch (_) {}
};

(async () => {
  let ok = false;
  try {
    console.log('test folder:', T);
    fs.mkdirSync(appdata, { recursive: true });
    // 1) the "installed" version
    fs.cpSync(unpacked, inst, { recursive: true });
    // 2) a hammam that is already set up (so the app opens its main screen, not the wizard)
    process.env.APPDATA = appdata;
    const StorageManager = require(path.join(ROOT, 'src/services/StorageManager'));
    const s = new StorageManager(path.join(appdata, 'HammamPOS', 'hammampos.db'));
    await s.initialize();
    s.setSetting('hammam_name', 'اختبار التحديث');
    s.save(); s.close();
    // 3) the updater, prepared exactly as the app does, from inside the install folder
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      if (req === 'electron') return { app: { getPath: () => appdata, isPackaged: true, getVersion: () => '0.0.0' } };
      return orig.call(this, req, ...rest);
    };
    const UM = require(path.join(ROOT, 'src/services/UpdateManager.js'));
    Module._load = orig;
    const um = typeof UM === 'function' ? new UM() : (UM.UpdateManager ? new UM.UpdateManager() : UM);
    um.installDir = inst; um.stagingDir = inst + '-update'; um.oldDir = inst + '-old'; um.oldPreviousDir = inst + '-old-previous';
    um.latestRelease = { version };
    fs.copyFileSync(zip, path.join(um.updatesDir, `update-v${version}.zip`));
    const cwd = process.cwd();
    process.chdir(inst);            // like the app started from the desktop shortcut
    try { um.applyAndRestart(); } finally { process.chdir(cwd); }
    // 4) wait for the handshake (or a failure) in the updater's log
    const log = path.join(um.logsDir, 'Updater.log');
    const t0 = Date.now();
    let text = '';
    while (Date.now() - t0 < 4 * 60 * 1000) {
      await sleep(2000);
      try { text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; } catch (_) { continue; } // the updater is writing it
      if (/HANDSHAKE RECEIVED|FATAL|ROLLBACK/.test(text)) break;
    }
    const lines = text.split(/\r?\n/).filter(l => /Step 0|SWAP COMPLETE|HANDSHAKE|FATAL|ROLLBACK|Giving up/.test(l));
    lines.forEach(l => console.log('  ' + l.trim()));
    const noUac = /no UAC prompt/.test(text);
    const swapped = fs.existsSync(path.join(inst, 'HammamPOS.exe')) && fs.existsSync(inst + '-old');
    ok = /HANDSHAKE RECEIVED/.test(text) && !/FATAL/.test(text) && noUac && swapped;
    if (!noUac) console.log('  ✗ the updater asked for Administrator');
    if (!swapped) console.log('  ✗ the folders were not swapped');
  } catch (error) {
    console.error('update test error:', error.message);
  } finally {
    killTestApps();
    await sleep(2000);
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }); } catch (_) { console.log('  (could not remove ' + T + ')'); }
  }
  console.log(ok ? 'UPDATE TEST PASSED: v' + version + ' installed and started' : 'UPDATE TEST FAILED');
  process.exit(ok ? 0 : 1);
})();
