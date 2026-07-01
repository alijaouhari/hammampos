/**
 * HammamPOS - Critical Hypothesis Validation Test
 * 
 * HYPOTHESIS: A PowerShell process launched via VBS (WScript.Shell.Run / 
 * ShellExecuteEx) survives the death of the Node.js process that created it.
 *
 * This test:
 * 1. Spawns a CHILD Node.js process (simulating Electron)
 * 2. The child writes VBS + PS1 files and launches VBS
 * 3. The child immediately exits (simulating app.quit())
 * 4. THIS process waits and checks if the PS1 ran to completion
 *
 * If the marker file appears AFTER the child dies, the hypothesis is proven.
 *
 * Run: node tests/test-updater-survives-parent-death.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const testDir = path.join(process.env.APPDATA, 'HammamPOS', 'tests');
const markerFile = path.join(testDir, 'parent-death-proof.txt');
const childScript = path.join(testDir, 'child-launcher.js');

// Setup
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

// Write the child script that simulates Electron's behavior
const childCode = `
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const testDir = '${testDir.replace(/\\/g, '\\\\')}';
const markerFile = '${markerFile.replace(/\\/g, '\\\\')}';

// Write PS1 that waits 3 seconds then writes marker
const ps1Path = path.join(testDir, 'survivor-test.ps1');
const ps1 = \`
Start-Sleep -Seconds 3
$data = @{
    timestamp = (Get-Date -Format 'o')
    pid = $PID
    proof = 'PowerShell survived parent death'
    parentDied = 'before this file was written'
} | ConvertTo-Json
Set-Content -Path '\${markerFile.replace(/\\\\\\\\/g, '\\\\\\\\\\\\\\\\')}' -Value $data -Encoding UTF8
\`;
fs.writeFileSync(ps1Path, ps1, 'utf8');

// Write VBS launcher (same as production UpdateManager._buildVBS)
const vbsPath = path.join(testDir, 'survivor-launcher.vbs');
const vbs = [
  "'Test: parent death survival",
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + ps1Path + '""", 0, False',
  'Set sh = Nothing',
].join('\\r\\n');
fs.writeFileSync(vbsPath, vbs, 'utf8');

// Launch VBS (same as production)
execSync('cmd /c start "" /b wscript.exe "' + vbsPath + '"', {
  windowsHide: true,
  timeout: 10000
});

console.log('CHILD: VBS launched. Exiting immediately (simulating app.quit)...');
process.exit(0);
`;

fs.writeFileSync(childScript, childCode, 'utf8');

console.log('='.repeat(60));
console.log('HYPOTHESIS VALIDATION: PowerShell survives parent death');
console.log('='.repeat(60));
console.log('');
console.log('Launching child process (simulates Electron)...');

// Spawn child and wait for it to exit
const child = spawn('node', [childScript], {
  stdio: 'pipe',
  windowsHide: true
});

let childOutput = '';
child.stdout.on('data', d => { childOutput += d.toString(); });
child.stderr.on('data', d => { childOutput += d.toString(); });

child.on('close', (code) => {
  console.log(`Child exited with code ${code}`);
  if (childOutput.trim()) console.log('  Child output:', childOutput.trim());
  console.log('');
  console.log('Child is DEAD. Waiting for PowerShell to write marker...');
  console.log('(PS1 waits 3 seconds to prove it outlived the parent)');
  console.log('');

  // Wait up to 15 seconds for the marker
  const deadline = Date.now() + 15000;
  const interval = setInterval(() => {
    if (fs.existsSync(markerFile)) {
      clearInterval(interval);
      let content;
      try {
        content = fs.readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, '');
        content = JSON.parse(content);
      } catch (e) {
        content = { raw: fs.readFileSync(markerFile, 'utf8') };
      }
      console.log('✓ HYPOTHESIS CONFIRMED: PowerShell survived parent death!');
      console.log('');
      console.log('  Evidence:');
      console.log('    PS PID:', content.pid);
      console.log('    Timestamp:', content.timestamp);
      console.log('    Proof:', content.proof);
      console.log('');
      console.log('  This validates that:');
      console.log('  - WScript.Shell.Run (ShellExecuteEx) escapes Job Objects');
      console.log('  - PowerShell continues after the launcher process dies');
      console.log('  - The updater architecture is sound');
      console.log('');

      // Cleanup
      try { fs.unlinkSync(markerFile); } catch (_) {}
      try { fs.unlinkSync(childScript); } catch (_) {}
      try { fs.unlinkSync(path.join(testDir, 'survivor-test.ps1')); } catch (_) {}
      try { fs.unlinkSync(path.join(testDir, 'survivor-launcher.vbs')); } catch (_) {}
      console.log('='.repeat(60));
    } else if (Date.now() > deadline) {
      clearInterval(interval);
      console.log('✗ HYPOTHESIS REJECTED: Marker not created within 15 seconds');
      console.log('  PowerShell did NOT survive the parent process death.');
      console.log('  The VBS launcher approach may not work on this system.');
      process.exit(1);
    }
  }, 500);
});
