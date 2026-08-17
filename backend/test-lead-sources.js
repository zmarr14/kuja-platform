process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-lead-sources';
require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const leadsRouter = require('./routes/leads');

const TEST_CLIENT_ID = 'test-sources-client-001';
const OTHER_CLIENT_ID = 'test-sources-other-001';
const LISTING_ID = 'test-sources-listing-001';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanup() {
  db.prepare('DELETE FROM leads WHERE client_id IN (?, ?)').run(TEST_CLIENT_ID, OTHER_CLIENT_ID);
  db.prepare('DELETE FROM listings WHERE client_id = ?').run(TEST_CLIENT_ID);
  db.prepare('DELETE FROM clients WHERE id IN (?, ?)').run(TEST_CLIENT_ID, OTHER_CLIENT_ID);
}

function seed() {
  cleanup();
  const hash = bcrypt.hashSync('testpass', 12);
  db.prepare(`
    INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(TEST_CLIENT_ID, 'Test Agent', 'sources@test.com', hash, 'Test Agency', null, 'test_sources_key_001');
  db.prepare(`
    INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(OTHER_CLIENT_ID, 'Other Agent', 'other-sources@test.com', hash, 'Other Agency', null, 'test_sources_key_002');

  db.prepare(`
    INSERT INTO listings (id, client_id, address, url, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(LISTING_ID, TEST_CLIENT_ID, '23 Smith St', 'https://example.com/listing/123');

  const insertLead = db.prepare(`
    INSERT INTO leads (id, client_id, name, email, source_page, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `);

  for (let i = 0; i < 3; i++) {
    insertLead.run(uuidv4(), TEST_CLIENT_ID, 'Lead A' + i, `a${i}@test.com`, 'https://example.com/listing/123/', `-${i} hours`);
  }
  for (let i = 0; i < 2; i++) {
    insertLead.run(uuidv4(), TEST_CLIENT_ID, 'Lead B' + i, `b${i}@test.com`, 'https://example.com/listing/456?utm_source=fb', `-${i + 1} days`);
  }
  insertLead.run(uuidv4(), TEST_CLIENT_ID, 'Lead C', 'c@test.com', null, '-2 days');
  insertLead.run(uuidv4(), TEST_CLIENT_ID, 'Lead D', 'd@test.com', 'https://other.com/page', '-1 days');
  insertLead.run(uuidv4(), OTHER_CLIENT_ID, 'Other Lead', 'other@test.com', 'https://example.com/listing/123', '-1 hours');
}

function tokenFor(clientId, email) {
  return jwt.sign({ clientId, email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function api(base, path, token) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return { status: res.status, data };
}

async function run() {
  seed();
  const app = express();
  app.use('/api/leads', leadsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/leads`;
  const token = tokenFor(TEST_CLIENT_ID, 'sources@test.com');
  const otherToken = tokenFor(OTHER_CLIENT_ID, 'other-sources@test.com');

  try {
    const res = await api(base, '/sources', token);
    assert(res.status === 200, 'sources endpoint should succeed');
    const sources = res.data.sources;
    assert(Array.isArray(sources), 'sources should be an array');

    const listingSource = sources.find((s) => s.source_page === 'https://example.com/listing/123/');
    assert(listingSource && listingSource.count === 3, 'same listing URL should aggregate to 3 leads');
    assert(listingSource.listing_address === '23 Smith St', 'listing address should match normalized URL');

    const secondSource = sources.find((s) => s.source_page === 'https://example.com/listing/456?utm_source=fb');
    assert(secondSource && secondSource.count === 2, 'second URL should have 2 leads');
    assert(secondSource.listing_address == null, 'unmatched listing URL should have null address');

    const unknown = sources.find((s) => s.source_page === 'Direct / Unknown');
    assert(unknown && unknown.count === 1, 'null source_page should group under Direct / Unknown');

    const otherClient = await api(base, '/sources', otherToken);
    assert(!otherClient.data.sources.some((s) => s.count > 0 && s.source_page.includes('listing/123/')), 'other client must not see test client sources');

    assert(sources[0].count >= sources[1].count, 'sources should be sorted by count desc');

    console.log('✅ All lead sources tests passed');
  } finally {
    server.close();
    cleanup();
  }
}

run().catch((err) => {
  console.error('❌ Test failed:', err.message);
  cleanup();
  process.exit(1);
});
