'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const TIMEZONE = 'America/Los_Angeles';
const BUSINESS_OPEN = 9;   // 9am
const BUSINESS_CLOSE = 17; // 5pm

function getAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getAuthClient() });
}

/**
 * Parse a natural date string into a Date object in Pacific time.
 * Accepts: "2026-03-05", "Thursday", "next Thursday", "tomorrow", etc.
 * Returns a Date for the start of that day in PT.
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  const normalized = dateStr.trim().toLowerCase();

  // ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    // Parse as Pacific midnight
    return new Date(`${normalized}T00:00:00-08:00`);
  }

  const now = new Date();
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  if (normalized === 'today') return startOfDayPT(now);
  if (normalized === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return startOfDayPT(d);
  }

  // "next thursday" or just "thursday"
  const isNext = normalized.startsWith('next ');
  const dayName = isNext ? normalized.slice(5) : normalized;
  const targetDow = days.indexOf(dayName);
  if (targetDow !== -1) {
    const d = new Date(now);
    const currentDow = d.getDay();
    let diff = targetDow - currentDow;
    if (diff <= 0 || isNext) diff += 7;
    d.setDate(d.getDate() + diff);
    return startOfDayPT(d);
  }

  // Try native parse as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed)) return startOfDayPT(parsed);

  return null;
}

function startOfDayPT(date) {
  // Get the date string in PT and reconstruct midnight PT
  const ptStr = date.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
  return new Date(`${ptStr}T00:00:00-08:00`);
}

function formatTimeForDisplay(isoString) {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TIMEZONE,
    hour12: true,
  });
}

function formatDateForDisplay(isoString) {
  return new Date(isoString).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE,
  });
}

/**
 * Get available time slots for a given date and appointment duration.
 *
 * @param {string} dateStr - "2026-03-05", "Thursday", "tomorrow", etc.
 * @param {number} durationMinutes - length of the appointment
 * @returns {Array<{start: string, end: string, display: string}>} up to ~6 slots
 */
async function getAvailableSlots(dateStr, durationMinutes) {
  const calendar = getCalendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const date = parseDate(dateStr);
  if (!date) throw new Error(`Could not parse date: ${dateStr}`);

  // Build 9am–5pm window with explicit PT offset (handles PST/PDT automatically)
  const dateLabel = date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

  // Get the actual PT offset for this date (e.g. -480 for PST, -420 for PDT)
  const ptOffset = getPTOffset(new Date(`${dateLabel}T12:00:00Z`));
  const sign = ptOffset >= 0 ? '+' : '-';
  const absH  = String(Math.floor(Math.abs(ptOffset) / 60)).padStart(2, '0');
  const absM  = String(Math.abs(ptOffset) % 60).padStart(2, '0');
  const tzStr = `${sign}${absH}:${absM}`;  // e.g. "-08:00" or "-07:00"

  const windowStart = new Date(`${dateLabel}T${String(BUSINESS_OPEN).padStart(2,'0')}:00:00${tzStr}`);
  const windowEnd   = new Date(`${dateLabel}T${String(BUSINESS_CLOSE).padStart(2,'0')}:00:00${tzStr}`);

  // FreeBusy query
  const freeBusyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busy = (freeBusyRes.data.calendars[calendarId]?.busy || []).map(b => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));

  // Generate candidate slots every 30 minutes
  const slots = [];
  const slotMs = durationMinutes * 60 * 1000;
  let cursor = new Date(windowStart);

  while (cursor.getTime() + slotMs <= windowEnd.getTime()) {
    const slotEnd = new Date(cursor.getTime() + slotMs);

    const overlaps = busy.some(b => cursor < b.end && slotEnd > b.start);
    if (!overlaps) {
      slots.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
        display: formatTimeForDisplay(cursor.toISOString()),
      });
    }

    cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
  }

  return slots;
}

/**
 * Get the Pacific Time UTC offset in minutes for a given date.
 * Returns -480 (PST) or -420 (PDT).
 */
function getPTOffset(date) {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const ptDate  = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return (ptDate - utcDate) / 60000;
}

/**
 * Create a Google Calendar event for a booked appointment.
 *
 * @param {object} details
 * @param {string} details.summary     - event title, e.g. "Acupuncture - Jenny Chen"
 * @param {string} details.start       - ISO 8601 start time
 * @param {string} details.end         - ISO 8601 end time
 * @param {string} [details.description]
 * @param {string} [details.attendeeEmail]
 * @returns {object} created event
 */
async function createEvent(details) {
  const calendar = getCalendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const event = {
    summary: details.summary,
    description: details.description || '',
    start: { dateTime: details.start, timeZone: TIMEZONE },
    end:   { dateTime: details.end,   timeZone: TIMEZONE },
  };

  if (details.attendeeEmail) {
    event.attendees = [{ email: details.attendeeEmail }];
  }

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: 'none',
  });

  return res.data;
}

module.exports = {
  getAvailableSlots,
  createEvent,
  parseDate,
  formatTimeForDisplay,
  formatDateForDisplay,
};
