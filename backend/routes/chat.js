const express = require('express');
const router = express.Router();
const { db } = require('../db');

const WORKER_URL = 'https://billowing-water-5807.joicvmarr4.workers.dev';

router.post('/', async (req, res) => {
  try {
    const { api_key, messages, system } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key required' });
    const client = db.prepare("SELECT * FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
    if (!client) return res.status(401).json({ error: 'Invalid api_key' });

    const workerResponse = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, system }),
    });

    const data = await workerResponse.json();
    return res.status(workerResponse.status).json(data);
  } catch (e) {
    console.error('❌ /api/chat failed:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
