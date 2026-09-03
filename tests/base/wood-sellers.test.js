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
