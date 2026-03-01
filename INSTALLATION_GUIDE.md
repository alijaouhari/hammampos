# 📦 HammamPOS Installation Guide

Simple step-by-step guide to install and start using HammamPOS.

---

## ⚙️ Step 1: Install Node.js

1. Open the `tools-needed` folder
2. Double-click `node-v20.x.x-x64.msi`
3. Click "Next" on all screens (use default settings)
4. Click "Install"
5. Wait for installation to complete
6. Click "Finish"
7. **Restart your computer**

---

## 📂 Step 2: Prepare HammamPOS

1. Copy the `hammampos-desktop` folder to your Desktop
2. Open the folder
3. You should see files like:
   - `package.json`
   - `start-hammampos.bat`
   - Folders: `src`, `data`, `tools`

---

## 🔧 Step 3: Install HammamPOS

1. Open the `hammampos-desktop` folder
2. Hold **Shift** and **Right-click** inside the folder
3. Select "Open PowerShell window here" or "Open command window here"
4. Type this command and press Enter:
   ```
   npm install
   ```
5. Wait 2-3 minutes while it installs
6. You'll see lots of text - this is normal
7. When it's done, you'll see the command prompt again

---

## 🚀 Step 4: Start HammamPOS

1. Double-click `start-hammampos.bat`
   
   OR
   
   In the command window, type:
   ```
   npm start
   ```

2. The application will open

---

## 🎯 Step 5: First Time Setup

When you first open HammamPOS, you'll see the Setup Wizard:

### 5.1 Enter Hammam Name
- Type your hammam name (example: "Hammam Al Baraka")
- Click "Next"

### 5.2 Set Admin Password
- Choose a password (example: "1234")
- Remember this password - you'll need it for settings
- Click "Next"

### 5.3 Select Printer (Optional)
- If you have a thermal printer connected, select it
- If not, click "Skip" - you can set it up later
- Click "Next"

### 5.4 Add Categories
Add your ticket categories and prices:

**Example:**
- Category: "Adults / رجال" - Price: 50
- Category: "Women / نساء" - Price: 60
- Category: "Children / أولاد" - Price: 30

Click "Add Category" for each one, then click "Finish"

---

## ✅ Step 6: Start Using HammamPOS

You're ready! The main screen will show:

### To Sell a Ticket:
1. Click on a category button (example: "Adults")
2. A ticket will be created
3. Cash amount increases automatically
4. Ticket prints (if printer is connected)

### To Add an Expense:
1. Click "➕ مصروف" (Add Expense)
2. Enter description (example: "Electricity")
3. Enter amount (example: 100)
4. Click "Save"

### To View Reports:
1. Click "📊 الملخص اليومي" (Daily Summary)
2. Select a date
3. View sales and expenses

### To Access Settings:
1. Click "⚙️ الإعدادات" (Settings)
2. Enter your admin password
3. Change settings, add categories, etc.

---

## 📁 Important Files

### Database
Your data is saved in:
```
hammampos-desktop\data\hammampos.db
```

### Excel Export
An Excel file is automatically created:
```
hammampos-desktop\data\hammampos.xlsx
```
You can open this file to view all your data in Excel.

### Backups
Automatic backups are saved in:
```
C:\Users\[YourName]\Documents\HammamPOS-Backups\
```

---

## 🔄 Daily Use

### Starting HammamPOS Each Day:
1. Go to `hammampos-desktop` folder
2. Double-click `start-hammampos.bat`

### Closing HammamPOS:
- Click the X button to close the window
- Your data is automatically saved

---

## 🆘 Troubleshooting

### Problem: "npm is not recognized"
**Solution:** Node.js is not installed
- Install Node.js from `tools-needed` folder
- Restart your computer
- Try again

### Problem: Application won't start
**Solution:** 
1. Restart your computer
2. Make sure you ran `npm install` first
3. Try running `start-hammampos.bat` again

### Problem: Printer not working
**Solution:**
1. Make sure printer is connected and turned on
2. Open Settings (⚙️) with your password
3. Select your printer from the list
4. Click "Test Print" to verify

### Problem: Data disappeared
**Solution:**
- Check if `data\hammampos.db` file exists
- Restore from backup in `Documents\HammamPOS-Backups\`

### Problem: Excel file not updating
**Solution:**
- Close Excel if it's open
- Restart HammamPOS

---

## 📞 Need Help?

If you have problems:
1. Take a screenshot of any error messages
2. Contact support with:
   - Screenshot
   - What you were doing when the error happened
   - Your Windows version

---

## 🎉 You're Done!

HammamPOS is now installed and ready to use.

**Quick Tips:**
- Keep the `hammampos-desktop` folder safe - don't delete it
- Backup the `data` folder regularly
- The Excel file updates automatically - you can check it anytime
- Use Settings to add more categories or change prices

**Enjoy using HammamPOS! 🏛️**
