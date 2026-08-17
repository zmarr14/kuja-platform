process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-followup-sequence';
require('dotenv').config();

const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const sent = { day1: 0, day3: 0, day7: 0, agent: 0 };
let failNext = null;

const mockEmail = {
  sendLeadFollowup: async () => {
    if (failNext === 'day1') { failNext = null; throw new Error('mock day1 failure'); }
    sent.day1++;
  },
  sendLeadFollowupDay3: async () => {
    if (failNext === 'day3') { failNext = null; throw new Error('mock day3 failure'); }
    sent.day3++;
  },
  sendLeadFollowupDay7: async () => {
    if (failNext === 'day7') { failNext = null; throw new Error('mock day7 failure'); }
    sent.day7++;
  },
  sendAgentReminder: async () => { sent.agent++; },
  sendLeadNotification: async () => {},
  sendBookingConfirmation: async () => {},
};

require.cache[path.join(__dirname, 'email.js')] = {
  id: path.join(__dirname, 'email.js'),
  filename: path.join(__dirname, 'email.js'),
  loaded: true,
  exports: mockEmail,
};

delete require.cache[path.join(__dirname, 'followups.js')];
const {
  processLeadFollowup,
  processLeadSequence,
  getLeadAgeMs,
} = require('./followups');

const TEST_CLIENT_ID = 'test-followup-client-001';
const TEST_API_KEY = 'test_followup_api_key_001';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resetSent() {
  sent.day1 = 0;
  sent.day3 = 0;
  sent.day7 = 0;
  sent.agent = 0;
  failNext = null;
}

function cleanup() {
  db.prepare('DELETE FROM bookings WHERE client_id = ?').run(TEST_CLIENT_ID);
  db.prepare('DELETE FROM leads WHERE client_id = ?').run(TEST_CLIENT_ID);
  db.prepare('DELETE FROM clients WHERE id = ?').run(TEST_CLIENT_ID);
}

function seedClient() {
  cleanup();
  const hash = bcrypt.hashSync('testpass', 12);
  db.prepare(`
    INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(TEST_CLIENT_ID, 'Test Agent', 'agent-followup@test.com', hash, 'Test Agency', null, TEST_API_KEY);
}

function insertLead({ id, email, phone, followupStage, followupSent, agentReminderSent, ageDays }) {
  const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO leads (id, client_id, name, phone, email, transcript, followup_stage, followup_sent, agent_reminder_sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    TEST_CLIENT_ID,
    'Fake Test Lead',
    phone || '0400000001',
    email || 'fake-followup@test.com',
    'Visitor: Interested in a property',
    followupStage,
    followupSent || 0,
    agentReminderSent || 0,
    createdAt
  );
}

function getLead(id) {
  return db.prepare(`
    SELECT l.*, c.email AS agent_email, c.agency_name
    FROM leads l
    JOIN clients c ON l.client_id = c.id
    WHERE l.id = ?
  `).get(id);
}

async function run() {
  seedClient();
  resetSent();

  try {
    const day1Id = 'test-followup-day1';
    insertLead({ id: day1Id, followupStage: 0, ageDays: 25 / 24 });
    await processLeadSequence(getLead(day1Id));
    assert(sent.day1 === 1, 'Day 1 email should send at 25 hours');
    assert(getLead(day1Id).followup_stage === 1, 'Day 1 should advance followup_stage to 1');
    assert(getLead(day1Id).followup_sent === 1, 'Day 1 should set followup_sent for legacy compatibility');

    resetSent();
    const day3Id = 'test-followup-day3';
    insertLead({ id: day3Id, followupStage: 1, ageDays: 4 });
    await processLeadSequence(getLead(day3Id));
    assert(sent.day3 === 1, 'Day 3 email should send at 4 days with stage 1');
    assert(getLead(day3Id).followup_stage === 2, 'Day 3 should advance followup_stage to 2');

    resetSent();
    await processLeadSequence(getLead(day3Id));
    assert(sent.day3 === 0, 'Day 3 should not send twice after stage 2');

    resetSent();
    const day7Id = 'test-followup-day7';
    insertLead({ id: day7Id, followupStage: 2, ageDays: 8 });
    await processLeadSequence(getLead(day7Id));
    assert(sent.day7 === 1, 'Day 7 email should send at 8 days with stage 2');
    assert(getLead(day7Id).followup_stage === 3, 'Day 7 should advance followup_stage to 3');

    resetSent();
    await processLeadSequence(getLead(day7Id));
    assert(sent.day7 === 0, 'No email after sequence complete');

    resetSent();
    const bookingId = 'test-followup-booking';
    insertLead({ id: bookingId, followupStage: 1, ageDays: 4, email: 'booked@test.com', phone: '0400000099' });
    db.prepare(`
      INSERT INTO bookings (id, client_id, lead_name, lead_email, lead_phone, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'), datetime('now', '+1 day', '+30 minutes'))
    `).run(uuidv4(), TEST_CLIENT_ID, 'Fake Test Lead', 'booked@test.com', '0400000099');
    await processLeadFollowup(getLead(bookingId));
    assert(sent.day3 === 0, 'Booked lead should not receive Day 3 email');
    assert(getLead(bookingId).followup_stage === 4, 'Booked lead should stop sequence at stage 4');

    resetSent();
    const failId = 'test-followup-fail';
    insertLead({ id: failId, followupStage: 1, ageDays: 4 });
    failNext = 'day3';
    await processLeadSequence(getLead(failId));
    assert(getLead(failId).followup_stage === 1, 'Failed Day 3 send must not advance stage');
    resetSent();
    await processLeadSequence(getLead(failId));
    assert(sent.day3 === 1, 'Day 3 should retry after failure');
    assert(getLead(failId).followup_stage === 2, 'Day 3 should advance after successful retry');

    resetSent();
    const agentId = 'test-followup-agent';
    insertLead({ id: agentId, followupStage: 3, followupSent: 1, agentReminderSent: 0, ageDays: 2 });
    await processLeadFollowup(getLead(agentId));
    assert(sent.agent === 1, 'Agent reminder should still send when followup_stage is complete');
    assert(getLead(agentId).agent_reminder_sent === 1, 'Agent reminder should mark agent_reminder_sent');
    assert(getLead(agentId).followup_stage === 3, 'Agent reminder must not change followup_stage');

    console.log('✅ All follow-up sequence tests passed');
  } finally {
    cleanup();
  }
}

run().catch(err => {
  console.error('❌ Test failed:', err.message);
  cleanup();
  process.exit(1);
});
