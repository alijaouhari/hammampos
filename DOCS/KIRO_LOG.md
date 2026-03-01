# HammamPOS - Kiro Development Log

**Single Source of Truth for Development Notes**

---

## Project Overview

HammamPOS is an Electron-based Point of Sale system with a plugin architecture for feature management.

## Architecture

- **Main Process**: `src/main/main-working.js` - Electron main process
- **Renderer**: `src/renderer/` - HTML/CSS/JS frontend
- **Services**: `src/services/` - Core business logic services
- **Plugins**: `src/plugins/` - Feature plugin system with licensing

## Core Services

- `BackupManager.js` - Database backup functionality
- `EmailService.js` - Email notifications
- `ExcelManager.js` - Excel file operations
- `ExpenseTemplateManager.js` - Expense template management
- `PrintManager.js` - Receipt printing
- `SchedulerService.js` - Task scheduling
- `StorageManager.js` - Data persistence
- `WebDashboard.js` - Web-based dashboard

## Plugin System

- **Core**: `src/plugins/core/` - Plugin infrastructure
  - `PluginManager.js` - Plugin lifecycle management
  - `LicenseManager.js` - License validation
- **Features**: `src/plugins/features/` - Feature plugins
  - `inventory-management/` - Inventory tracking plugin

## Build & Deployment

- `BUILD_FOR_DEPLOYMENT.bat` - Production build script
- `build-installer.bat` - Installer creation
- `installer/hammampos-setup.iss` - Inno Setup configuration

## Development Notes

All development notes, guides, and documentation must be recorded here only.

---

*Last Updated: 2026-03-01*
