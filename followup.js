'use strict';

require('dotenv').config();
const { getDueFollowUpTexts, getDueFollowUpEmails, getDueNudges, markFollowUpSent } = require('./appointments');
const { sendFollowUpSMS, sendFollowUpEmail, sendNudgeSMS } = require('./notifications');

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function runFollowUpJob() {
  const now = new Date().toISOString();
  console.log(`[Followup] Running at ${now}`);

  // 1. Post-visit texts (2–24 hours after appointment end, sms_opted_in = 1)
  let dueTexts = [];
  try { dueTexts = getDueFollowUpTexts(); } catch (err) { console.error('[Followup] getDueFollowUpTexts error:', err.message); }

  for (const appt of dueTexts) {
    try {
      await sendFollowUpSMS(appt.patient_phone, { name: appt.name, service: appt.service });
      markFollowUpSent(appt.id, 'text');
      console.log(`[Followup] Text sent to ${appt.patient_phone} for appt ${appt.id}`);
    } catch (err) {
      console.error(`[Followup] Text error for appt ${appt.id}:`, err.message);
    }
  }

  // 2. Follow-up emails (12–72 hours after appointment end, patient has email)
  let dueEmails = [];
  try { dueEmails = getDueFollowUpEmails(); } catch (err) { console.error('[Followup] getDueFollowUpEmails error:', err.message); }

  for (const appt of dueEmails) {
    try {
      await sendFollowUpEmail(appt.email, { name: appt.name, service: appt.service });
      markFollowUpSent(appt.id, 'email');
      console.log(`[Followup] Email sent to ${appt.email} for appt ${appt.id}`);
    } catch (err) {
      console.error(`[Followup] Email error for appt ${appt.id}:`, err.message);
    }
  }

  // 3. 3-day nudge (no rebook, sms_opted_in = 1)
  let dueNudges = [];
  try { dueNudges = getDueNudges(); } catch (err) { console.error('[Followup] getDueNudges error:', err.message); }

  for (const appt of dueNudges) {
    try {
      await sendNudgeSMS(appt.patient_phone, { name: appt.name });
      markFollowUpSent(appt.id, 'nudge');
      console.log(`[Followup] Nudge sent to ${appt.patient_phone} for appt ${appt.id}`);
    } catch (err) {
      console.error(`[Followup] Nudge error for appt ${appt.id}:`, err.message);
    }
  }
}

function startFollowUpScheduler() {
  console.log('[Followup] Scheduler started (runs every 15 min)');
  // Run once immediately, then on interval
  runFollowUpJob().catch(err => console.error('[Followup] Job error:', err.message));
  setInterval(() => {
    runFollowUpJob().catch(err => console.error('[Followup] Job error:', err.message));
  }, INTERVAL_MS);
}

module.exports = { startFollowUpScheduler, runFollowUpJob };
