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

## Add-Ons — Planning (Employees, Deferred Expenses)

Two features are being specified together as ADD-ONS. Beyond their own value, they are the deliberate test of whether the HammamPOS add-on architecture is production-ready. Neither is implemented by this task; no source code, `package.json`, version, or release was changed. Terminology follows existing conventions (صندوق الصرف / expenses / collections / cash-in-hand / audit_log / mirror pattern).

Legend used below:
- **FACT** = verified from the current repository.
- **USER** = explicitly stated by the user.
- **NECESSARY** = logically required to deliver the USER behavior given the FACTS.
- **OPEN DECISION** = a product choice the user has not made; must not be invented.
- **UNDEFINED** = neither defined in the repo nor stated by the user; must not be filled with assumptions.

### Shared Add-On Architecture Findings

- **FACT — the add-on system is partial scaffolding, wired but unproven.** `PluginManager` and `LicenseManager` are instantiated in `main-working.js:initializeServices()` and `loadAllPlugins()` runs at startup. But `src/plugins/features/` is empty, so the loader has **never actually loaded a real plugin in production**. The Inventory spec already recorded this. The two aspirational docs are inaccurate: no `PluginLoader.js`, no `registry/` dir; real core files are `PluginManager.js`, `LicenseManager.js`, `interfaces/Plugin.js`.
- **FACT — gating is by file presence, not license enforcement.** `loadPlugin()` loads any folder present; it does not call `LicenseManager.validateLicense()`. The base `hammampos-core` check is bypassed for testing. So "add-on = ship the folder"; `licenseRequired` in `plugin.json` is currently metadata only.
- **FACT — the plugin context is thin and cannot reach key core services.** Context passed to plugins is `{ database, ui: null, licensing, events, config, logger, storage, excel }`. It **does NOT include BackupManager**, and `ui` is `null`. Meanwhile every existing feature registers its IPC handlers AND its BackupManager/ExcelManager/CloudSync mirroring **directly in `main-working.js`** (see tickets, expenses, collections, float). The renderer is a single `hammampos.html` with no build step and no plugin UI-injection mechanism.
- **FACT — there is no IPC bridge from a plugin to the renderer.** All `ipcMain.handle('ns:action', …)` handlers live in `main-working.js`; the renderer calls them via `api.<ns>.<action>`. A plugin's `main.js` class has no established way to register IPC or add DOM.
- **CONCLUSION — can the current add-on architecture support these two features without core changes?** Partially. A plugin can create its own tables via `context.database` and hold business logic. But to match every existing convention (teller/admin UI in `hammampos.html`, IPC handlers, and Backup+Excel+Cloud mirroring), **core files must still be edited** because: (1) BackupManager is not in the plugin context; (2) the renderer has no plugin-UI hook; (3) `clearAllData()` and `rebuildFromDatabase()` live in core and must know the new tables. So the honest finding is: **the add-on system is production-ready enough to isolate a plugin's data/logic, but NOT yet production-ready for a self-contained UI+mirroring add-on.** This is the central architecture decision the two features exist to force — see OPEN DECISION A1–A4 below.

Shared add-on OPEN DECISIONS (apply to BOTH features):
- **A1 — What does "add-on" mean operationally?** Options: (a) a real loaded plugin under `src/plugins/features/<id>/` with `initialize(context)`; (b) a feature-flag/settings toggle inside core (like everything shipped so far), delivered by file presence of its module; (c) hybrid — plugin owns schema+logic, core owns IPC+UI+mirroring. Consequence: (a) truly tests the plugin system but hits the context/UI gaps above; (b) is the proven pattern but does not test the add-on system the user wants to validate; (c) tests the system while staying shippable. Recommended: (c). Decide before implementation: yes — this is the whole point of the experiment.
- **A2 — Should the plugin context be extended to include BackupManager (and a UI-registration hook)?** Options: (a) yes, extend context (a real core change enabling self-contained add-ons); (b) no, keep mirroring in `main-working.js`. Consequence: (a) is the investment that makes future add-ons self-contained; (b) keeps add-ons dependent on core edits. Recommended: decide alongside A1. This is a genuine core-architecture change and must be an explicit decision, not assumed.
- **A3 — How is an add-on enabled/disabled/uninstalled, and what happens to its data?** Options: (a) folder present = enabled, remove folder = disabled but tables/data remain (safe, matches file-presence gating); (b) explicit enable/disable setting; (c) uninstall also drops tables (destructive). Consequence: base UI must degrade gracefully when the add-on is absent (buttons hidden, no broken IPC calls). Recommended: (a) — disabling hides UI and stops new writes but preserves data and audit trail; never auto-drop tables. Decide before implementation: yes.
- **A4 — Licensing.** Use the EXISTING mechanism only (file presence; optional `licenseRequired: true` metadata; per-feature `.license` + `featureId` if global gating is later switched on). Do NOT invent a new licensing mechanism. `featureId` values proposed: `employees`, `deferred-expenses`.

---

### Employees Add-On (الموظفون / العمال) — SPECIFICATION REQUIRED

Status: **SPECIFICATION REQUIRED**. Blocked on OPEN DECISIONS below. Purpose: track employees, their working days, sick days, vacation days, and weekly pay (paid weekly, typically Sunday). Also serves as the first real test of the add-on architecture.

#### Employees — Facts, Requirements, Necessities

- **FACT** — No employee/attendance/payroll concept exists anywhere in the repo today (no tables, IPC, or UI). Nearest financial precedent: expenses (wages `أجر صاحب الصندوق`, `أجر الفرناتشي` exist only as expense templates — free-text payroll today).
- **USER** — Create employees to track them.
- **USER** — Track working days, sick days, vacation days.
- **USER** — Employees are usually paid weekly, every Sunday (weekly pay cycle anchored on Sunday).
- **USER** — Explicitly an add-on and a test of the add-on system.
- **NECESSARY** — An employee record with a stable id and a display name (needed to attach attendance and payments).
- **NECESSARY** — Active/inactive flag (mirrors `categories.active`) so ex-employees stop appearing without deleting history.
- **NECESSARY** — A day-level attendance record keyed by (employee, date) with a status among at least {worked, sick, vacation} — the three the user named. A per-day record is required to count working/sick/vacation days.
- **NECESSARY** — A payment record (employee, pay period, amount, paid date) with history, because the user wants pay weeks tracked and payments are events distinct from attendance.
- **NECESSARY** — A defined pay-week boundary because "every Sunday" only has meaning against a fixed week definition (see OPEN DECISION E4).
- **NECESSARY** — Audit entries for create/update/delete of employees, attendance, and payments (existing `logAudit` convention).

#### Employees — Data Model (proposed, only after rules)

```sql
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,                         -- optional free text (e.g. فرناتشي); NOT a managed role system
  active INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  date TEXT NOT NULL,                -- YYYY-MM-DD
  status TEXT NOT NULL,              -- 'worked' | 'sick' | 'vacation' (see E1)
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS employee_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,        -- YYYY-MM-DD (week start)
  period_end TEXT NOT NULL,          -- YYYY-MM-DD (week end / Sunday)
  amount REAL NOT NULL,
  paid_date TEXT NOT NULL,           -- YYYY-MM-DD actually paid
  expense_id INTEGER,               -- set only if payment also posts an expense (see E5)
  note TEXT,
  date TEXT NOT NULL, time TEXT NOT NULL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id)
);

CREATE INDEX IF NOT EXISTS idx_employee_attendance_date ON employee_attendance(date);
CREATE INDEX IF NOT EXISTS idx_employee_payments_paid_date ON employee_payments(paid_date);
-- Uniqueness of (employee_id, date) for attendance is enforced in the write layer (see E2).
```

#### Employees — Relationship between attendance and payment

- **UNDEFINED / OPEN DECISION E3** — Whether the weekly `amount` is computed from attendance (e.g. worked-days × daily rate) or entered manually. The user did NOT state a rate, a salary, or that pay depends on attendance. Attendance and payment are therefore modeled as **independent records** unless the user decides otherwise. The amount is entered by the admin at payment time by default; any automatic computation is E3.

#### Employees — Permissions

- **FACT** — The app has exactly two levels: unauthenticated teller (header) and admin (password-gated dashboard).
- **NECESSARY/RECOMMENDED** — Employee management (create/edit/deactivate, record payment) is **admin-only** (payments are money movements, consistent with collections/float being admin-only). Attendance entry placement is OPEN DECISION E6 (admin-only vs teller daily check-in).

#### Employees — Audit / Backup / Excel / IPC / UI

- **Audit**: `logAudit('CREATE'|'UPDATE'|'DELETE', 'employees'|'employee_attendance'|'employee_payments', id, details)`.
- **Backup/Excel**: follow the mirror pattern — `backupManager.addEmployee/addAttendance/addPayment` (CSV/JSON/TXT + `updateHTML`) and ExcelManager Arabic RTL sheets (proposed `الموظفون`, `الحضور`, `أجور الموظفين`), included in `rebuildFromDatabase`. Wired in `main-working.js` unless A2 changes the context.
- **IPC/API**: namespace `employees:` — e.g. `employees:list`, `employees:create`, `employees:update`, `employees:setActive`, `employees:setAttendance`, `employees:getAttendance`, `employees:recordPayment`, `employees:getPayments`, `employees:getWeekSummary`. Exposed as `api.employees.*`.
- **UI placement**: an admin-dashboard button "👷 الموظفون" opening an employees modal/section (list + add/edit, weekly attendance grid, record-payment form, payment history). Follows the Float/admin pattern. `context.ui` is null, so UI is added into `hammampos.html` directly (see A1/A2).
- **If add-on disabled/uninstalled**: the "الموظفون" button and IPC are absent; base app is unaffected; tables/data and audit remain (per A3). Base UI must not call employee IPC when the add-on is absent.

#### Employees — Must NOT be invented

Per the user: do NOT invent salaries, hourly/daily rates, overtime, deductions, bonuses, advances, Moroccan labor-law rules, CNSS, contracts, payroll taxes, or end-of-service. None exist in the repo or the user's statement. Each is an OPEN DECISION or UNDEFINED, never a silent requirement.

#### Employees — OPEN PRODUCT DECISIONS

- **E1 — Attendance status set.** User named worked/sick/vacation. Are those the only statuses, or also {absent (unexcused), holiday, half-day}? Options: (a) exactly the three named (recommended MVP); (b) add absent/holiday. Consequence: affects reporting and any attendance-based pay. Decide before implementation: yes.
- **E2 — One record per employee per day?** Options: (a) yes, `setAttendance` upserts (recommended); (b) allow multiple. Consequence: (a) needs upsert + uniqueness enforcement. Decide: yes.
- **E3 — Is weekly pay computed from attendance or entered manually?** Options: (a) manual amount entered at payment (recommended — no rate exists); (b) computed from a per-employee rate × worked days (requires inventing a rate → also E7). Consequence: (b) pulls in rate/salary which the user said not to invent. Decide: yes.
- **E4 — Pay-week definition.** "Every Sunday" — is the week Mon–Sun paid on Sunday, or Sun–Sat, and is Sunday the period_end or the paid_date? Options: (a) week = Monday–Sunday, paid on/after the Sunday (recommended, matches "paid every Sunday"); (b) other boundary. Consequence: drives `period_start/period_end` and week grouping. Decide: yes.
- **E5 — Does a payment post to `expenses` (and thus cash-in-hand)?** Options: (a) yes, create a linked `expenses` row (`expense_id`), consistent with wages being expenses today (recommended); (b) no, payments tracked only in `employee_payments`. Consequence: (a) keeps wages in the ledger/cash-in-hand and daily summary; (b) hides wages from cash-in-hand. **This also intersects Deferred Expenses** (a wage owed-but-unpaid is itself a deferred expense). Decide: yes.
- **E6 — Who records attendance?** Options: (a) admin-only (recommended MVP); (b) teller daily check-in from the header. Consequence: teller access widens the surface but eases daily use. Decide: yes.
- **E7 — Required employee fields beyond name.** Is `role`/phone/hire-date required or optional? Options: (a) name required, role/notes optional (recommended); (b) more required fields. Consequence: form + validation. Decide: yes.
- **E8 — Partial weeks / mid-week hire or leave, and editing past attendance.** How far back can attendance be edited, and by whom? Options: (a) admin may edit any date, audited (recommended); (b) lock past weeks once paid. Decide: yes.

#### Employees — Acceptance Criteria (implementation-ready, testable)

1. Creating an employee persists a row and a CREATE audit entry; survives restart.
2. Deactivating an employee hides them from active lists but preserves attendance/payment history.
3. Setting attendance for (employee, date) with status worked/sick/vacation persists exactly one record per day (upsert per E2) and is audited.
4. A week summary returns correct counts of worked/sick/vacation days for the defined pay week (E4).
5. Recording a payment persists period_start/period_end/amount/paid_date and appears in payment history newest-first.
6. If E5=(a): the payment inserts a linked `expenses` row, appears in the daily ledger, and reduces cash-in-hand exactly once; if E5=(b): cash-in-hand is unaffected and no expense is created.
7. Employee/attendance/payment records are mirrored to BackupManager and ExcelManager; `rebuildFromDatabase` reconstructs them.
8. `clearAllData()` clears employee tables (guarded) and logs the clear.
9. Employee management actions are reachable only after admin-password verification (attendance per E6).
10. With the add-on folder absent, the base app runs unchanged, exposes no employee UI, and makes no employee IPC calls.

---

### Unpaid / Deferred Expenses Add-On (المصاريف المؤجلة) — SPECIFICATION REQUIRED

Status: **SPECIFICATION REQUIRED**. Blocked on OPEN DECISIONS below. Purpose: let an expense be recorded (the obligation exists) without reducing cash-in-hand until it is actually paid, while still tracking it as an outstanding obligation. The user wants to determine if this solves a real operational problem or is unnecessary complexity.

#### Deferred Expenses — Current behavior (FACTS to change)

- **FACT** — `StorageManager.addExpense(description, amount)` writes to `expenses(description, amount, date, time, timestamp)` immediately. There is no payment status and no payment date; **date = the day it was entered = treated as paid**.
- **FACT** — `getCashInHand() = SUM(tickets.price) − SUM(expenses.amount) − SUM(collections.amount)`. **Every expense reduces cash-in-hand the instant it is created.**
- **FACT** — `getDailySummariesWithDetails()` groups `expenses` by `date` and feeds the per-day amounts shown in the admin Money-Collection modal (revenue − expenses per day). So expenses also affect what appears collectible per day.
- **FACT** — The expense modal ("إضافة مصروف") is a **teller-facing header button** (not admin-gated) with types template/custom/wood. There is **no** same-day checkbox or payment-date field today.
- **FACT** — Deletions are admin-only and audited; deleted rows are kept in backups for the audit trail. There is no "edit expense" path today.

#### Deferred Expenses — State model (the core of this feature)

The user's requirement is operational accuracy: distinguish **"we owe this"** from **"we already paid this."** The minimum model separates the following states for a single expense:

1. **Incurred / obligation created** — the expense is entered; description + amount + the date it was incurred are recorded. This does NOT necessarily mean cash left.
2. **Unpaid (outstanding)** — obligation exists, `paid = 0`, no cash movement yet. Must NOT reduce cash-in-hand. Must appear in an "outstanding obligations" view and in expense reporting as incurred-but-unpaid.
3. **Paid** — `paid = 1` with a `paid_date`; at this moment (and only this moment) the amount reduces cash-in-hand.
4. **Cash actually leaving the business** — equals the sum of PAID expenses (plus collections). This is what cash-in-hand and the "money actually paid out" review must reflect.

Minimum fields required to represent this (added to expenses via the add-on; ownership per DX8):
- `paid` (INTEGER 0/1, default 1 for backward compatibility — existing rows are paid).
- `paid_date` (TEXT YYYY-MM-DD, nullable; set when paid).
- `due_date` (TEXT YYYY-MM-DD, nullable; the intended future payment date, optional).
- `same_day` (INTEGER 0/1) — the teller's at-entry decision that this was paid the same day; immutable by the teller (see immutability analysis).

Distinctions the model MUST preserve (and must NOT collapse):
- **expense/invoice date ≠ payment date.** `date` (incurred) is independent of `paid_date`.
- **amount in expense reporting** = all incurred expenses (paid + unpaid), so the owner sees total obligations.
- **amount affecting cash-in-hand** = only PAID expenses. This requires changing `getCashInHand()` and the daily-summary/collection amounts to subtract only `WHERE paid = 1` (see DX1 for exactly which surfaces change).
- **outstanding obligations** = `SUM(amount) WHERE paid = 0`, shown separately.

#### Deferred Expenses — Worked example (user's plumber scenario)

- **Day 1** — Plumber starts; expense incurred (`date = Day1`, `amount`, `paid = 0`, `due_date` optional). Hammam stays open. Cash-in-hand is **unchanged** (unpaid). The obligation shows in the outstanding list.
- **Day 2** — Plumber still working, still unpaid. State unchanged: `paid = 0`, cash-in-hand still unchanged. It is one obligation, not two (no double counting).
- **Payment day** — Admin marks it paid: `paid = 1`, `paid_date = payment day`. **Now** cash-in-hand decreases by `amount`; the obligation moves from outstanding to paid; expense reporting still shows the original incurred date, and the cash movement is dated `paid_date`.

Same-day path: if the teller checks "نفس اليوم / Same Day" at entry, the expense is created `paid = 1`, `paid_date = date`, `same_day = 1` — identical to today's behavior, immediately reducing cash-in-hand.

#### Deferred Expenses — Immutability analysis (teller cannot change the same-day decision)

- **USER** — After entry, the teller must NOT be able to modify the same-day/paid decision.
- **NECESSARY** — Since expenses are teller-created and there is no edit path today, the add-on must treat `same_day`/`paid` as **immutable at the teller level** once written. The teller UI provides no control to flip it.
- **NECESSARY (admin correction without destroying the audit trail)** — An authorized admin may need to correct a mistake (e.g. marked paid by error). This must be **non-destructive**: do NOT silently overwrite. Options for the mechanism are DX4; the recommended approach is an audited state transition — admin action writes `paid`/`paid_date` change AND a full `logAudit('UPDATE', 'expenses', id, 'marked paid: <before>→<after> by admin')`, preserving the original incurred record. Marking an unpaid expense as paid (the normal happy path) is itself an admin state transition, always audited. Reversing a payment (paid→unpaid) is the sensitive correction and must be admin-only + audited (DX4).

#### Deferred Expenses — Permissions, Audit, Backup/Excel, IPC, UI

- **Permissions**: teller may CREATE an expense (paid or deferred) — matches today's teller-facing modal. Marking an outstanding expense as **paid** is a money movement → **admin-only** (recommended, consistent with collections/float). Reversing a payment → admin-only + audited.
- **Audit**: creation logs CREATE as today; each pay/unpay transition logs UPDATE with before→after and actor.
- **Backup/Excel**: the new expense fields (`paid`, `paid_date`, `due_date`, `same_day`) must be added to the existing expenses CSV/JSON/TXT columns and the ExpensesExcel sheet, and honored by `rebuildFromDatabase`. A dedicated "outstanding/deferred" view may be added to `summary.html`.
- **IPC/API**: extend the expenses surface — e.g. `expenses:addDeferred` (or extend `storage:addExpense` with paid/due params), `expenses:markPaid`, `expenses:getOutstanding`, `expenses:reversePayment` (admin). Exposed as `api.storage.*` / `api.expenses.*`.
- **UI**:
  - Expense modal gains a "نفس اليوم" (Same Day) checkbox (default checked = paid today) and, when unchecked, an optional payment/due date field.
  - Admin dashboard gains an "outstanding expenses" list with a per-item "تم الدفع اليوم / Mark Paid Today" action (sets `paid=1`, `paid_date=today`).
  - Cash-in-hand and the Money-Collection day amounts reflect only paid expenses (DX1).
- **If add-on disabled/uninstalled**: base behavior must remain correct. Because existing rows default `paid=1`, cash-in-hand math is unchanged when the add-on is off. If the add-on is removed while unpaid rows exist, those rows are `paid=0` and would be excluded from cash-in-hand by core only if the core query was changed — hence DX8 (who owns the schema/query change) is pivotal: a pure plugin cannot alter core `getCashInHand()`.

#### Deferred Expenses — Must NOT be invented

Do NOT invent: accrual accounting, accounts-payable ledgers, supplier credit terms, partial payments, interest, aging buckets beyond a simple outstanding list, or multi-installment schedules — unless the user asks. Partial payment in particular is UNDEFINED (see DX5).

#### Deferred Expenses — OPEN PRODUCT DECISIONS

- **DX1 — Which surfaces must exclude unpaid expenses?** At minimum `getCashInHand()`. Also the Money-Collection per-day amounts and the daily-summary "expenses" column? Options: (a) cash-in-hand counts only paid; daily-summary shows incurred (reporting truth) but collection amounts use paid (recommended); (b) everything uses paid; (c) everything uses incurred (defeats the purpose). Consequence: determines exactly which queries change. Decide: yes (this is the crux).
- **DX2 — What date drives the cash movement and the day it is "collected"?** When an expense is paid later, does it reduce the box on `paid_date` (recommended) or retroactively on the incurred `date`? Consequence: retroactive changes historical days and collection amounts. Decide: yes.
- **DX3 — Default of the Same Day checkbox.** Options: (a) checked/paid by default (recommended — preserves current behavior and avoids accidental deferrals); (b) unchecked. Decide: yes.
- **DX4 — Admin correction mechanism for a wrong same-day/paid decision.** Options: (a) audited state transition that flips `paid`/`paid_date` in place with a mandatory audit note (recommended, non-destructive because the row and its history remain); (b) reversing entry (a compensating record); (c) no reversal allowed. Consequence: (a) is simplest and keeps one row; (b) is more ledger-pure but adds records. Decide: yes.
- **DX5 — Partial payments.** Can an obligation be paid partially? Options: (a) no — paid is all-or-nothing (recommended MVP); (b) yes — needs paid_amount and a payments child table. Consequence: (b) is materially more complex. Decide: yes.
- **DX6 — Backdating / due dates in the past, and reminders.** Is a `due_date` merely informational, or does the system prompt when it arrives ("mark Paid Today")? Options: (a) informational + an outstanding list the admin reviews (recommended MVP); (b) active reminders/notifications. Decide: yes.
- **DX7 — Do deferred wages (Employees E5) use this same mechanism?** A wage owed-but-unpaid is a deferred expense. Options: (a) yes, unify — employee payment marks a deferred expense paid (recommended if both ship); (b) keep separate. Consequence: unification avoids two parallel "owed vs paid" models. Decide: yes (cross-feature).
- **DX8 — Schema/query ownership (core vs plugin).** Because `getCashInHand()`, the daily-summary query, `clearAllData()`, and Backup/Excel mirroring are all in core, the deferred-expense fields and query changes **cannot be delivered by a pure plugin**. Options: (a) implement as core changes gated by a setting/file-presence (recommended, and the honest answer to "is this a real add-on"); (b) extend the plugin context so a plugin can override financial queries (large core change). Consequence: this feature, more than Employees, proves the add-on system's limits. Decide: yes.

#### Deferred Expenses — Acceptance Criteria (implementation-ready, testable)

1. Existing expenses (pre-migration) are treated as paid (`paid = 1`); cash-in-hand is byte-for-byte unchanged versus current behavior when no deferred expenses exist.
2. Creating a same-day expense (checkbox on) sets `paid=1, paid_date=date, same_day=1` and reduces cash-in-hand immediately, exactly as today.
3. Creating a deferred expense (checkbox off) sets `paid=0`, does NOT reduce cash-in-hand, and appears in the outstanding list.
4. Marking a deferred expense paid (admin) sets `paid=1, paid_date=today` and reduces cash-in-hand by exactly the amount, once.
5. Outstanding total = `SUM(amount) WHERE paid=0`, shown separately from cash-in-hand.
6. Expense reporting shows incurred expenses (paid + unpaid) with their incurred date; cash-in-hand and collection amounts reflect only paid (per DX1/DX2).
7. The teller has no control to change `same_day`/`paid` after entry; attempting it is impossible in the teller UI.
8. An admin correction of a paid/unpaid decision writes an `audit_log` UPDATE with before→after and actor, and never deletes the original row (per DX4).
9. New expense fields are mirrored to BackupManager and ExcelManager and reconstructed by `rebuildFromDatabase`.
10. The plumber scenario reproduces exactly: unchanged cash-in-hand on Day 1–2, and a single amount reduction on the payment day.
11. With the deferred-expense capability disabled, all existing expense flows and cash-in-hand math are unchanged.

---

### Add-Ons — Decisions Required Before Implementation (summary)

Must be answered by the user first:
- **A1** (what "add-on" means) and **A2** (extend plugin context / UI hook) — gate BOTH features and are the architecture experiment itself.
- **A3** (enable/disable/uninstall + data retention), **A4** (licensing = existing only).
- Employees: **E1** statuses, **E3** manual vs computed pay, **E4** pay-week definition, **E5** payment→expense coupling, **E6** who records attendance.
- Deferred Expenses: **DX1** which surfaces exclude unpaid (crux), **DX2** cash-movement date, **DX4** admin-correction mechanism, **DX8** core-vs-plugin ownership.
- Cross-feature: **DX7 / E5** — whether deferred wages reuse the deferred-expense mechanism.

### Add-Ons — Recommended Implementation Order

1. **Resolve A1–A4 first** (the add-on architecture decision). Everything else depends on it.
2. **Deferred Expenses before Employees.** Rationale: it is smaller, touches the already-understood expense/cash-in-hand core, directly answers the user's "is this useful or just complexity" question, and (via DX7/E5) provides the "owed vs paid" primitive that employee wage payments can reuse. It also most sharply tests whether the add-on system can support a core-touching feature (DX8).
3. **Employees second**, reusing the deferred mechanism for unpaid wages if DX7=(a).

### Add-Ons — Files That Would Eventually Change (planning only — nothing changed now)

Employees (assuming hybrid A1=(c)):
- New: `src/plugins/features/employees/` (`plugin.json`, `main.js`, `database/`, `services/`).
- `src/services/StorageManager.js` — employee tables (or plugin-owned per DX8), `clearAllData()` guard.
- `src/services/BackupManager.js` — `addEmployee/addAttendance/addPayment` + `rebuildFromDatabase`.
- `src/services/ExcelManager.js` — `الموظفون`/`الحضور`/`أجور الموظفين` sheets + `rebuildFromDatabase`.
- `src/main/main-working.js` — `employees:*` IPC + mirroring wiring.
- `src/renderer/hammampos.html` — admin "الموظفون" button, modals, `api.employees.*`.

Deferred Expenses:
- `src/services/StorageManager.js` — add `paid`/`paid_date`/`due_date`/`same_day` to `expenses`; migration defaulting existing rows to paid; update `getCashInHand()` and `getDailySummariesWithDetails()` (per DX1/DX2); `markExpensePaid`/`getOutstandingExpenses`/`reverseExpensePayment`.
- `src/services/BackupManager.js` and `ExcelManager.js` — new expense columns + `rebuildFromDatabase`.
- `src/main/main-working.js` — `expenses:markPaid`/`getOutstanding`/`reversePayment` IPC (+ extend addExpense params) and mirroring.
- `src/renderer/hammampos.html` — Same Day checkbox + optional date in expense modal; admin outstanding-expenses list with Mark-Paid; cash-in-hand/collection displays honoring paid-only.

### Add-Ons — Can the current architecture support these without core changes?

- **No, not fully.** Both features need renderer UI and, for Deferred Expenses, changes to core financial queries (`getCashInHand`, daily summary) and Backup/Excel — none reachable from the current plugin context (no BackupManager, `ui: null`, no IPC/UI registration hook). Employees could keep its data/logic in a plugin but still needs core edits for UI, IPC, and mirroring.
- **Therefore the realistic delivery is the hybrid (A1=c):** plugin owns schema + business logic where possible; core is edited for IPC, renderer UI, and Backup/Excel mirroring. If the user wants truly self-contained add-ons in future, that requires the deliberate core investment in A2 (extend context + a UI-registration mechanism). This is the concrete outcome the two-feature experiment was designed to surface.

#### Implementation Readiness

- Specifications: COMPLETE for both add-ons.
- Blocking: shared A1–A4 (architecture) plus per-feature decisions above. No source code, schema, version bump, or release was produced by this task.
