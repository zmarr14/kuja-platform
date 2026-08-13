const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { clientAuth } = require('../middleware/auth');
const { rateLimit } = require('./ratelimit');
const {
  DEFAULT_HOURS,
  getHours,
  getValidToken,
  oauthClient,
  getPublicAvailability,
  createPublicBooking,
} = require('../services/booking');
const { google } = require('googleapis');

router.get('/google/connect', clientAuth, (req, res) => {
  const authUrl = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: req.clientId,
  });
  res.json({ authUrl });
});

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
  const hours = {
    days: days || DEFAULT_HOURS.days,
    start: start || DEFAULT_HOURS.start,
    end: end || DEFAULT_HOURS.end,
    slotMinutes: slotMinutes || DEFAULT_HOURS.slotMinutes,
  };
  db.prepare('UPDATE clients SET booking_hours = ? WHERE id = ?').run(JSON.stringify(hours), req.clientId);
  res.json({ hours });
});

router.get('/bookings', clientAuth, (req, res) => {
  const bookings = db.prepare('SELECT * FROM bookings WHERE client_id = ? AND start_time >= datetime("now") ORDER BY start_time ASC').all(req.clientId);
  res.json({ bookings });
});

const availabilityLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyFn: (req) => req.query?.api_key,
  message: 'Too many availability checks — please try again shortly.',
});

router.get('/public/availability', availabilityLimit, async (req, res) => {
  try {
    const { api_key, date } = req.query;
    const result = await getPublicAvailability(api_key, date);
    res.json({ slots: result.slots, slotMinutes: result.slotMinutes });
  } catch (e) {
    console.error('❌ /public/availability failed:', e);
    res.status(e.status || 500).json({ error: e.message || 'Something went wrong checking availability.' });
  }
});

const bookingLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => req.body?.api_key,
  message: 'Too many booking attempts — please try again shortly.',
});

router.post('/public/book', bookingLimit, async (req, res) => {
  try {
    const { api_key, start_time, name, email, phone } = req.body;
    const result = await createPublicBooking({
      apiKey: api_key,
      startTime: start_time,
      name,
      email,
      phone,
    });
    res.json({ success: true, bookingId: result.bookingId, startTime: result.startTime });
  } catch (e) {
    console.error('❌ /public/book failed:', e);
    res.status(e.status || 500).json({ error: e.message || 'Something went wrong creating that booking.' });
  }
});

module.exports = router;
