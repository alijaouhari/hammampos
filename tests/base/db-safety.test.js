'use strict';
/**
 * Database safety (v2.8.29): two copies of the app writing the same file must never
 * silently erase sales; daily snapshots; per-day history diagnostics.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const StorageManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'StorageManager'));
const BackupManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'BackupManager'));
after(() => cleanupAll());

const ticketCount = (file) => {
  const SQL = require(path.join(PROJECT_ROOT, 'node_modules', 'sql.js'));
  return SQL().then(S => { const d = new S.Database(fs.readFileSync(file)); const n = d.exec('SELECT COUNT(*) FROM tickets')[0].values[0][0]; d.close(); return n; });
};

test('the lost-days scenario: a stale second copy saving keeps the newer file aside', async () => {
  const a = await newStorage();                 // copy A: left open since "Nov 1"
  const b = new StorageManager(a.dbPath);       // copy B: opened later, used for 11 days
  await b.initialize();
  try {
    const c = b.addCategory('x', 35);
    for (let i = 0; i < 5; i++) b.createTicket(c);   // sales recorded in copy B
    assert.equal(await ticketCount(a.dbPath), 5);
    // copy A wakes up (e.g. 23:59 day close) and saves its old in-memory data
    await new Promise(r => setTimeout(r, 20));
    a.save();
    assert.ok(a.lastConflict, 'conflict detected');
    assert.ok(fs.existsSync(a.lastConflict.keptAs), 'newer file kept');
    assert.equal(await ticketCount(a.lastConflict.keptAs), 5, 'the 5 sales are recoverable');
    const copies = a.listSafetyCopies();
    assert.equal(copies.overwritten.length, 1);
  } finally { cleanup(a); cleanup(b); }
});

test('normal saves by one copy never raise a conflict', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('x', 35);
    for (let i = 0; i < 5; i++) s.createTicket(c);
    s.save(); s.save();
    assert.equal(s.lastConflict, undefined);
    assert.equal(s.listSafetyCopies().overwritten.length, 0);
    assert.ok(!fs.existsSync(s.dbPath + '.tmp'), 'no temp file left behind');
  } finally { cleanup(s); }
});

test('one snapshot per day is kept in snapshots/', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('x', 35);
    s.createTicket(c);
    s.createTicket(c);
    const snaps = s.listSafetyCopies().snapshots;
    assert.equal(snaps.length, 1);
    assert.match(snaps[0], /^\d{4}-\d{2}-\d{2}\.db$/);
    // old snapshots beyond 30 are removed
    const dir = path.join(path.dirname(s.dbPath), 'snapshots');
    for (let i = 0; i < 35; i++) {
      const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      fs.writeFileSync(path.join(dir, d + '.db'), 'x');
    }
    s._snapshotDay = null;
    s.save();
    assert.ok(s.listSafetyCopies().snapshots.length <= 30);
  } finally { cleanup(s); }
});

test('history diagnostics: per-day counts from the DB and from the backup CSV', async () => {
  const s = await newStorage();
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hp_bk_'));
  try {
    const c = s.addCategory('x', 35);
    const today = new Date().toISOString().slice(0, 10);
    s.createTicket(c);
    s.createTicket(c);
    const h = s.getHistoryDiagnostics(75);
    assert.equal(h.ticketsPerDay[today], 2);
    assert.ok(Object.keys(h.auditPerDay).length >= 1);
    // CSV holds a day that the DB lost
    const lost = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, 'tickets.csv'), '\uFEFFserial,category,price,date,time\n' +
      `1,x,35,${lost},10:00:00\n2,x,35,${lost},11:00:00\n3,x,35,${today},12:00:00\n`);
    const bk = new BackupManager(dir);
    const cov = bk.getTicketCsvCoverage(h.since);
    assert.equal(cov.exists, true);
    assert.equal(cov.perDay[lost], 2);
    assert.equal(h.ticketsPerDay[lost], undefined); // missing from the DB
  } finally { cleanup(s); fs.rmSync(dir, { recursive: true, force: true }); }
});
