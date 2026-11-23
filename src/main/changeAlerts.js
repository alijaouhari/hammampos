/**
 * Alerts to the manager's phone when something already recorded is deleted or
 * changed: tickets, expenses, collections, prices, wood purchases, "clear all data".
 *
 * It listens to the audit log (every such action already writes one line there) and
 * turns the watched lines into a 'change' notification. Changes the manager makes
 * himself from the dashboard's remote panel are not sent: he knows.
 */
'use strict';

const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

/** One audit line → { kind, text, before?, after? } or null when it is not watched. */
function describeChange(action, entity, entityId, details, { switchedOver = true } = {}) {
  const d = details == null ? '' : String(details);
  const key = action + ' ' + entity;
  switch (key) {
    case 'DELETE tickets': return { kind: 'ticket_deleted', text: d };
    case 'UNDO_REFUND tickets': return { kind: 'refund_undone', text: d };
    case 'DELETE money_expenses': {
      const j = parse(d) || {};
      const b = j.before || {};
      return { kind: 'expense_deleted', text: [b.description, b.total != null ? b.total + 'dh' : '', b.date].filter(Boolean).join(' - '), by: j.by || null };
    }
    case 'EDIT money_expenses': {
      const j = parse(d) || {};
      const b = j.before || {}, a = j.after || {};
      return { kind: 'expense_edited', text: (a.description || b.description || ''), before: b, after: a, by: j.by || null };
    }
    case 'CANCEL money_collections': return { kind: 'collection_cancelled', text: d };
    case 'EDIT money_collections': {
      const j = parse(d) || {};
      return { kind: 'collection_edited', text: '', before: j.before || null, after: j.after || null };
    }
    // Before the money system is on, the old lists are the real ones.
    case 'DELETE expenses': return switchedOver ? null : { kind: 'expense_deleted', text: d };
    case 'DELETE collections': return switchedOver ? null : { kind: 'collection_deleted', text: d };
    case 'UPDATE categories': return { kind: 'category_changed', text: d };
    case 'UPDATE wood_purchases': return { kind: 'wood_edited', text: d };
    case 'CLEAR_ALL_DATA system': return { kind: 'data_cleared', text: d };
    default: return null;
  }
}

/**
 * Wraps storage.logAudit. notify(payload) sends the alert; isRemote() is true while
 * the manager's remote panel is running an action.
 */
function installChangeAlerts({ storage, notify, isRemote = () => false, isSwitchedOver = () => true, log = () => {} }) {
  if (!storage || storage.__changeAlerts) return;
  const original = storage.logAudit.bind(storage);
  storage.logAudit = function (action, entity, entityId = null, details = null) {
    const result = original(action, entity, entityId, details);
    try {
      if (!isRemote()) {
        const c = describeChange(action, entity, entityId, details, { switchedOver: isSwitchedOver() });
        // Sent just after the action finishes (never in the middle of its database work)
        if (c) setImmediate(() => { try { notify({ ...c, entity, entityId }); } catch (e) { log('change alert failed: ' + e.message); } });
      }
    } catch (error) {
      log('change alert skipped: ' + error.message); // never stops the action itself
    }
    return result;
  };
  storage.__changeAlerts = true;
}

module.exports = { describeChange, installChangeAlerts };
