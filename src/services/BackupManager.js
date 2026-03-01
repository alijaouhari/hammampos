/**
 * BackupManager - Multi-Format Database Backup
 * Free alternative to Excel - supports CSV, JSON, HTML, and TXT formats
 * Saves to user-friendly locations for Google Drive sync and emergency access
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class BackupManager {
  constructor(backupDir = null) {
    // Save to user's Documents/HammamPOS folder for easy access and Google Drive sync
    this.backupDir = backupDir || path.join(os.homedir(), 'Documents', 'HammamPOS-Backups');
    this.formats = ['csv', 'json', 'html', 'txt'];
    this.ensureBackupDirectory();
  }

  /**
   * Ensure backup directory exists
   */
  ensureBackupDirectory() {
    try {
      console.log('🔧 Checking backup directory:', this.backupDir);
      
      if (!fs.existsSync(this.backupDir)) {
        console.log('📁 Creating backup directory:', this.backupDir);
        fs.mkdirSync(this.backupDir, { recursive: true });
        console.log('✅ Backup directory created successfully');
        
        // Verify directory was created
        if (fs.existsSync(this.backupDir)) {
          console.log('✅ Directory verification successful');
        } else {
          console.error('❌ Directory verification failed - directory does not exist after creation');
        }
        
        // Create a README file to explain what this folder is
        const readmePath = path.join(this.backupDir, 'README.txt');
        const readmeContent = `🏛️ HammamPOS - النسخ الاحتياطية
=====================================

هذا المجلد يحتوي على النسخ الاحتياطية لبيانات نظام HammamPOS.

📊 الملفات المتاحة:
• summary.html - ملخص شامل (افتح في المتصفح)
• tickets.csv - التذاكر المباعة (يفتح في Excel/LibreOffice)
• expenses.csv - المصروفات (يفتح في Excel/LibreOffice)
• collections.csv - عمليات التحصيل (يفتح في Excel/LibreOffice)
• tickets.json - بيانات التذاكر (للمطورين)
• expenses.json - بيانات المصروفات (للمطورين)
• collections.json - بيانات التحصيل (للمطورين)

☁️ للنسخ الاحتياطي السحابي المجاني:
1. قم بتحميل Google Drive على الكمبيوتر
2. انسخ هذا المجلد إلى مجلد Google Drive
3. ستتم مزامنة البيانات تلقائياً مع السحابة
4. يمكنك الوصول للبيانات من أي مكان عبر drive.google.com

🆘 في حالة الطوارئ:
إذا تعطل التطبيق، يمكنك الوصول لجميع بياناتك من هذا المجلد:
• افتح summary.html في المتصفح لرؤية ملخص شامل
• افتح ملفات CSV في Excel أو LibreOffice للتحليل
• جميع الملفات تعمل بدون الحاجة للتطبيق

📱 الوصول من الهاتف:
• افتح تطبيق Google Drive على الهاتف
• ابحث عن مجلد HammamPOS-Backups
• افتح summary.html لرؤية البيانات

🔄 التحديث التلقائي:
البيانات تُحدث تلقائياً مع كل عملية بيع أو مصروف في التطبيق.

آخر تحديث: ${new Date().toLocaleString('ar-MA')}
المجلد: ${this.backupDir}
`;
        
        fs.writeFileSync(readmePath, readmeContent, 'utf8');
        console.log('📄 README file created at:', readmePath);
      } else {
        console.log('✅ Backup directory already exists');
      }
      
      // Test write permissions
      const testFile = path.join(this.backupDir, 'test-write.txt');
      try {
        fs.writeFileSync(testFile, 'Test write permissions', 'utf8');
        fs.unlinkSync(testFile);
        console.log('✅ Write permissions verified');
      } catch (writeError) {
        console.error('❌ Write permission test failed:', writeError);
        throw new Error(`Cannot write to backup directory: ${writeError.message}`);
      }
      
    } catch (error) {
      console.error('❌ Failed to create backup directory:', error);
      console.error('Error details:', error.stack);
      
      // Fallback to app directory if user directory fails
      console.log('🔄 Trying fallback directory...');
      this.backupDir = path.join(__dirname, '../../data/backups');
      console.log('📁 Fallback directory:', this.backupDir);
      
      try {
        if (!fs.existsSync(this.backupDir)) {
          fs.mkdirSync(this.backupDir, { recursive: true });
          console.log('✅ Fallback directory created');
        }
      } catch (fallbackError) {
        console.error('❌ Fallback directory creation also failed:', fallbackError);
        throw new Error(`Cannot create backup directory: ${fallbackError.message}`);
      }
    }
  }

  /**
   * Add ticket to all backup formats
   */
  async addTicket(ticket) {
    try {
      console.log('📝 Adding ticket to backups:', ticket);
      
      const ticketData = {
        serial: `${ticket.category_name}-${ticket.serial_number}/${ticket.year}`,
        category: ticket.category_name,
        price: ticket.price,
        timestamp: ticket.timestamp || new Date().toISOString(),
        date: ticket.timestamp?.split('T')[0] || new Date().toISOString().split('T')[0],
        time: ticket.timestamp?.split('T')[1]?.split('.')[0] || new Date().toTimeString().split(' ')[0]
      };

      await this.appendToCSV('tickets.csv', ticketData, ['serial', 'category', 'price', 'date', 'time']);
      await this.appendToJSON('tickets.json', ticketData);
      await this.updateHTML();
      await this.appendToTXT('tickets.txt', `${ticketData.date} ${ticketData.time} - ${ticketData.category}: ${ticketData.price} درهم (${ticketData.serial})`);
      
      console.log('✅ Ticket added to all backup formats');
    } catch (error) {
      console.error('❌ Failed to add ticket to backups:', error);
    }
  }

  /**
   * Add expense to all backup formats
   */
  async addExpense(expense) {
    try {
      console.log('💸 Adding expense to backups:', expense);
      
      const expenseData = {
        description: expense.description,
        amount: expense.amount,
        timestamp: expense.timestamp || new Date().toISOString(),
        date: expense.timestamp?.split('T')[0] || new Date().toISOString().split('T')[0],
        time: expense.timestamp?.split('T')[1]?.split('.')[0] || new Date().toTimeString().split(' ')[0]
      };

      await this.appendToCSV('expenses.csv', expenseData, ['description', 'amount', 'date', 'time']);
      await this.appendToJSON('expenses.json', expenseData);
      await this.updateHTML();
      await this.appendToTXT('expenses.txt', `${expenseData.date} ${expenseData.time} - ${expenseData.description}: ${expenseData.amount} درهم`);
      
      console.log('✅ Expense added to all backup formats');
    } catch (error) {
      console.error('❌ Failed to add expense to backups:', error);
    }
  }

  /**
   * Add collection to all backup formats
   */
  async addCollection(collection) {
    try {
      console.log('💰 Adding collection to backups:', collection);
      
      const collectionData = {
        amount: collection.amount,
        notes: collection.notes || '',
        timestamp: collection.timestamp || new Date().toISOString(),
        date: collection.timestamp?.split('T')[0] || new Date().toISOString().split('T')[0],
        time: collection.timestamp?.split('T')[1]?.split('.')[0] || new Date().toTimeString().split(' ')[0]
      };

      await this.appendToCSV('collections.csv', collectionData, ['amount', 'notes', 'date', 'time']);
      await this.appendToJSON('collections.json', collectionData);
      await this.updateHTML();
      await this.appendToTXT('collections.txt', `${collectionData.date} ${collectionData.time} - تحصيل: ${collectionData.amount} درهم ${collectionData.notes ? '(' + collectionData.notes + ')' : ''}`);
      
      console.log('✅ Collection added to all backup formats');
    } catch (error) {
      console.error('❌ Failed to add collection to backups:', error);
    }
  }

  /**
   * Append data to CSV file
   */
  async appendToCSV(filename, data, headers) {
    const filePath = path.join(this.backupDir, filename);
    
    // Check if file exists, if not create with headers
    if (!fs.existsSync(filePath)) {
      const headerRow = headers.join(',') + '\n';
      fs.writeFileSync(filePath, '\uFEFF' + headerRow, 'utf8'); // Add BOM for Arabic support
    }
    
    // Append data row
    const dataRow = headers.map(header => {
      const value = data[header] || '';
      // Escape commas and quotes in CSV
      return typeof value === 'string' && (value.includes(',') || value.includes('"')) 
        ? `"${value.replace(/"/g, '""')}"` 
        : value;
    }).join(',') + '\n';
    
    fs.appendFileSync(filePath, dataRow, 'utf8');
  }

  /**
   * Append data to JSON file
   */
  async appendToJSON(filename, data) {
    const filePath = path.join(this.backupDir, filename);
    
    let jsonData = [];
    
    // Read existing data if file exists
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        jsonData = JSON.parse(content);
      } catch (error) {
        console.warn('Failed to parse existing JSON, starting fresh');
        jsonData = [];
      }
    }
    
    // Add new data
    jsonData.push(data);
    
    // Write back to file with proper formatting
    fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
  }

  /**
   * Append line to text file
   */
  async appendToTXT(filename, line) {
    const filePath = path.join(this.backupDir, filename);
    const content = line + '\n';
    fs.appendFileSync(filePath, content, 'utf8');
  }

  /**
   * Update HTML summary file
   */
  async updateHTML() {
    try {
      const htmlPath = path.join(this.backupDir, 'summary.html');
      
      // Read all data
      const tickets = await this.readJSONFile('tickets.json');
      const expenses = await this.readJSONFile('expenses.json');
      const collections = await this.readJSONFile('collections.json');
      
      // Calculate totals
      const totalRevenue = tickets.reduce((sum, t) => sum + (t.price || 0), 0);
      const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
      const totalCollections = collections.reduce((sum, c) => sum + (c.amount || 0), 0);
      const netProfit = totalRevenue - totalExpenses;
      
      const html = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HammamPOS - ملخص البيانات</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            direction: rtl; 
            background: #f8fafc;
            color: #1f2937;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            text-align: center; 
            color: #2563eb; 
            margin-bottom: 30px; 
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header h1 { margin: 0; font-size: 2rem; }
        .header p { margin: 10px 0 0 0; color: #6b7280; }
        .summary { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px; 
        }
        .card { 
            background: white; 
            border: 2px solid #e5e7eb; 
            border-radius: 12px; 
            padding: 20px; 
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: transform 0.2s ease;
        }
        .card:hover { transform: translateY(-2px); }
        .card h3 { margin: 0 0 15px 0; color: #374151; font-size: 1rem; }
        .card .value { font-size: 1.8rem; font-weight: bold; margin-bottom: 5px; }
        .card .label { font-size: 0.9rem; color: #6b7280; }
        .revenue { color: #059669; }
        .expense { color: #dc2626; }
        .profit { color: ${netProfit >= 0 ? '#059669' : '#dc2626'}; }
        .info { color: #2563eb; }
        
        table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 20px 0; 
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        th, td { 
            border: 1px solid #e5e7eb; 
            padding: 12px 8px; 
            text-align: center; 
        }
        th { 
            background: #f3f4f6; 
            font-weight: 600; 
            color: #374151;
            border-bottom: 2px solid #d1d5db;
        }
        tbody tr:nth-child(even) { background: #f9fafb; }
        tbody tr:hover { background: #eff6ff; }
        
        .section { 
            margin: 30px 0; 
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .section h2 { 
            color: #1f2937; 
            border-bottom: 3px solid #2563eb; 
            padding-bottom: 10px; 
            margin-top: 0;
            font-size: 1.3rem;
        }
        
        .timestamp { 
            font-size: 0.9rem; 
            color: #6b7280; 
            text-align: center; 
            margin-top: 40px; 
            padding: 20px;
            background: white;
            border-radius: 8px;
            border: 1px solid #e5e7eb;
        }
        
        .emergency-info {
            background: #fef3c7;
            border: 2px solid #f59e0b;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .emergency-info h3 {
            color: #92400e;
            margin: 0 0 10px 0;
        }
        
        .file-info {
            background: #e0f2fe;
            border: 1px solid #0284c7;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .file-info h3 {
            color: #0c4a6e;
            margin: 0 0 10px 0;
        }
        
        .no-data {
            text-align: center;
            color: #6b7280;
            font-style: italic;
            padding: 20px;
        }
        
        @media print {
            body { background: white; }
            .card { break-inside: avoid; }
            .section { break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏛️ HammamPOS - ملخص البيانات</h1>
            <p>نسخة احتياطية شاملة من قاعدة البيانات - يمكن الوصول إليها بدون التطبيق</p>
        </div>
        
        <div class="emergency-info">
            <h3>🆘 معلومات الطوارئ</h3>
            <p>هذا الملف يعمل بدون الحاجة للتطبيق. يمكنك الوصول لجميع بياناتك حتى لو تعطل التطبيق.</p>
        </div>
        
        <div class="file-info">
            <h3>📁 ملفات أخرى متاحة في هذا المجلد</h3>
            <p><strong>tickets.csv</strong> - التذاكر (يفتح في Excel/LibreOffice) | 
               <strong>expenses.csv</strong> - المصروفات | 
               <strong>collections.csv</strong> - التحصيلات</p>
        </div>
        
        <div class="summary">
            <div class="card">
                <h3>إجمالي الإيرادات</h3>
                <div class="value revenue">${totalRevenue.toLocaleString()}</div>
                <div class="label">درهم</div>
            </div>
            <div class="card">
                <h3>إجمالي المصروفات</h3>
                <div class="value expense">${totalExpenses.toLocaleString()}</div>
                <div class="label">درهم</div>
            </div>
            <div class="card">
                <h3>صافي الربح</h3>
                <div class="value profit">${netProfit.toLocaleString()}</div>
                <div class="label">درهم</div>
            </div>
            <div class="card">
                <h3>عدد التذاكر</h3>
                <div class="value info">${tickets.length.toLocaleString()}</div>
                <div class="label">تذكرة</div>
            </div>
            <div class="card">
                <h3>عدد المصروفات</h3>
                <div class="value info">${expenses.length.toLocaleString()}</div>
                <div class="label">مصروف</div>
            </div>
            <div class="card">
                <h3>عمليات التحصيل</h3>
                <div class="value info">${collections.length.toLocaleString()}</div>
                <div class="label">عملية</div>
            </div>
        </div>

        <div class="section">
            <h2>📊 آخر 50 تذكرة</h2>
            ${tickets.length > 0 ? `
            <table>
                <thead>
                    <tr><th>التاريخ</th><th>الوقت</th><th>الفئة</th><th>السعر</th><th>الرقم التسلسلي</th></tr>
                </thead>
                <tbody>
                    ${tickets.slice(-50).reverse().map(t => `
                        <tr>
                            <td>${t.date}</td>
                            <td>${t.time}</td>
                            <td>${t.category}</td>
                            <td>${t.price} درهم</td>
                            <td>${t.serial}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ` : '<div class="no-data">لا توجد تذاكر مسجلة</div>'}
        </div>

        <div class="section">
            <h2>💸 آخر 50 مصروف</h2>
            ${expenses.length > 0 ? `
            <table>
                <thead>
                    <tr><th>التاريخ</th><th>الوقت</th><th>الوصف</th><th>المبلغ</th></tr>
                </thead>
                <tbody>
                    ${expenses.slice(-50).reverse().map(e => `
                        <tr>
                            <td>${e.date}</td>
                            <td>${e.time}</td>
                            <td>${e.description}</td>
                            <td>${e.amount} درهم</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ` : '<div class="no-data">لا توجد مصروفات مسجلة</div>'}
        </div>

        <div class="section">
            <h2>💰 عمليات التحصيل</h2>
            ${collections.length > 0 ? `
            <table>
                <thead>
                    <tr><th>التاريخ</th><th>الوقت</th><th>المبلغ</th><th>الملاحظات</th></tr>
                </thead>
                <tbody>
                    ${collections.slice(-50).reverse().map(c => `
                        <tr>
                            <td>${c.date}</td>
                            <td>${c.time}</td>
                            <td>${c.amount} درهم</td>
                            <td>${c.notes || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            ` : '<div class="no-data">لا توجد عمليات تحصيل مسجلة</div>'}
        </div>

        <div class="timestamp">
            <strong>آخر تحديث:</strong> ${new Date().toLocaleString('ar-MA')}<br>
            <strong>المجلد:</strong> ${this.backupDir}<br>
            <strong>💡 نصيحة:</strong> انسخ هذا المجلد إلى Google Drive للحصول على نسخة احتياطية سحابية مجانية
        </div>
    </div>
</body>
</html>`;

      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log('✅ HTML summary updated');
      
    } catch (error) {
      console.error('❌ Failed to update HTML summary:', error);
    }
  }

  /**
   * Read JSON file helper
   */
  async readJSONFile(filename) {
    const filePath = path.join(this.backupDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return [];
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.warn(`Failed to read ${filename}:`, error.message);
      return [];
    }
  }

  /**
   * Get backup status and file info
   */
  async getBackupStatus() {
    try {
      const files = {};
      const formats = ['csv', 'json', 'html', 'txt'];
      
      for (const format of formats) {
        files[format] = {};
        
        const fileTypes = ['tickets', 'expenses', 'collections'];
        if (format === 'html') fileTypes.push('summary');
        
        for (const type of fileTypes) {
          const filename = format === 'html' && type === 'summary' 
            ? 'summary.html' 
            : `${type}.${format}`;
          const filePath = path.join(this.backupDir, filename);
          
          if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            files[format][type] = {
              exists: true,
              size: stats.size,
              modified: stats.mtime,
              path: filePath
            };
          } else {
            files[format][type] = { exists: false };
          }
        }
      }
      
      return {
        backupDir: this.backupDir,
        files,
        totalFiles: Object.values(files).reduce((total, format) => 
          total + Object.values(format).filter(f => f.exists).length, 0
        )
      };
      
    } catch (error) {
      console.error('Failed to get backup status:', error);
      return { error: error.message };
    }
  }

  /**
   * Clear all backup files
   */
  async clearAllBackups() {
    try {
      const files = fs.readdirSync(this.backupDir);
      
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        fs.unlinkSync(filePath);
      }
      
      console.log('✅ All backup files cleared');
      return { success: true, cleared: files.length };
      
    } catch (error) {
      console.error('❌ Failed to clear backups:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Rebuild all backups from database
   */
  async rebuildFromDatabase(storage) {
    try {
      console.log('🔄 Rebuilding backups from database...');
      
      // Clear existing backups
      await this.clearAllBackups();
      
      // Get all data from database
      const tickets = storage.getTickets('2000-01-01', '2099-12-31');
      const expenses = storage.getExpenses('2000-01-01', '2099-12-31');
      const collections = storage.getCollections('2000-01-01', '2099-12-31');
      
      // Add all tickets
      for (const ticket of tickets) {
        await this.addTicket(ticket);
      }
      
      // Add all expenses
      for (const expense of expenses) {
        await this.addExpense(expense);
      }
      
      // Add all collections
      for (const collection of collections) {
        await this.addCollection(collection);
      }
      
      console.log('✅ Backups rebuilt from database');
      return { 
        success: true, 
        tickets: tickets.length, 
        expenses: expenses.length, 
        collections: collections.length 
      };
      
    } catch (error) {
      console.error('❌ Failed to rebuild backups:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = BackupManager;