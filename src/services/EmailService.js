/**
 * HammamPOS - EmailService
 * Copyright (c) 2024 HammamPOS Solutions. All rights reserved.
 * 
 * This software is proprietary and confidential.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Email Reporting - Handles sending daily reports via email
 * REQ-14: Email reporting functionality
 */

const nodemailer = require('nodemailer');

class EmailService {
  constructor(storageManager) {
    this.storage = storageManager;
    this.transporter = null;
    this.isInitialized = false;
  }

  /**
   * Initialize email service with SMTP configuration
   */
  async initialize() {
    try {
      console.log('📧 Initializing EmailService...');
      
      // Get email settings from storage
      const emailEnabled = this.storage.getSetting('email_enabled');
      if (emailEnabled !== 'true') {
        console.log('📧 Email service disabled');
        return { success: false, reason: 'disabled' };
      }
      
      const emailAddress = this.storage.getSetting('email_address');
      const emailPassword = this.storage.getSetting('email_password');
      const smtpHost = this.storage.getSetting('email_smtp_host') || 'smtp.gmail.com';
      const smtpPort = parseInt(this.storage.getSetting('email_smtp_port')) || 587;
      
      if (!emailAddress || !emailPassword) {
        console.log('📧 Email credentials not configured');
        return { success: false, reason: 'no_credentials' };
      }
      
      // Create transporter
      this.transporter = nodemailer.createTransporter({
        host: smtpHost,
        port: smtpPort,
        secure: false, // true for 465, false for other ports
        auth: {
          user: emailAddress,
          pass: emailPassword
        }
      });
      
      // Verify connection
      await this.transporter.verify();
      
      this.isInitialized = true;
      console.log('✅ EmailService initialized successfully');
      
      return { success: true };
    } catch (error) {
      console.error('❌ EmailService initialization failed:', error);
      this.isInitialized = false;
      return { success: false, error: error.message };
    }
  }

  /**
   * Test email connection
   */
  async testConnection(emailConfig = null) {
    try {
      let testTransporter;
      
      if (emailConfig) {
        // Use provided config for testing
        testTransporter = nodemailer.createTransporter({
          host: emailConfig.host,
          port: parseInt(emailConfig.port),
          secure: false,
          auth: {
            user: emailConfig.user,
            pass: emailConfig.password
          }
        });
      } else {
        // Use current transporter
        if (!this.transporter) {
          throw new Error('Email service not initialized');
        }
        testTransporter = this.transporter;
      }
      
      await testTransporter.verify();
      console.log('✅ Email connection test successful');
      
      return { success: true };
    } catch (error) {
      console.error('❌ Email connection test failed:', error);
      throw error;
    }
  }

  /**
   * Send daily report email
   */
  async sendDailyReport(recipientEmail, reportData) {
    if (!this.isInitialized) {
      throw new Error('Email service not initialized');
    }
    
    try {
      const hammamName = this.storage.getSetting('hammam_name') || 'الحمام';
      const subject = `تقرير يومي - ${hammamName} - ${reportData.date}`;
      
      // Generate HTML email content
      const htmlContent = this.generateReportHTML(reportData, hammamName);
      
      // Send email
      const info = await this.transporter.sendMail({
        from: this.storage.getSetting('email_address'),
        to: recipientEmail,
        subject: subject,
        html: htmlContent
      });
      
      console.log('✅ Daily report email sent:', info.messageId);
      
      // Log email send
      this.storage.logAudit('EMAIL_SENT', 'email', null, 
        `Daily report sent to ${recipientEmail} for ${reportData.date}`);
      
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Failed to send daily report:', error);
      
      // Log email error
      this.storage.logAudit('EMAIL_ERROR', 'email', null, 
        `Failed to send daily report: ${error.message}`);
      
      throw error;
    }
  }

  /**
   * Generate HTML content for daily report
   */
  generateReportHTML(reportData, hammamName) {
    const formatDate = (dateStr) => {
      return new Date(dateStr).toLocaleDateString('ar-MA', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    };
    
    const formatCurrency = (amount) => {
      return `${amount} درهم`;
    };
    
    // Generate category breakdown HTML
    let categoryHTML = '';
    Object.entries(reportData.categoryBreakdown).forEach(([category, data]) => {
      categoryHTML += `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">${category}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${data.count}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${formatCurrency(data.revenue)}</td>
        </tr>
      `;
    });
    
    // Generate expenses HTML
    let expensesHTML = '';
    if (reportData.expenses.length > 0) {
      reportData.expenses.forEach(expense => {
        expensesHTML += `
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${expense.description}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${expense.time}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${formatCurrency(expense.amount)}</td>
          </tr>
        `;
      });
    } else {
      expensesHTML = '<tr><td colspan="3" style="padding: 8px; text-align: center; color: #666;">لا توجد مصروفات</td></tr>';
    }
    
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>تقرير يومي - ${hammamName}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
            direction: rtl;
            text-align: right;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: #2563eb;
            color: white;
            padding: 20px;
            text-align: center;
        }
        .content {
            padding: 20px;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .summary-card {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            padding: 15px;
            text-align: center;
        }
        .summary-card h3 {
            margin: 0 0 10px 0;
            color: #374151;
            font-size: 14px;
        }
        .summary-card .value {
            font-size: 24px;
            font-weight: bold;
            color: #059669;
        }
        .summary-card.expenses .value {
            color: #dc2626;
        }
        .summary-card.net .value {
            color: ${reportData.netRevenue >= 0 ? '#059669' : '#dc2626'};
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th {
            background: #f3f4f6;
            padding: 12px 8px;
            border: 1px solid #d1d5db;
            font-weight: 600;
        }
        td {
            padding: 8px;
            border: 1px solid #e5e7eb;
        }
        .section-title {
            color: #374151;
            border-bottom: 2px solid #e5e7eb;
            padding-bottom: 10px;
            margin: 30px 0 15px 0;
        }
        .footer {
            background: #f8fafc;
            padding: 15px 20px;
            text-align: center;
            color: #6b7280;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏛️ ${hammamName}</h1>
            <h2>التقرير اليومي</h2>
            <p>${formatDate(reportData.date)}</p>
        </div>
        
        <div class="content">
            <div class="summary-grid">
                <div class="summary-card">
                    <h3>إجمالي التذاكر</h3>
                    <div class="value">${reportData.totalTickets}</div>
                </div>
                <div class="summary-card">
                    <h3>إجمالي الإيرادات</h3>
                    <div class="value">${formatCurrency(reportData.totalRevenue)}</div>
                </div>
                <div class="summary-card expenses">
                    <h3>إجمالي المصروفات</h3>
                    <div class="value">${formatCurrency(reportData.totalExpenses)}</div>
                </div>
                <div class="summary-card net">
                    <h3>صافي الربح</h3>
                    <div class="value">${formatCurrency(reportData.netRevenue)}</div>
                </div>
                <div class="summary-card">
                    <h3>النقد في الصندوق</h3>
                    <div class="value">${formatCurrency(reportData.cashInHand)}</div>
                </div>
            </div>
            
            <h3 class="section-title">📊 تفصيل المبيعات حسب الفئة</h3>
            <table>
                <thead>
                    <tr>
                        <th>الفئة</th>
                        <th>عدد التذاكر</th>
                        <th>الإيرادات</th>
                    </tr>
                </thead>
                <tbody>
                    ${categoryHTML}
                </tbody>
            </table>
            
            <h3 class="section-title">💸 المصروفات</h3>
            <table>
                <thead>
                    <tr>
                        <th>الوصف</th>
                        <th>الوقت</th>
                        <th>المبلغ</th>
                    </tr>
                </thead>
                <tbody>
                    ${expensesHTML}
                </tbody>
            </table>
        </div>
        
        <div class="footer">
            <p>تم إنشاء هذا التقرير تلقائياً بواسطة نظام HammamPOS</p>
            <p>التاريخ والوقت: ${new Date().toLocaleString('ar-MA')}</p>
        </div>
    </div>
</body>
</html>
    `;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      enabled: this.storage.getSetting('email_enabled') === 'true',
      configured: !!(this.storage.getSetting('email_address') && this.storage.getSetting('email_password'))
    };
  }
}

module.exports = EmailService;