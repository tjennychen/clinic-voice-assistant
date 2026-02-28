'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'patients.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT,
      last_service TEXT,
      last_appointment_date TEXT,
      sms_opted_in INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_phone TEXT NOT NULL,
      service TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      gcal_event_id TEXT,
      followup_text_sent INTEGER DEFAULT 0,
      followup_email_sent INTEGER DEFAULT 0,
      nudge_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Look up a patient by phone number.
 * Phone should be in E.164 format (e.g. +14155551234).
 * @returns {object|null}
 */
function lookupByPhone(phone) {
  const normalized = normalizePhone(phone);
  const row = getDb().prepare('SELECT * FROM patients WHERE phone = ?').get(normalized);
  return row || null;
}

/**
 * Insert or update a patient record.
 * @param {object} data
 * @param {string} data.phone - required
 * @param {string} [data.name]
 * @param {string} [data.email]
 * @param {string} [data.last_service]
 * @param {string} [data.last_appointment_date]
 * @param {number} [data.sms_opted_in]
 */
function upsertPatient(data) {
  const phone = normalizePhone(data.phone);
  const existing = getDb().prepare('SELECT id FROM patients WHERE phone = ?').get(phone);

  if (existing) {
    // Only update fields that were provided
    const updates = [];
    const params = [];

    if (data.name !== undefined)                  { updates.push('name = ?');                   params.push(data.name); }
    if (data.email !== undefined)                 { updates.push('email = ?');                  params.push(data.email); }
    if (data.last_service !== undefined)          { updates.push('last_service = ?');           params.push(data.last_service); }
    if (data.last_appointment_date !== undefined) { updates.push('last_appointment_date = ?'); params.push(data.last_appointment_date); }
    if (data.sms_opted_in !== undefined)          { updates.push('sms_opted_in = ?');           params.push(data.sms_opted_in ? 1 : 0); }

    if (updates.length > 0) {
      params.push(phone);
      getDb().prepare(`UPDATE patients SET ${updates.join(', ')} WHERE phone = ?`).run(...params);
    }

    return getDb().prepare('SELECT * FROM patients WHERE phone = ?').get(phone);
  } else {
    getDb().prepare(`
      INSERT INTO patients (phone, name, email, last_service, last_appointment_date, sms_opted_in)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      phone,
      data.name || null,
      data.email || null,
      data.last_service || null,
      data.last_appointment_date || null,
      data.sms_opted_in ? 1 : 0
    );

    return getDb().prepare('SELECT * FROM patients WHERE phone = ?').get(phone);
  }
}

/**
 * Normalize phone to E.164. Accepts US numbers in various formats.
 * Leaves already-E.164 numbers alone.
 */
function normalizePhone(phone) {
  if (!phone) return phone;
  // Strip everything except digits and leading +
  const stripped = phone.replace(/[^\d+]/g, '');
  if (stripped.startsWith('+')) return stripped;
  // Assume US number
  const digits = stripped.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

module.exports = { lookupByPhone, upsertPatient, normalizePhone, getDb };
