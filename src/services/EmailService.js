/**
 * HammamPOS - EmailService
 * Copyright (c) 2024-2026 Ali Jaouhari. All rights reserved.
 * 
 * Unauthorized copying or distribution is strictly prohibited.
 * Unauthorized copying or distribution is strictly prohibited.
 * 
 * Email Reporting - Handles sending daily reports via email
 * REQ-14: Email reporting functionality
 */

const nodemailer = require('nodemailer');
const { getLanguage, getHammamName } = require('./DailyReport');

// Fixed texts of the e-mails, in the same wording as the app screens (see src/renderer/i18n-fr.js).
const TEXTS = {
  ar: {
    report: {
      title: 'التقرير اليومي',
      tickets: 'التذاكر',
      sales: 'المبيعات',
      expenses: 'المصروفات',
      net: 'الصافي',
      netHint: 'المبيعات ناقص المصروفات',
      refunds: 'الاسترجاعات',
      salesByCategory: 'المبيعات حسب الفئة',
      category: 'الفئة',
      amount: 'المبلغ',
      noTickets: 'لا توجد تذاكر مباعة في هذا اليوم',
      expensesOfDay: 'مصروفات اليوم',
      description: 'الوصف',
      status: 'الحالة',
      paid: 'مدفوع',
      unpaid: 'غير مدفوع',
      totalExpenses: 'إجمالي المصروفات',
      noExpenses: 'لا توجد مصروفات في هذا اليوم',
      moneyNow: 'وضع المال عند إرسال التقرير',
      cash: 'النقد في الصندوق',
      owedToSuppliers: 'مستحق للموردين',
      owedToManager: 'مستحق للمدير',
      owedBySeller: 'ما على البائع',
      changeFloat: 'صندوق الصرف',
      openBills: 'الفواتير غير المدفوعة',
      pendingLate: 'إدخالات متأخرة',
      footer: 'أُنشئ هذا التقرير تلقائياً بواسطة HammamPOS'
    },
    recovery: {
      title: 'رمز استرجاع كلمة مرور الإدارة',
      intro: 'طُلب رمز لإعادة تعيين كلمة مرور الإدارة في HammamPOS. الرمز:',
      neverShare: 'لا تشارك هذا الرمز مع أي شخص أبداً.',
      validity: 'صالح لمدة 15 دقيقة ويُستعمل مرة واحدة.',
      ignore: 'إذا لم تطلبه فتجاهل هذه الرسالة.',
      requestedAt: 'وقت الطلب'
    }
  },
  fr: {
    report: {
      title: 'Rapport journalier',
      tickets: 'Tickets',
      sales: 'Ventes',
      expenses: 'Dépenses',
      net: 'Net',
      netHint: 'Ventes moins dépenses',
      refunds: 'Remboursements',
      salesByCategory: 'Ventes par catégorie',
      category: 'Catégorie',
      amount: 'Montant',
      noTickets: 'Aucun ticket vendu ce jour',
      expensesOfDay: 'Dépenses du jour',
      description: 'Description',
      status: 'État',
      paid: 'Payé',
      unpaid: 'Impayé',
      totalExpenses: 'Total des dépenses',
      noExpenses: 'Aucune dépense ce jour',
      moneyNow: "Situation de l'argent à l'envoi du rapport",
      cash: 'Argent en caisse',
      owedToSuppliers: 'Dû aux fournisseurs',
      owedToManager: 'Dû au gérant',
      owedBySeller: 'Dû par le vendeur',
      changeFloat: 'Fonds de monnaie',
      openBills: 'Factures impayées',
      pendingLate: 'Saisies tardives',
      footer: 'Rapport généré automatiquement par HammamPOS'
    },
    recovery: {
      title: "Code de récupération du mot de passe de l'administration",
      intro: "Un code a été demandé pour réinitialiser le mot de passe de l'administration dans HammamPOS. Code :",
      neverShare: 'Ne communiquez jamais ce code à personne.',
      validity: 'Valable 15 minutes, utilisable une seule fois.',
      ignore: "Si vous ne l'avez pas demandé, ignorez ce message.",
      requestedAt: 'Demandé le'
    }
  }
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Plain Latin digits, at most 2 decimals (the same in both languages).
const fmt = (n) => String(Math.round((Number(n) || 0) * 100) / 100);
const pad = (n) => String(n).padStart(2, '0');
const shortDate = (d) => { const [y, m, day] = String(d).split('-'); return `${day}/${m}/${y}`; };
const stampOf = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
function longDate(d, lang) {
  const [y, m, day] = String(d).split('-').map(Number);
  try {
    return new Date(y, m - 1, day, 12).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'ar-MA-u-nu-latn',
      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return shortDate(d); }
}


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
      this.transporter = nodemailer.createTransport({
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
   * Send a one-off security email (e.g. password reset code) using the saved SMTP
   * settings. Independent of the daily-report toggle; needs address + app password.
   */
  async sendSecurityEmail(to, subject, html) {
    const user = this.storage.getSetting('email_address');
    const pass = this.storage.getSetting('email_password');
    const host = this.storage.getSetting('email_smtp_host') || 'smtp.gmail.com';
    const port = parseInt(this.storage.getSetting('email_smtp_port')) || 587;
    if (!user || !pass) throw new Error('email_not_configured');

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    await transporter.sendMail({ from: user, to, subject, html });
    this.storage.logAudit('EMAIL_SENT', 'email', null, 'Security email sent');
  }

  /**
   * Test email connection
   */
  async testConnection(emailConfig = null) {
    try {
      let testTransporter;
      
      if (emailConfig) {
        // Use provided config for testing
        testTransporter = nodemailer.createTransport({
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
   * Send daily report email. `report` comes from DailyReport.buildDailyReport.
   */
  async sendDailyReport(recipientEmail, report) {
    if (!this.isInitialized) {
      throw new Error('Email service not initialized');
    }
    try {
      const { subject, html } = this.renderDailyReport(report);
      const info = await this.transporter.sendMail({
        from: this.storage.getSetting('email_address'),
        to: recipientEmail,
        subject,
        html
      });
      console.log('Daily report email sent:', info.messageId);
      this.storage.logAudit('EMAIL_SENT', 'email', null,
        `Daily report sent to ${recipientEmail} for ${report.date}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Failed to send daily report:', error);
      this.storage.logAudit('EMAIL_ERROR', 'email', null,
        `Failed to send daily report: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send the admin password recovery code (language and hammam name follow the app settings).
   */
  async sendRecoveryCode(to, code) {
    const lang = getLanguage(this.storage);
    const { subject, html } = this.renderRecoveryCode({
      lang, code, hammamName: getHammamName(this.storage, lang), sentAt: new Date()
    });
    await this.sendSecurityEmail(to, subject, html);
  }

  /** Subject + HTML of the daily report. Pure: no network. */
  renderDailyReport(report, generatedAt = new Date()) {
    const lang = report.lang === 'fr' ? 'fr' : 'ar';
    const t = TEXTS[lang].report;
    const dir = lang === 'fr' ? 'ltr' : 'rtl';
    const align = lang === 'fr' ? 'left' : 'right';
    const name = esc(report.hammamName);
    const dh = (n) => `${fmt(n)}&nbsp;DH`;
    const cell = (content, extra = '') =>
      `<td style="padding:8px;border:1px solid #e5e7eb;text-align:${align};${extra}">${content}</td>`;
    const head = (labels) => `<tr>${labels.map(l =>
      `<th style="padding:8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:${align};font-weight:bold;">${l}</th>`).join('')}</tr>`;
    const section = (title) =>
      `<h3 style="margin:24px 0 10px 0;padding-bottom:6px;border-bottom:2px solid #e5e7eb;color:#374151;font-size:16px;">${title}</h3>`;
    const table = (inner) =>
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">${inner}</table>`;
    const empty = (msg) =>
      `<p style="margin:0;padding:12px;background:#f8fafc;border:1px solid #e5e7eb;color:#6b7280;text-align:center;">${msg}</p>`;
    const box = (label, value, color, hint) =>
      `<td width="50%" valign="top" style="padding:4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:12px;background:#f8fafc;border:1px solid #e2e8f0;text-align:center;">` +
      `<div style="font-size:13px;color:#374151;">${label}</div>` +
      `<div style="font-size:22px;font-weight:bold;color:${color};padding-top:4px;">${value}</div>` +
      (hint ? `<div style="font-size:11px;color:#6b7280;padding-top:2px;">${hint}</div>` : '') +
      `</td></tr></table></td>`;

    const boxes =
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
      `<tr>${box(t.tickets, report.tickets, '#059669')}${box(t.sales, dh(report.sales), '#059669')}</tr>` +
      `<tr>${box(t.expenses, dh(report.totalExpenses), '#dc2626')}${box(t.net, dh(report.net), report.net >= 0 ? '#059669' : '#dc2626', t.netHint)}</tr>` +
      `</table>`;

    const refundsLine = report.refunds.count > 0
      ? `<p style="margin:10px 4px 0 4px;color:#374151;">${t.refunds}: ${report.refunds.count} (${dh(report.refunds.total)})</p>` : '';

    const categories = report.byCategory.length
      ? table(head([t.category, t.tickets, t.amount]) + report.byCategory.map(c =>
        `<tr>${cell(`<span dir="auto">${esc(c.name)}</span>`)}${cell(c.count, 'text-align:center;')}${cell(dh(c.revenue), 'text-align:center;')}</tr>`).join(''))
      : empty(t.noTickets);

    const expenses = report.expenses.length
      ? table(head(report.switchedOver ? [t.description, t.amount, t.status] : [t.description, t.amount]) +
        report.expenses.map(e => {
          const label = `<span dir="auto">${esc(e.description)}</span>` +
            (e.supplier ? `<br><span dir="auto" style="color:#6b7280;font-size:12px;">${esc(e.supplier)}</span>` : '');
          const status = e.unpaid > 0
            ? `<span style="color:#dc2626;">${t.unpaid}: ${dh(e.unpaid)}</span>`
            : `<span style="color:#059669;">${t.paid}</span>`;
          return `<tr>${cell(label)}${cell(dh(e.amount), 'text-align:center;')}${report.switchedOver ? cell(status, 'text-align:center;') : ''}</tr>`;
        }).join('') +
        `<tr>${cell(`<strong>${t.totalExpenses}</strong>`, 'background:#f8fafc;')}${cell(`<strong>${dh(report.totalExpenses)}</strong>`, 'text-align:center;background:#f8fafc;')}${report.switchedOver ? cell('', 'background:#f8fafc;') : ''}</tr>`)
      : empty(t.noExpenses);

    const money = [[t.cash, dh(report.cashInHand)]];
    if (report.switchedOver) {
      money.push([t.owedToSuppliers, dh(report.owedToSuppliers)]);
      money.push([t.owedToManager, dh(report.owedToManager)]);
      money.push([t.owedBySeller, dh(report.owedBySeller)]);
    }
    if (report.changeFloat != null) money.push([t.changeFloat, dh(report.changeFloat)]);
    if (report.switchedOver) {
      money.push([t.openBills, `${report.openBills.count} (${dh(report.openBills.total)})`]);
      money.push([t.pendingLate, `${report.pendingLate.count} (${dh(report.pendingLate.total)})`]);
    }
    const moneyTable = table(money.map(([k, v]) =>
      `<tr>${cell(k)}${cell(`<strong>${v}</strong>`, 'text-align:center;')}</tr>`).join(''));

    const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t.title} - ${name}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;" dir="${dir}">
<tr><td align="center" style="padding:16px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e5e7eb;font-family:Arial,Tahoma,sans-serif;font-size:14px;color:#111827;text-align:${align};">
<tr><td style="background:#2563eb;color:#ffffff;padding:20px;text-align:center;">
<div style="font-size:22px;font-weight:bold;"><span dir="auto">${name}</span></div>
<div style="font-size:16px;padding-top:4px;">${t.title}</div>
<div style="font-size:14px;padding-top:4px;">${esc(longDate(report.date, lang))}</div>
</td></tr>
<tr><td style="padding:20px;">
${boxes}
${refundsLine}
${section(t.salesByCategory)}
${categories}
${section(t.expensesOfDay)}
${expenses}
${section(t.moneyNow)}
${moneyTable}
</td></tr>
<tr><td style="background:#f8fafc;padding:14px 20px;text-align:center;color:#6b7280;font-size:12px;">
<div>${t.footer}</div>
<div style="padding-top:4px;">${stampOf(generatedAt)}</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
    return { subject: `${t.title} - ${report.hammamName} - ${shortDate(report.date)}`, html };
  }

  /** Subject + HTML of the recovery code e-mail. Pure: no network. */
  renderRecoveryCode({ lang, code, hammamName, sentAt = new Date() }) {
    lang = lang === 'fr' ? 'fr' : 'ar';
    const t = TEXTS[lang].recovery;
    const dir = lang === 'fr' ? 'ltr' : 'rtl';
    const align = lang === 'fr' ? 'left' : 'right';
    const name = esc(hammamName || 'HammamPOS');
    const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t.title} - ${name}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;" dir="${dir}">
<tr><td align="center" style="padding:16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #e5e7eb;font-family:Arial,Tahoma,sans-serif;font-size:15px;color:#111827;text-align:${align};">
<tr><td style="background:#2563eb;color:#ffffff;padding:18px;text-align:center;">
<div style="font-size:20px;font-weight:bold;"><span dir="auto">${name}</span></div>
<div style="font-size:13px;padding-top:4px;">HammamPOS</div>
</td></tr>
<tr><td style="padding:22px;">
<p style="margin:0 0 10px 0;font-size:17px;font-weight:bold;">${t.title}</p>
<p style="margin:0 0 16px 0;">${t.intro}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:14px;background:#f8fafc;border:1px solid #e2e8f0;text-align:center;font-size:32px;font-weight:bold;letter-spacing:6px;direction:ltr;font-family:Consolas,'Courier New',monospace;">${esc(code)}</td></tr></table>
<p style="margin:16px 0 0 0;padding:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-weight:bold;">${t.neverShare}</p>
<p style="margin:14px 0 0 0;">${t.validity}</p>
<p style="margin:8px 0 0 0;">${t.ignore}</p>
</td></tr>
<tr><td style="background:#f8fafc;padding:12px 20px;text-align:center;color:#6b7280;font-size:12px;">
<div>${t.requestedAt}: ${stampOf(sentAt)}</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
    return { subject: `${t.title} - ${hammamName || 'HammamPOS'}`, html };
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