# ⚡ Quick Test Checklist - First Deployment

## 🎯 **WHAT YOU NEED**

### **On Your Dev Machine**
```bash
cd hammampos-desktop
npm run build:win
```
**Result**: `dist/HammamPOS Setup 2.0.0.exe`

### **On Target Machine**
- Windows 10/11 (64-bit)
- 4GB RAM minimum
- Administrator access
- USB drive with installer

---

## 🚀 **5-MINUTE QUICK TEST**

### **1. Install (2 minutes)**
- Copy installer to target PC
- Right-click > Run as administrator
- Follow wizard, use defaults
- Launch application

### **2. Setup (1 minute)**
- Enter hammam name: "Test Hammam"
- Set password: "admin123"
- Add category: "Adults" - 50 MAD
- Complete setup

### **3. Test Core (2 minutes)**
- ✅ Click "Adults" button → Ticket #1 appears
- ✅ Cash shows 50.00 MAD
- ✅ Close app, reopen → Data still there
- ✅ Check `%APPDATA%\HammamPOS\data` → Files exist

**✅ SUCCESS = All 4 checks pass**

---

## 🔍 **DETAILED TEST (15 minutes)**

### **Core Features**
- [ ] Sell 3 tickets (different categories)
- [ ] Add 2 expenses
- [ ] Check cash calculation is correct
- [ ] View daily summary
- [ ] Close and reopen app
- [ ] Data persists correctly

### **Premium Features** (Optional)
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

## 🐛 **COMMON ISSUES**

| Issue | Solution |
|-------|----------|
| "Windows protected your PC" | Click "More info" → "Run anyway" |
| Won't install | Run as Administrator |
| Database error | Check `%APPDATA%\HammamPOS\data` exists |
| Port 3000 in use | Close other apps using port 3000 |

---

## 📋 **QUICK REPORT**

```
Date: __________
Machine: __________
Windows: __________

✅ / ❌  Installation
✅ / ❌  Setup wizard
✅ / ❌  Sell tickets
✅ / ❌  Data persists
✅ / ❌  Web dashboard (optional)

Issues: ____________________

Result: PASS / FAIL
```

---

## 🎯 **MINIMUM SUCCESS**
✅ Installs without errors  
✅ Can sell tickets  
✅ Data saves correctly  
✅ No crashes

**That's it! If these 4 work, you're good to go! 🎉**