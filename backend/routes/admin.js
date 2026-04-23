const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { adminAuth } = require('../middleware/auth');

router.use(adminAuth);

router.get('/stats', (req, res) => {
  const totalClients = db.prepare("SELECT COUNT(*) as c FROM clients WHERE plan = 'active'").get().c;
  res.json({
    totalClients,
    mrr: totalClients * 150,
    totalLeads:    db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
    leadsToday:    db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at) = date('now')").get().c,
    leadsThisWeek: db.prepare("SELECT COUNT(*) as c FROM leads WHERE created_at >= datetime('now','-7 days')").get().c,
  });
});

router.get('/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT c.*, COUNT(l.id) as lead_count, MAX(l.created_at) as last_lead_at
    FROM clients c LEFT JOIN leads l ON c.id = l.client_id
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  res.json({ clients: clients.map(({ password, ...rest }) => rest) });
});

router.post('/clients', (req, res) => {
  const { name, email, password, agency_name, website } = req.body;
  if (!name || !email || !password || !agency_name) return res.status(400).json({ error: 'name, email, password, agency_name required' });
  if (db.prepare('SELECT id FROM clients WHERE email = ?').get(email.toLowerCase().trim()))
    return res.status(409).json({ error: 'Email already exists' });
  const id = uuidv4();
  const api_key = 'kuja_' + uuidv4().replace(/-/g, '');
  db.prepare('INSERT INTO clients (id, name, email, password, agency_name, website, api_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, email.toLowerCase().trim(), bcrypt.hashSync(password, 12), agency_name, website||null, api_key);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  const { password: _, ...safe } = client;
  res.status(201).json({ client: safe });
});

router.patch('/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const { name, email, agency_name, website, plan, password } = req.body;
  db.prepare('UPDATE clients SET name=?, email=?, agency_name=?, website=?, plan=?, password=? WHERE id=?').run(
    name ?? client.name,
    email?.toLowerCase().trim() ?? client.email,
    agency_name ?? client.agency_name,
    website ?? client.website,
    plan ?? client.plan,
    password ? bcrypt.hashSync(password, 12) : client.password,
    req.params.id
  );
  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  const { password: _, ...safe } = updated;
  res.json({ client: safe });
});

router.delete('/clients/:id', (req, res) => {
  db.prepare("UPDATE clients SET plan = 'inactive' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

router.get('/clients/:id/api-key', (req, res) => {
  const client = db.prepare('SELECT api_key, agency_name FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json({ apiKey: client.api_key, agencyName: client.agency_name });
});

module.exports = router;
