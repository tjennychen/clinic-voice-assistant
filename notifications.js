'use strict';

require('dotenv').config();
const twilio = require('twilio');
const { Resend } = require('resend');
const { formatDateForDisplay, formatTimeForDisplay } = require('./google-calendar');

const CLINIC_NAME = 'Puzzle Acupuncture';

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ---------------------------------------------------------------------------
// Confirmation messages (sent immediately after booking)
// ---------------------------------------------------------------------------

/**
 * Send booking confirmation SMS.
 */
async function sendConfirmationSMS(phone, details) {
  const { name, service, startTime, price } = details;
  const dateStr = formatDateForDisplay(startTime);
  const timeStr = formatTimeForDisplay(startTime);

  const body = `Hi ${name.split(' ')[0]}, you're booked at ${CLINIC_NAME}!\n${service}\n${dateStr} at ${timeStr} Pacific\n${price}\nReply STOP to opt out.`;

  await getTwilioClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

/**
 * Send booking confirmation email.
 */
async function sendConfirmationEmail(email, details) {
  const { name, service, duration, price, startTime } = details;
  const dateStr = formatDateForDisplay(startTime);
  const timeStr = formatTimeForDisplay(startTime);
  const firstName = name.split(' ')[0];

  const subject = `You're booked — ${service} on ${dateStr}`;

  const html = `
<p>Hi ${firstName},</p>
<p>You're all set. Here are your appointment details:</p>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:15px">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Service</td><td><strong>${service}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td><strong>${dateStr}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Time</td><td><strong>${timeStr} Pacific</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Duration</td><td>${duration} min</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Price</td><td>${price}</td></tr>
</table>
<p>Need to reschedule or cancel? Just call or text us.</p>
<p>See you soon,<br>${CLINIC_NAME}</p>
`;

  await getResend().emails.send({
    from: `${CLINIC_NAME} <${process.env.CLINIC_EMAIL}>`,
    to: email,
    subject,
    html,
  });
}

// ---------------------------------------------------------------------------
// Follow-up messages (sent by followup.js scheduler)
// ---------------------------------------------------------------------------

/**
 * Send post-visit follow-up SMS.
 * For free consult: invite to book first paid visit.
 * For paid visits: Google review link + rebook offer.
 */
async function sendFollowUpSMS(phone, details) {
  const { name, service } = details;
  const firstName = name ? name.split(' ')[0] : 'there';
  const reviewLink = process.env.GOOGLE_REVIEW_LINK || '';
  const isFreeConsult = service?.toLowerCase().includes('consult') && !service?.toLowerCase().includes('herbal');

  let body;
  if (isFreeConsult) {
    body = `Hi ${firstName}, thanks for chatting today. If you'd like to book your first acupuncture visit, reply with a day and time window and I'll send you some openings. Reply STOP to opt out.`;
  } else if (reviewLink) {
    body = `Thanks for coming in today${firstName !== 'there' ? `, ${firstName}` : ''}. If you feel up for it, here's our Google review link — it helps a ton: ${reviewLink}\n\nAnd whenever you're ready for your next visit, just reply with a day that works. Reply STOP to opt out.`;
  } else {
    body = `Thanks for coming in today${firstName !== 'there' ? `, ${firstName}` : ''}. Whenever you're ready for your next visit, just reply with a day that works. Reply STOP to opt out.`;
  }

  await getTwilioClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

/**
 * Send post-visit follow-up email (next morning).
 */
async function sendFollowUpEmail(email, details) {
  const { name } = details;
  const firstName = name ? name.split(' ')[0] : 'there';

  const subject = 'Your next visit, whenever you\'re ready';

  const html = `
<p>Hi ${firstName},</p>
<p>Thanks again for coming in.</p>
<p>If you'd like to schedule your next visit, just reply with a day and a general time — like "Tue afternoon" or "Sat morning" — and I'll send back a few real openings from the calendar.</p>
<p>You can also call the clinic number anytime and I'll book it with you on the phone.</p>
<p>Warmly,<br>${CLINIC_NAME} scheduling assistant</p>
`;

  await getResend().emails.send({
    from: `${CLINIC_NAME} <${process.env.CLINIC_EMAIL}>`,
    to: email,
    subject,
    html,
  });
}

/**
 * Send 3-day nudge SMS to patients who haven't rebooked.
 */
async function sendNudgeSMS(phone, details) {
  const { name } = details;
  const firstName = name ? name.split(' ')[0] : 'there';

  const body = `Hi ${firstName}, just a reminder that we're here whenever you're ready for your next visit. Reply with a day and I'll find you a time. Reply STOP to opt out.`;

  await getTwilioClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

// ---------------------------------------------------------------------------
// Inbound SMS replies
// ---------------------------------------------------------------------------

/**
 * Reply to an inbound SMS (used by /incoming-sms handler).
 */
async function replySMS(phone, body) {
  await getTwilioClient().messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

module.exports = {
  sendConfirmationSMS,
  sendConfirmationEmail,
  sendFollowUpSMS,
  sendFollowUpEmail,
  sendNudgeSMS,
  replySMS,
};
