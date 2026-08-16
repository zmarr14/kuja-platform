process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-bdm-activity';
require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const leadsRouter = require('./routes/leads');

const TEST_CLIENT_ID = 'test-bdm-client-001';
const OTHER_CLIENT_ID = 'test-bdm-other-001';
const TEST_LEAD_ID = 'test-bdm-lead-001';
const TEST_API_KEY = 'test_bdm_api_key_001';
const OTHER_API_KEY = 'test_bdm_api_key_002';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanup() {
  db.prepare('DELETE FROM lead_activity WHERE client_id IN (?, ?)').run(TEST_CLIENT_ID, OTHER_CLIENT_ID);
  db.prepare('DELETE FROM leads WHERE client_id IN (?, ?)').run(TEST_CLIENT_ID, OTHER_CLIENT_ID);
  db.prepare('DELETE FROM clients WHERE id IN (?, ?)').run(TEST_CLIENT_ID, OTHER_CLIENT_ID);
}

function seedTestData() {
  cleanup();
  const hash = bcrypt.hashSync('testpass', 12);
  db.prepare(`
    INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(TEST_CLIENT_ID, 'Test Agent', 'test-bdm@example.com', hash, 'Test Agency', null, TEST_API_KEY);
  db.prepare(`
    INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(OTHER_CLIENT_ID, 'Other Agent', 'other-bdm@example.com', hash, 'Other Agency', null, OTHER_API_KEY);
  db.prepare(`
    INSERT INTO leads (id, client_id, name, phone, email, transcript, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    TEST_LEAD_ID,
    TEST_CLIENT_ID,
    'Fake Test Lead',
    '0400000000',
    'fake-lead@example.com',
    'Visitor: Looking for a 3 bed house ASAP with budget around $800k',
    'new'
  );
}

function tokenFor(clientId, email) {
  return jwt.sign({ clientId, email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function api(base, method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function run() {
  seedTestData();
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/leads`;
  const token = tokenFor(TEST_CLIENT_ID, 'test-bdm@example.com');
  const otherToken = tokenFor(OTHER_CLIENT_ID, 'other-bdm@example.com');

  try {
    let res = await api(base, 'GET', `/${TEST_LEAD_ID}/activity`, token);
    assert(res.status === 200, 'GET activity should succeed');
    assert(Array.isArray(res.data.activities) && res.data.activities.length === 0, 'Initial timeline should be empty');

    const leadBefore = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    const scoreBefore = (() => {
      let score = 0;
      if (leadBefore.name) score++;
      if (leadBefore.phone) score++;
      if (leadBefore.email) score++;
      const t = (leadBefore.transcript || '').toLowerCase();
      if (/\$\s?\d|\b\d+\s?(k|m)\b|budget|price range|per week|per month/.test(t)) score++;
      if (/asap|urgent|this week|this weekend|today|tomorrow|soon|right away|ready to (buy|sell|move|rent)|need to (buy|sell|move)/.test(t)) score++;
      return score >= 4 ? 'hot' : score >= 2 ? 'warm' : 'cold';
    })();

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'called', note: '' });
    assert(res.status === 200, 'POST called should succeed');
    assert(res.data.type === 'called', 'Activity type should be called');

    res = await api(base, 'GET', `/${TEST_LEAD_ID}/activity`, token);
    assert(res.data.activities.length === 1, 'Timeline should have one activity after called');
    assert(res.data.activities[0].type === 'called', 'Latest activity should be called');

    let lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert((lead.stage || 'new') === 'new', 'Called should not change stage');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'inspection_booked', note: '' });
    assert(res.status === 200, 'POST inspection_booked should succeed');
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert(lead.stage === 'inspection_booked', 'Stage should be inspection_booked');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'applied', note: '' });
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert(lead.stage === 'applied', 'Stage should be applied');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'won', note: '' });
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert(lead.stage === 'won', 'Stage should be won');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'lost', note: '' });
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert(lead.stage === 'lost', 'Stage should be lost');

    const countBeforeDuplicate = db.prepare('SELECT COUNT(*) as c FROM lead_activity WHERE lead_id = ?').get(TEST_LEAD_ID).c;
    res = await api(base, 'PATCH', `/${TEST_LEAD_ID}/stage`, token, { stage: 'lost' });
    assert(res.status === 200, 'PATCH duplicate lost should succeed');
    const countAfterDuplicate = db.prepare('SELECT COUNT(*) as c FROM lead_activity WHERE lead_id = ?').get(TEST_LEAD_ID).c;
    assert(countAfterDuplicate === countBeforeDuplicate, 'Duplicate stage PATCH should not create another activity');

    res = await api(base, 'PATCH', `/${TEST_LEAD_ID}/stage`, token, { stage: 'contacted' });
    assert(res.status === 200, 'PATCH contacted should succeed');
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(TEST_LEAD_ID);
    assert(lead.stage === 'contacted', 'Stage should be contacted');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, token, { type: 'invalid_type', note: '' });
    assert(res.status === 400, 'Invalid activity type should return 400');

    res = await api(base, 'PATCH', `/${TEST_LEAD_ID}/stage`, token, { stage: 'invalid_stage' });
    assert(res.status === 400, 'Invalid stage should return 400');

    res = await api(base, 'GET', `/${TEST_LEAD_ID}/activity`, otherToken);
    assert(res.status === 404, 'Other client cannot read activity');

    res = await api(base, 'POST', `/${TEST_LEAD_ID}/activity`, otherToken, { type: 'called', note: '' });
    assert(res.status === 404, 'Other client cannot post activity');

    res = await api(base, 'PATCH', `/${TEST_LEAD_ID}/stage`, otherToken, { stage: 'won' });
    assert(res.status === 404, 'Other client cannot patch stage');

    const listRes = await api(base, 'GET', '/', token);
    assert(listRes.status === 200, 'Lead list should still work');
    const listed = listRes.data.leads.find(l => l.id === TEST_LEAD_ID);
    assert(listed, 'Fake lead should appear in list');
    assert(listed.score_label === scoreBefore, 'Score label should remain unchanged');

    console.log('✅ All BDM activity tests passed');
  } finally {
    server.close();
    cleanup();
  }
}

run().catch(err => {
  console.error('❌ Test failed:', err.message);
  cleanup();
  process.exit(1);
});
