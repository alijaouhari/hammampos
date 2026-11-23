'use strict';
/** Updates started from the dashboard must not wait for a UAC "Oui" when the install folder is writable. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const Module = require('module');
const { PROJECT_ROOT } = require('./helpers');

function loadUpdateManager() {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' } };
    return orig.call(this, req, ...rest);
  };
  try {
    const UM = require(path.join(PROJECT_ROOT, 'src', 'services', 'UpdateManager.js'));
    return typeof UM === 'function' ? new UM() : (UM.UpdateManager ? new UM.UpdateManager() : UM);
  } finally { Module._load = orig; }
}

test('the updater never runs from inside the install folder (Windows blocks the rename)', () => {
  const um = loadUpdateManager();
  const vbs = um._buildVBS('C:\\Users\\DT\\AppData\\Roaming\\HammamPOS\\updates\\hammampos-updater.ps1');
  assert.match(vbs, /sh\.CurrentDirectory = "C:\\Users\\DT\\AppData\\Roaming\\HammamPOS\\updates"/);
  assert.ok(vbs.indexOf('sh.CurrentDirectory') < vbs.indexOf('sh.Run'));
  for (const s of [um._buildUpdatePS1('C:\\x.zip', 'C:\\x.lock'), um._buildRevertPS1()]) {
    assert.match(s, /Set-Location -LiteralPath \$wd; \[Environment\]::CurrentDirectory = \$wd/);
  }
});

for (const [name, build] of [
  ['update', (um) => um._buildUpdatePS1('C:\\x.zip', 'C:\\x.lock')],
  ['revert', (um) => um._buildRevertPS1()]
]) {
  test(`${name} script: checks the folder first and asks for admin only when it cannot write`, () => {
    const s = build(loadUpdateManager());
    assert.match(s, /function Test-CanWriteInstall\(\$dir\)/);
    assert.match(s, /\$canWrite = Test-CanWriteInstall \$installDir/);
    assert.match(s, /if \(-not \$isElevated -and -not \$canWrite\) \{/);
    // the RunAs request is inside that guarded block, never before the check
    assert.ok(s.indexOf('$canWrite = Test-CanWriteInstall') < s.indexOf('-Verb RunAs'));
    // Administrators only counts when really elevated
    assert.match(s, /if \(-not \$elev\) \{ \$sids = \$sids \| Where-Object \{ \$_ -ne 'S-1-5-32-544' \} \}/);
  });
}
