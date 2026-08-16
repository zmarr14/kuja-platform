const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { clientAuth, adminAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { sendLeadNotification } = require('../email');

// ── Lead scoring ──
// Computed on read (not stored) so this never touches existing data or requires a migration.
// score: 0-5 · label: 'hot' (4-5) | 'warm' (2-3) | 'cold' (0-1)
function scoreLead(lead) {
  let score = 0;
  if (lead.name) score++;
  if (lead.phone) score++;
  if (lead.email) score++;

  const t = (lead.transcript || '').toLowerCase();
  // budget / price signal
  if (/\$\s?\d|\b\d+\s?(k|m)\b|budget|price range|per week|per month/.test(t)) score++;
  // urgency / timeline signal
  if (/asap|urgent|this week|this weekend|today|tomorrow|soon|right away|ready to (buy|sell|move|rent)|need to (buy|sell|move)/.test(t)) score++;

  const label = score >= 4 ? 'hot' : score >= 2 ? 'warm' : 'cold';
  return { score, score_label: label };
}

function withScore(lead) {
  return { ...lead, ...scoreLead(lead) };
}

const VALID_STAGES = ['new', 'contacted', 'inspection_booked', 'applied', 'won', 'lost'];
const VALID_ACTIVITY_TYPES = ['called', 'emailed', 'inspection_booked', 'applied', 'won', 'lost', 'note'];
const ACTIVITY_STAGE_MAP = {
  inspection_booked: 'inspection_booked',
  applied: 'applied',
  won: 'won',
  lost: 'lost',
};
const STAGE_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  inspection_booked: 'Inspection booked',
  applied: 'Applied',
  won: 'Won',
  lost: 'Lost',
};

function stageActivityType(stage) {
  if (['inspection_booked', 'applied', 'won', 'lost'].includes(stage)) return stage;
  return 'note';
}

function stageChangeNote(stage) {
  return `Stage changed to ${STAGE_LABELS[stage] || stage}`;
}

function getOwnedLead(id, clientId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(id, clientId);
}

// Chatbot posts lead here (replaces Formspree)
const leadWebhookLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,                  // way above legitimate traffic for a small business, catches spam floods
  keyFn: (req) => req.body?.api_key,
  message: 'Too many leads submitted — please try again shortly.',
});

router.post('/webhook', leadWebhookLimit, async (req, res) => {
  const { api_key, name, phone, email, transcript, source_page } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  const client = db.prepare("SELECT * FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
  if (!client) return res.status(401).json({ error: 'Invalid api_key' });
  if (!name && !phone && !email) return res.status(400).json({ error: 'At least one contact field required' });

  const id = uuidv4();
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;

  let summary = null;
  if (transcript) {
    try {
      const sumRes = await fetch('https://billowing-water-5807.joicvmarr4.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: transcript }],
          system: 'Summarize this lead conversation in one short sentence — what they want and any key details (property, budget, timeline). Be concise and factual, no preamble, just the summary sentence itself.',
        }),
      });
      const sumData = await sumRes.json();
      const textBlock = sumData.content && sumData.content.find(b => b.type === 'text');
      if (textBlock) summary = textBlock.text;
    } catch (e) {
      console.error('Lead summary generation failed:', e.message);
    }
  }

  db.prepare('INSERT INTO leads (id, client_id, name, phone, email, transcript, source_page, ip_address, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, client.id, name||null, phone||null, email||null, transcript||null, source_page||null, ip, summary);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  sendLeadNotification({ clientEmail: client.email, agencyName: client.agency_name, lead }).catch(e => console.error('Email failed:', e.message));
  console.log(`✅ Lead for ${client.agency_name}: ${name || email || phone}`);
  res.json({ success: true, leadId: id });
});

// Client: get their leads
router.get('/', clientAuth, (req, res) => {
  const { page = 1, limit = 100, unread } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE client_id = ?';
  const params = [req.clientId];
  if (unread === 'true') { where += ' AND read_at IS NULL'; }
  const total = db.prepare(`SELECT COUNT(*) as c FROM leads ${where}`).get(...params).c;
  const leads = db.prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  res.json({ leads: leads.map(withScore), total });
});

router.get('/stats', clientAuth, (req, res) => {
  const id = req.clientId;
  const hotCount = db.prepare('SELECT * FROM leads WHERE client_id = ?').all(id)
    .filter(l => scoreLead(l).score_label === 'hot').length;
  res.json({
    total:    db.prepare('SELECT COUNT(*) as c FROM leads WHERE client_id = ?').get(id).c,
    unread:   db.prepare('SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND read_at IS NULL').get(id).c,
    today:    db.prepare("SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND date(created_at) = date('now')").get(id).c,
    thisWeek: db.prepare("SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND created_at >= datetime('now','-7 days')").get(id).c,
    hot:      hotCount,
  });
});

router.patch('/:id/read', clientAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(req.params.id, req.clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE leads SET read_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/activity', clientAuth, (req, res) => {
  const { type, note } = req.body || {};
  if (!type || !VALID_ACTIVITY_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid activity type' });
  }
  const lead = getOwnedLead(req.params.id, req.clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const activityId = uuidv4();
  const stageUpdate = ACTIVITY_STAGE_MAP[type] || null;
  const insertActivity = db.prepare(`
    INSERT INTO lead_activity (id, lead_id, client_id, type, note)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateStage = db.prepare('UPDATE leads SET stage = ? WHERE id = ? AND client_id = ?');

  const run = db.transaction(() => {
    insertActivity.run(activityId, lead.id, req.clientId, type, note || null);
    if (stageUpdate) updateStage.run(stageUpdate, lead.id, req.clientId);
  });
  run();

  const activity = db.prepare('SELECT * FROM lead_activity WHERE id = ?').get(activityId);
  res.json(activity);
});

router.get('/:id/activity', clientAuth, (req, res) => {
  const lead = getOwnedLead(req.params.id, req.clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const activities = db.prepare(`
    SELECT *
    FROM lead_activity
    WHERE lead_id = ?
      AND client_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id, req.clientId);
  res.json({ activities });
});

router.patch('/:id/stage', clientAuth, (req, res) => {
  const { stage } = req.body || {};
  if (!stage || !VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Invalid stage' });
  }
  const lead = getOwnedLead(req.params.id, req.clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const currentStage = lead.stage || 'new';
  if (currentStage === stage) {
    return res.json({ success: true, stage, lead: withScore({ ...lead, stage }) });
  }

  const activityId = uuidv4();
  const activityType = stageActivityType(stage);
  const activityNote = activityType === 'note' ? stageChangeNote(stage) : stageChangeNote(stage);
  const insertActivity = db.prepare(`
    INSERT INTO lead_activity (id, lead_id, client_id, type, note)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateStage = db.prepare('UPDATE leads SET stage = ? WHERE id = ? AND client_id = ?');

  const run = db.transaction(() => {
    updateStage.run(stage, lead.id, req.clientId);
    insertActivity.run(activityId, lead.id, req.clientId, activityType, activityNote);
  });
  run();

  const updatedLead = getOwnedLead(lead.id, req.clientId);
  res.json({ success: true, stage, lead: withScore(updatedLead) });
});

// Admin: all leads
router.get('/admin/all', adminAuth, (req, res) => {
  const leads = db.prepare(`
    SELECT l.*, c.agency_name, c.name as client_name
    FROM leads l JOIN clients c ON l.client_id = c.id
    ORDER BY l.created_at DESC LIMIT 200
  `).all();
  res.json({ leads: leads.map(withScore), total: leads.length });
});

module.exports = router;
