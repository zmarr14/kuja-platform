const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { clientAuth } = require('../middleware/auth');

// ── Client dashboard: manage own listings (requires login) ──

router.get('/', clientAuth, (req, res) => {
  const listings = db.prepare('SELECT * FROM listings WHERE client_id = ? ORDER BY created_at DESC').all(req.clientId);
  res.json({ listings });
});

router.post('/', clientAuth, (req, res) => {
  const { address, suburb, price, bedrooms, bathrooms, property_type, description, url, image_url } = req.body;
  if (!address) return res.status(400).json({ error: 'address is required' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO listings (id, client_id, address, suburb, price, bedrooms, bathrooms, property_type, description, url, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.clientId, address, suburb||null, price||null, bedrooms||null, bathrooms||null, property_type||null, description||null, url||null, image_url||null);
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  res.status(201).json({ listing });
});

router.patch('/:id', clientAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND client_id = ?').get(req.params.id, req.clientId);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  const { address, suburb, price, bedrooms, bathrooms, property_type, description, url, status, image_url } = req.body;
  db.prepare(`
    UPDATE listings SET address=?, suburb=?, price=?, bedrooms=?, bathrooms=?, property_type=?, description=?, url=?, status=?, image_url=?
    WHERE id=?
  `).run(
    address ?? listing.address,
    suburb ?? listing.suburb,
    price ?? listing.price,
    bedrooms ?? listing.bedrooms,
    bathrooms ?? listing.bathrooms,
    property_type ?? listing.property_type,
    description ?? listing.description,
    url ?? listing.url,
    status ?? listing.status,
    image_url ?? listing.image_url,
    req.params.id
  );
  const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  res.json({ listing: updated });
});

router.delete('/:id', clientAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND client_id = ?').get(req.params.id, req.clientId);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM listings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Public: chat widget fetches active listings by api_key (no login) ──
// Mirrors the pattern used by /api/leads/webhook — the widget already has
// the client's api_key embedded, same trust model as lead submission.
router.get('/public', (req, res) => {
  const { api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  const client = db.prepare("SELECT id, agency_name FROM clients WHERE api_key = ? AND plan = 'active'").get(api_key);
  if (!client) return res.status(401).json({ error: 'Invalid api_key' });
  const listings = db.prepare("SELECT address, suburb, price, bedrooms, bathrooms, property_type, description, url, image_url FROM listings WHERE client_id = ? AND status = 'active' ORDER BY created_at DESC").all(client.id);
  res.json({ agencyName: client.agency_name, listings });
});

module.exports = router;
