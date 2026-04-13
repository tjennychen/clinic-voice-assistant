# Puzzle Acupuncture — Voice Booking Assistant

A phone bot that answers calls, recognizes returning patients, checks real Google Calendar availability, books appointments, and sends SMS + email confirmations.

---

## What it does

- Caller dials your Twilio number
- Bot greets them, asks what service they want
- Checks your Google Calendar for real openings
- Collects name, phone, email — only after they pick a time
- Books the event on Google Calendar
- Texts + emails a confirmation instantly
- Texts a follow-up 2–4 hours after the visit with your Google review link
- Recognizes returning patients by phone number and greets them warmly

---

## Prerequisites

- Node.js 18+
- A [Twilio](https://twilio.com) account with a phone number
- An [OpenAI](https://platform.openai.com) account with Realtime API access
- A [Google Cloud](https://console.cloud.google.com) project with Calendar API enabled
- A [Resend](https://resend.com) account with a verified sending domain/email
- [Railway](https://railway.app) account (for hosting) — or ngrok for local testing

---

## Step 1 — Fill in your `.env`

Open `.env` and fill in every value:

```
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...       # your Twilio number in E.164 format
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=           # leave blank for now — Step 2 fills this in
GOOGLE_CALENDAR_ID=primary      # or paste a specific calendar ID
RESEND_API_KEY=re_...
CLINIC_EMAIL=you@yourdomain.com # must be verified in Resend
GOOGLE_REVIEW_LINK=https://g.page/r/...  # your Google Maps review link
PORT=3000
```

### Where to find each value

**OpenAI**
- Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Create a new secret key

**Twilio**
- Account SID + Auth Token: [console.twilio.com](https://console.twilio.com) → dashboard
- Phone number: buy one under Phone Numbers → Manage → Buy a Number (choose a US number with Voice capability)

**Resend**
- API key: [resend.com/api-keys](https://resend.com/api-keys)
- You must verify your sending domain first (or use a Resend test address during development)

**Google Review Link**
- Go to your Google Maps business listing → click "Get more reviews" → copy the link

---

## Step 2 — Google Calendar auth (one-time setup)

This gets a refresh token so the bot can read and write your calendar without prompting you to log in every time.

### 2a. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (name it anything, e.g. "Puzzle Voice Bot")
3. In the left sidebar: **APIs & Services → Library**
4. Search "Google Calendar API" → Enable it

### 2b. Create OAuth2 credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. If prompted, configure the consent screen first:
   - User type: **External**
   - App name: anything (e.g. "Puzzle Scheduling Bot")
   - Add your email as a test user
   - Scopes: add `https://www.googleapis.com/auth/calendar`
3. Back to Create Credentials → OAuth client ID:
   - Application type: **Desktop app**
   - Name: anything
4. Click Create → copy the **Client ID** and **Client Secret** into your `.env`

### 2c. Run the auth script

```bash
node get-gcal-token.js
```

- Your browser will open a Google sign-in page
- Sign in with the Google account that owns the calendar you want to use
- Click Allow
- The terminal prints your `GOOGLE_REFRESH_TOKEN`
- Paste it into `.env`

That's it. You never need to run this again — the token doesn't expire unless you revoke it.

### 2d. Find your Calendar ID (optional)

If you want to use a specific calendar instead of your primary one:
1. Go to [calendar.google.com](https://calendar.google.com)
2. Click the three dots next to your calendar → **Settings and sharing**
3. Scroll down to "Integrate calendar" → copy the Calendar ID
4. Paste it into `.env` as `GOOGLE_CALENDAR_ID`

If you leave it as `primary`, it uses your main calendar.

---

## Step 3 — Test locally with ngrok

### 3a. Start the server

```bash
npm start
```

You should see:
```
[Server] Listening on port 3000
[Followup] Scheduler started (runs every 15 min)
```

### 3b. Expose it with ngrok

In a new terminal tab:

```bash
ngrok http 3000
```

Copy the `https://` URL it gives you, e.g. `https://abc123.ngrok-free.app`

### 3c. Point Twilio to your local server

1. Go to [console.twilio.com](https://console.twilio.com) → Phone Numbers → Manage → Active Numbers
2. Click your number
3. Under **Voice & Fax → A Call Comes In**:
   - Set to **Webhook**
   - URL: `https://abc123.ngrok-free.app/incoming-call`
   - Method: **HTTP POST**
4. Save

### 3d. Point Twilio to your SMS webhook (for inbound texts)

On the same phone number page, under **Messaging**:
- When a message comes in: **Webhook**
- URL: `https://abc123.ngrok-free.app/incoming-sms`
- Method: **HTTP POST**
- Save

### 3e. Make a test call

Call your Twilio number. You should hear the bot pick up.

**Test checklist:**
- [ ] New caller: full flow — service → date → slots → name/phone/email → confirm → booked
- [ ] Check Google Calendar — event should appear
- [ ] Check your phone — SMS confirmation should arrive
- [ ] Check your email — confirmation email should arrive
- [ ] Returning caller: call from same number — bot should recognize and greet warmly
- [ ] Fully booked day: ask for a day that's fully blocked — bot should offer alternatives
- [ ] Outside hours question: ask what time they're open
- [ ] Medical advice: ask if acupuncture helps with X condition

---

## Step 4 — Deploy to Railway

### 4a. Push to GitHub

```bash
git add .
git commit -m "initial clinic voice assistant"
git push
```

Make sure `.env` is in `.gitignore` (it is) — never commit secrets.

### 4b. Create a Railway project

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select your repo
3. Railway will auto-detect Node.js and run `npm start`

### 4c. Add environment variables

In your Railway project dashboard:
1. Click your service → **Variables**
2. Add every variable from your `.env` file one by one
   (or use Railway's bulk import — paste the whole `.env` contents)

### 4d. Get your Railway URL

1. In Railway: **Settings → Networking → Generate Domain**
2. Copy the `https://` URL (e.g. `https://clinic-voice-assistant.up.railway.app`)

### 4e. Update Twilio webhooks

Go back to your Twilio phone number settings and replace the ngrok URL with your Railway URL:
- Voice: `https://your-app.up.railway.app/incoming-call`
- SMS: `https://your-app.up.railway.app/incoming-sms`

### 4f. Verify

Check Railway logs (service → **Deployments → View Logs**). You should see:
```
[Server] Listening on port ...
[Followup] Scheduler started
```

Call the number. You're live.

---

## Troubleshooting

**Bot doesn't pick up / call goes to voicemail**
- Check Twilio webhook URL is correct and using `https://`
- Check Railway logs for errors
- Verify `OPENAI_API_KEY` is set and has Realtime API access

**"This model requires Realtime API access"**
- OpenAI Realtime API may require joining a waitlist — check [platform.openai.com](https://platform.openai.com)

**Calendar events not showing up**
- Verify `GOOGLE_REFRESH_TOKEN` is set correctly
- Check `GOOGLE_CALENDAR_ID` — try `primary` if unsure
- Make sure Calendar API is enabled in your Google Cloud project

**SMS not sending**
- Verify Twilio credentials and phone number format (must be E.164: `+14155551234`)
- Check Twilio console for message logs and error codes

**Email not sending**
- Verify `CLINIC_EMAIL` is verified in Resend
- Check Resend dashboard for delivery logs

**Returning patient not recognized**
- Phone matching uses E.164 normalization — both the stored number and the Twilio `From` param should normalize the same way
- Check the DB: `sqlite3 patients.db "SELECT * FROM patients;"`

---

## Local DB inspection

```bash
# Install sqlite3 CLI if needed: brew install sqlite3
sqlite3 patients.db

# Useful queries:
.tables
SELECT * FROM patients;
SELECT * FROM appointments ORDER BY created_at DESC LIMIT 10;
```

---

## File overview

| File | What it does |
|---|---|
| `server.js` | Express + WebSocket entry point |
| `realtime.js` | OpenAI Realtime API connection + audio relay |
| `tools.js` | Tool definitions + implementations |
| `google-calendar.js` | Check availability + create events |
| `patients.js` | SQLite patient records |
| `appointments.js` | SQLite appointments + follow-up queries |
| `followup.js` | 15-min scheduler for post-visit messages |
| `notifications.js` | SMS (Twilio) + email (Resend) |
| `clinic-config.js` | Services, pricing, system prompt builder |
| `get-gcal-token.js` | One-time Google OAuth script |
| `railway.json` | Railway deploy config |
| `.env` | Secrets (never committed) |

---

Built by [Jenny Chen](https://linkedin.com/in/tjennychen)
