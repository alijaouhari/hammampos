# HammamPOS — Project Context

## Business Model

- SaaS for Moroccan hammams (bathhouses)
- Creator: Ali Jaouhari — built for his own hammams first, now selling to other hammam owners
- Max ~100 clients. This is niche software for a specific business, not a mass-market app.
- Base product: ticketing POS (categories, tickets, printer, daily ledger, expenses, collections)
- Revenue model: base license + paid add-ons (inventory management, employee management, custom per-client add-ons)
- Ali's own installations get ALL features. Clients get base + whatever add-ons they purchased.
- Plugins are NOT the priority. The main app must be fully functional and tested first.

## Update Architecture

- Core updates auto-check on launch via GitHub Releases API
- User sees notification in settings: "تحديث متاح"
- User clicks a button to install the update (not forced)
- User has a "revert" button in settings to roll back to previous version if the update is broken
- Previous version is kept as a backup ZIP before overwriting
- Updates must never touch the database (`%APPDATA%\HammamPOS\hammampos.db`)
- Two repos may exist: one for Ali (testing/dev), one for clients (stable releases)

### Updater Validation Status — END-TO-END PASS

- Status: COMPLETE / PASS (real production update validated)
- Tested transition: **2.8.7 → 2.8.8** (published GitHub release)
- Production install path tested: `C:\Program Files\HammamPOS`
- Download verified: ZIP size 124,159,203 bytes
- UAC `Start-Process -Verb RunAs` self-elevation was exercised: updater started non-elevated, Step 0 requested Administrator elevation, and the elevated instance continued.
- Protected Program Files operations succeeded: Step 3 extraction, Step 4 staging verification, Step 5 backup lifecycle, Step 6 install→old rename (succeeded on attempt 1), Step 7 staging→install swap.
- New process launched (Step 8) and Step 9 startup handshake received for version 2.8.8.
- Final installed version independently verified from packaged `app.asar` = **2.8.8**.
- No ACL manipulation, no manual file replacement, no workaround used.
- Rollback backup: `C:\Program Files\HammamPOS-old` contains the previous **2.8.7** copy and MUST remain untouched.
- Resolves the prior production failure: `Access to the path 'HammamPOS-update' is denied`.
- Relevant fixes: updater UAC self-elevation + UTF-8 BOM PS1 generation (commit `6efa875`); Step-6 bounded rename retry (commit `7937c6e`).

## Features

### Change Money / Float (صندوق الصرف) — COMPLETE

- Status: COMPLETE (implemented, tested).
- Dedicated table `change_float` (id, operation ADD/TAKE, amount, balance_after, note, date, time, timestamp) with index `idx_change_float_date`.
- Financially independent: float never touches tickets/expenses/collections/daily-summary. `getCashInHand()` remains `SUM(tickets.price) - SUM(expenses.amount) - SUM(collections.amount)`.
- StorageManager API: `addFloat(amount, notes)`, `takeFloat(amount, notes)`, `getFloatBalance()`, `getFloatHistory()`. Parameterized SQL; balance computed server-side from persisted state.
- ADD/TAKE validation in the DB layer: amount must be finite and > 0; TAKE rejected if it exceeds the current balance (no negative balance, no silent clamping). `resulting_balance` stored per operation.
- Negative-balance protection: enforced; TAKE beyond balance returns an error and writes nothing.
- Persistence: stored in the existing SQLite DB, survives restart.
- Audit: every ADD/TAKE writes an `audit_log` entry (entity `change_float`).
- IPC: `float:add`, `float:take`, `float:getBalance`, `float:getHistory`; renderer bridge `api.float`.
- UI: admin-stats card "صندوق الصرف" (balance) + admin-actions button opening a Change Money modal (ADD/TAKE + history table: التاريخ/الوقت/العملية/المبلغ/الرصيد بعد العملية/الملاحظات, newest first, إضافة/سحب labels).
- Backups/Excel: float operations mirrored to BackupManager (change_float.csv/json/txt) and ExcelManager ("صندوق الصرف" sheet); included in rebuildFromDatabase.
- clearAllData: clears `change_float` (resets float to 0) consistent with clearing all transactional financial history.
- Testing: 22/22 checks passed (fresh=0; ADD 100→100, ADD 50→150, TAKE 30→120, TAKE 120→0, TAKE 1 rejected, zero/negative rejected, history + resulting_balance correct, persists across restart, audit entries created, getCashInHand/revenue/expenses/collections/ticket-count unchanged, clearAllData resets float). App startup regression verified.

## Technical Stack

- Electron 28 + SQLite (sql.js) + Supabase cloud sync
- ESC/POS raster printing via PowerShell Win32 API
- Single-file HTML renderers (no build step, no React/Vue)
- electron-builder for packaging
- GitHub Releases for distribution

## Production Deployment

- Install path: `C:\HammamPOS`
- Database: `%APPDATA%\HammamPOS\hammampos.db`
- Backups: `~/Documents/HammamPOS-Backups/`
- Desktop shortcut → `C:\HammamPOS\HammamPOS.exe`

## Code Rules

- Verify issue — read full code, report problem and solution
- Confirm before executing
- Detailed fix report before execution
- Prove it's done with evidence
- Wait for testing before moving on
- No patching. No lying. No "it's fixed" without proof. Accuracy over speed.
- No filler, no fluff, no redundancy
- Full processes followed to completion, not superficially

### Inventory Management (إدارة المخزون) — SPECIFICATION REQUIRED

- Status: **SPECIFICATION REQUIRED** (specification below is complete; blocked on OPEN PRODUCT DECISIONS before implementation).
- Business position: first paid add-on in the documented Business Model order (base license + paid add-ons: inventory management, employee management, custom per-client add-ons). README lists inventory-management first.
- Implementation readiness: **BLOCKED** until the OPEN PRODUCT DECISIONS in this section are resolved. Do NOT implement until then. No source code has been written for this feature; `src/plugins/features/` is empty.

This section is a functional specification intended to let a subsequent task implement Inventory Management without ambiguity. Verified architectural findings and genuine product decisions are separated explicitly.

#### Verified Architectural Findings (read from current code, not assumed)

These correct/confirm the aspirational docs:

- **Plugin gating is by FILE PRESENCE, not a runtime license check.** `PluginManager.loadPlugin()` explicitly loads any plugin whose folder exists (comment: "you install = it loads"). `LicenseManager` exists (hardware-fingerprint, per-feature `.license` files, key format `XXXX-XXXX-XXXX-XXXX`, `activateLicense(key, featureId)` / `validateLicense(featureId)`), but plugin loading does NOT consult it, and the base `hammampos-core` check is currently bypassed. Add-on delivery = shipping the plugin folder to the client.
- **Real plugin core files** are `src/plugins/core/PluginManager.js`, `LicenseManager.js`, `interfaces/Plugin.js`. There is NO `PluginLoader.js` and NO `registry/` directory (the plugins `README.md` is inaccurate on this point). Plugin registry is a DB table `plugin_registry` created by `PluginManager`.
- **plugin.json** required fields: `id`, `name`, `version`, `entryPoint`. Optional: `dependencies[]`, `licenseRequired`, `author`, `description`, `permissions{}`. `entryPoint` resolves relative to the plugin folder.
- **Plugin lifecycle**: `new PluginClass()` then optional `initialize(context)` / `shutdown()`. Context passed is `{ database: storage, ui: null, licensing: licenseManager, events: EventEmitter, config: storage, logger: console, storage: storage, excel: excelManager }`. Note: `ui` is `null` and **BackupManager is NOT in the context**.
- **Data layer** (`StorageManager`, sql.js): single SQLite file at `%APPDATA%/HammamPOS/hammampos.db`; every write must call `this.save()`; `PRAGMA foreign_keys = ON`. Column conventions: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `date TEXT` (YYYY-MM-DD), `time TEXT` (HH:MM:SS), `timestamp TEXT DEFAULT CURRENT_TIMESTAMP`, money as `REAL`, `idx_<table>_date` indexes.
- **Audit** convention: `storage.logAudit(action, entity, entityId, details)` → `audit_log`. Actions used today: `CREATE`, `UPDATE`, `DELETE`, `CLEAR_ALL_DATA`. Deletions log full details BEFORE deleting and are retained in backups for the audit trail.
- **Validation** convention (from Float): coerce with `Number(x)`, reject non-finite or `<= 0` with `{ success: false, error: '<arabic message>' }`; never clamp silently; compute balances server-side from persisted rows.
- **Cash-in-hand** = `SUM(tickets.price) − SUM(expenses.amount) − SUM(collections.amount)`. Float is deliberately excluded. Any new financial impact must be a conscious decision about whether it flows through `expenses`.
- **Firewood already exists and is modeled as an EXPENSE, not stock.** `ExpenseTemplateManager.addWoodPurchase()` creates an `expenses` row first, then inserts a `wood_purchases` row linked by `expense_id`. There is no stock balance for wood. Consumables/products have no existing model at all.
- **Mirror pattern** for every financial record: IPC handler calls `storage.<op>()`, then mirrors to `backupManager.<addX>()` (CSV/JSON/TXT + `updateHTML`), `excelManager.<addX>()` (Arabic-named RTL worksheet), and `cloudSync.syncX()` (non-blocking). IPC is `namespace:action`, exposed on renderer as `api.<namespace>.<action>`. Both managers expose `rebuildFromDatabase(storage)`.
- **Renderer** is a single `hammampos.html` (no build step, `nodeIntegration` true). Admin area is gated by `settings:verifyAdminPassword`. Features surface as an `admin-stat-card` + an `admin-actions` button opening a modal (Float is the reference implementation).

#### 1. PURPOSE

Give hammam owners a way to track physical stock of consumable supplies and resale/products (e.g. soap, shampoo sachets, ghassoul, towels, bottled water) so they know current quantity on hand, get low-stock alerts, and can review a full movement history. It answers "how much do we have, what came in, what went out, and what is it worth" — which the base POS (tickets/expenses/collections) cannot answer today.

#### 2. SCOPE

In scope (MVP):
- Inventory items with name, unit, current stock, optional reorder level and cost.
- Stock movements: stock-in (purchase/receive), stock-out (usage/consumption), and adjustment (correction/loss/wastage).
- Authoritative current-stock calculation derived from movements.
- Movement history per item and overall, newest first.
- Low-stock alerts against a reorder level.
- Admin UI (list, create/edit item, record movement, view history, alerts) behind the existing admin password.
- Backup + Excel mirroring and rebuild, following existing conventions.
- Delivered as a file-present premium plugin under `src/plugins/features/`.

Explicitly OUT of MVP:
- Multi-location / multi-warehouse stock.
- Barcode scanning, batch/lot/expiry tracking, serial numbers.
- Automatic stock deduction driven by ticket sales (no product-to-service mapping in the base POS).
- Migrating existing firewood/`wood_purchases` into inventory (firewood stays an expense; see OPEN DECISION D5).
- Supplier master records as a managed entity (supplier is a free-text field on stock-in only; a supplier table is a post-MVP option — see OPEN DECISION D6).
- Purchase orders, receiving workflows, approvals.

#### 3. INVENTORY ITEMS

An inventory item represents a single stock-keeping thing that is counted in one unit.

Required fields:
- `name` (TEXT, non-empty, unique among non-deleted items — see edge cases).
- `unit` (TEXT — see UNITS).
- `active` (INTEGER 0/1, default 1) — soft enable/disable, mirroring `categories.active`.

Optional fields:
- `reorder_level` (REAL, nullable) — threshold for low-stock alert; null = no alert.
- `unit_cost` (REAL, nullable) — most-recent/standard cost per unit, used for valuation. Whether this auto-updates on purchase is OPEN DECISION D3.
- `notes` (TEXT, nullable).

Derived (never stored as source of truth):
- `current_stock` — computed from `inventory_movements` (see STOCK BALANCE).

Arbitrary item types: MVP supports a flat list of items with a free-form `unit`. There is no separate "item type/category" taxonomy in MVP (kept out to match the lean base POS). An optional `category` grouping field is OPEN DECISION D7.

#### 4. UNITS

- Unit is a free-text field on the item (TEXT), matching how `expense_templates.unit` is already a free-text TEXT column. No fixed enum is imposed.
- Recommended defaults offered in the UI dropdown (with free-text override): `قطعة` (piece), `كغ` (kg), `لتر` (liter), `علبة` (box/pack). This is a UI convenience only; storage remains free text.
- Units are NOT independently configurable as a managed list in MVP (no units table); they are just whatever strings owners type/pick per item.
- Quantities are stored as `REAL` (consistent with `wood_purchases.net_wood_weight` and money columns), allowing fractional units (e.g. 2.5 kg).
- Precision rule: store the `REAL` as entered; round only for display (2 decimal places in UI, matching money display). No server-side rounding of stored quantities. Reject non-finite values.

#### 5. STOCK MOVEMENTS

All stock changes are rows in a single append-only ledger `inventory_movements`. Current stock is always the signed sum of movement quantities for an item. Movements are the audit trail; they are not edited in place.

Movement types (`movement_type`):

1. `in` — Stock-in / purchase / receive.
   - Direction: increases stock (positive quantity).
   - Required fields: `item_id`, `quantity` (> 0), `date`, `time`.
   - Optional: `unit_cost`, `supplier` (free text), `note`.
   - Financial effect: depends on OPEN DECISION D1 (whether it creates an `expenses` row). Default recommendation: creates a linked expense.
   - Note required: no (note optional; supplier/cost recommended for purchases).
   - Reversible/editable: not editable in place. Corrected by recording an `adjustment` (or a compensating movement). Deleting a movement is admin-only and audit-logged (see HISTORY).

2. `out` — Stock-out / usage / consumption.
   - Direction: decreases stock (negative effect; quantity stored positive, applied as negative).
   - Required fields: `item_id`, `quantity` (> 0), `date`, `time`.
   - Optional: `note`, `reason`.
   - Financial effect: none (usage of already-purchased stock is not a new expense; the expense happened at purchase). See OPEN DECISION D1/D2 for the alternative model.
   - Note required: no.
   - Reversible/editable: not editable in place; correct via adjustment.
   - Must not drive stock negative (see STOCK BALANCE).

3. `adjustment` — Manual correction, loss, damage, wastage, stock-count fix.
   - Direction: either sign. Stored as a signed `quantity` OR as `quantity` + `direction` — see DATABASE note; the spec uses a signed effect.
   - Required fields: `item_id`, `quantity` (non-zero), `direction` (`increase`/`decrease`), `reason`/`note` (REQUIRED — an adjustment must always carry a note explaining it), `date`, `time`.
   - Financial effect: none in MVP (adjustments/wastage do not post to `expenses`). Valuation reports may still reflect the lost value. Posting wastage as an expense is OPEN DECISION D4.
   - Note required: YES.
   - Reversible/editable: not editable in place; correct via a further adjustment.
   - A decrease adjustment must not drive stock negative.

There are no other movement types in MVP.

#### 6. PURCHASES / STOCK-IN

How inventory enters stock: an `in` movement recorded via the inventory UI, with optional `unit_cost` and `supplier`.

Financial coupling — **OPEN PRODUCT DECISION D1** (do not choose silently). The three candidate behaviors:
- (a) Stock-in also creates a linked `expenses` row (mirroring the existing firewood model, which posts an expense and links by `expense_id`). Consequence: purchases show in the daily ledger and reduce cash-in-hand automatically; double-entry risk if the owner also logs the same purchase as a manual expense.
- (b) Stock-in is a pure inventory movement with no financial record. Consequence: no double counting, but inventory purchases no longer appear in expenses/cash-in-hand, diverging from how firewood behaves.
- (c) Stock-in optionally creates an expense via a per-movement checkbox ("سجّل كمصروف"). Consequence: flexible, matches mixed real-world bookkeeping, but adds a decision point for the user and a nullable `expense_id` link.

Recommended default: **(c)** — optional expense link, defaulting to ON, storing `expense_id` when created. It is the only option consistent BOTH with the existing firewood-as-expense precedent AND with avoiding forced double entry. Must be confirmed before implementation.

#### 7. STOCK-OUT / USAGE

How stock leaves inventory in MVP: **manually entered** `out` movements (owner/teller records "used 3 قطعة صابون"). Usage is purely an inventory movement with NO expense and NO automatic tie to tickets or any business operation (the base POS has no product-to-service mapping, so automatic deduction is out of scope — see SCOPE and OPEN DECISION D8). A `reason`/`note` is optional. Usage never creates a financial transaction because the money already left at purchase time.

#### 8. STOCK ADJUSTMENTS

Adjustments cover corrections, losses, damaged goods, and wastage. Rules:
- An adjustment always has an explicit `direction` (increase or decrease) and a REQUIRED note/reason.
- A decrease adjustment is validated against current stock and rejected if it would produce a negative balance (same rule as `out`).
- Adjustments do not post to `expenses` in MVP (OPEN DECISION D4 covers wastage-as-expense).
- Every adjustment is audit-logged with the reason in `details`.
- Recommended fixed reason options in the UI (free-text note still required): `تصحيح جرد` (count correction), `تلف` (damage), `ضياع` (loss), `أخرى` (other).

#### 9. STOCK BALANCE

Authoritative calculation (server-side, from the ledger — never a stored running field as source of truth):

```
current_stock(item) =
    SUM(quantity)  WHERE movement_type = 'in'
  − SUM(quantity)  WHERE movement_type = 'out'
  + SUM(CASE WHEN direction = 'increase' THEN quantity ELSE −quantity END)
                   WHERE movement_type = 'adjustment'
```

Negative-stock protection (intended and enforced):
- Any `out` or decrease `adjustment` is checked against `current_stock` BEFORE writing.
- If the requested deduction exceeds available stock, the operation writes NOTHING and returns `{ success: false, error: 'الكمية المطلوبة أكبر من المخزون المتوفر' }` (mirrors the Float "amount exceeds balance" behavior). No clamping, no partial deduction, no negative balance is ever persisted.
- Zero or negative or non-finite quantities are rejected before any stock check.
- Optional convenience: a `balance_after` column may be stored per movement (as `change_float.balance_after` does) for history display, but the SUM formula remains authoritative.

#### 10. HISTORY / AUDIT

- The `inventory_movements` ledger IS the history. It is append-only in normal operation.
- History query returns movements newest-first (`ORDER BY timestamp DESC, id DESC`), matching Float/collections ordering. Filterable by `item_id`.
- Required history fields surfaced in UI: date, time, item name, movement type (localized: `إدخال`/`إخراج`/`تعديل`), direction/sign, quantity, unit, resulting balance (if stored), supplier/cost (for `in`), note/reason.
- Audit: every create of an item and every movement calls `storage.logAudit(action, entity, entityId, details)` with entities `inventory_items` and `inventory_movements`, following existing action verbs (`CREATE`/`UPDATE`/`DELETE`). Item enable/disable is `UPDATE`. Movement deletion (admin-only) logs full movement details before deletion and is retained in backups.

#### 11. ADMIN UI

- Location: inside the existing admin panel (behind `settings:verifyAdminPassword`), consistent with Float. Add an `admin-actions` button "📦 إدارة المخزون" that opens an inventory modal/section. Optionally add an `admin-stat-card` showing count of low-stock items.
- Item list: table of items with name, unit, current stock, reorder level, low-stock flag, active toggle.
- Item creation/editing: form for name, unit (dropdown + free text), reorder level (optional), unit cost (optional), notes; edit reuses the same form. Deactivate rather than hard-delete when the item has movement history (see edge cases).
- Current stock: shown per item in the list, computed live.
- Stock movement interface: pick item, choose movement type (`in`/`out`/`adjustment`), enter quantity, plus type-specific fields (supplier/cost for `in`; reason for `adjustment`); submit calls the corresponding IPC.
- History: per-item history view (and/or a global movements view), newest first, with localized labels.
- Alerts: visual low-stock indicator in the list and a summary count; item is "low" when `reorder_level` is set and `current_stock <= reorder_level`.
- Reports: minimal report views per REPORTING.
- Permissions: all inventory actions live in the admin area gated by the admin password. No separate role system exists; do not invent one.

#### 12. REPORTING

Minimum useful reports (read-only, computed from the ledger):
- Current stock report: all active items with current stock, unit, and (if `unit_cost` set) line valuation `current_stock * unit_cost`, plus a total inventory valuation.
- Low-stock report: items where `reorder_level` is set and `current_stock <= reorder_level`.
- Movement history report: filter by item and/or date range, newest first.
Inventory valuation uses `unit_cost` when present; items without a cost contribute 0 to valuation and are flagged as "uncosted". Valuation method (latest cost vs average) is tied to OPEN DECISION D3.

#### 13. BACKUP / EXCEL

Follow the established mirror pattern exactly:
- BackupManager: add `addInventoryItem(item)` and `addInventoryMovement(movement)` writing `inventory_items.{csv,json,txt}` and `inventory_movements.{csv,json,txt}` via `appendToCSV/appendToJSON/appendToTXT`, and call `updateHTML()`. Include both in `rebuildFromDatabase(storage)`. (Note: BackupManager is not in the plugin context, so mirroring is wired in the `main-working.js` IPC handlers, exactly like tickets/expenses/float.)
- ExcelManager: add Arabic-named RTL worksheets — proposed `المخزون` (items) and `حركات المخزون` (movements) — created in `initialize()` with a `createInventoryItemsSheet()` / `createInventoryMovementsSheet()`, styled header row, `addRow` per record, `save()` after, and a missing-sheet guard (create-on-demand) like `addFloatOperation`. Include both in `rebuildFromDatabase(storage)`.
- CloudSync: optional `syncInventoryItem` / `syncInventoryMovement` (non-blocking) may be added to match the pattern; not required for MVP if cloud sync is unconfigured.

#### 14. DATABASE

Proposed schema (only after the rules above; follows existing SQLite conventions). Two tables:

```sql
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  reorder_level REAL DEFAULT NULL,
  unit_cost REAL DEFAULT NULL,
  notes TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL,          -- 'in' | 'out' | 'adjustment'
  direction TEXT,                       -- 'increase' | 'decrease' (required for adjustment; implied for in/out)
  quantity REAL NOT NULL,               -- always stored positive; sign derived from type/direction
  balance_after REAL,                   -- optional convenience snapshot (SUM formula remains authoritative)
  unit_cost REAL DEFAULT NULL,          -- for 'in'
  supplier TEXT,                        -- free text, for 'in'
  reason TEXT,                          -- for 'adjustment'
  note TEXT,
  expense_id INTEGER,                   -- set only if stock-in created a linked expense (OPEN DECISION D1)
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_date ON inventory_movements(date);
```

Relationships: each movement belongs to one item (`item_id` FK). An `in` movement may optionally link to an `expenses` row (`expense_id` FK) if D1 resolves to (a) or (c). Current stock is derived by aggregating movements; `inventory_items` stores no authoritative quantity column. `clearAllData()` in StorageManager must also clear `inventory_items` and `inventory_movements` (guarded with try/catch like `wood_purchases`, since tables may not exist on older installs) to stay consistent with clearing all transactional history.

Table creation ownership is OPEN DECISION D9 (plugin `initialize()` vs StorageManager core), because backup/Excel mirroring lives in core `main-working.js` and `clearAllData` must reference the tables.

#### 15. PLUGIN ARCHITECTURE

Delivered as a file-present plugin folder `src/plugins/features/inventory-management/`. Include only what the verified architecture actually uses:

```
src/plugins/features/inventory-management/
├── plugin.json          # id: "inventory-management", name, version, entryPoint: "main.js",
│                        #   licenseRequired: true (metadata only; loading is by file presence),
│                        #   author, description
├── main.js              # exports a class with initialize(context) / shutdown();
│                        #   receives { database/storage, licensing, events, config, logger, excel }
├── database/            # schema + queries (item/movement CRUD, balance calc) — see D9 on ownership
├── services/            # business logic (validation, balance, valuation, alerts)
└── ui/                  # renderer fragments/assets IF used (note: context.ui is null today; the
                         #   established pattern injects UI directly into hammampos.html instead)
```

- `interfaces/` is NOT created per-plugin (interfaces live in `src/plugins/core/interfaces/`).
- There is NO `registry/` folder to create; the DB `plugin_registry` table is managed by core.
- Because `context.ui` is `null` and the renderer is a single HTML file with no build step, the practical integration is: plugin provides main-process services/IPC, and the inventory UI is added into `hammampos.html` alongside the existing admin UI (same as Float). Whether inventory IPC handlers live in the plugin or in `main-working.js` is OPEN DECISION D10 (the current app registers all IPC and all backup/Excel mirroring in `main-working.js`, and BackupManager is not exposed to plugins).

#### 16. LICENSING

- Use the EXISTING mechanism only. As a paid add-on, `inventory-management` is gated by **file presence**: Ali's builds and paying clients receive the plugin folder; others do not. This matches `PluginManager.loadPlugin()`'s documented "you install = it loads" behavior.
- `plugin.json` may set `licenseRequired: true` as metadata, but no new runtime license enforcement is invented. If/when the existing `LicenseManager` gating is switched on globally, inventory would use the same per-feature `.license` flow with `featureId = "inventory-management"` — no new licensing system.

#### 17. FAILURE / EDGE CASES

- Invalid quantity (non-numeric / non-finite): reject before any DB write → `{ success: false, error: 'الكمية غير صالحة' }`.
- Zero / negative quantity: rejected (quantities must be > 0; adjustments must be non-zero with an explicit direction).
- Insufficient stock (`out` or decrease adjustment beyond balance): reject, write nothing, return the "exceeds available stock" error. Never persist negative stock.
- Deleted / disabled item: cannot record new movements against an `active = 0` item (return error); history for it remains viewable. Prefer deactivate over delete.
- Deleting an item that has movements: block hard delete (FK + history integrity) and require deactivation instead; only allow hard delete when the item has zero movements, and audit-log it.
- Malformed data (missing item_id, unknown movement_type, adjustment without direction/reason): reject with a specific error; do not write partial rows.
- Duplicate item name: reject creating a second active item with the same `name` (case/whitespace-trimmed) → `{ success: false, error: 'صنف بنفس الاسم موجود مسبقاً' }`.
- Database failure on write: follow existing behavior — the operation surfaces the error; `save()` failures are logged (StorageManager catches and logs save errors). Never report success on a failed write.
- Backup failure: mirror the existing tolerance — backup/Excel writes are wrapped in try/catch in the IPC handler and MUST NOT fail the primary DB operation (tickets/expenses/float behave this way). The DB remains the master record.
- Excel failure: same as backup — logged and swallowed; a missing worksheet is created on demand (as `addFloatOperation` does).

#### 18. ACCEPTANCE CRITERIA (implementation-ready, objectively testable)

1. Creating an item persists a row in `inventory_items` and an `audit_log` CREATE entry; it survives app restart.
2. Duplicate active item name is rejected with the Arabic error and writes nothing.
3. Recording `in` 10 then `in` 5 yields `current_stock = 15` via the balance formula.
4. Recording `out` 4 against stock 15 yields `current_stock = 11`.
5. `out` exceeding current stock is rejected, writes nothing, returns the "exceeds available stock" error, and leaves stock unchanged.
6. Zero, negative, and non-finite quantities are rejected for all movement types.
7. An `adjustment` requires a direction and a note; missing either is rejected.
8. A decrease adjustment beyond stock is rejected (no negative balance).
9. Low-stock flag is true exactly when `reorder_level` is set and `current_stock <= reorder_level`.
10. History returns movements newest-first with localized type labels and correct signs.
11. Every movement writes an `audit_log` entry with entity `inventory_movements`.
12. Each item/movement is mirrored to BackupManager (`inventory_items.*`, `inventory_movements.*`) and ExcelManager worksheets; `rebuildFromDatabase` reconstructs both from the DB.
13. `clearAllData()` clears both inventory tables and logs the clear.
14. If D1 = (a)/(c): a stock-in that creates an expense inserts a linked `expenses` row and stores its `expense_id`, and it appears in the daily ledger; if the expense is not created, `expense_id` is null and cash-in-hand is unaffected.
15. Backup/Excel failures do not fail or roll back the primary DB write.
16. The plugin loads purely by presence of `src/plugins/features/inventory-management/` (no license key required to function), and does not load when the folder is absent.
17. Inventory admin actions are reachable only after admin-password verification.
18. Current-stock, low-stock, and valuation reports match hand-computed values from the movement ledger on a seeded dataset.

#### OPEN PRODUCT DECISIONS (must be resolved before implementation)

Only decisions that cannot be established from the existing repository/business requirements are listed. These are NOT requirements and must be decided first.

- **D1 — Does stock-in create an expense?**
  - Options: (a) always create a linked expense; (b) never (pure movement); (c) optional per-movement checkbox, default ON.
  - Consequence: (a) matches firewood precedent and keeps the ledger complete but risks double-entry; (b) avoids double counting but diverges from firewood and hides purchase spend from cash-in-hand; (c) flexible, needs a nullable `expense_id` and one UI toggle.
  - Recommended default: (c). Defensible because it is the only option consistent with both the firewood-as-expense precedent and avoiding forced double entry.
  - Must decide before implementation: yes — drives `expense_id`, mirroring, and cash-in-hand behavior.

- **D2 — Is stock-out ever financial?** Options: (a) never (recommended, since money left at purchase); (b) post a cost-of-goods entry. Consequence: (b) introduces accounting the base app does not do. Recommended: (a). Decide before implementation: yes (affects whether `out` touches `expenses`).

- **D3 — Valuation / unit_cost method.** Options: (a) latest cost (overwrite `unit_cost` on each `in`); (b) weighted average; (c) manual only (cost never auto-updates). Consequence: (b) is more accurate but more complex; (a)/(c) are simple. Recommended: (a) latest-cost. Decide before implementation: yes (affects `in` handler and reports).

- **D4 — Do wastage/loss adjustments post an expense?** Options: (a) no (MVP recommended); (b) yes, decrease adjustments with a loss reason create an expense. Consequence: (b) reflects true cost of loss but adds financial coupling. Recommended: (a). Decide before implementation: yes.

- **D5 — Firewood integration.** Options: (a) leave `wood_purchases` untouched, firewood stays an expense (recommended); (b) migrate firewood into inventory as an item with stock. Consequence: (b) is a data migration and changes existing behavior. Recommended: (a). Decide before implementation: yes (scope boundary).

- **D6 — Suppliers as a managed entity?** Options: (a) free-text `supplier` on `in` only (MVP recommended); (b) a `suppliers` table with FK. Consequence: (b) enables supplier reports but adds CRUD/UI. Recommended: (a). Decide before implementation: yes (schema).

- **D7 — Item grouping/category field?** Options: (a) none (flat list, recommended); (b) add optional `category` TEXT for grouping. Consequence: (b) helps larger catalogs. Recommended: (a) for MVP. Decide before implementation: yes if UI grouping is wanted.

- **D8 — Auto-deduct stock on ticket sale?** Options: (a) no (MVP recommended — base POS has no product-to-service mapping); (b) map products to services and auto-deduct. Consequence: (b) is a large feature touching the core POS. Recommended: (a). Decide before implementation: yes (scope boundary).

- **D9 — Who creates the inventory tables?** Options: (a) plugin `initialize()` creates them via `context.database`; (b) StorageManager core creates them (like other tables). Consequence: core mirroring (`main-working.js` backup/Excel) and `clearAllData` reference these tables, so (b) is simpler/safer; (a) keeps the plugin self-contained but risks ordering issues. Recommended: (b) or a hybrid (plugin owns logic, core owns schema + clearAllData). Decide before implementation: yes.

- **D10 — Where do inventory IPC + mirroring live?** Options: (a) in `main-working.js` alongside all other IPC and backup/Excel mirroring (matches current app; BackupManager is not in plugin context); (b) inside the plugin. Consequence: (a) is consistent with the codebase and gives access to BackupManager; (b) is more encapsulated but cannot reach BackupManager as context stands. Recommended: (a), or extend the plugin context to include BackupManager if (b) is desired. Decide before implementation: yes.

#### Implementation Readiness

- Specification: COMPLETE.
- Blocking: 10 OPEN PRODUCT DECISIONS (D1–D10) — chiefly D1 (expense coupling), D9 (schema ownership), and D10 (IPC/mirroring location). Once these are decided, this spec is directly implementable following the Float feature as the reference pattern.
- Not implemented: no source code, no schema, no version bump, no release created by this task.
