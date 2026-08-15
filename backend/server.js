require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { db, seedAdmin } = require('./db');
const { sendLeadFollowup, sendAgentReminder } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));

// Serve frontend — works whether frontend is at ../frontend or ./frontend
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/chat', require('./routes/chat'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', platform: 'Kuja AI' }));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(frontendPath, 'index.html'));
  }
});

const getEligibleLeads = db.prepare(`
  SELECT l.*, c.email AS agent_email, c.agency_name
  FROM leads l
  JOIN clients c ON l.client_id = c.id
  WHERE l.created_at <= datetime('now', '-24 hours')
    AND (COALESCE(l.followup_sent, 0) = 0 OR COALESCE(l.agent_reminder_sent, 0) = 0)
`);

const findLeadBooking = db.prepare(`
  SELECT id FROM bookings
  WHERE client_id = ?
    AND (
      (? IS NOT NULL AND ? != '' AND lead_email = ?)
      OR (? IS NOT NULL AND ? != '' AND lead_phone = ?)
    )
  LIMIT 1
`);

const markFollowupSent = db.prepare('UPDATE leads SET followup_sent = 1 WHERE id = ?');
const markAgentReminderSent = db.prepare('UPDATE leads SET agent_reminder_sent = 1 WHERE id = ?');
const markBothFollowupsSent = db.prepare('UPDATE leads SET followup_sent = 1, agent_reminder_sent = 1 WHERE id = ?');

async function processLeadFollowup(lead) {
  const leadEmail = lead.email?.trim() || null;
  const leadPhone = lead.phone?.trim() || null;

  const booking = findLeadBooking.get(
    lead.client_id,
    leadEmail, leadEmail, leadEmail,
    leadPhone, leadPhone, leadPhone
  );

  if (booking) {
    markBothFollowupsSent.run(lead.id);
    return;
  }

  if (!lead.followup_sent) {
    if (leadEmail) {
      try {
        await sendLeadFollowup({
          leadEmail,
          leadName: lead.name || 'there',
          agencyName: lead.agency_name,
        });
        markFollowupSent.run(lead.id);
      } catch (e) {
        console.error(`❌ Lead follow-up failed for lead ${lead.id} (${leadEmail}):`, e.message);
      }
    } else {
      markFollowupSent.run(lead.id);
    }
  }

  if (!lead.agent_reminder_sent) {
    const agentEmail = lead.agent_email?.trim() || null;
    if (agentEmail) {
      try {
        await sendAgentReminder({
          agentEmail,
          leadName: lead.name || 'Unknown lead',
          leadPhone,
          leadEmail,
          transcript: lead.transcript,
          agencyName: lead.agency_name,
        });
        markAgentReminderSent.run(lead.id);
      } catch (e) {
        console.error(`❌ Agent reminder failed for lead ${lead.id}:`, e.message);
      }
    } else {
      markAgentReminderSent.run(lead.id);
    }
  }
}

async function checkFollowups() {
  try {
    const leads = getEligibleLeads.all();
    for (const lead of leads) {
      try {
        await processLeadFollowup(lead);
      } catch (e) {
        console.error(`❌ Follow-up processing failed for lead ${lead.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ checkFollowups failed:', e);
  }
}

app.listen(PORT, () => {
  seedAdmin();
  console.log(`
  ╔════════════════════════════════╗
  ║   Kuja AI Platform             ║
  ║   http://localhost:${PORT}        ║
  ╚════════════════════════════════╝
  `);
  checkFollowups();
  setInterval(checkFollowups, 15 * 60 * 1000);
});
