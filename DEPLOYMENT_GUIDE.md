# 🚀 HammamPOS Deployment Guide

**Complete guide for building, testing, and deploying HammamPOS**

---

## 📋 **QUICK START**

### **1. Build Installer**
```bash
cd hammampos-desktop
BUILD_FOR_DEPLOYMENT.bat
```
**Output**: `dist/HammamPOS Setup 2.0.0.exe`

### **2. Check Target Windows Version**
On target machine, run: `CHECK_WINDOWS_VERSION.bat`

### **3. Install & Test**
Follow the 5-minute quick test below.

---

## ⚡ **5-MINUTE QUICK TEST**

### **On Target Machine:**

1. **Install** (2 min)
   - Copy installer to target PC
   - Right-click → Run as administrator
   - Follow wizard, use defaults

2. **Setup** (1 min)
   - Enter hammam name: "Test Hammam"
   - Set password: "admin123"
   - Add category: "Adults" - 50 MAD

3. **Test** (2 min)
   - ✅ Click "Adults" → Ticket #1 appears
   - ✅ Cash shows 50.00 MAD
   - ✅ Close app, reopen → Data still there

**✅ SUCCESS = All 3 checks pass**

---

## 🪟 **WINDOWS COMPATIBILITY**

### **Check Windows Version First!**
```
Win + R → type "winver" → Enter
```

| Version | Status | Notes |
|---------|--------|-------|
| Windows 11 | ✅ Perfect | All features work |
| Windows 10 | ✅ Perfect | All features work |
| Windows 8.1 | ✅ Good | Works with warning |
| Windows 8 | ✅ Good | Works with warning |
| Windows 7 | ⚠️ Limited | Core features only |
| Older | ❌ No | Upgrade required |

### **Windows 7 Limitations**
- ✅ Core POS works (tickets, expenses, cash)
- ❌ Web dashboard may not work
- ❌ Cloud sync may not work
- ⚠️ Security risk (no updates since 2020)

**See `WINDOWS_COMPATIBILITY.md` for full details**

---

## 📦 **SYSTEM REQUIREMENTS**

### **Minimum**
- Windows 7 or later (Win 10/11 recommended)
- 64-bit system (x64)
- 4GB RAM (8GB for Windows 7)
- 2GB free disk space
- Administrator access

### **Recommended**
- Windows 10 or 11
- 8GB RAM
- 5GB free disk space
- Thermal printer (optional)

---

## 🧪 **DETAILED TESTING**

### **Core Features (15 minutes)**
- [ ] Sell 3 tickets (different categories)
- [ ] Add 2 expenses
- [ ] Check cash calculation is correct
- [ ] View daily summary
- [ ] Close and reopen app
- [ ] Data persists correctly
- [ ] Excel file generated

### **Premium Features (Optional)**
- [ ] Get Machine ID (Help > About)
- [ ] Generate license key on dev machine
- [ ] Activate license on target machine
- [ ] Open http://localhost:3000
- [ ] Login to web dashboard

### **Files Check**
- [ ] `C:\Program Files\HammamPOS` exists
- [ ] `%APPDATA%\HammamPOS\data\hammampos.db` exists
- [ ] `%APPDATA%\HammamPOS\data\hammampos.xlsx` exists
- [ ] Desktop shortcut works

---

## 🔧 **PREMIUM FEATURES**

### **License Activation**
1. **Get Machine ID** (on target machine)
   - Help > About
   - Copy Machine ID

2. **Generate License** (on dev machine)
   ```bash
   cd hammampos-desktop
   node tools/license-generator.js
   ```
   - Enter Machine ID
   - Enter feature: `inventory-management`
   - Copy license key

3. **Activate** (on target machine)
   - Settings > Premium Features
   - Enter license key
   - Feature activates

### **Web Dashboard**
- Access: http://localhost:3000
- Login with admin password
- View business metrics
- Mobile-friendly interface

### **Cloud Sync**
1. Run: `node tools/google-auth.js`
2. Follow Google Drive authentication
3. Enable in Settings > Cloud Sync

---

## 🐛 **TROUBLESHOOTING**

### **Installation Issues**

| Issue | Solution |
|-------|----------|
| "Windows protected your PC" | Click "More info" → "Run anyway" |
| Won't install | Run as Administrator |
| Antivirus blocks | Temporarily disable antivirus |
| Installation fails | Check disk space, restart PC |

### **Runtime Issues**

| Issue | Solution |
|-------|----------|
| Database error | Check `%APPDATA%\HammamPOS\data` exists |
| App won't start | Restart computer, try again |
| Web dashboard not working | Check port 3000 is free |
| Printer not found | Install printer drivers, set as default |

### **Performance Issues**

| Issue | Solution |
|-------|----------|
| Application slow | Check RAM, close other apps |
| Database growing large | Backup and clear old data |
| Crashes frequently | Check Windows Event Viewer |

---

## 🗑️ **DELETE DATABASE FEATURE**

### **How to Clear All Data**
1. Open admin dashboard (password required)
2. Click "🗑️ مسح جميع البيانات" (Clear All Data)
3. Confirm THREE times:
   - First confirmation
   - Second confirmation
   - Type "مسح البيانات" exactly

### **What Gets Deleted**
- ✅ All tickets
- ✅ All expenses
- ✅ All collections
- ✅ Daily summaries
- ✅ Serial counters reset

### **What Stays**
- ✅ Categories and prices
- ✅ Settings
- ✅ Admin password
- ✅ Premium licenses

**⚠️ WARNING**: This cannot be undone! Use only for testing.

---

## 📊 **TESTING CHECKLIST**

```
QUICK TEST (Minimum)
[ ] Installs successfully
[ ] Setup wizard completes
[ ] Can sell tickets
[ ] Data persists after restart

FULL TEST (Recommended)
[ ] Multiple tickets work
[ ] Expenses work
[ ] Cash calculations correct
[ ] Reports display
[ ] Excel file generates
[ ] Desktop shortcut works
[ ] Delete database works

PREMIUM TEST (Optional)
[ ] Machine ID displays
[ ] License activates
[ ] Web dashboard works
[ ] Plugins load
[ ] Cloud sync works
```

---

## 📝 **DEPLOYMENT REPORT TEMPLATE**

```
DEPLOYMENT TEST REPORT
Date: _______________
Tester: _______________
Machine: _______________

SYSTEM INFO:
- Windows Version: _______________
- RAM: _______________
- Disk Space: _______________

INSTALLATION:
- Installer Size: _______________
- Installation Time: _______________

TESTING RESULTS:
✅ / ❌  Application Launch
✅ / ❌  Setup Wizard
✅ / ❌  Ticket Sales
✅ / ❌  Expense Tracking
✅ / ❌  Data Persistence
✅ / ❌  Reports
✅ / ❌  Delete Database
✅ / ❌  Premium Features

ISSUES FOUND:
1. _______________
2. _______________

OVERALL RESULT: ✅ PASS / ❌ FAIL
```

---

## 🎯 **SUCCESS CRITERIA**

### **Minimum Success**
- ✅ Application installs
- ✅ Can sell tickets
- ✅ Data saves correctly
- ✅ No crashes

### **Full Success**
- ✅ All core features work
- ✅ Premium features activate
- ✅ Performance is good
- ✅ Delete database works
- ✅ User finds it easy

---

## 🛠️ **DEVELOPMENT COMMANDS**

### **Build & Deploy**
```bash
BUILD_FOR_DEPLOYMENT.bat    # Build installer
CHECK_WINDOWS_VERSION.bat   # Check Windows version
CLEANUP.bat                 # Clean build artifacts
```

### **Development**
```bash
npm start                   # Run in development mode
npm run pack                # Build without installer
npm run build:win           # Build NSIS installer
npm run build:installer     # Build Inno Setup installer
```

### **Tools**
```bash
node tools/license-generator.js    # Generate license keys
node tools/google-auth.js          # Setup Google Drive
node tools/excel-consolidator.js   # Consolidate Excel files
```

---

## 📞 **SUPPORT**

### **During Testing**
- Take screenshots of errors
- Check `%APPDATA%\HammamPOS\logs`
- Note steps before error
- Document system info

### **Files to Check**
- Installation: `C:\Program Files\HammamPOS`
- Data: `%APPDATA%\HammamPOS\data`
- Logs: `%APPDATA%\HammamPOS\logs`

---

## 📚 **ADDITIONAL DOCUMENTATION**

- `README.md` - General application overview
- `WINDOWS_COMPATIBILITY.md` - Detailed Windows version info
- `CLOUD_SYNC_SETUP.md` - Google Drive setup guide
- `QUICK_TEST_CHECKLIST.md` - Fast testing reference

---

## 🎉 **YOU'RE READY!**

### **Deployment Checklist**
- [ ] Build installer with `BUILD_FOR_DEPLOYMENT.bat`
- [ ] Copy to USB with version checker
- [ ] Check Windows version on target machine
- [ ] Install and run quick test
- [ ] Document results
- [ ] Fix any issues found

**Good luck with your deployment! 🚀**