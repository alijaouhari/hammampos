'use strict';
/**
 * Cloud backup, change alerts, duplicate warning, box count, PC health,
 * regular expenses (wages), and the new phone messages.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
const CloudBackup = require(path.join(PROJECT_ROOT, 'src', 'services', 'CloudBackup'));
const HealthMonitor = require(path.join(PROJECT_ROOT, 'src', 'main', 'healthMonitor'));
const ExpenseTemplateManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'ExpenseTemplateManager'));
const { describeChange, installChangeAlerts } = require(path.join(PROJECT_ROOT, 'src', 'main', 'changeAlerts'));
const { buildMessage } = require(path.join(PROJECT_ROOT, 'dashboard-deploy', 'api', '_message'));
after(() => cleanupAll());

async function money(startIso = '2026-11-20T08:00:00Z') {
  const s = await newStorage();
  let t = new Date(startIso);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  return { s, m, at: (iso) => { t = new Date(iso); } };
}
const sell = (s, price, st) => s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
  VALUES (?, 2026, 1, 'ر', ?, ?, ?, ?)`, [Math.floor(Math.random() * 1e6), price, st.slice(0, 10), st.slice(11), st]);

// ── Duplicate warning ──
test('same description and amount within 24 hours asks first; allowDuplicate adds it', async () => {
  const { s, m, at } = await money();
  try {
    sell(s, 2000, '2026-11-20 08:00:00');
    assert.equal(m.recordExpense({ description: 'أجر الفرناتشي', total: 600, fromDrawer: 600 }).success, true);
    at('2026-11-21T06:45:00Z');
    const again = m.recordExpense({ description: ' أجر الفرناتشي ', total: 600, fromDrawer: 600 });
    assert.equal(again.success, false);
    assert.equal(again.duplicate.total, 600);
    assert.equal(again.duplicate.at, '2026-11-20 08:00:00');
    assert.equal(m.recordExpense({ description: 'أجر الفرناتشي', total: 600, fromDrawer: 600, allowDuplicate: true }).success, true);
    // other amount, or more than 24 hours later: no question
    assert.equal(m.recordExpense({ description: 'أجر الفرناتشي', total: 650, fromDrawer: 650 }).success, true);
    at('2026-11-22T07:00:00Z');
    assert.equal(m.recordExpense({ description: 'مصباح', total: 50, fromDrawer: 50 }).success, true);
    at('2026-11-23T07:01:00Z');
    assert.equal(m.recordExpense({ description: 'مصباح', total: 50, fromDrawer: 50 }).success, true);
  } finally { cleanup(s); }
});

// ── Box count ──
test('box count records the difference, moves no money, and notifies', async () => {
  const { s, m } = await money();
  try {
    sell(s, 1500, '2026-11-20 08:00:00');
    assert.equal(m.hasCashCountToday(), false);
    const before = m.getBalances();
    const r = m.recordCashCount({ counted: 1450, note: 'نقص 50' });
    assert.equal(r.success, true);
    assert.deepEqual([r.count.expected, r.count.counted, r.count.difference], [1500, 1450, -50]);
    assert.deepEqual(m.getBalances(), before); // only a record
    assert.equal(m.hasCashCountToday(), true);
    assert.equal(m.getCashCounts()[0].difference, -50);
    const n = s.db.exec("SELECT type, payload FROM notifications WHERE type = 'count'")[0].values[0];
    assert.equal(JSON.parse(n[1]).difference, -50);
    assert.equal(m.recordCashCount({ counted: -1 }).success, false);
  } finally { cleanup(s); }
});

// ── Change alerts ──
test('watched audit lines become change alerts; remote actions and unwatched lines do not', async () => {
  assert.equal(describeChange('DELETE', 'tickets', 5, 'رجال - 41/2026 - 15dh').kind, 'ticket_deleted');
  const del = describeChange('DELETE', 'money_expenses', 5, JSON.stringify({ by: 'manager', before: { description: 'أجر', total: 600, date: '2026-11-23' } }));
  assert.deepEqual([del.kind, del.text, del.by], ['expense_deleted', 'أجر - 600dh - 2026-11-23', 'manager']);
  assert.equal(describeChange('DELETE', 'expenses', 5, 'x', { switchedOver: true }), null); // the money system's line is the one sent
  assert.equal(describeChange('DELETE', 'expenses', 5, 'x', { switchedOver: false }).kind, 'expense_deleted');
  assert.equal(describeChange('CREATE', 'tickets', 1, 'x'), null);
  const s = await newStorage();
  try {
    const sent = [];
    let remote = false;
    installChangeAlerts({ storage: s, notify: (p) => sent.push(p), isRemote: () => remote });
    installChangeAlerts({ storage: s, notify: (p) => sent.push(p) }); // installed once only
    s.logAudit('DELETE', 'tickets', 7, 'نساء - 3/2026 - 18dh');
    s.logAudit('CREATE', 'tickets', 8, 'x');
    remote = true; s.logAudit('DELETE', 'tickets', 9, 'from the dashboard'); remote = false;
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].entityId, 7);
    assert.equal(s.db.exec("SELECT COUNT(*) FROM audit_log WHERE entity = 'tickets'")[0].values[0][0], 3); // the audit itself is unchanged
  } finally { cleanup(s); }
});

// ── Cloud backup ──
test('cloud backup: uploads a gzip copy once a day, keeps 30 days + the 1st of each month', async () => {
  const s = await newStorage();
  try {
    s.setSetting('hammam_name', 'X'); s.save();
    let now = new Date('2026-11-24T10:00:00Z');
    const uploads = [], removed = [];
    const files = ['2026-09-01.db.gz', '2026-09-15.db.gz', '2026-10-24.db.gz', '2026-10-25.db.gz', '2026-11-20.db.gz', 'other.txt'];
    const client = { storage: { from: (b) => ({
      upload: async (name, data, o) => { uploads.push({ b, name, data, o }); return { error: null }; },
      list: async () => ({ data: files.map(name => ({ name })), error: null }),
      remove: async (names) => { removed.push(...names); return { error: null }; }
    }) } };
    const cb = new CloudBackup({ storage: s, client: () => client, locationId: () => 'LOC', now: () => now });
    assert.equal(cb.isDue(), false); // not right at start-up
    now = new Date('2026-11-24T10:04:00Z');
    assert.equal(cb.isDue(), true);
    const snapshot = fs.readFileSync(s.dbPath);
    const r = await cb.maybeRun();
    assert.equal(r.ok, true);
    assert.equal(uploads[0].b, 'backups');
    assert.equal(uploads[0].name, 'LOC/2026-11-24.db.gz');
    assert.equal(uploads[0].o.upsert, true);
    assert.deepEqual(zlib.gunzipSync(uploads[0].data), snapshot); // the whole database
    assert.deepEqual(removed.sort(), ['LOC/2026-09-15.db.gz', 'LOC/2026-10-24.db.gz']);
    assert.equal(cb.isDue(), false); // done for today
    assert.equal(cb.status().day, '2026-11-24');
    assert.equal(await cb.maybeRun(), null);
  } finally { cleanup(s); }
});

test('cloud backup failure is remembered (for the dashboard and the health alert)', async () => {
  const s = await newStorage();
  try {
    const now = new Date('2026-11-24T10:00:00Z');
    const client = { storage: { from: () => ({ upload: async () => ({ error: { message: 'Bucket not found' } }) }) } };
    const cb = new CloudBackup({ storage: s, client: () => client, locationId: () => 'LOC', now: () => now });
    const r = await cb.run();
    assert.equal(r.ok, false);
    assert.equal(cb.status().error, 'Bucket not found');
    assert.equal(cb.status().errorAt, now.toISOString());
    const cb2 = new CloudBackup({ storage: s, client: () => null, locationId: () => null, now: () => now });
    assert.equal((await cb2.run()).error, 'cloud not linked');
  } finally { cleanup(s); }
});

// ── PC health ──
test('health: disk, backup age, printer and restarts; one alert per kind every 6 hours', async () => {
  const s = await newStorage();
  try {
    let now = new Date('2026-11-24T10:00:00Z');
    const sent = [];
    let free = 50 * 1024 ** 3;
    let backup = { at: '2026-11-24T05:00:00Z', error: null };
    const h = new HealthMonitor({ storage: s, backupStatus: () => backup, notify: (p) => sent.push(p), now: () => now, diskFree: () => free });
    assert.deepEqual(h.problems(), []);
    free = 1.2 * 1024 ** 3;
    backup = { at: '2026-11-21T05:00:00Z', error: 'timeout' };
    assert.deepEqual(h.problems().map(p => p.kind).sort(), ['backup', 'disk']);
    h.printFailed(new Error('paper out'));
    assert.deepEqual(sent.map(p => p.kind).sort(), ['backup', 'disk', 'printer']);
    h.check(); // same problems again: no new alerts within 6 hours
    assert.equal(sent.length, 3);
    h.printOk();
    assert.equal(h.problems().some(p => p.kind === 'printer'), false);
    now = new Date('2026-11-24T17:00:00Z');
    h.check();
    assert.equal(sent.length, 5); // disk and backup again after 6 hours
    for (let i = 0; i < 6; i++) h.noteStart();
    assert.equal(h.startsToday(), 6);
    assert.ok(h.problems().some(p => p.kind === 'restarts'));
    const info = h.info();
    assert.equal(info.diskFreeGb, 1.2);
    assert.equal(info.startsToday, 6);
  } finally { cleanup(s); }
});

// ── Regular expenses (wages) ──
test('wages: missing and entered twice are found, per daily / weekly / monthly rule', async () => {
  const { s, m, at } = await money('2026-11-16T08:00:00Z');
  try {
    const tm = new ExpenseTemplateManager(s);
    tm.initialize();
    const wage = tm.addTemplate('أجر الفرناتشي', 'عام');
    const box = tm.addTemplate('أجر صاحب الصندوق', 'عام');
    const bill = tm.addTemplate('فاتورة الماء', 'عام');
    assert.equal(tm.setTemplateRepeat(wage, 'weekly:0').success, true);   // every Sunday
    assert.equal(tm.setTemplateRepeat(box, 'weekly:0').success, true);
    assert.equal(tm.setTemplateRepeat(bill, 'monthly').success, true);
    assert.equal(tm.setTemplateRepeat(bill, 'weekly:9').success, false);
    sell(s, 5000, '2026-11-16 08:00:00');
    // Sunday 22 Nov: furnace wage entered twice (evening and next morning), box keeper never
    at('2026-11-22T19:42:00Z'); m.recordExpense({ description: 'أجر الفرناتشي', total: 600, fromDrawer: 600, date: '2026-11-22' });
    at('2026-11-23T06:45:00Z'); m.recordExpense({ description: 'أجر الفرناتشي', total: 600, fromDrawer: 600, date: '2026-11-22', allowDuplicate: true });
    const st = tm.getRepeatStatus('2026-11-23', '2026-11-16 08:00:00');
    const cur = (name) => st.filter(x => x.name === name && x.from === '2026-11-22')[0];
    assert.deepEqual([cur('أجر الفرناتشي').status, cur('أجر الفرناتشي').count], ['double', 2]);
    assert.equal(cur('أجر صاحب الصندوق').status, 'missing'); // Monday: one day of grace is over
    // the week before the app was used is not checked
    assert.equal(st.some(x => x.from === '2026-11-15'), false);
    // on the Sunday itself, nothing is "missing" yet
    assert.equal(tm.getRepeatStatus('2026-11-22', '2026-11-16').filter(x => x.name === 'أجر صاحب الصندوق' && x.from === '2026-11-22')[0].status, 'waiting');
    // monthly: this month is still open
    assert.equal(st.filter(x => x.name === 'فاتورة الماء' && x.from === '2026-11-01')[0], undefined); // before the start (16 Nov)
    assert.equal(tm.getRepeatStatus('2026-12-02', '2026-11-01').filter(x => x.name === 'فاتورة الماء' && x.from === '2026-11-01')[0].status, 'missing');
  } finally { cleanup(s); }
});

// ── Phone messages ──
test('phone messages for change, count and health open the right page', () => {
  const del = buildMessage({ type: 'change', location_id: 'L1', hammam: 'حمام الفتح', payload: { kind: 'expense_deleted', text: 'أجر - 600dh' } }, 'ar');
  assert.equal(del.title, 'حمام الفتح · حذف مصروف');
  assert.equal(del.body, 'أجر - 600dh');
  assert.equal(del.url, '/?open=alerts&loc=L1');
  const ed = buildMessage({ type: 'change', payload: { kind: 'expense_edited', before: { description: 'خشب', total: 1000, date: '2026-11-22' }, after: { description: 'خشب', total: 1008, date: '2026-11-22' } } }, 'fr');
  assert.match(ed.title, /Dépense modifiée/);
  assert.match(ed.body, /1 000 DH → 1 008 DH/);
  const c = buildMessage({ type: 'count', location_id: 'L1', payload: { countId: 3, expected: 1500, counted: 1450, difference: -50 } }, 'ar');
  assert.match(c.body, /^ناقص 50 DH/);
  assert.equal(c.url, '/?open=cash&loc=L1');
  assert.match(buildMessage({ type: 'count', payload: { expected: 10, counted: 10, difference: 0 } }, 'fr').body, /^Exact/);
  const h = buildMessage({ type: 'health', location_id: 'L1', payload: { kind: 'printer', text: 'الطابعة لا تطبع' } }, 'ar');
  assert.equal(h.url, '/?open=devices&loc=L1');
  assert.equal(h.body, 'الطابعة لا تطبع');
});
