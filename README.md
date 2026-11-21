# HammamPOS Desktop

Point-of-sale app for Moroccan hammams. Windows desktop app (Electron). The seller sells category tickets printed on an 80 mm thermal printer; the manager runs the money (expenses, collections, seller debts, unpaid bills, change box, refunds), settings and reports from a password-protected admin panel. Data lives in a local SQLite database (sql.js) and works offline. An optional cloud link (Supabase) feeds the web dashboard, live support commands and the remote admin panel.

Version: see `package.json`. Screens: Arabic, with a French switch.

## Layout

```
hammampos-desktop/
├── src/
│   ├── main/
│   │   ├── main-working.js        # Electron main process, IPC handlers, startup
│   │   └── desktopShortcut.js     # Keeps the desktop shortcut name in sync
│   ├── renderer/
│   │   ├── hammampos.html         # Seller screen + admin panel (one file; defines the IPC "api")
│   │   ├── setup-wizard.html      # First-run setup (language, hammam, categories, printer, email, cloud code)
│   │   ├── i18n.js                # Arabic / French switch (runtime translation of the screens)
│   │   └── i18n-fr.js             # French texts (key: Arabic text, value: French)
│   └── services/
│       ├── StorageManager.js      # Database, tickets, settings, admin password, recovery
│       ├── MoneyService.js        # Money system: cash in hand, expenses/bills, collections, debts, refunds, notifications
│       ├── PrintManager.js        # Thermal printing (raw-print.ps1 is shipped as a resource)
│       ├── BackupManager.js       # CSV/JSON/TXT/HTML backups
│       ├── ExcelManager.js        # hammampos.xlsx, rebuilt from the database (read-only copy)
│       ├── ExpenseTemplateManager.js
│       ├── CloudSync.js           # Supabase sync, heartbeat + summary, notifications, connection codes
│       ├── RemoteCommands.js      # Support commands from the dashboard (ping, sync, restart, update...)
│       ├── RemoteAdmin.js         # Remote admin panel channel (allow-list, protected settings)
│       ├── EmailService.js        # Optional SMTP (reports, password recovery code)
│       ├── SchedulerService.js    # Daily tasks
│       ├── OnScreenKeyboard.js    # Arabic on-screen keyboard
│       └── UpdateManager.js       # GitHub-release updater + revert
├── dashboard-deploy/              # Web dashboard (Vercel): index.html, remote admin panel (admin.html, built), PWA files
├── supabase/migrations/           # Cloud database (apply in order)
├── scripts/
│   ├── build-remote-admin.js      # Builds dashboard-deploy/admin.html from the app screen
│   └── release.ps1                # Tests → version → build → zip → GitHub release → remote panel
├── tests/base/                    # Unit tests (node:test), run by tests/run-base.js
├── assets/icon.png, icon.svg      # App icon (ticket logo)
└── package.json                   # App metadata + electron-builder config
```

## Develop

```bash
npm install
npm start          # run the app
npm run dev        # with DevTools
npm test           # all unit tests
```

Test against a copy of a database, never a production one: set `APPDATA` to a folder containing `HammamPOS\hammampos.db` before `npm start`.

## Release

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 2.8.35 -Notes "What changed"
```

Then deploy `dashboard-deploy` (Vercel) so the remote panel matches the new version, and install from the dashboard (Appareils → "تثبيت آخر تحديث") or from the app's Updates tab. The updater expects the GitHub release asset `HammamPOS-v<version>.zip` (zip of `dist\win-unpacked`).

## Paths on a PC

- Program: `C:\HammamPOS` (previous version kept in `C:\HammamPOS-old`)
- Data: `%APPDATA%\HammamPOS\` — `hammampos.db`, `hammampos.xlsx`, `snapshots\`, backups
- Updates never touch the data folder.

## French texts

To fix a French text, edit its value in `src/renderer/i18n-fr.js`. A new Arabic text in the screens shows in Arabic until a line is added there. Names typed by the owner (hammam, categories, suppliers) are never translated.
