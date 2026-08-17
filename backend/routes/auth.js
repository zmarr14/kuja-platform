const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');

function createLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many login attempts, try again later.' });
    },
  });
}

router.post('/client/login', createLoginLimiter(), (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email.toLowerCase().trim());
  if (!client || !bcrypt.compareSync(password, client.password))
    return res.status(401).json({ error: 'Invalid email or password' });
  db.prepare('UPDATE clients SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(client.id);
  const token = jwt.sign({ clientId: client.id, email: client.email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, client: { id: client.id, name: client.name, email: client.email, agencyName: client.agency_name, website: client.website } });
});

router.post('/admin/login', createLoginLimiter(), (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const admin = db.prepare('SELECT * FROM admin WHERE email = ?').get(email.toLowerCase().trim());
  if (!admin || !bcrypt.compareSync(password, admin.password))
    return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ adminId: admin.id, email: admin.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, admin: { email: admin.email } });
});

module.exports = router;
