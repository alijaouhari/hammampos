'use strict';
/**
 * Excel copy: rebuilt from the database (nothing lost on restart), no secrets,
 * startup build skipped when the file is already up to date.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const ExcelManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'ExcelManager'));
after(() => cleanupAll());

function sell(s, cat, price, date, time) {
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES ((SELECT COALESCE(MAX(serial_number),0)+1 FROM tickets), 2026, ?, 'x', ?, ?, ?, ?)`,
  [cat, price, date, time, date + ' ' + time]);
}

test('a new manager keeps the old rows: everything comes from the database', async () => {
  const s = await newStorage();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp_xl2_'));
  try {
    const cat = s.addCategory('x', 20);
    sell(s, cat, 20, '2026-11-01', '09:00:00');
    sell(s, cat, 20, '2026-11-02', '09:00:00');
    s.setSetting('device_password', 'secret-should-not-leak');
    const file = path.join(dir, 'x.xlsx');
    const a = new ExcelManager(file);
    await a.initialize();
    await a.rebuildFromDatabase(s);
    // "restart": a new manager must not empty the file
    const b = new ExcelManager(file);
    await b.initialize();
    assert.ok(fs.statSync(file).size > 0);
    sell(s, cat, 20, '2026-11-03', '09:00:00');
    await b.rebuildFromDatabase(s);
    assert.equal(b.workbook.getWorksheet('التذاكر').rowCount, 4); // header + 3
    const summary = b.workbook.getWorksheet('الملخص اليومي');
    assert.equal(summary.rowCount, 4);
    assert.equal(summary.getRow(2).getCell(1).value, '2026-11-03'); // newest day first
    assert.equal(b.workbook.getWorksheet('الإعدادات'), undefined);
    const names = b.workbook.worksheets.map(w => w.name).join(',');
    assert.ok(!names.includes('الإعدادات'));
    assert.ok(!fs.existsSync(file + '.tmp'));
    // the secret is nowhere in the file
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    let leaked = false;
    wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => { if (String(c.value).includes('secret-should-not-leak')) leaked = true; })));
    assert.equal(leaked, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); cleanup(s); }
});

test('startup: no build when the file is newer than the database, a build when older', async () => {
  const s = await newStorage();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp_xl3_'));
  try {
    const db = path.join(dir, 'db.db');
    const file = path.join(dir, 'x.xlsx');
    fs.writeFileSync(db, 'x');
    fs.writeFileSync(file, 'x');
    const now = Date.now() / 1000;
    fs.utimesSync(db, now - 100, now - 100);
    fs.utimesSync(file, now, now);
    const fresh = new ExcelManager(file);
    await fresh.initialize(s, null, { dbPath: db });
    assert.equal(fresh.getStatus().pending, false);
    fs.utimesSync(db, now + 100, now + 100);
    const stale = new ExcelManager(file);
    await stale.initialize(s, null, { dbPath: db });
    assert.equal(stale.getStatus().pending, true);
    clearTimeout(stale.timer);
    // a change asks for a build
    const m = new ExcelManager(file);
    await m.initialize(s, null, { dbPath: path.join(dir, 'none.db') });
    clearTimeout(m.timer); m.timer = null;
    await m.addTicket({});
    assert.equal(m.getStatus().pending, true);
    clearTimeout(m.timer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); cleanup(s); }
});
