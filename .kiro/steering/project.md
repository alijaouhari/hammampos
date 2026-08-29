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
