'use strict';
/** Desktop shortcut: versioned name and the logo file (the exe itself is not edited). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROJECT_ROOT } = require('./helpers');
const { syncDesktopShortcutName } = require(path.join(PROJECT_ROOT, 'src', 'main', 'desktopShortcut'));

const EXE = 'C:\\HammamPOS\\HammamPOS.exe';
const ICO = 'C:\\HammamPOS\\resources\\icon.ico';

function fakeDesktop(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpos-desk-'));
  const links = {};
  for (const [name, link] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), '');
    links[path.join(dir, name).toLowerCase()] = { ...link };
  }
  const calls = [];
  const shell = {
    readShortcutLink: (p) => { const l = links[p.toLowerCase()]; if (!l) throw new Error('no link'); return l; },
    writeShortcutLink: (p, op, opts) => {
      calls.push({ name: path.basename(p), op, opts });
      const key = p.toLowerCase();
      links[key] = op === 'update' ? { ...links[key], ...opts } : { ...opts };
      if (op !== 'update') fs.writeFileSync(p, '');
      return true;
    }
  };
  return { dir, shell, links, calls };
}

test('rename also sets the logo file on the shortcut', () => {
  const d = fakeDesktop({ 'HammamPOS v2.8.38.lnk': { target: EXE, icon: EXE } });
  syncDesktopShortcutName({ shell: d.shell, desktopDirs: [d.dir], exePath: EXE, version: '2.8.39', iconPath: ICO });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].name, 'HammamPOS v2.8.39.lnk');
  assert.equal(d.calls[0].opts.icon, ICO);
  assert.equal(d.calls[0].opts.iconIndex, 0);
  assert.deepEqual(fs.readdirSync(d.dir), ['HammamPOS v2.8.39.lnk']);
});

test('right name already: only the logo is updated, once', () => {
  const d = fakeDesktop({ 'HammamPOS v2.8.39.lnk': { target: EXE, icon: EXE } });
  const run = () => syncDesktopShortcutName({ shell: d.shell, desktopDirs: [d.dir], exePath: EXE, version: '2.8.39', iconPath: ICO });
  run();
  assert.deepEqual(d.calls.map(c => [c.op, c.opts.icon]), [['update', ICO]]);
  run(); // second start: nothing left to do
  assert.equal(d.calls.length, 1);
});

test('no logo file: shortcut keeps its own icon', () => {
  const d = fakeDesktop({ 'HammamPOS v2.8.38.lnk': { target: EXE, icon: 'X.ico', iconIndex: 2 } });
  syncDesktopShortcutName({ shell: d.shell, desktopDirs: [d.dir], exePath: EXE, version: '2.8.39' });
  assert.equal(d.calls[0].opts.icon, 'X.ico');
  assert.equal(d.calls[0].opts.iconIndex, 2);
});

test('build config: exe is not edited and the logo file ships', () => {
  const pkg = require(path.join(PROJECT_ROOT, 'package.json'));
  assert.equal(pkg.build.win.signAndEditExecutable, false);
  assert.ok(pkg.build.extraResources.some(r => r.from === 'assets/icon.ico' && r.to === 'icon.ico'));
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'icon.ico')));
});
