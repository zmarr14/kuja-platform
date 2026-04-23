const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { clientAuth, adminAuth } = require('../middleware/auth');
const { sendLeadNotification } = require('../email');

// Chatbot posts lead here (replaces Formspree)
router.post('/webhook', async (req, res) => {
  const { api_key, name, phone, email, transcript, source_page } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  const client = db.prepare("SELECT * FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
  if (!client) return res.status(401).json({ error: 'Invalid api_key' });
  if (!name && !phone && !email) return res.status(400).json({ error: 'At least one contact field required' });

  const id = uuidv4();
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
  db.prepare('INSERT INTO leads (id, client_id, name, phone, email, transcript, source_page, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, client.id, name||null, phone||null, email||null, transcript||null, source_page||null, ip);

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
  res.json({ leads, total });
});

router.get('/stats', clientAuth, (req, res) => {
  const id = req.clientId;
  res.json({
    total:    db.prepare('SELECT COUNT(*) as c FROM leads WHERE client_id = ?').get(id).c,
    unread:   db.prepare('SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND read_at IS NULL').get(id).c,
    today:    db.prepare("SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND date(created_at) = date('now')").get(id).c,
    thisWeek: db.prepare("SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND created_at >= datetime('now','-7 days')").get(id).c,
  });
});

router.patch('/:id/read', clientAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(req.params.id, req.clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE leads SET read_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Admin: all leads
router.get('/admin/all', adminAuth, (req, res) => {
  const leads = db.prepare(`
    SELECT l.*, c.agency_name, c.name as client_name
    FROM leads l JOIN clients c ON l.client_id = c.id
    ORDER BY l.created_at DESC LIMIT 200
  `).all();
  res.json({ leads, total: leads.length });
});

module.exports = router;
