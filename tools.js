'use strict';

require('dotenv').config();
const { SERVICES, getServiceByName, BUSINESS_HOURS } = require('./clinic-config');
const { getAvailableSlots, createEvent, formatDateForDisplay, formatTimeForDisplay } = require('./google-calendar');
const { upsertPatient } = require('./patients');
const { saveAppointment } = require('./appointments');
const { sendConfirmationSMS, sendConfirmationEmail } = require('./notifications');

// ---------------------------------------------------------------------------
// Tool definitions (passed to OpenAI Realtime session config)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'get_services',
    description: 'Returns the list of available services with prices and durations.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'check_availability',
    description: 'Check available appointment slots for a specific service and date. Call this after the caller states a preferred date.',
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'The service name, e.g. "Follow-Up Acupuncture", "New Patient Acupuncture", "Herbal Consult", "Free Consult"',
        },
        date: {
          type: 'string',
          description: 'The requested date. Can be natural language ("Thursday", "tomorrow", "next Monday") or ISO format (2026-03-05)',
        },
      },
      required: ['service', 'date'],
    },
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Book an appointment after the caller has explicitly confirmed all details. Creates calendar event, saves patient record, sends SMS and email confirmation.',
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'The service name',
        },
        start_time: {
          type: 'string',
          description: 'The appointment start time in ISO 8601 format',
        },
        name: {
          type: 'string',
          description: "Caller's full name",
        },
        phone: {
          type: 'string',
          description: "Caller's phone number for SMS confirmation",
        },
        email: {
          type: 'string',
          description: "Caller's email address (optional)",
        },
        sms_opted_in: {
          type: 'boolean',
          description: 'Whether the caller opted in to post-visit SMS reminders',
        },
      },
      required: ['service', 'start_time', 'name', 'phone'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function getServices() {
  const lines = SERVICES.map(s => `${s.name}: ${s.duration} min, ${s.priceDisplay}`);
  return {
    services: lines,
    hours: `${BUSINESS_HOURS.days}, ${BUSINESS_HOURS.open}am–${BUSINESS_HOURS.close - 12}pm Pacific`,
  };
}

async function checkAvailability(service, date) {
  const svc = getServiceByName(service);
  if (!svc) {
    return { error: `Unknown service: ${service}. Available: ${SERVICES.map(s => s.name).join(', ')}` };
  }

  let slots;
  try {
    slots = await getAvailableSlots(date, svc.duration);
  } catch (err) {
    return { error: `Could not check availability: ${err.message}` };
  }

  if (slots.length === 0) {
    return {
      available: false,
      message: `No openings on ${date} for ${svc.name}. Try asking the caller if a different day works.`,
      date,
      service: svc.name,
    };
  }

  // Return up to 6 slots; bot will pick 2–3 to mention
  const displaySlots = slots.slice(0, 6).map(s => ({
    start: s.start,
    end: s.end,
    display: s.display,
  }));

  return {
    available: true,
    service: svc.name,
    duration: svc.duration,
    date: formatDateForDisplay(slots[0].start),
    slots: displaySlots,
    message: `Found ${slots.length} openings. Offer 2–3 to the caller.`,
  };
}

async function bookAppointment({ service, start_time, name, phone, email, sms_opted_in }) {
  const svc = getServiceByName(service);
  if (!svc) {
    return { success: false, error: `Unknown service: ${service}` };
  }

  // Calculate end time
  const startDate = new Date(start_time);
  const endDate = new Date(startDate.getTime() + svc.duration * 60 * 1000);
  const end_time = endDate.toISOString();

  // 1. Create Google Calendar event
  let gcalEvent;
  try {
    gcalEvent = await createEvent({
      summary: `${svc.name} — ${name}`,
      description: `Phone: ${phone}${email ? `\nEmail: ${email}` : ''}\nBooked via phone assistant`,
      start: start_time,
      end: end_time,
      attendeeEmail: email || null,
    });
  } catch (err) {
    return { success: false, error: `Calendar error: ${err.message}` };
  }

  // 2. Upsert patient record
  try {
    await upsertPatient({
      phone,
      name,
      email: email || undefined,
      last_service: svc.name,
      last_appointment_date: start_time.slice(0, 10),
      sms_opted_in: sms_opted_in ? 1 : 0,
    });
  } catch (err) {
    console.error('Patient upsert error:', err);
    // Non-fatal — continue
  }

  // 3. Save appointment record
  let appt;
  try {
    appt = saveAppointment({
      patient_phone: phone,
      service: svc.name,
      start_time,
      end_time,
      gcal_event_id: gcalEvent.id,
    });
  } catch (err) {
    console.error('Appointment save error:', err);
  }

  // 4. Send confirmation SMS + email
  const confirmDetails = {
    name,
    service: svc.name,
    duration: svc.duration,
    price: svc.priceDisplay,
    startTime: start_time,
    endTime: end_time,
  };

  try {
    await sendConfirmationSMS(phone, confirmDetails);
  } catch (err) {
    console.error('SMS error:', err.message);
  }

  if (email) {
    try {
      await sendConfirmationEmail(email, confirmDetails);
    } catch (err) {
      console.error('Email error:', err.message);
    }
  }

  const displayDate = formatDateForDisplay(start_time);
  const displayTime = formatTimeForDisplay(start_time);

  return {
    success: true,
    message: `Booked. ${svc.name} on ${displayDate} at ${displayTime} Pacific for ${name}. Confirmation sent to ${phone}${email ? ` and ${email}` : ''}.`,
    gcal_event_id: gcalEvent.id,
    appointment_id: appt?.id,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — called by realtime.js when OpenAI invokes a tool
// ---------------------------------------------------------------------------

async function executeTool(name, args) {
  switch (name) {
    case 'get_services':
      return getServices();

    case 'check_availability':
      return checkAvailability(args.service, args.date);

    case 'book_appointment':
      return bookAppointment(args);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
