'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');

const { lookupByPhone, upsertPatient, normalizePhone } = require('./patients');
const { buildCallerContextString } = require('./clinic-config');
const { replySMS } = require('./notifications');
const { formatTimeForDisplay } = require('./google-calendar');
const { executeTool } = require('./tools');
const { startFollowUpScheduler } = require('./followup');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.send('Puzzle Acupuncture voice assistant — running.');
});

// ---------------------------------------------------------------------------
// POST /retell-event  — Retell calls this for call lifecycle events
// ---------------------------------------------------------------------------

app.post('/retell-event', async (req, res) => {
  const event = req.body;

  if (event.event === 'call_started') {
    const from = event.data?.from_number || '';
    let callerContext = { isReturning: false };

    if (from) {
      try {
        const patient = lookupByPhone(from);
        if (patient) {
          callerContext = {
            isReturning: true,
            name: patient.name,
            email: patient.email,
            lastService: patient.last_service,
            lastAppointmentDate: patient.last_appointment_date,
          };
          console.log(`[Call] Returning patient: ${patient.name}`);
        }
      } catch (err) {
        console.error('[Call] Patient lookup error:', err.message);
      }
    }

    return res.json({
      dynamic_variables: {
        callerContext: buildCallerContextString(callerContext),
      },
    });
  }

  res.json({});
});

// ---------------------------------------------------------------------------
// POST /retell-function  — Retell calls this when agent invokes a custom function
// ---------------------------------------------------------------------------

app.post('/retell-function', async (req, res) => {
  const { function_name, function_input } = req.body;
  console.log(`[Tool] ${function_name}(${JSON.stringify(function_input)})`);
  try {
    const result = await executeTool(function_name, function_input);
    console.log(`[Tool] Result:`, JSON.stringify(result).slice(0, 200));
    res.json({ result });
  } catch (err) {
    console.error(`[Tool] Error:`, err.message);
    res.json({ result: { error: err.message } });
  }
});

// ---------------------------------------------------------------------------
// POST /incoming-sms  — Twilio calls this for inbound text messages
// ---------------------------------------------------------------------------

app.post('/incoming-sms', async (req, res) => {
  const from = normalizePhone(req.body.From || '');
  const body = (req.body.Body || '').trim();

  console.log(`[SMS] From ${from}: ${body}`);

  // Always acknowledge to Twilio immediately
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  if (!from || !body) return;

  // Handle STOP
  if (/^stop$/i.test(body)) {
    try {
      upsertPatient({ phone: from, sms_opted_in: 0 });
      console.log(`[SMS] STOP received from ${from} — opted out`);
    } catch (err) {
      console.error('[SMS] STOP opt-out error:', err.message);
    }
    return;
  }

  // Look up patient
  let patient = null;
  try { patient = lookupByPhone(from); } catch {}

  // Check if it looks like a scheduling request
  const isSchedulingIntent = /\b(book|schedule|appointment|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|morning|afternoon|evening|\d+(am|pm))\b/i.test(body);

  if (isSchedulingIntent) {
    await handleSmsBookingIntent(from, body, patient);
  } else {
    const reply = patient
      ? `Hi${patient.name ? ` ${patient.name.split(' ')[0]}` : ''}! To book or reschedule, reply with a day and time that works for you, or give us a call.`
      : 'Hi! To book an appointment, reply with a day and time that works, or give us a call.';
    try { await replySMS(from, reply); } catch (err) { console.error('[SMS] Reply error:', err.message); }
  }
});

/**
 * Handle a scheduling-intent SMS.
 * Tries to extract a date hint and returns available slots.
 */
async function handleSmsBookingIntent(from, body, patient) {
  const service = patient?.last_service || 'Follow-Up Acupuncture';

  const dayMatch = body.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next \w+)\b/i);
  const dateHint = dayMatch ? dayMatch[1] : 'tomorrow';

  try {
    const result = await executeTool('check_availability', { service, date: dateHint });

    if (!result.available || !result.slots?.length) {
      await replySMS(from,
        `Looks like ${dateHint} is fully booked. What other day works for you?`
      );
      return;
    }

    const top3 = result.slots.slice(0, 3)
      .map((s, i) => `${i + 1}. ${formatTimeForDisplay(s.start)}`)
      .join('\n');

    const greeting = patient?.name ? `Hi ${patient.name.split(' ')[0]}! ` : 'Hi! ';
    await replySMS(from,
      `${greeting}Here are some openings on ${result.date} for ${service}:\n${top3}\n\nReply with a number to pick one, or call us to book. Reply STOP to opt out.`
    );
  } catch (err) {
    console.error('[SMS] Availability check error:', err.message);
    await replySMS(from,
      'Sorry, I had trouble checking the calendar. Give us a call and we\'ll get you booked!'
    );
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  startFollowUpScheduler();
});
