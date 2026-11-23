/**
 * Text and destination of a push notification, from a cloud event.
 * event: { type, location_id, hammam, payload, at }   lang: 'ar' | 'fr'
 * Returns { title, body, url, tag } or null when the type is not sent.
 */
'use strict';
const T = {
  ar: {
    expense: 'مصروف جديد', unpaidPart: 'غير مدفوع', fullyUnpaid: 'غير مدفوع بالكامل', byManager: 'دفعه المدير',
    late_entry: 'إدخال متأخر', lateWait: 'ينتظر مراجعتك', refund: 'استرجاع تذكرة',
    seller_collection: 'إيداع / تحويل من البائع', offline: 'الجهاز غير متصل', offlineBody: (m) => 'لا إشارة منذ ' + m + ' دقيقة',
    online: 'عاد الاتصال', onlineBody: 'الجهاز متصل من جديد', test: 'تجربة الإشعارات', testBody: 'الإشعارات تعمل على هذا الهاتف ✓',
    types: { in_person: 'تحصيل شخصي', bank: 'إيداع بنكي', transfer: 'تحويل', on_behalf: 'دفع نيابة عنك' }, ref: 'مرجع'
  },
  fr: {
    expense: 'Nouvelle dépense', unpaidPart: 'impayé', fullyUnpaid: 'entièrement impayée', byManager: 'payé par le gérant',
    late_entry: 'Saisie tardive', lateWait: 'en attente de votre vérification', refund: 'Ticket remboursé',
    seller_collection: 'Dépôt / virement du vendeur', offline: 'Ordinateur hors ligne', offlineBody: (m) => 'Aucun signal depuis ' + m + ' min',
    online: 'Connexion rétablie', onlineBody: "L'ordinateur est de nouveau connecté", test: 'Test des notifications', testBody: 'Les notifications fonctionnent sur ce téléphone ✓',
    types: { in_person: 'Encaissement sur place', bank: 'Dépôt bancaire', transfer: 'Virement', on_behalf: 'Paiement pour votre compte' }, ref: 'réf.'
  }
};
const dh = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' DH';
};
function buildMessage(event, lang) {
  const t = T[lang === 'fr' ? 'fr' : 'ar'];
  const p = (event && event.payload) || {};
  const where = event.hammam ? event.hammam + ' · ' : '';
  const loc = event.location_id ? '&loc=' + encodeURIComponent(event.location_id) : '';
  const parts = (...xs) => xs.filter(Boolean).join(' · ');
  switch (event.type) {
    case 'expense': {
      const unpaid = Number(p.unpaid) || 0;
      const status = unpaid > 0 ? (unpaid >= Number(p.total) ? t.fullyUnpaid : t.unpaidPart + ' ' + dh(unpaid))
        : (Number(p.paidByManager) > 0 ? t.byManager + ' ' + dh(p.paidByManager) : '');
      return { title: where + t.expense, body: parts((p.description || '') + ': ' + dh(p.total), p.supplier, status),
        url: '/?open=expenses' + loc + (/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? '&date=' + p.date : ''), tag: 'expense-' + (event.location_id || '') + '-' + (p.expenseId || '') };
    }
    case 'late_entry':
      return { title: where + t.late_entry, body: parts((p.description || '') + ': ' + dh(p.amount), t.lateWait),
        url: '/?open=late' + loc, tag: 'late-' + (event.location_id || '') + '-' + (p.expenseId || '') };
    case 'refund':
      return { title: where + t.refund, body: parts((p.category || '') + (p.serial ? ' #' + p.serial : '') + ': ' + dh(p.amount), p.reason),
        url: '/?open=sales' + loc, tag: 'refund-' + (event.location_id || '') + '-' + (p.ticketId || '') };
    case 'seller_collection':
      return { title: where + (t.types[p.type] || t.seller_collection), body: parts(dh(p.amount), p.recipient, p.reference ? t.ref + ' ' + p.reference : ''),
        url: '/?open=alerts' + loc, tag: 'collection-' + (event.location_id || '') + '-' + (p.collectionId || '') };
    case 'offline':
      return { title: where + t.offline, body: t.offlineBody(p.minutes || 10), url: '/?open=devices' + loc, tag: 'status-' + (event.location_id || '') };
    case 'online':
      return { title: where + t.online, body: t.onlineBody, url: '/?open=devices' + loc, tag: 'status-' + (event.location_id || '') };
    case 'test':
      return { title: t.test, body: t.testBody, url: '/', tag: 'test' };
    default:
      return null;
  }
}
// Which setting a type belongs to ("online" follows "offline").
const settingOf = (type) => (type === 'online' ? 'offline' : type);
module.exports = { buildMessage, settingOf };
