/**
 * Keeps the desktop shortcut name in step with the running version, e.g.
 * "HammamPOS.lnk" -> "HammamPOS v2.8.27.lnk", so several installations can be
 * told apart without opening them.
 *
 * Only shortcuts whose target is THIS installation's exe are touched; shortcuts
 * for other installations keep their own name. Nothing is created if no
 * shortcut exists (the user may have removed it on purpose). All failures are
 * swallowed: a shortcut problem must never stop the app from starting.
 */
const fs = require('fs');
const path = require('path');

const samePath = (a, b) =>
  path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

/**
 * @param {object} opts
 * @param {object} opts.shell        Electron shell (readShortcutLink / writeShortcutLink)
 * @param {string[]} opts.desktopDirs folders to scan (user desktop, public desktop)
 * @param {string} opts.exePath      this installation's exe
 * @param {string} opts.version      e.g. "2.8.27"
 * @param {string} [opts.iconPath]   logo file (.ico) to show on the shortcut
 * @param {function} [opts.refreshDesktop] called once when a shortcut changed, so the
 *   desktop redraws (otherwise Windows can keep showing the old name or icon)
 * @param {function} [opts.log]
 * @returns {{renamed: string[], skipped: string[]}}
 */
function syncDesktopShortcutName({ shell, desktopDirs, exePath, version, iconPath, refreshDesktop, log = () => {} }) {
  const result = { renamed: [], skipped: [] };
  const wantedName = `HammamPOS v${version}.lnk`;

  for (const dir of desktopDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }

    // Shortcuts on this desktop that open this installation.
    const ours = [];
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      const full = path.join(dir, name);
      try {
        const link = shell.readShortcutLink(full);
        // Only HammamPOS-named shortcuts are managed; a shortcut the user renamed to
        // something else keeps the name they chose.
        if (samePath(link.target, exePath) && /^hammampos/i.test(name)) ours.push({ name, full, link });
      } catch (_) { /* not a readable shortcut */ }
    }
    if (ours.length === 0) continue;

    const target = path.join(dir, wantedName);
    // Keep at most one shortcut per desktop, named with the current version.
    const keep = ours.find(o => o.name.toLowerCase() === wantedName.toLowerCase()) || ours[0];
    for (const o of ours) {
      try {
        if (o === keep) {
          if (o.full.toLowerCase() === target.toLowerCase()) {
            // Right name already; only the logo may still need setting.
            if (iconPath && !samePath(o.link.icon, iconPath)) {
              const ok = shell.writeShortcutLink(o.full, 'update', { icon: iconPath, iconIndex: 0 });
              if (!ok) throw new Error('writeShortcutLink returned false');
              result.renamed.push(`${o.name} (logo)`);
            }
            continue;
          }
          // Write the new one first, then remove the old one, so a failure never
          // leaves the desktop without a shortcut.
          const ok = shell.writeShortcutLink(target, 'create', {
            target: o.link.target,
            cwd: o.link.cwd || path.dirname(exePath),
            args: o.link.args || '',
            description: o.link.description || 'HammamPOS',
            icon: iconPath || o.link.icon || exePath,
            iconIndex: iconPath ? 0 : (o.link.iconIndex || 0)
          });
          if (!ok) throw new Error('writeShortcutLink returned false');
          fs.unlinkSync(o.full);
          result.renamed.push(`${o.name} -> ${wantedName}`);
        } else {
          // Another HammamPOS shortcut to this same installation on the same
          // desktop: merged into the single versioned one.
          fs.unlinkSync(o.full);
          result.renamed.push(`${o.name} -> (merged into ${wantedName})`);
        }
      } catch (error) {
        // Typically the all-users Public desktop without admin rights.
        result.skipped.push(`${o.full}: ${error.message}`);
      }
    }
  }
  if (result.renamed.length) {
    log('Desktop shortcut updated: ' + result.renamed.join('; '));
    if (refreshDesktop) { try { refreshDesktop(); } catch (_) { /* never stops the app */ } }
  }
  if (result.skipped.length) log('Desktop shortcut not updated: ' + result.skipped.join('; '));
  return result;
}

/**
 * Ask Windows to redraw the desktop and reload icons (SHChangeNotify "associations
 * changed", then the icon cache refresh). Runs hidden, in the background.
 */
function refreshWindowsDesktop() {
  const { spawn } = require('child_process');
  const ps = "Add-Type -Namespace H -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);';" +
    '[H.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero);' +
    "Start-Process -FilePath \"$env:SystemRoot\\System32\\ie4uinit.exe\" -ArgumentList '-show' -WindowStyle Hidden";
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true, detached: false, stdio: 'ignore' });
  p.on('error', () => {});
}

module.exports = { syncDesktopShortcutName, refreshWindowsDesktop };
