'use strict';

const { getDb, normalizePhone } = require('./patients');

/**
 * Save a new appointment record.
 * @param {object} data
 * @param {string} data.patient_phone
 * @param {string} data.service
 * @param {string} data.start_time  - ISO 8601
 * @param {string} data.end_time    - ISO 8601
 * @param {string} [data.gcal_event_id]
 * @returns {object} inserted row
 */
function saveAppointment(data) {
  const phone = normalizePhone(data.patient_phone);
  const stmt = getDb().prepare(`
    INSERT INTO appointments (patient_phone, service, start_time, end_time, gcal_event_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(phone, data.service, data.start_time, data.end_time, data.gcal_event_id || null);
  return getDb().prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Get appointments that are due for a follow-up text.
 * Criteria:
 *   - end_time was 2+ hours ago (and less than 24 hours ago to avoid late sends)
 *   - followup_text_sent = 0
 *   - patient sms_opted_in = 1
 */
function getDueFollowUpTexts() {
  return getDb().prepare(`
    SELECT a.*, p.name, p.email, p.sms_opted_in
    FROM appointments a
    JOIN patients p ON p.phone = a.patient_phone
    WHERE a.followup_text_sent = 0
      AND p.sms_opted_in = 1
      AND datetime(a.end_time) <= datetime('now', '-2 hours')
      AND datetime(a.end_time) >= datetime('now', '-24 hours')
  `).all();
}

/**
 * Get appointments that are due for a follow-up email.
 * Criteria:
 *   - end_time was 12+ hours ago (next morning window)
 *   - followup_email_sent = 0
 *   - patient has an email address
 */
function getDueFollowUpEmails() {
  return getDb().prepare(`
    SELECT a.*, p.name, p.email, p.sms_opted_in
    FROM appointments a
    JOIN patients p ON p.phone = a.patient_phone
    WHERE a.followup_email_sent = 0
      AND p.email IS NOT NULL
      AND p.email != ''
      AND datetime(a.end_time) <= datetime('now', '-12 hours')
      AND datetime(a.end_time) >= datetime('now', '-72 hours')
  `).all();
}

/**
 * Get appointments due for a 3-day nudge.
 * Criteria:
 *   - end_time was 3+ days ago
 *   - nudge_sent = 0
 *   - patient sms_opted_in = 1
 *   - no newer appointment exists for this patient
 */
function getDueNudges() {
  return getDb().prepare(`
    SELECT a.*, p.name, p.email, p.sms_opted_in
    FROM appointments a
    JOIN patients p ON p.phone = a.patient_phone
    WHERE a.nudge_sent = 0
      AND p.sms_opted_in = 1
      AND datetime(a.end_time) <= datetime('now', '-3 days')
      AND NOT EXISTS (
        SELECT 1 FROM appointments a2
        WHERE a2.patient_phone = a.patient_phone
          AND a2.id != a.id
          AND datetime(a2.start_time) > datetime(a.start_time)
      )
  `).all();
}

/**
 * Mark a follow-up as sent.
 * @param {number} id - appointment id
 * @param {'text'|'email'|'nudge'} type
 */
function markFollowUpSent(id, type) {
  const col = type === 'text' ? 'followup_text_sent' : type === 'email' ? 'followup_email_sent' : 'nudge_sent';
  getDb().prepare(`UPDATE appointments SET ${col} = 1 WHERE id = ?`).run(id);
}

module.exports = {
  saveAppointment,
  getDueFollowUpTexts,
  getDueFollowUpEmails,
  getDueNudges,
  markFollowUpSent,
};
