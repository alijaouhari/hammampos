# HammamPOS - Installation & Verification Guide
# Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.

## Requirements (Client Machine)
- Windows 10/11 64-bit
- 80mm USB thermal printer (installed with its Windows driver)
- Internet connection (for cloud sync)

## Pre-Install Setup (Done by you once per client)
- Create Supabase project
- Get Supabase URL + anon key
- Deploy Vercel dashboard
- Know the location name

## Installation Steps
1. Copy "HammamPOS Installer" folder to client machine
2. Right-click INSTALL-HAMMAMPOS.bat → Run as Administrator
3. Launch HammamPOS from desktop shortcut
4. Complete the setup wizard (name, password, printer, categories, cloud sync)

## Post-Install Checklist
- [ ] App launches
- [ ] Printer detected in settings
- [ ] Test print works
- [ ] Click category = ticket prints
- [ ] Cloud sync shows green (connected) in settings
- [ ] Open dashboard → location appears
- [ ] Sell ticket → appears on dashboard in realtime
- [ ] Excel file exists and grows after sales
- [ ] Documents\HammamPOS-Backups\ has CSV/JSON files

## Troubleshooting
- No printer detected: Check USB cable, install printer driver
- Cloud sync not connecting: Verify URL and key in settings
- App won't start: Run as Administrator
- Tickets not syncing: Check internet connection
