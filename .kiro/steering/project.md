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
