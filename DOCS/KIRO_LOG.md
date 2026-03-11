# HammamPOS Development Log

## Project Overview
This is the single source of truth for all development notes, guides, and documentation for HammamPOS.

---

## 2026-03-11 - System State Audit Complete

### SECTION 1 — SYSTEM ARCHITECTURE

**Programming Language:** JavaScript (Node.js)

**Framework:** Electron 28.0.0

**Application Type:** Desktop (Hybrid - Electron wraps web technologies)

**Packaging Method:** 
- NSIS Installer (Windows)
- electron-builder for packaging
- Installer script: `hammampos-setup.iss` (Inno Setup)

**Repository Location:** Local Git repository

**Branch:** master

**Last Commit:** ba6c5d92c0cd7e219c4a5721563c4461a6d9bd9b (2026-03-11 12:32:55 +0000)

---

### SECTION 2 — LOCAL DATABASE

**Database Engine:** SQLite (via sql.js - WebAssembly implementation)

**Database Location:** `data/hammampos.db`

**Complete Schema:**

**TABLE: settings**
- key (TEXT PRIMARY KEY)
- value (TEXT NOT NULL)
- updated_at (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: categories**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- name (TEXT NOT NULL)
- price (REAL NOT NULL)
- active (INTEGER DEFAULT 1)
- serial_counter (INTEGER DEFAULT 0)
- created_at (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: tickets**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- serial_number (INTEGER NOT NULL)
- year (INTEGER NOT NULL)
- category_id (INTEGER NOT NULL)
- category_name (TEXT NOT NULL)
- price (REAL NOT NULL)
- date (TEXT NOT NULL)
- time (TEXT NOT NULL)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)
- FOREIGN KEY (category_id) REFERENCES categories(id)

**TABLE: expenses**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- description (TEXT NOT NULL)
- amount (REAL NOT NULL)
- date (TEXT NOT NULL)
- time (TEXT NOT NULL)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: collections**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- amount (REAL NOT NULL)
- date (TEXT NOT NULL)
- time (TEXT NOT NULL)
- notes (TEXT)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: daily_summary**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- date (TEXT NOT NULL UNIQUE)
- total_tickets (INTEGER NOT NULL)
- total_revenue (REAL NOT NULL)
- total_expenses (REAL NOT NULL)
- net_revenue (REAL NOT NULL)
- cash_in_hand (REAL NOT NULL)
- category_breakdown (TEXT NOT NULL)
- created_at (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: audit_log**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- action (TEXT NOT NULL)
- entity (TEXT NOT NULL)
- entity_id (INTEGER)
- details (TEXT)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: serial_resets**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- year (INTEGER NOT NULL)
- reset_date (TEXT NOT NULL)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: email_log**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- recipient (TEXT NOT NULL)
- subject (TEXT NOT NULL)
- status (TEXT NOT NULL)
- error (TEXT)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**TABLE: sync_status**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- sync_type (TEXT NOT NULL)
- status (TEXT NOT NULL)
- last_sync (TEXT)
- error (TEXT)
- timestamp (TEXT DEFAULT CURRENT_TIMESTAMP)

**Indexes:**
- idx_tickets_date ON tickets(date)
- idx_tickets_year ON tickets(year)
- idx_expenses_date ON expenses(date)
- idx_collections_date ON collections(date)
- idx_audit_timestamp ON audit_log(timestamp)

---

### SECTION 3 — POS SELLING INTERFACE

**Category buttons:** IMPLEMENTED
- Dynamic category grid loaded from database
- 4-column grid layout
- Shows category name and price
- Hover effects and visual feedback

**Price configuration:** IMPLEMENTED
- Prices stored in categories table
- Configurable per category
- Displayed on category buttons

**One-click ticket generation:** IMPLEMENTED
- Single click on category button creates ticket
- Automatic serial number generation
- Yearly serial counter per category

**Automatic ticket printing:** IMPLEMENTED
- Prints immediately after ticket creation
- Uses Windows printer integration
- Minimal format to save paper

**Ticket serial numbering:** IMPLEMENTED
- Format: #serial/year (e.g., #123/2026)
- Per-category serial counter
- Automatic yearly reset

**Yearly serial reset:** PARTIALLY IMPLEMENTED
- Serial reset tracking table exists
- Reset logic implemented in StorageManager
- Automatic reset on year change

**Category configuration UI:** IMPLEMENTED
- Add new categories
- Update category name and price
- Toggle category active/inactive status
- Admin password protected

---

### SECTION 4 — PRINTER SYSTEM

**Printing method:** Windows command-line printing via PowerShell

**Printer library:** Native Node.js child_process (exec)

**Ticket template format:** Plain text with Arabic support
- Hammam name (centered)
- Serial number (#serial/year)
- Date and time
- Category name
- Price in Dirhams
- Minimal format (no separators, blank lines only)

**58mm support:** IMPLEMENTED
- Paper width configurable (default 58mm)
- Template optimized for 58mm thermal printers

**80mm support:** IMPLEMENTED
- Paper width configurable
- Same template scales to 80mm

**Tested printer models:** 
- Auto-detection for thermal printers
- Keywords: pos, thermal, receipt, xprinter, epson, star, bixolon
- Falls back to first available printer

**Printing status:** FULLY WORKING
- Printer initialization implemented
- Test print function available
- Automatic printer detection
- Error handling for missing printers

---

### SECTION 5 — EXCEL MIRROR SYSTEM

**Library used:** ExcelJS 4.4.0

**File location:** `data/hammampos.xlsx`

**Write trigger timing:** Real-time on every transaction
- Ticket creation → immediate Excel write
- Expense addition → immediate Excel write
- Collection recording → immediate Excel write

**Sheets implemented:**

✅ **الإعدادات (Settings)** - IMPLEMENTED
- Mirrors settings table
- Columns: key, value, updated_at

✅ **الفئات (Categories)** - IMPLEMENTED
- Mirrors categories table
- Columns: id, name, price, active, serial_counter, created_at

✅ **التذاكر (Tickets)** - IMPLEMENTED
- Mirrors tickets table
- Columns: id, serial_number, year, category_id, category_name, price, date, time, timestamp

✅ **المصروفات (Expenses)** - IMPLEMENTED
- Mirrors expenses table
- Columns: id, description, amount, date, time, timestamp

✅ **التحصيلات (Collections)** - IMPLEMENTED
- Mirrors collections table
- Columns: id, amount, date, time, notes, timestamp

✅ **الملخص اليومي (DailySummary)** - IMPLEMENTED
- Mirrors daily_summary table
- Columns: id, date, total_tickets, total_revenue, total_expenses, net_revenue, cash_in_hand, category_breakdown, created_at

✅ **سجل التدقيق (AuditLog)** - IMPLEMENTED
- Mirrors audit_log table
- Columns: id, action, entity, entity_id, details, timestamp

✅ **إعادة تعيين التسلسل (SerialResets)** - IMPLEMENTED
- Mirrors serial_resets table
- Columns: id, year, reset_date, timestamp

✅ **سجل البريد (EmailLog)** - IMPLEMENTED
- Mirrors email_log table
- Columns: id, recipient, subject, status, error, timestamp

✅ **حالة المزامنة (SyncStatus)** - IMPLEMENTED
- Mirrors sync_status table
- Columns: id, sync_type, status, last_sync, error, timestamp

**Excel system status:** FULLY WORKING
- All sheets created and styled
- Real-time write on transactions
- Rebuild from database function available
- Arabic RTL support enabled

---

### SECTION 6 — GOOGLE DRIVE SYNC

**Sync method:** NOT IMPLEMENTED

**Status:** REMOVED FEATURE
- CloudSyncManager code commented out in main-working.js
- No Google Drive integration active
- Excel file can be manually synced via Google Drive Desktop Client (user responsibility)

---

### SECTION 7 — FINANCIAL LOGIC

**Lifetime revenue:** IMPLEMENTED
- Calculated from all tickets in database
- Real-time updates
- Displayed in status bar

**Cash-in-hand counter:** IMPLEMENTED
- Formula: Total Revenue - Total Expenses - Total Collections
- Real-time calculation
- Displayed in status bar and dashboard

**Money collection process:** IMPLEMENTED
- Record collection amount
- Optional notes field
- Reduces cash-in-hand
- Logged in collections table
- Written to Excel and backups

**Expense recording:** IMPLEMENTED
- Description and amount fields
- Date and time stamped
- Reduces cash-in-hand
- Logged in expenses table
- Written to Excel and backups
- Expense templates system available

---

### SECTION 8 — ADMIN DASHBOARD

**Sales today:** IMPLEMENTED
- Today's ticket count
- Today's revenue
- Category breakdown
- Real-time updates

**Cash-in-hand display:** IMPLEMENTED
- Prominent display in status bar
- Color-coded (green)
- Real-time calculation

**Ticket counts by category:** IMPLEMENTED
- Category breakdown in daily summary
- Per-category ticket counts
- Historical data available

**Collection history:** IMPLEMENTED
- Date range filtering
- Amount and notes display
- Searchable and sortable

**Expense history:** IMPLEMENTED
- Date range filtering
- Description and amount display
- Searchable and sortable

**Settings page:** IMPLEMENTED
- Admin password protection
- Hammam name configuration
- Printer settings
- Email settings
- Category management
- Web dashboard toggle

---

### SECTION 9 — ACCESS CONTROL

**Admin password system:** IMPLEMENTED
- Default password: 1234
- Password verification for admin functions
- Stored in settings table
- Change password function available

**Cashier restrictions:** PARTIALLY IMPLEMENTED
- No separate cashier role
- All users have full access
- Admin password protects sensitive functions

**Report access protection:** IMPLEMENTED
- Admin password required for:
  - Settings access
  - Category management
  - Data deletion
  - System configuration

---

### SECTION 10 — REPORTING

**Daily report generation:** IMPLEMENTED
- Daily summary table tracks all metrics
- Category breakdown included
- Historical data available
- Date range filtering

**Email sending:** IMPLEMENTED
- EmailService class available
- SMTP configuration in settings
- Test connection function
- Email log tracking
- Status: Configurable (disabled by default)

**SMS sending:** NOT IMPLEMENTED

---

### SECTION 11 — DEPLOYMENT

**Build method:** electron-builder

**Build commands:**
- `npm run build` - Build for current platform
- `npm run build:win` - Build for Windows
- `npm run build:installer` - Build + create installer
- `npm run dist` - Full distribution build

**Installer availability:** IMPLEMENTED
- NSIS installer for Windows
- Inno Setup script available (hammampos-setup.iss)
- One-click installation
- Desktop shortcut creation
- Start menu shortcut

**Setup steps:**
1. Run installer
2. First launch shows setup wizard
3. Configure hammam name and admin password
4. Select printer and paper width
5. Configure email (optional)
6. Create categories
7. Test print
8. Complete setup

**Printer configuration process:** IMPLEMENTED
- Setup wizard includes printer selection
- Auto-detection of thermal printers
- Test print function
- Paper width selection (58mm/80mm)
- Reconfigurable in settings

---

### SECTION 12 — KNOWN LIMITATIONS

**Bugs:**
- None currently documented

**Unstable components:**
- Email service depends on external SMTP configuration
- Web dashboard requires port availability (default 3000)

**Incomplete systems:**
- Google Drive sync removed (manual sync required)
- SMS notifications not implemented
- Multi-user role system not implemented (single admin mode only)
- Cashier restrictions not enforced

**Technical debt:**
- CloudSyncManager code commented out but not removed
- No automated backup scheduling (manual Excel backup)
- No data export to other formats (only Excel)
- No inventory management (requires plugin)

---

### ADDITIONAL NOTES

**Plugin System:** IMPLEMENTED
- PluginManager and LicenseManager available
- Plugin architecture defined
- License-based feature activation
- Inventory management available as licensed plugin

**Backup System:** IMPLEMENTED (Dual Strategy)
- BackupManager for JSON backups
- ExcelManager for Excel backups
- Real-time backup on all transactions
- Rebuild from database function

**Web Dashboard:** IMPLEMENTED
- Express.js server
- JWT authentication
- REST API for data access
- Admin password login
- Configurable port
- Enable/disable in settings
- Status: Optional (disabled by default)

**Scheduler Service:** IMPLEMENTED
- node-cron based scheduling
- Email report scheduling
- Configurable intervals

**Test Data Generator:** IMPLEMENTED
- Generate test periods
- Populate database with sample data
- Testing and demo purposes

---

## Next Steps
- Document plugin development workflow
- Create user manual
- Establish testing procedures
- Plan feature roadmap

