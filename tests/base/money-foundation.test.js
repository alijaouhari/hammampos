'use strict';
/**
 * Money system — Task 1: foundation, switch-over, notifications store.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { newStorage, cleanup, cleanupAll, PROJECT_ROOT } = require('./helpers');
const MoneyService = require(path.join(PROJECT_ROOT, 'src', 'services', 'MoneyService'));

after(() => cleanupAll());

// Controllable clock.
function clock(iso) {
  let t = new Date(iso);
  const now = () => new Date(t);
  now.set = (v) => { t = new Date(v); };
  return now;
}

function insertTicket(s, catId, price, stamp) {
  s.db.run(`INSERT INTO tickets (serial_number, year, category_id, category_name, price, date, time, timestamp)
            VALUES (?, 2026, ?, 'ر', ?, ?, ?, ?)`,
    [Math.floor(Math.random() * 99999), catId, price, stamp.slice(0, 10), stamp.slice(11), stamp]);
}

test('empty database: all four balances are 0 after switch-over', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: clock('2026-11-15T10:00:00Z') });
    assert.equal(m.isSwitchedOver(), false);
    m.switchOver();
    const b = m.getBalances();
    assert.equal(b.switchedOver, true);
    assert.deepEqual(
      [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller], [0, 0, 0, 0]);
  } finally { cleanup(s); }
});

test('before switch-over, cash in hand falls back to the old calculation', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 50);
    insertTicket(s, c, 50, '2026-11-15 08:00:00');
    s.addExpense('old', 20);
    const m = new MoneyService(s, { now: clock('2026-11-15T10:00:00Z') });
    const b = m.getBalances();
    assert.equal(b.switchedOver, false);
    assert.equal(b.cashInHand, s.getCashInHand());
    assert.equal(b.cashInHand, 30);
  } finally { cleanup(s); }
});

test('only tickets sold after the switch-over count in cash in hand', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 50);
    insertTicket(s, c, 100, '2026-11-15 09:59:59');   // before
    const now = clock('2026-11-15T10:00:00Z');
    const m = new MoneyService(s, { now });
    m.switchOver();
    insertTicket(s, c, 40, '2026-11-15 10:00:00');    // same second: counts
    insertTicket(s, c, 60, '2026-11-15 12:30:00');    // after
    assert.equal(m.getBalances().cashInHand, 100);
  } finally { cleanup(s); }
});

test('createTicket after switch-over counts (real CURRENT_TIMESTAMP)', async () => {
  const s = await newStorage();
  try {
    const c = s.addCategory('ر', 35);
    const m = new MoneyService(s, { now: () => new Date(Date.now() - 2000) });
    m.switchOver();
    s.createTicket(c);
    s.createTicket(c);
    assert.equal(m.getBalances().cashInHand, 70);
  } finally { cleanup(s); }
});

test('switch-over runs only once and survives a restart', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: clock('2026-11-15T10:00:00Z') });
    assert.equal(m.switchOver().success, true);
    const again = m.switchOver();
    assert.equal(again.success, false);
    const m2 = new MoneyService(s); // new instance = app restart, same DB
    assert.equal(m2.isSwitchedOver(), true);
    assert.equal(m2.getSwitchOverAt(), '2026-11-15 10:00:00');
  } finally { cleanup(s); }
});

test('old expenses are converted with the same cost and payment source', async () => {
  const s = await newStorage();
  try {
    s.addExpense('wood', 1200);                                          // paid cash
    s.recordExpense({ description: 'bulb', amount: 50, paid: true, paymentSource: 'out_of_pocket' });
    s.recordExpense({ description: 'parts', amount: 300, paid: false }); // unpaid
    const m = new MoneyService(s, { now: clock('2026-11-15T10:00:00Z') });
    const r = m.switchOver();
    assert.equal(r.convertedExpenses, 3);

    const oldTotal = s.db.exec('SELECT SUM(amount) FROM expenses')[0].values[0][0];
    const newTotal = s.db.exec('SELECT SUM(total) FROM money_expenses WHERE legacy_expense_id IS NOT NULL')[0].values[0][0];
    assert.equal(newTotal, oldTotal);

    const pays = s.db.exec(`SELECT e.description, p.source, p.amount FROM expense_payments p
                            JOIN money_expenses e ON e.id = p.expense_id ORDER BY e.id`)[0].values;
    assert.deepEqual(pays, [['wood', 'drawer', 1200], ['bulb', 'manager', 50]]); // unpaid has no payment

    // Paid-from-drawer legacy records never affect the new balances; the unpaid one
    // is still owed to the supplier and the out-of-pocket one is owed to the manager.
    const b = m.getBalances();
    assert.deepEqual(
      [b.cashInHand, b.owedToSuppliers, b.owedToManager, b.owedBySeller], [0, 300, 50, 0]);
    assert.equal(r.carriedOwedToManager, 50);
  } finally { cleanup(s); }
});

test('notify() stores a pending row and sends nothing', async () => {
  const s = await newStorage();
  try {
    const m = new MoneyService(s, { now: clock('2026-11-15T10:00:00Z') });
    let delivered = false;
    m._deliverNotification = () => { delivered = true; };
    const id = m.notify('refund', { ticketId: 7, amount: 35 });
    assert.ok(id > 0);
    const list = m.getNotifications();
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'refund');
    assert.equal(list[0].delivery_status, 'pending');
    assert.deepEqual(list[0].payload, { ticketId: 7, amount: 35 });
    assert.equal(delivered, false, 'delivery must be disabled in this phase');
    assert.equal(MoneyService.NOTIFICATION_DELIVERY_ENABLED, false);
    assert.throws(() => m.notify('not_a_type', {}));
  } finally { cleanup(s); }
});

test('schema is idempotent (MoneyService created twice on the same DB)', async () => {
  const s = await newStorage();
  try {
    new MoneyService(s);
    new MoneyService(s);
    const cols = s.db.exec("PRAGMA table_info(tickets)")[0].values.map(r => r[1]);
    assert.ok(cols.includes('refunded_at') && cols.includes('refund_reason'));
  } finally { cleanup(s); }
});
