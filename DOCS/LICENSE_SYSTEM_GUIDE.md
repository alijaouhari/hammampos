# HammamPOS License System Guide

## Implementation Complete

Base POS license enforcement has been implemented with activation screen, keygen GUI, and customer dashboard.

---

## Files Changed

### New Files Created:
1. `src/renderer/license-activation.html` - License activation screen
2. `tools/keygen-gui.html` - License key generator GUI
3. `tools/customer-dashboard.html` - Customer management dashboard
4. `tools/launch-keygen.bat` - Keygen launcher script
5. `tools/launch-customer-dashboard.bat` - Dashboard launcher script

### Modified Files:
1. `src/main/main-working.js` - Added base license check on startup

---

## Startup Flow After Changes

### 1. Application Launch
```
User runs HammamPOS
  ↓
License Manager initializes
  ↓
Check for base license (hammampos-core)
  ↓
├─ License Valid → Continue to Setup Wizard or Main App
└─ License Invalid → Show License Activation Screen
```

### 2. License Activation Screen
```
License Screen displays:
  - Machine ID (read-only, copyable)
  - License Key input field
  - Activate button
  ↓
User enters license key
  ↓
Click "Activate"
  ↓
System validates key
  ↓
├─ Valid → Continue to Setup Wizard
└─ Invalid → Show error, stay on screen
```

### 3. After Activation
```
License validated
  ↓
Check if first run (no hammam name)
  ↓
├─ First Run → Show Setup Wizard
└─ Configured → Open Main POS Application
```

---

## How to Generate a Base POS License

### Method 1: Using Keygen GUI (Recommended)

1. **Launch Keygen Tool:**
   ```
   Double-click: tools/launch-keygen.bat
   OR
   Open: tools/keygen-gui.html in browser
   ```

2. **Fill in the form:**
   - **License Type:** Select "HammamPOS Core (الترخيص الأساسي)"
   - **Machine ID:** Paste the Machine ID from customer's activation screen
   - **Duration:** Enter months (default: 12)

3. **Generate Key:**
   - Click "توليد مفتاح الترخيص"
   - Copy the generated key (format: XXXX-XXXX-XXXX-XXXX)

4. **Send to Customer:**
   - Send key via WhatsApp or secure channel

### Method 2: Using Command Line

```bash
cd tools
node license-generator.js hammampos-core <machine-id> 12
```

Example:
```bash
node license-generator.js hammampos-core 9d70222b3b897df5 12
```

Output:
```
License Key: A3F2-9D4E-7B1C-5E8A
```

---

## How to Activate License on Clean Machine

### Step 1: Install HammamPOS
1. Run installer on customer's machine
2. Complete installation

### Step 2: First Launch
1. Launch HammamPOS
2. License activation screen appears automatically

### Step 3: Get Machine ID
1. Copy the Machine ID displayed on screen
2. Send to license provider (you)

### Step 4: Generate License
1. Use Keygen GUI or command line
2. Generate key for "hammampos-core" feature
3. Use customer's Machine ID

### Step 5: Activate
1. Customer enters license key in activation screen
2. Click "تفعيل الترخيص"
3. System validates and continues to setup wizard

### Step 6: Complete Setup
1. Setup wizard appears
2. Configure hammam name, password, categories
3. Configure printer
4. Complete setup

### Step 7: Start Using
1. Main POS application opens
2. System is ready for use

---

## How to Use Keygen GUI

### Launch:
```
Double-click: tools/launch-keygen.bat
```

### Interface:
- **License Type Dropdown:** Select feature to license
  - hammampos-core (Base POS)
  - inventory-management
  - spa-appointments
  - commission-system
  - loyalty-cards
  - analytics-dashboard
  - multi-location
  - communication-tools
  - financial-integration

- **Machine ID Field:** Paste customer's machine fingerprint

- **Duration Field:** Enter months (1-120)

- **Generate Button:** Creates license key

### Output:
- License key in format: XXXX-XXXX-XXXX-XXXX
- Feature ID
- Machine ID (first 16 chars)
- Duration in months
- Expiration date
- Copy button for easy sharing

---

## How to Use Customer Dashboard GUI

### Launch:
```
Double-click: tools/launch-customer-dashboard.bat
```

### Features:

#### 1. Dashboard Overview
- Total customers count
- Active licenses count
- Monthly installations count

#### 2. Add New Customer
Click "إضافة عميل جديد" button

**Required Fields:**
- Customer Name (اسم العميل)
- Hammam Name (اسم الحمام)
- Phone Number (رقم الهاتف)

**Optional Fields:**
- City (المدينة)
- Installation Date (تاريخ التثبيت)
- Machine Fingerprint (معرف الجهاز)
- License Key (مفتاح الترخيص)
- Installed Version (الإصدار المثبت)
- Addons (الإضافات المفعلة)
- Installation Type (نوع التثبيت)
- Reinstall Fee (رسوم إعادة التثبيت)
- Notes (ملاحظات)

#### 3. Edit Customer
- Click "تعديل" button on any customer row
- Update information
- Click "حفظ" to save

#### 4. Delete Customer
- Click "حذف" button on any customer row
- Confirm deletion

#### 5. Search
- Use search box to filter by:
  - Customer name
  - Hammam name
  - Phone number
  - City

#### 6. Export Data
- Click "تصدير البيانات"
- Downloads JSON file with all customer data
- Filename: `hammampos-customers-YYYY-MM-DD.json`

#### 7. Import Data
- Click "استيراد البيانات"
- Select JSON file
- Confirm import

### Data Storage:
- File: `tools/customers-data.json`
- Format: JSON array of customer objects
- Automatically saved on every change

---

## Typical Workflow

### New Installation:

1. **Open Customer Dashboard**
   ```
   tools/launch-customer-dashboard.bat
   ```

2. **Add Customer Record**
   - Click "إضافة عميل جديد"
   - Enter customer name, hammam name, phone
   - Set installation date to today
   - Save

3. **Install on Customer PC**
   - Run HammamPOS installer
   - Launch application
   - License screen appears

4. **Capture Machine ID**
   - Copy Machine ID from customer's screen
   - Update customer record in dashboard
   - Paste Machine ID

5. **Generate Base License**
   ```
   tools/launch-keygen.bat
   ```
   - Select "HammamPOS Core"
   - Paste Machine ID
   - Set duration (12 months)
   - Click "توليد مفتاح الترخيص"
   - Copy generated key

6. **Update Customer Record**
   - Paste license key in customer dashboard
   - Set installed version (2.0.0)
   - Save

7. **Activate on Customer PC**
   - Enter license key in activation screen
   - Click "تفعيل الترخيص"
   - Setup wizard appears

8. **Complete Setup**
   - Follow setup wizard steps
   - Configure hammam details
   - Configure printer
   - Create categories
   - Finish setup

9. **Record Installation**
   - Update customer record
   - Mark installation as complete
   - Add any notes

### Adding Addon License:

1. **Open Keygen GUI**
2. **Select Addon Feature**
   - Example: "Inventory Management"
3. **Use Same Machine ID**
4. **Generate Addon Key**
5. **Send to Customer**
6. **Customer Activates in Settings**

---

## License File Locations

### Base License:
```
data/licenses/hammampos-core.license
```

### Addon Licenses:
```
data/licenses/inventory-management.license
data/licenses/spa-appointments.license
data/licenses/commission-system.license
... etc
```

### License Format:
```json
{
  "encrypted": "hex-encoded-encrypted-data",
  "iv": "hex-encoded-initialization-vector",
  "algorithm": "aes-256-cbc"
}
```

---

## Security Notes

1. **Master Secret:** Hardcoded in `tools/license-generator.js`
   - Keep this file secure
   - Do not share with customers

2. **Hardware Binding:** Licenses tied to machine fingerprint
   - Cannot transfer between machines
   - Reinstall requires new license or same machine

3. **Offline Validation:** No internet required
   - All validation is local
   - License files encrypted with hardware fingerprint

4. **Expiration:** Encoded in license key
   - Default: 12 months
   - Configurable during generation

---

## Troubleshooting

### License Screen Doesn't Appear:
- Check if `data/licenses/hammampos-core.license` exists
- Delete file to force re-activation

### Invalid License Key Error:
- Verify Machine ID matches exactly
- Check key format: XXXX-XXXX-XXXX-XXXX
- Ensure key generated for correct feature

### License Expired:
- Generate new key with extended duration
- Customer must re-activate

### Hardware Mismatch:
- Machine fingerprint changed (OS reinstall, hardware change)
- Generate new license for new Machine ID
- May charge reinstall fee

---

## Support Workflow

### Customer Reports Issue:

1. **Check Customer Dashboard**
   - Find customer record
   - Review installation details
   - Check license key and expiration

2. **Verify License Status**
   - Ask customer for Machine ID
   - Compare with recorded ID
   - Check if hardware changed

3. **Generate New License if Needed**
   - Use Keygen GUI
   - Update customer record
   - Send new key

4. **Record Support Interaction**
   - Add notes to customer record
   - Update reinstall fee if applicable
   - Save changes

---

## End of Guide
