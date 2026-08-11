const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { clientAuth } = require('../middleware/auth');
const { sendBookingConfirmation } = require('../email');

const REDIRECT_URI = (process.env.PLATFORM_URL || 'https://platform.kujaai.com') + '/api/calendar/google/callback';

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

const DEFAULT_HOURS = { days: [1,2,3,4,5], start: '09:00', end: '17:00', slotMinutes: 30 };

function getHours(client) {
  try { return client.booking_hours ? JSON.parse(client.booking_hours) : DEFAULT_HOURS; }
  catch { return DEFAULT_HOURS; }
}

// ── Client dashboard: connect/disconnect/status (requires login) ──

router.get('/google/connect', clientAuth, (req, res) => {
  const authUrl = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/userinfo.email'],
    state: req.clientId,
  });
  res.json({ authUrl });
});

// Google redirects here after the agent approves access — no auth middleware
// (Google doesn't send our JWT), client identity comes from the signed state param instead.
router.get('/google/callback', async (req, res) => {
  const { code, state: clientId } = req.query;
  if (!code || !clientId) return res.status(400).send('Missing code or state');
  try {
    const oauth2 = oauthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    const oauth2Api = google.oauth2({ auth: oauth2, version: 'v2' });
    const { data: userInfo } = await oauth2Api.userinfo.get();

    db.prepare(`
      INSERT INTO calendar_connections (client_id, google_email, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET google_email=excluded.google_email, access_token=excluded.access_token,
        refresh_token=COALESCE(excluded.refresh_token, calendar_connections.refresh_token), token_expiry=excluded.token_expiry
    `).run(clientId, userInfo.email, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null);

    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Google Calendar connected ✓</h2><p>You can close this tab and go back to your dashboard.</p></body></html>');
  } catch (e) {
    console.error('Google OAuth callback failed:', e.message);
    res.status(500).send('Connection failed — please try again from your dashboard.');
  }
});

router.get('/status', clientAuth, (req, res) => {
  const conn = db.prepare('SELECT google_email, connected_at FROM calendar_connections WHERE client_id = ?').get(req.clientId);
  const client = db.prepare('SELECT booking_hours FROM clients WHERE id = ?').get(req.clientId);
  res.json({ connected: !!conn, googleEmail: conn?.google_email || null, hours: getHours(client) });
});

router.delete('/disconnect', clientAuth, (req, res) => {
  db.prepare('DELETE FROM calendar_connections WHERE client_id = ?').run(req.clientId);
  res.json({ success: true });
});

router.put('/hours', clientAuth, (req, res) => {
  const { days, start, end, slotMinutes } = req.body;
  const hours = { days: days || DEFAULT_HOURS.days, start: start || DEFAULT_HOURS.start, end: end || DEFAULT_HOURS.end, slotMinutes: slotMinutes || DEFAULT_HOURS.slotMinutes };
  db.prepare('UPDATE clients SET booking_hours = ? WHERE id = ?').run(JSON.stringify(hours), req.clientId);
  res.json({ hours });
});

router.get('/bookings', clientAuth, (req, res) => {
  const bookings = db.prepare('SELECT * FROM bookings WHERE client_id = ? AND start_time >= datetime("now") ORDER BY start_time ASC').all(req.clientId);
  res.json({ bookings });
});

// ── Helper: get a fresh, valid access token for a client, refreshing if needed ──
async function getValidToken(clientId) {
  const conn = db.prepare('SELECT * FROM calendar_connections WHERE client_id = ?').get(clientId);
  if (!conn) return null;
  const oauth2 = oauthClient();
  oauth2.setCredentials({ access_token: conn.access_token, refresh_token: conn.refresh_token, expiry_date: conn.token_expiry });
  if (!conn.token_expiry || conn.token_expiry < Date.now() + 60000) {
    const { credentials } = await oauth2.refreshAccessToken();
    db.prepare('UPDATE calendar_connections SET access_token = ?, token_expiry = ? WHERE client_id = ?')
      .run(credentials.access_token, credentials.expiry_date, clientId);
    oauth2.setCredentials(credentials);
  }
  return oauth2;
}

// ── Public: widget checks availability + books, keyed by api_key (no login) ──

router.get('/public/availability', async (req, res) => {
  const { api_key, date } = req.query; // date = 'YYYY-MM-DD'
  if (!api_key || !date) return res.status(400).json({ error: 'api_key and date required' });
  const client = db.prepare("SELECT * FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
  if (!client) return res.status(401).json({ error: 'Invalid api_key' });

  const hours = getHours(client);
  const day = new Date(date + 'T00:00:00');
  if (!hours.days.includes(day.getDay())) return res.json({ slots: [] });

  const oauth2 = await getValidToken(client.id);
  if (!oauth2) return res.status(400).json({ error: 'This business hasn\'t connected their calendar yet' });

  const dayStart = new Date(date + 'T' + hours.start + ':00');
  const dayEnd = new Date(date + 'T' + hours.end + ':00');

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const fb = await calendar.freebusy.query({ requestBody: { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), items: [{ id: 'primary' }] } });
  const busy = (fb.data.calendars.primary.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));

  const slots = [];
  let cursor = new Date(dayStart);
  while (cursor < dayEnd) {
    const slotEnd = new Date(cursor.getTime() + hours.slotMinutes * 60000);
    const overlapsBusy = busy.some(b => cursor < b.end && slotEnd > b.start);
    const isPast = cursor < new Date();
    if (!overlapsBusy && !isPast) slots.push(cursor.toISOString());
    cursor = slotEnd;
  }
  res.json({ slots, slotMinutes: hours.slotMinutes });
});

router.post('/public/book', async (req, res) => {
  const { api_key, start_time, name, email, phone } = req.body;
  if (!api_key || !start_time || !name) return res.status(400).json({ error: 'api_key, start_time and name required' });
  const client = db.prepare("SELECT * FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
  if (!client) return res.status(401).json({ error: 'Invalid api_key' });

  const oauth2 = await getValidToken(client.id);
  if (!oauth2) return res.status(400).json({ error: 'This business hasn\'t connected their calendar yet' });

  const hours = getHours(client);
  const start = new Date(start_time);
  const end = new Date(start.getTime() + hours.slotMinutes * 60000);

  // Re-check the slot is still free right before booking (avoids race conditions)
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const fb = await calendar.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: 'primary' }] } });
  if ((fb.data.calendars.primary.busy || []).length > 0) {
    return res.status(409).json({ error: 'That time was just booked — please pick another.' });
  }

  const event = await calendar.events.insert({
    calendarId: 'primary',
    sendUpdates: 'all',
    requestBody: {
      summary: `${name} — booked via Kuja AI`,
      description: `Booked automatically via ${client.agency_name}'s AI assistant.\nPhone: ${phone || 'n/a'}\nEmail: ${email || 'n/a'}`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: email ? [{ email }] : [],
    },
  });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookings (id, client_id, lead_name, lead_email, lead_phone, start_time, end_time, google_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, client.id, name, email||null, phone||null, start.toISOString(), end.toISOString(), event.data.id);

  sendBookingConfirmation({ clientEmail: client.email, agencyName: client.agency_name, name, email, phone, startTime: start }).catch(e => console.error('Booking email failed:', e.message));

  res.json({ success: true, bookingId: id, startTime: start.toISOString() });
});

module.exports = router;
