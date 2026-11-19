'use strict';
/**
 * Money system: reports (Task 9). Day summary, Excel sheets and backup file for the
 * new tables.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));
const ExcelManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'ExcelManager'));
const BackupManager = require(path.join(PROJECT_ROOT, 'src', 'services', 'BackupManager'));
after(() => cleanupAll());
const stamp = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const L = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);
let serial = 1;
async function setup() {
  const s = await newStorage();
  let t = L(2026, 11, 15, 6);
  const m = new MoneyService(s, { now: () => new Date(t) });
  m.switchOver();
  const c = s.addCategory('x', 1);
  return {
    s, m, c, at: (d) => { t = d; },
    sell(price, when) {
      const st = stamp(when);
      s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
                VALUES (?, 2026, ?, 'x', ?, ?, ?, ?)`, [serial++, c, price, st.slice(0, 10), st.slice(11), st]);
      return s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }
  };
}

test('day summary: income net of refunds, cost, and how the cost was paid', async () => {
  const { s, m, sell, at } = await setup();
  try {
    m.setRefundsEnabled(true);
    sell(500, L(2026, 11, 15, 8));
    const r = sell(35, L(2026, 11, 15, 9));
    at(L(2026, 11, 15, 9, 30));
    assert.equal(m.refundTicket(r, 'water').success, true);
    m.recordExpense({ description: 'a', total: 100, fromDrawer: 100, date: '2026-11-15' });
    m.recordExpense({ description: 'b', total: 200, fromDrawer: 50, restAs: 'manager', date: '2026-11-15' });
    m.recordExpense({ description: 'c', total: 80, fromDrawer: 0, restAs: 'unpaid', date: '2026-11-15' });
    const d = m.getDaySummary('2026-11-15');
    assert.equal(d.sales, 500);
    assert.equal(d.tickets, 1);
    assert.deepEqual(d.refunds, { count: 1, total: 35 });
    assert.equal(d.cost, 380);
    assert.equal(d.paidDrawer, 150);
    assert.equal(d.paidManager, 150);
    assert.equal(d.unpaid, 80);
    // another day is empty
    const e = m.getDaySummary('2026-11-14');
    assert.equal(e.cost, 0);
    assert.equal(e.sales, 0);
  } finally { cleanup(s); }
});

test('exportData lists every new record; Excel rebuild writes the new sheets', async () => {
  const { s, m, sell, at } = await setup();
  try {
    sell(1000, L(2026, 11, 15, 8));
    m.recordExpense({ description: 'a', total: 100, fromDrawer: 100, date: '2026-11-15' });
    at(L(2026, 11, 15, 12));
    m.recordRemoteCollection({ type: 'bank', amount: 300, reference: 'R1' });
    at(L(2026, 11, 15, 14));
    m.collectInPerson({ counted: 550 }); // expected 600 -> shortage 50
    const data = m.exportData();
    assert.equal(data.expenses.length, 1);
    assert.equal(data.expenses[0].payments.length, 1);
    assert.equal(data.collections.length, 2);
    assert.equal(data.sellerDebts[0].amount, 50);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp_xl_'));
    try {
      const xl = new ExcelManager(path.join(dir, 'x.xlsx'));
      await xl.initialize();
      await xl.rebuildFromDatabase(s, m);
      await xl.rebuildFromDatabase(s, m); // twice: no duplicate rows, no duplicate sheets
      const names = xl.workbook.worksheets.map(w => w.name);
      for (const n of ['مصاريف (النظام الجديد)', 'دفعات المصاريف', 'تحصيل (النظام الجديد)', 'ديون البائع', 'تذاكر مسترجعة']) {
        assert.equal(names.filter(x => x === n).length, 1, n);
      }
      assert.equal(xl.workbook.getWorksheet('تحصيل (النظام الجديد)').rowCount, 3); // header + 2
      assert.equal(xl.workbook.getWorksheet('مصاريف (النظام الجديد)').rowCount, 2);
      assert.ok(fs.existsSync(path.join(dir, 'x.xlsx')));

      const bk = new BackupManager(path.join(dir, 'bk'));
      const res = await bk.rebuildFromDatabase(s, m);
      assert.equal(res.success, true, res.error);
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'bk', 'money.json'), 'utf8'));
      assert.equal(json.collections.length, 2);
      assert.equal(json.balances.owedBySeller, 50);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { cleanup(s); }
});
