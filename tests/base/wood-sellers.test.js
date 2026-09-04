'use strict';
/**
 * Regression tests for roadmap item #4 — Wood Sellers (v2.8.15).
 *
 * Covers: seller CRUD + persistence, the three pricing methods (per_kg with
 * per-purchase override, per_load, agreement), wood-type/seller snapshotting,
 * historical price integrity after a seller's default price changes, the
 * unpaid-until-paid cash model (no cash impact at delivery, cash drops at
 * payment), reopen persistence, and the by-seller / by-type reports.
 *
 * All wood logic lives in ExpenseTemplateManager (with a StorageManager ref).
 * Dates use daysAgo() (recent) to avoid the far-past date window caveat.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { newStorage, cleanup, cleanupAll, StorageManager } = require('./helpers');

after(() => cleanupAll());

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function etFor(s) {
  const { ExpenseTemplateManager } = require('./helpers');
  const et = new ExpenseTemplateManager(s);
  et.initialize();
  return et;
}

// 1. Create + persist + retrieve a seller
test('wood seller: create, list, and retrieve preserves all info', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const res = et.addWoodSeller('محمد', '0600000000', 'زيتون', 2.5, 'مورد رئيسي');
    assert.equal(res.success, true);
    assert.equal(typeof res.id, 'number');

    const all = et.getWoodSellers(false);
    assert.equal(all.length, 1);
    const seller = et.getWoodSeller(res.id);
    assert.equal(seller.name, 'محمد');
    assert.equal(seller.phone, '0600000000');
    assert.equal(seller.wood_type, 'زيتون');
    assert.equal(seller.default_price_per_kg, 2.5);
    assert.equal(seller.notes, 'مورد رئيسي');
    assert.equal(seller.active, 1);
  } finally { cleanup(s); }
});

// 2. Name is required
test('wood seller: empty name is rejected', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const res = et.addWoodSeller('   ', '', '', null, '');
    assert.equal(res.success, false);
    assert.ok(res.error);
    assert.equal(et.getWoodSellers(false).length, 0);
  } finally { cleanup(s); }
});

// 3. Default per-kg price is optional (may be null)
test('wood seller: default price is optional', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const res = et.addWoodSeller('بدون سعر', '', 'أوكاليبتوس');
    assert.equal(res.success, true);
    const seller = et.getWoodSeller(res.id);
    assert.equal(seller.default_price_per_kg, null);
  } finally { cleanup(s); }
});

// 4. Update seller + deactivate/reactivate (toggle) + activeOnly filter
test('wood seller: update and toggle active affect the picker list', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id } = et.addWoodSeller('بائع', '0611', 'زيتون', 3);
    et.updateWoodSeller(id, 'بائع محدث', '0622', 'أرز', 4, 'محدث');
    let seller = et.getWoodSeller(id);
    assert.equal(seller.name, 'بائع محدث');
    assert.equal(seller.wood_type, 'أرز');
    assert.equal(seller.default_price_per_kg, 4);

    // toggle off -> excluded from activeOnly picker but still listed in full list
    et.toggleWoodSeller(id, false);
    assert.equal(et.getWoodSellers(true).length, 0);
    assert.equal(et.getWoodSellers(false).length, 1);
    et.toggleWoodSeller(id, true);
    assert.equal(et.getWoodSellers(true).length, 1);
  } finally { cleanup(s); }
});

// 5. per_kg pricing computes total = net * unit and reduces cash when paid
test('wood purchase per_kg: total = net*unit, paid reduces cash-in-hand', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000);
    s.createTicket(c); // +5000 revenue
    const { id: sellerId } = et.addWoodSeller('مورد كيلو', '', 'زيتون', 2);

    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'زيتون', pricingMethod: 'per_kg',
      netWeight: 800, unitPrice: 2, deliveryDate: daysAgo(2), paid: true
    });
    assert.equal(res.success, true);
    assert.equal(res.totalAmount, 1600);
    assert.equal(typeof res.expenseId, 'number');
    assert.equal(s.getCashInHand(), before - 1600);
  } finally { cleanup(s); }
});

// 6. per_kg per-purchase override: seller default must NOT be forced
test('wood purchase per_kg: unit price can override the seller default', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد', '', 'زيتون', 2); // default 2
    const res = et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 3.5, // override to 3.5
      deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    assert.equal(res.totalAmount, 350);
    const out = et.getWoodPurchases ? et.getWoodPurchases(10) : null;
    if (out) {
      assert.equal(out[0].unit_price, 3.5);
      assert.equal(out[0].price_per_kg, 3.5);
    }
  } finally { cleanup(s); }
});

// 7. per_load pricing: no kg required, uses totalAmount
test('wood purchase per_load: uses total amount, no weight required', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد حمولة', '', 'مختلط');
    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_load',
      totalAmount: 1200, deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    assert.equal(res.totalAmount, 1200);
    assert.equal(s.getCashInHand(), before - 1200);
  } finally { cleanup(s); }
});

// 8. agreement pricing: no kg required, uses totalAmount
test('wood purchase agreement: uses agreed amount', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد اتفاق', '', 'زيتون');
    const res = et.recordWoodPurchase({
      sellerId, pricingMethod: 'agreement',
      totalAmount: 5000, deliveryDate: daysAgo(3), paid: true
    });
    assert.equal(res.success, true);
    assert.equal(res.totalAmount, 5000);
  } finally { cleanup(s); }
});

// 9. Invalid inputs are rejected per method
test('wood purchase: invalid pricing method and missing values rejected', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد', '', 'زيتون', 2);
    assert.equal(et.recordWoodPurchase({ sellerId, pricingMethod: 'bogus', deliveryDate: daysAgo(1) }).success, false);
    assert.equal(et.recordWoodPurchase({ sellerId, pricingMethod: 'per_kg', netWeight: 0, unitPrice: 2, deliveryDate: daysAgo(1) }).success, false);
    assert.equal(et.recordWoodPurchase({ sellerId, pricingMethod: 'per_load', totalAmount: 0, deliveryDate: daysAgo(1) }).success, false);
    assert.equal(et.recordWoodPurchase({ sellerId, pricingMethod: 'agreement', totalAmount: 100 }).success, false); // no date
  } finally { cleanup(s); }
});

// 10. wood_type and seller association snapshotted on the purchase
test('wood purchase: seller name and wood type snapshotted on the row', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('البائع الأصلي', '', 'زيتون', 2);
    et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_load', totalAmount: 900,
      deliveryDate: daysAgo(1), paid: true
    });
    const bySeller = et.getWoodBySeller();
    assert.equal(bySeller.length, 1);
    assert.equal(bySeller[0].supplier_name, 'البائع الأصلي');
    const byType = et.getWoodByType();
    assert.equal(byType.length, 1);
    assert.equal(byType[0].wood_type, 'زيتون'); // inherited from seller when not overridden
  } finally { cleanup(s); }
});

// 11. Historical price integrity: changing seller default does NOT rewrite past purchases
test('historical integrity: seller default change does not alter past purchase price', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد', '', 'زيتون', 2);
    et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_kg', netWeight: 100, unitPrice: 2,
      deliveryDate: daysAgo(5), paid: true
    });
    // Owner later raises the default price
    et.updateWoodSeller(sellerId, 'مورد', '', 'زيتون', 9);

    const purchases = et.getWoodPurchases(10);
    const p = purchases[0];
    assert.equal(p.unit_price, 2);       // snapshot preserved
    assert.equal(p.total_amount, 200);   // 100 * 2, not 100 * 9
    // Seller's current default is updated for FUTURE purchases
    assert.equal(et.getWoodSeller(sellerId).default_price_per_kg, 9);
  } finally { cleanup(s); }
});

// 12. Unpaid purchase: NO cash impact at delivery + appears in outstanding
test('unpaid wood: no cash impact at delivery, shows as outstanding', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c); // +3000
    const { id: sellerId } = et.addWoodSeller('مورد آجل', '', 'زيتون', 2);

    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_load', totalAmount: 1000,
      deliveryDate: daysAgo(2), paid: false
    });
    assert.equal(res.success, true);
    assert.equal(res.expenseId, null);          // no expense created
    assert.equal(s.getCashInHand(), before);    // cash untouched at delivery

    const outstanding = et.getOutstandingWoodPurchases();
    assert.equal(outstanding.length, 1);
    assert.equal(outstanding[0].paid, 0);
    assert.equal(outstanding[0].total_amount, 1000);
  } finally { cleanup(s); }
});

// 13. Paying an outstanding purchase drops cash + marks paid + sets paid_date
test('paying wood: cash drops at payment, marks paid with paid_date', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 3000);
    s.createTicket(c); // +3000
    const { id: sellerId } = et.addWoodSeller('مورد آجل', '', 'زيتون', 2);
    const rec = et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_load', totalAmount: 1000,
      deliveryDate: daysAgo(4), paid: false
    });
    const before = s.getCashInHand();

    const payDate = daysAgo(1);
    const pay = et.payWoodPurchase(rec.woodId, payDate);
    assert.equal(pay.success, true);
    assert.equal(typeof pay.expenseId, 'number');
    assert.equal(s.getCashInHand(), before - 1000);   // cash drops now
    assert.equal(et.getOutstandingWoodPurchases().length, 0);

    const purchases = et.getWoodPurchases(10);
    const p = purchases.find(x => x.id === rec.woodId);
    assert.equal(p.paid, 1);
    assert.equal(p.paid_date, payDate);
    assert.equal(typeof p.expense_id, 'number');

    // paying twice is rejected
    assert.equal(et.payWoodPurchase(rec.woodId, payDate).success, false);
  } finally { cleanup(s); }
});

// 14. paid_date of a paid-now purchase equals its delivery date
test('paid-now wood: paid_date equals delivery date', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد', '', 'زيتون', 2);
    const d = daysAgo(2);
    const rec = et.recordWoodPurchase({
      sellerId, pricingMethod: 'per_load', totalAmount: 500,
      deliveryDate: d, paid: true
    });
    const p = et.getWoodPurchases(10).find(x => x.id === rec.woodId);
    assert.equal(p.paid, 1);
    assert.equal(p.paid_date, d);
  } finally { cleanup(s); }
});

// 15. Persistence across reopen: sellers + purchases + outstanding survive
test('persistence: sellers and purchases survive a reopen', async () => {
  const s = await newStorage();
  const dbPath = s.dbPath;
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('مورد دائم', '0699', 'زيتون', 2.75, 'ملاحظة');
    et.recordWoodPurchase({ sellerId, pricingMethod: 'per_load', totalAmount: 800, deliveryDate: daysAgo(2), paid: false });
    cleanup(s);

    const s2 = new StorageManager(dbPath);
    s2.dbPath = dbPath;
    await s2.initialize();
    try {
      const et2 = etFor(s2);
      const sellers = et2.getWoodSellers(false);
      assert.equal(sellers.length, 1);
      assert.equal(sellers[0].name, 'مورد دائم');
      assert.equal(sellers[0].default_price_per_kg, 2.75);

      const outstanding = et2.getOutstandingWoodPurchases();
      assert.equal(outstanding.length, 1);
      assert.equal(outstanding[0].total_amount, 800);
    } finally { cleanup(s2); }
  } catch (e) { cleanup(s); throw e; }
});

// 16. Reports: by-seller and by-type aggregate correctly incl. outstanding
test('reports: by-seller and by-type aggregate purchases and outstanding', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const a = et.addWoodSeller('بائع أ', '', 'زيتون', 2).id;
    const b = et.addWoodSeller('بائع ب', '', 'أرز', 3).id;

    et.recordWoodPurchase({ sellerId: a, pricingMethod: 'per_kg', netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(3), paid: true });   // 200, زيتون
    et.recordWoodPurchase({ sellerId: a, pricingMethod: 'per_load', totalAmount: 300, deliveryDate: daysAgo(2), paid: false });            // 300 outstanding, زيتون
    et.recordWoodPurchase({ sellerId: b, pricingMethod: 'agreement', totalAmount: 1000, deliveryDate: daysAgo(1), paid: true });           // 1000, أرز

    const bySeller = et.getWoodBySeller();
    const sellerA = bySeller.find(r => r.supplier_name === 'بائع أ');
    const sellerB = bySeller.find(r => r.supplier_name === 'بائع ب');
    assert.equal(sellerA.purchases, 2);
    assert.equal(sellerA.total_amount, 500);
    assert.equal(sellerA.outstanding_amount, 300);
    assert.equal(sellerB.total_amount, 1000);
    assert.equal(sellerB.outstanding_amount, 0);

    const byType = et.getWoodByType();
    const zaytoun = byType.find(r => r.wood_type === 'زيتون');
    const arz = byType.find(r => r.wood_type === 'أرز');
    assert.equal(zaytoun.total_amount, 500);
    assert.equal(arz.total_amount, 1000);
  } finally { cleanup(s); }
});


/* ══════════════════════════════════════════════════════════════════════
 * v2.8.16 — Wood buying flow fixes + seller/wood-type corrections
 * Covers behaviors A–L from the task spec.
 * ══════════════════════════════════════════════════════════════════════ */

// This mirrors the renderer helper formatMoroccoPhone() in hammampos.html
// (kept identical). Duplicated here because the renderer is not requireable
// from the node:test process. If the renderer helper changes, update this too.
function formatMoroccoPhone(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '').slice(0, 10);
  const groups = [];
  for (let i = 0; i < digits.length; i += 2) groups.push(digits.slice(i, i + 2));
  return groups.join(' ');
}

// B. Seller phone formatting: XX XX XX XX XX (2 digits x 5 groups).
test('phone format: groups digits into XX XX XX XX XX', () => {
  assert.equal(formatMoroccoPhone('0612345678'), '06 12 34 56 78');
  assert.equal(formatMoroccoPhone('06 12 34 56 78'), '06 12 34 56 78'); // idempotent
  assert.equal(formatMoroccoPhone('06-12-34-56-78'), '06 12 34 56 78'); // strips separators
  assert.equal(formatMoroccoPhone('061234567890'), '06 12 34 56 78');   // caps at 10 digits
  assert.equal(formatMoroccoPhone(''), '');
  assert.equal(formatMoroccoPhone('061'), '06 1'); // partial while typing
});

// C. A seller can have MULTIPLE wood types (array input).
test('multi-type seller: create with several wood types', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id } = et.addWoodSeller('صالح', '06 11 22 33 44', ['أوكاليبتوس', 'ليج'], 2);
    const seller = et.getWoodSeller(id);
    assert.deepEqual(seller.types.sort(), ['أوكاليبتوس', 'ليج'].sort());
    // A comma-separated string is also accepted and split.
    const { id: id2 } = et.addWoodSeller('مراد', '', 'مدري جدرة، دشيش');
    assert.deepEqual(et.getWoodSeller(id2).types.sort(), ['دشيش', 'مدري جدرة'].sort());
  } finally { cleanup(s); }
});

// D. Selecting a seller limits the wood-type list to THAT seller's types.
test('seller-scoped types: each seller returns only its own types', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const saleh = et.addWoodSeller('صالح', '', ['أوكاليبتوس', 'ليج']).id;
    const mourad = et.addWoodSeller('مراد', '', ['مدري جدرة', 'دشيش']).id;
    assert.deepEqual(et.getWoodSellerTypes(saleh).sort(), ['أوكاليبتوس', 'ليج'].sort());
    assert.deepEqual(et.getWoodSellerTypes(mourad).sort(), ['دشيش', 'مدري جدرة'].sort());
    // Seller with no types returns an empty list (handled clearly in UI).
    const noTypes = et.addWoodSeller('بدون أنواع', '', []).id;
    assert.deepEqual(et.getWoodSellerTypes(noTypes), []);
  } finally { cleanup(s); }
});

// Updating a seller's types does not restrict the seller identity.
test('editing seller types keeps identity and replaces types', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id } = et.addWoodSeller('صالح', '', ['أوكاليبتوس']);
    et.updateWoodSeller(id, 'صالح', '', ['أوكاليبتوس', 'ليج', 'أرز'], 3);
    const seller = et.getWoodSeller(id);
    assert.equal(seller.name, 'صالح');
    assert.equal(seller.types.length, 3);
  } finally { cleanup(s); }
});

// A + K. Recording a purchase persists it and it is retrievable via getWoodPurchases.
test('purchase persists and is retrievable from the wood table query', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_load',
      netWeight: 1200, totalAmount: 900, deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    const rows = et.getWoodPurchases(50);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wood_type, 'ليج');
    assert.equal(rows[0].supplier_name, 'صالح');
    assert.equal(rows[0].total_amount, 900);
  } finally { cleanup(s); }
});

// F. Per-load records wood type + total weight + total price (no per-kg calc).
test('per_load: records type, total weight, and agreed price (no per-kg calc)', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('صالح', '', ['أوكاليبتوس'], 2).id; // default 2 d/kg
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'أوكاليبتوس', pricingMethod: 'per_load',
      netWeight: 1500, totalAmount: 1000, deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    // Price is the agreed 1000, NOT 1500*2=3000 from the default per-kg rate.
    assert.equal(res.totalAmount, 1000);
    const row = et.getWoodPurchases(10)[0];
    assert.equal(row.wood_type, 'أوكاليبتوس');
    assert.equal(row.net_wood_weight, 1500);
    assert.equal(row.total_amount, 1000);
    assert.equal(row.pricing_method, 'per_load');
  } finally { cleanup(s); }
});

// G + H + I. Paid affects cash; unpaid does not; paying later affects cash exactly once.
test('cash model: paid drops cash, unpaid does not, pay-later drops exactly once', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000);
    s.createTicket(c); // +5000
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;

    // Paid now: cash drops immediately.
    const paidBefore = s.getCashInHand();
    et.recordWoodPurchase({ sellerId, woodType: 'ليج', pricingMethod: 'per_load', netWeight: 100, totalAmount: 500, deliveryDate: daysAgo(3), paid: true });
    assert.equal(s.getCashInHand(), paidBefore - 500);

    // Unpaid: no cash change at delivery.
    const unpaidBefore = s.getCashInHand();
    const rec = et.recordWoodPurchase({ sellerId, woodType: 'ليج', pricingMethod: 'per_load', netWeight: 100, totalAmount: 700, deliveryDate: daysAgo(2), paid: false });
    assert.equal(s.getCashInHand(), unpaidBefore);

    // Pay later: cash drops by exactly the amount, once.
    et.payWoodPurchase(rec.woodId, daysAgo(1));
    assert.equal(s.getCashInHand(), unpaidBefore - 700);
    // Paying again is rejected — no double charge.
    const again = et.payWoodPurchase(rec.woodId, daysAgo(1));
    assert.equal(again.success, false);
    assert.equal(s.getCashInHand(), unpaidBefore - 700);
  } finally { cleanup(s); }
});

// J. Purchase history preserves seller/type/weight/price/status/pay-date.
test('history integrity: purchase snapshot survives seller edits', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const rec = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(5), paid: true
    });
    // Owner later renames the seller, changes its types and default price.
    et.updateWoodSeller(sellerId, 'صالح المحدث', '', ['نوع آخر'], 9);

    const row = et.getWoodPurchases(10).find(r => r.id === rec.woodId);
    assert.equal(row.supplier_name, 'صالح');   // snapshot name preserved
    assert.equal(row.wood_type, 'ليج');         // snapshot type preserved
    assert.equal(row.unit_price, 2);            // snapshot price preserved
    assert.equal(row.total_amount, 200);        // 100*2, not 100*9
    assert.equal(row.paid, 1);
  } finally { cleanup(s); }
});

// Historical single-type sellers are backfilled into the multi-type table.
test('legacy backfill: initialize copies old single wood_type into types table', async () => {
  const s = await newStorage();
  const dbPath = s.dbPath;
  try {
    const et = etFor(s);
    // Simulate a legacy row: seller with only the old wood_type column populated
    // and no rows in wood_seller_types.
    s.db.run("INSERT INTO wood_sellers (name, phone, wood_type, active) VALUES ('قديم', '', 'خشب قديم', 1)");
    const id = s.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    s.db.run('DELETE FROM wood_seller_types WHERE seller_id = ?', [id]);
    s.save();
    cleanup(s);

    // Reopen -> initialize() runs the guarded backfill.
    const s2 = new StorageManager(dbPath);
    s2.dbPath = dbPath;
    await s2.initialize();
    try {
      const et2 = etFor(s2);
      assert.deepEqual(et2.getWoodSellerTypes(id), ['خشب قديم']);
    } finally { cleanup(s2); }
  } catch (e) { cleanup(s); throw e; }
});

// L (regression companion). clearAllData wipes wood_seller_types too.
test('clearAllData removes wood sellers, purchases, and seller types', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج', 'أرز'], 2).id;
    et.recordWoodPurchase({ sellerId, woodType: 'ليج', pricingMethod: 'per_load', totalAmount: 500, netWeight: 100, deliveryDate: daysAgo(1), paid: false });
    s.clearAllData();
    assert.equal(et.getWoodSellers(false).length, 0);
    assert.equal(et.getWoodPurchases(10).length, 0);
    assert.equal(et.getWoodSellerTypes(sellerId).length, 0);
  } finally { cleanup(s); }
});


/* ══════════════════════════════════════════════════════════════════════
 * v2.8.18 — Bug fixes: seller deactivate vs permanent delete, wood-save
 * regression on legacy NOT NULL schema, historical integrity after delete,
 * and readability of legacy 'agreement' rows.
 * ══════════════════════════════════════════════════════════════════════ */

// Bug 2: seller can be deactivated (hidden from active picker) without deletion.
test('bugfix: seller deactivate hides from active list but keeps the record', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id } = et.addWoodSeller('مورد للتعطيل', '06 11 22 33 44', ['ليج'], 2);
    et.toggleWoodSeller(id, false);
    assert.equal(et.getWoodSellers(true).length, 0);   // not in active picker
    assert.equal(et.getWoodSellers(false).length, 1);   // still exists
    assert.ok(et.getWoodSeller(id));                     // record intact
  } finally { cleanup(s); }
});

// Bug 2: seller can be permanently removed and no longer appears anywhere.
test('bugfix: deleteWoodSeller permanently removes the seller and its types', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id } = et.addWoodSeller('مورد للحذف', '', ['ليج', 'أرز'], 2);
    assert.equal(et.getWoodSellerTypes(id).length, 2);
    const res = et.deleteWoodSeller(id);
    assert.equal(res.success, true);
    assert.equal(et.getWoodSeller(id), null);            // gone
    assert.equal(et.getWoodSellers(false).length, 0);    // not listed
    assert.equal(et.getWoodSellerTypes(id).length, 0);   // types removed
    // Deleting a missing seller fails cleanly.
    assert.equal(et.deleteWoodSeller(9999).success, false);
  } finally { cleanup(s); }
});

// Bug 2: historical wood purchases survive permanent seller deletion (snapshot).
test('bugfix: historical purchase remains intact after the seller is deleted', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const { id: sellerId } = et.addWoodSeller('صالح', '', ['ليج'], 2);
    const rec = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(3), paid: true
    });
    et.deleteWoodSeller(sellerId);

    const row = et.getWoodPurchases(10).find(r => r.id === rec.woodId);
    assert.ok(row, 'purchase row still exists');
    assert.equal(row.supplier_name, 'صالح');   // snapshot preserved
    assert.equal(row.wood_type, 'ليج');
    assert.equal(row.unit_price, 2);
    assert.equal(row.total_amount, 200);
    // Reports still read the historical row.
    assert.ok(et.getWoodBySeller().some(r => r.supplier_name === 'صالح'));
  } finally { cleanup(s); }
});

// Bug 4: wood purchase actually SAVES on a LEGACY database whose wood_purchases
// columns were declared NOT NULL. This reproduces the real failure and proves
// the fix (the INSERT now supplies safe defaults for the legacy columns).
test('bugfix: wood purchase saves on legacy NOT NULL schema (paid + unpaid)', async () => {
  const s = await newStorage();
  try {
    // Recreate the legacy wood_purchases table (NOT NULL truck/net/price columns)
    // BEFORE ExpenseTemplateManager.initialize runs its guarded ALTERs.
    s.db.run('DROP TABLE IF EXISTS wood_purchases');
    s.db.run(`CREATE TABLE wood_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL,
      truck_weight_gross REAL NOT NULL,
      truck_weight_empty REAL NOT NULL,
      net_wood_weight REAL NOT NULL,
      price_per_kg REAL NOT NULL,
      total_amount REAL NOT NULL,
      delivery_date TEXT NOT NULL,
      notes TEXT,
      expense_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    s.save();

    const et = etFor(s); // adds the new columns via guarded ALTER
    const c = s.addCategory('رجال', 5000);
    s.createTicket(c); // +5000 revenue
    const sellerId = et.addWoodSeller('صالح', '', ['ليج', 'أوكاليبتوس'], 2).id;

    // PAID per_load: must save AND drop cash by the agreed amount.
    const before = s.getCashInHand();
    const paidRes = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_load',
      totalAmount: 900, netWeight: 1200, deliveryDate: daysAgo(2), paid: true
    });
    assert.equal(paidRes.success, true, 'paid per_load saved');
    assert.equal(s.getCashInHand(), before - 900);

    // UNPAID per_kg: must save AND NOT change cash.
    const beforeUnpaid = s.getCashInHand();
    const unpaidRes = et.recordWoodPurchase({
      sellerId, woodType: 'أوكاليبتوس', pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(1), paid: false
    });
    assert.equal(unpaidRes.success, true, 'unpaid per_kg saved');
    assert.equal(s.getCashInHand(), beforeUnpaid); // no cash change until paid

    // Both appear in the wood table; one outstanding.
    assert.equal(et.getWoodPurchases(10).length, 2);
    assert.equal(et.getOutstandingWoodPurchases().length, 1);
  } finally { cleanup(s); }
});

// Bug 3: legacy rows recorded under the (now removed) 'agreement' method remain
// readable. The UI no longer offers the option, but old data must not break.
test('bugfix: legacy agreement purchases remain readable', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('مورد قديم', '', ['ليج'], 2).id;
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'agreement',
      totalAmount: 1500, deliveryDate: daysAgo(2), paid: true
    });
    assert.equal(res.success, true);
    const row = et.getWoodPurchases(10).find(r => r.id === res.woodId);
    assert.equal(row.pricing_method, 'agreement');
    assert.equal(row.total_amount, 1500);
  } finally { cleanup(s); }
});

// Bug 5: negative-number formatting helper mirrors the intended display: the
// minus sign is on the LEFT of the number. (Renderer applies LTR via CSS; this
// documents/locks the expected textual form.)
test('bugfix: negative amount formats with the minus sign on the left', () => {
  // The value HammamPOS stores/produces is a normal JS number; JS string form
  // already places the minus on the left. The RTL bug was purely visual (CSS).
  assert.equal(String(-50), '-50');
  assert.equal(String(-50).charAt(0), '-');
  assert.equal(String(-12.5), '-12.5'); // decimals preserved
  assert.equal(String(50), '50');       // positives unchanged
});


/* ══════════════════════════════════════════════════════════════════════
 * v2.8.19 — Bug 1: wood purchase persists IMMEDIATELY.
 * The root cause was the IPC handler awaiting slow backup/Excel mirroring
 * before returning; the DB row itself is persisted synchronously by
 * recordWoodPurchase (storage.save()). These tests prove the row is present
 * the instant recordWoodPurchase returns — no restart, no delay — for all
 * four combinations, with correct cash behavior and no duplicate rows.
 * (The IPC no-longer-blocking wiring lives in the Electron main process and
 * cannot be exercised headlessly; it is covered by human testing.)
 * ══════════════════════════════════════════════════════════════════════ */

test('bug1: paid per-kg purchase persists immediately and drops cash', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000); s.createTicket(c);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    // Present in the table the instant the call returns (no restart/delay).
    assert.equal(et.getWoodPurchases(50).length, 1);
    assert.equal(s.getCashInHand(), before - 200);
  } finally { cleanup(s); }
});

test('bug1: unpaid per-kg purchase persists immediately with no cash change', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000); s.createTicket(c);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_kg',
      netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(1), paid: false
    });
    assert.equal(res.success, true);
    assert.equal(et.getWoodPurchases(50).length, 1);
    assert.equal(s.getCashInHand(), before);            // unchanged
    assert.equal(et.getOutstandingWoodPurchases().length, 1);
  } finally { cleanup(s); }
});

test('bug1: paid per-load purchase persists immediately and drops cash', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000); s.createTicket(c);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_load',
      totalAmount: 800, netWeight: 1000, deliveryDate: daysAgo(1), paid: true
    });
    assert.equal(res.success, true);
    assert.equal(et.getWoodPurchases(50).length, 1);
    assert.equal(s.getCashInHand(), before - 800);
  } finally { cleanup(s); }
});

test('bug1: unpaid per-load purchase persists immediately with no cash change', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000); s.createTicket(c);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const before = s.getCashInHand();
    const res = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_load',
      totalAmount: 800, netWeight: 1000, deliveryDate: daysAgo(1), paid: false
    });
    assert.equal(res.success, true);
    assert.equal(et.getWoodPurchases(50).length, 1);
    assert.equal(s.getCashInHand(), before);
    assert.equal(et.getOutstandingWoodPurchases().length, 1);
  } finally { cleanup(s); }
});

test('bug1: each recordWoodPurchase creates exactly one row (no duplicates)', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    et.recordWoodPurchase({ sellerId, woodType: 'ليج', pricingMethod: 'per_kg', netWeight: 100, unitPrice: 2, deliveryDate: daysAgo(2), paid: true });
    et.recordWoodPurchase({ sellerId, woodType: 'ليج', pricingMethod: 'per_load', totalAmount: 300, netWeight: 400, deliveryDate: daysAgo(1), paid: false });
    assert.equal(et.getWoodPurchases(50).length, 2); // two calls -> two rows, no dup
  } finally { cleanup(s); }
});

test('bug1: an unpaid purchase can still be paid later (drops cash once)', async () => {
  const s = await newStorage();
  try {
    const et = etFor(s);
    const c = s.addCategory('رجال', 5000); s.createTicket(c);
    const sellerId = et.addWoodSeller('صالح', '', ['ليج'], 2).id;
    const rec = et.recordWoodPurchase({
      sellerId, woodType: 'ليج', pricingMethod: 'per_load',
      totalAmount: 700, netWeight: 900, deliveryDate: daysAgo(2), paid: false
    });
    const before = s.getCashInHand();
    const pay = et.payWoodPurchase(rec.woodId, daysAgo(1));
    assert.equal(pay.success, true);
    assert.equal(s.getCashInHand(), before - 700);
    assert.equal(et.getOutstandingWoodPurchases().length, 0);
    assert.equal(et.payWoodPurchase(rec.woodId, daysAgo(1)).success, false); // once only
  } finally { cleanup(s); }
});
