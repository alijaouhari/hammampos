# HammamPOS Desktop

Point-of-sale desktop application for Moroccan hammams (bathhouses). HammamPOS is a Windows desktop app built with Electron. A teller sells category tickets that print on a thermal receipt printer, and an admin manages categories, expenses, collections, the daily financial summary, and settings from a password-protected dashboard. All data is stored locally in a SQLite database.

**Current version: 2.8.8** (source of truth: `package.json` `version`).

Arabic (RTL) is the interface language.

---

## Core functionality

All of the following are implemented in the current base product (verified in `src/main/main-working.js`, `src/services/*`, and `src/renderer/hammampos.html`):

- **Category ticketing** — default categories رجال / نساء / أولاد / بنات (created during the setup wizard); admins can add, edit, and activate/deactivate categories.
- **Per-category serial numbering** — each ticket gets an incrementing `serial_number` per category, stamped with the year (printed as `#serial/year`).
- **Thermal printing** — 80mm ESC/POS raster printing via the Windows print spooler (`src/services/PrintManager.js` + `src/services/raw-print.ps1`). The printer is auto-detected or chosen in the setup wizard.
- **Expense management** — free-text expenses, predefined expense templates, and a firewood-purchase helper (`src/services/ExpenseTemplateManager.js`).
- **Collections** — recording money taken out of the till.
- **Cash-in-hand** — computed as `SUM(tickets) − SUM(expenses) − SUM(collections)`.
- **Daily / financial summaries** — per-day breakdown of tickets, revenue, and expenses across the full calendar range.
- **Change float (صندوق الصرف)** — a separate teller change balance (add/take with history) that is intentionally kept out of the cash-in-hand calculation.
- **Day status** — mark a day as working / holiday (عطلة) / repair (إصلاح).
- **Admin protection** — the admin dashboard is gated by an admin password (bcrypt-hashed).
- **Backups** — CSV/JSON/TXT/HTML mirror of business records (`src/services/BackupManager.js`).
- **Excel mirror** — records mirrored to an Excel workbook (`src/services/ExcelManager.js`).
- **Setup wizard** — first-run configuration of hammam name, admin password, categories, printer, and optional integrations (`src/renderer/setup-wizard.html`).
- **Updater with rollback** — GitHub release-based update check, download, install, and revert (`src/services/UpdateManager.js`).

### Optional integrations

These exist in the source but are inactive unless configured (they degrade gracefully when not set up):

- **Cloud sync** via Supabase (`src/services/CloudSync.js`) — only runs if a cloud URL/key is configured.
- **Email** via SMTP/Nodemailer (`src/services/EmailService.js`) — only runs if email is enabled/configured.
- **Scheduler** (`src/services/SchedulerService.js`).

---

## Data storage

- **Database:** SQLite, accessed through `sql.js` (WebAssembly build; no native SQLite dependency).
- **Location:** `%APPDATA%\HammamPOS\hammampos.db`.
- The database is **local** to the machine.
- **Fresh installations create the database automatically** — `StorageManager.createTables()` builds the full current schema on first run. No developer/seed database is shipped with the application.
- **Application updates must not overwrite the AppData database.** The updater operates on the installation directory only; the database lives in `%APPDATA%\HammamPOS`, outside the install directory.
- The admin password is stored as a **bcrypt hash** (`bcryptjs`). No claim of at-rest database encryption is made — the SQLite file itself is not encrypted.

---

## Fresh installation behavior

On a genuinely fresh, unconfigured machine (verified in `src/main/main-working.js` and `src/services/StorageManager.js`):

1. A new SQLite database is created in `%APPDATA%\HammamPOS\hammampos.db`.
2. Default settings are seeded and the install is treated as **unconfigured** (default hammam name).
3. The **setup wizard** is shown; the main POS window is not created until setup completes.
4. The owner enters the hammam name, an admin password (minimum 4 characters, entered twice), categories, and printer.
5. On completion, the admin password is stored as a bcrypt hash and the main POS window opens.

---

## Updating

The in-app updater (`src/services/UpdateManager.js`) works as follows (verified from source):

- On launch it checks the latest GitHub release of `alijaouhari/hammampos` via the GitHub Releases API.
- Versions are compared against `package.json` `version`; if the release is newer, the user is notified and can start the update.
- The release asset is a `.zip` (e.g. `HammamPOS-v2.8.8.zip`). It is downloaded to `%APPDATA%\HammamPOS\updates`, size- and integrity-checked, then applied by a helper script that swaps the installation directory and relaunches.
- **Rollback/revert** is supported: the previous installation is kept as a backup directory, and the user can revert to it.
- The **database is outside the installation directory** and is not touched by the update.

> The full installed-EXE update flow (download → swap → relaunch → handshake, and revert) has not been independently re-verified in this repository/environment. Treat the end-to-end updater as implemented-but-not-runtime-confirmed here.

---

## Repository structure

Only directories/files that currently exist are listed.

```
hammampos-desktop/
├── src/
│   ├── main/
│   │   └── main-working.js        # Electron main process + all IPC handlers (app "main" entry)
│   ├── renderer/
│   │   ├── hammampos.html         # Main POS + admin UI (single-file renderer, defines the IPC "api")
│   │   └── setup-wizard.html      # First-run setup wizard
│   ├── services/
│   │   ├── StorageManager.js      # SQLite (sql.js) data layer, financial calc, admin auth
│   │   ├── PrintManager.js        # Thermal ESC/POS printing
│   │   ├── raw-print.ps1          # Win32 raw-print helper (packaged as a resource)
│   │   ├── BackupManager.js       # CSV/JSON/TXT/HTML backups
│   │   ├── ExcelManager.js        # Excel workbook mirror
│   │   ├── ExpenseTemplateManager.js
│   │   ├── CloudSync.js           # Optional Supabase sync
│   │   ├── EmailService.js        # Optional SMTP email
│   │   ├── SchedulerService.js    # Optional scheduling
│   │   └── UpdateManager.js       # GitHub release updater + revert
│   └── plugins/                   # Add-on framework scaffolding (NOT part of the base product; see Maintenance notes)
├── data/
│   └── hammampos.xlsx             # Packaged Excel template (the runtime .db is NOT tracked/shipped)
├── scripts/
│   └── migrate-from-v2.2.ps1
├── installer/
│   └── hammampos-setup.iss        # Legacy Inno Setup script (not the primary distribution path)
├── tests/                         # Standalone updater/release validation scripts (no test framework)
├── package.json                   # App metadata + electron-builder config
├── build-release-zip.bat          # Build + zip a release for GitHub Releases
├── build-installer.bat
├── BUILD_FOR_DEPLOYMENT.bat
└── README.md
```

Note: `src/plugins/features/` is empty; the add-on architecture is deferred and is not part of the base product.

---

## Build / release

The scripts below are the actual `package.json` scripts and root batch files. Requires Node.js and (for launching) Electron; dependencies install with `npm install`.

Development:

```bash
npm install        # install dependencies
npm start          # run the app (electron .)
npm run dev        # run with DevTools + plugin hot-reload (electron . --dev)
```

Packaging (electron-builder, Windows):

```bash
npm run pack       # build an unpacked directory (electron-builder --dir)
npm run build:win  # build the Windows NSIS installer + unpacked dir
npm run build      # electron-builder (default targets)
```

Release helpers (root batch files):

- `build-release-zip.bat` — runs `build:win`, then zips `dist\win-unpacked` into `dist\HammamPOS-v<version>.zip` for upload as a GitHub release asset (the format the updater expects).
- `build-installer.bat`, `BUILD_FOR_DEPLOYMENT.bat` — additional build/deploy helpers.

electron-builder output goes to `dist/`.

---

## Important paths

- **Source:** `src/`
- **Main process:** `src/main/main-working.js`
- **Renderer (UI):** `src/renderer/hammampos.html`, `src/renderer/setup-wizard.html`
- **Services:** `src/services/`
- **Build configuration:** `package.json` (`build` section, electron-builder)
- **Runtime database:** `%APPDATA%\HammamPOS\hammampos.db`
- **Runtime backups:** `~/Documents/HammamPOS-Backups/` (created by `BackupManager`)
- **Updater working files/logs:** `%APPDATA%\HammamPOS\updates`, `%APPDATA%\HammamPOS\Logs`
- **Build output:** `dist/`

---

## Maintenance notes

- The runtime database is user data — **do not commit `data/hammampos.db`.** It is gitignored and excluded from packaging; fresh installs create their own database.
- **Do not reintroduce the developer database as a packaged resource.** Only `hammampos.xlsx` (and `raw-print.ps1`) are intentionally packaged from `data/` / services.
- **Preserve the AppData database during updates.** Keep update logic operating on the installation directory only.
- **Be careful with money-related logic** (cash-in-hand, tickets, expenses, collections, change float). Change float is deliberately excluded from cash-in-hand. Verify financial calculations against `StorageManager` before changing them.
- Database queries use **parameterized SQL**; dynamic identifiers (e.g. category-name columns in the daily summary) are safely quoted. Keep it that way — do not reintroduce string-interpolated SQL values.
- The **add-on / plugin** system and any removed dashboard/inventory functionality must not be reintroduced without an explicit project decision. They are out of scope for the base product.

---

## License

Proprietary. See `LICENSE.txt`.
