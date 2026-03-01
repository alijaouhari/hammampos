# HammamPOS - Quick Start Guide (For You)

**Simple steps to test and deploy your software**

---

## 🧪 Testing (Do This First)

### Step 1: Get VirtualBox
1. Download VirtualBox (free): https://www.virtualbox.org/
2. Install it
3. Done

### Step 2: Get Windows ISO
1. Download Windows 10 ISO from Microsoft
2. Save it somewhere

### Step 3: Create Test VM
1. Open VirtualBox
2. Click "New"
3. Name: "HammamPOS Test"
4. Type: Windows 10 (64-bit)
5. RAM: 4GB
6. Create virtual hard disk: 20GB
7. Start VM, select Windows ISO
8. Install Windows (skip product key)

### Step 4: Test HammamPOS
1. Copy `hammampos-desktop` folder to VM
2. Install Node.js in VM
3. Open folder in terminal
4. Run: `npm start`
5. Go through setup wizard
6. Test features:
   - ✅ Sell some tickets
   - ✅ Add expenses
   - ✅ Check Excel file
   - ✅ Open Admin panel
   - ✅ Enable Web Dashboard
   - ✅ Access from browser

**If everything works → Ready to deploy!**

---

## 🚀 Deploying to Customer

### What You Need
- Customer's PC (Windows 7 or newer)
- USB drive with HammamPOS folder
- 15 minutes

### Steps
1. Copy folder to customer PC (Desktop is fine)
2. Install Node.js (if not installed)
3. Double-click `start-hammampos.bat`
4. Help customer complete setup:
   - Hammam name
   - Password (they choose)
   - Printer selection
   - Categories (رجال، نساء، أولاد، بنات)
5. Test one ticket sale
6. Show them how to use it
7. Done!

---

## 🔑 Selling Premium Features

### When Customer Wants a Feature

**Example: Customer wants Inventory Management**

1. Open HammamPOS on their PC
2. Go to Settings → About
3. Copy their Machine ID (looks like: `a1b2c3d4e5f6...`)
4. On YOUR computer, run:
   ```
   cd hammampos-desktop/tools
   node license-generator.js inventory-management a1b2c3d4e5f6...
   ```
5. Copy the activation key (looks like: `XXXXX-XXXXX-XXXXX-XXXXX`)
6. Send key to customer via WhatsApp
7. Customer enters key in Settings → Premium Features
8. Feature unlocks!
9. Collect payment 💰

---

## 🛠️ Common Issues

### "Node.js not found"
→ Install Node.js from nodejs.org

### "Printer not working"
→ Check printer is connected and turned on
→ Try test print in Settings

### "Can't access Web Dashboard"
→ Make sure it's enabled in Settings
→ Check they're on same WiFi
→ Try: http://localhost:3000

### "Excel file not updating"
→ Close Excel if it's open
→ Restart HammamPOS

---

## 📞 Customer Support Template

**When customer has issue:**

1. Ask them to send screenshot
2. Check if it's in "Common Issues" above
3. If not, remote desktop (TeamViewer/AnyDesk)
4. Fix it
5. Document the issue for next time

---

## 💰 Pricing Ideas

**Base Software:** Free or $50 one-time
**Premium Features:** $30-50 each
**Cloud Access:** $10/month
**Support Package:** $20/month

**Example Sale:**
- HammamPOS: $50
- Inventory Plugin: $40
- Installation: $30
- Total: $120

---

## 📝 Quick Checklist Before Selling

- [ ] Tested on VM
- [ ] All features work
- [ ] Have USB with files ready
- [ ] Know how to generate licenses
- [ ] Have support plan ready
- [ ] Pricing decided

---

**That's it! Keep it simple, test first, then deploy.**

