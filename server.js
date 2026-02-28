'use strict';

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const { lookupByPhone, upsertPatient, normalizePhone } = require('./patients');
const { buildSystemPrompt } = require('./clinic-config');
const { createRealtimeSession } = require('./realtime');
const { replySMS, sendConfirmationSMS } = require('./notifications');
const { getAvailableSlots, formatDateForDisplay, formatTimeForDisplay } = require('./google-calendar');
const { executeTool } = require('./tools');
const { startFollowUpScheduler } = require('./followup');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Map callSid → caller context (set in /incoming-call, read in WS handler)
const callContextMap = new Map();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.send('Puzzle Acupuncture voice assistant — running.');
});

// ---------------------------------------------------------------------------
// POST /incoming-call  — Twilio calls this when someone dials the number
// ---------------------------------------------------------------------------

app.post('/incoming-call', async (req, res) => {
  const from   = req.body.From   || '';
  const callSid = req.body.CallSid || '';
  const host   = req.headers.host;

  console.log(`[Call] Incoming from ${from} (${callSid})`);

  // 1. Look up caller before starting the session
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

  // 2. Store context keyed by callSid for the WebSocket handler
  callContextMap.set(callSid, { callerContext, from });

  // 3. Return TwiML — connect the call to our media stream
  const wsUrl = `wss://${host}/media-stream?callSid=${encodeURIComponent(callSid)}`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}"/>
    </Stream>
  </Connect>
</Response>`);
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
    // Simple text-based booking flow
    await handleSmsBookingIntent(from, body, patient);
  } else {
    // Generic reply
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

  // Try to extract a day/time hint from the message
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
// WebSocket /media-stream  — bidirectional audio relay for active calls
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid') || '';

  console.log(`[WS] New media stream connection. callSid=${callSid}`);

  // Retrieve the caller context built in /incoming-call
  const ctx = callContextMap.get(callSid) || {};
  const callerContext = ctx.callerContext || { isReturning: false };
  const systemPrompt = buildSystemPrompt(callerContext);

  let streamSid = null;
  let realtimeSession = null;

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case 'start': {
        streamSid = msg.start.streamSid;
        console.log(`[WS] Stream started. streamSid=${streamSid}`);

        // Now we have streamSid — create the OpenAI session
        realtimeSession = createRealtimeSession(systemPrompt, twilioWs, streamSid);
        break;
      }

      case 'media': {
        if (!realtimeSession) break;
        const payload = msg.media?.payload;
        if (!payload) break;
        const mulawBuf = Buffer.from(payload, 'base64');
        realtimeSession.sendAudio(mulawBuf);
        break;
      }

      case 'stop': {
        console.log(`[WS] Stream stopped. streamSid=${streamSid}`);
        if (realtimeSession) realtimeSession.close();
        callContextMap.delete(callSid);
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    console.log(`[WS] Twilio WebSocket closed. streamSid=${streamSid}`);
    if (realtimeSession) realtimeSession.close();
    callContextMap.delete(callSid);
  });

  twilioWs.on('error', (err) => {
    console.error('[WS] Twilio WebSocket error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  startFollowUpScheduler();
});
