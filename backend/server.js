require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { seedAdmin } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve frontend — works whether frontend is at ../frontend or ./frontend
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', platform: 'Kuja AI' }));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(frontendPath, 'index.html'));
  }
});

app.listen(PORT, () => {
  seedAdmin();
  console.log(`
  ╔════════════════════════════════╗
  ║   Kuja AI Platform             ║
  ║   http://localhost:${PORT}        ║
  ╚════════════════════════════════╝
  `);
});
