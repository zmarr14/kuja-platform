process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-rate-limits';
require('dotenv').config();

const express = require('express');
const authRouter = require('./routes/auth');
const leadsRouter = require('./routes/leads');
const { db } = require('./db');
const bcrypt = require('bcryptjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function testLoginLimiter() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;

  try {
    for (let i = 0; i < 8; i++) {
      const res = await post(base, '/client/login', { email: 'nope@test.com', password: 'bad' });
      assert(res.status === 401 || res.status === 400, 'early login attempts should not be 429');
    }
    const blocked = await post(base, '/client/login', { email: 'nope@test.com', password: 'bad' });
    assert(blocked.status === 429, '9th client login should be rate limited');
    assert(blocked.data.error === 'Too many login attempts, try again later.', 'client login 429 message');

    for (let i = 0; i < 8; i++) {
      const res = await post(base, '/admin/login', { email: 'nope@test.com', password: 'bad' });
      assert(res.status === 401 || res.status === 400, 'early admin login attempts should not be 429');
    }
    const adminBlocked = await post(base, '/admin/login', { email: 'nope@test.com', password: 'bad' });
    assert(adminBlocked.status === 429, '9th admin login should be rate limited');
    assert(adminBlocked.data.error === 'Too many login attempts, try again later.', 'admin login 429 message');
  } finally {
    server.close();
  }
}

async function testWebhookLimiter() {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/leads`;

  try {
    for (let i = 0; i < 20; i++) {
      const res = await post(base, '/webhook', { api_key: 'invalid-key', name: 'Test' });
      assert(res.status !== 429, `webhook attempt ${i + 1} should not be limited yet`);
    }
    const blocked = await post(base, '/webhook', { api_key: 'invalid-key', name: 'Test' });
    assert(blocked.status === 429, '21st webhook request should be rate limited');
    assert(blocked.data.error === 'Too many submissions, please try again shortly.', 'webhook 429 message');
  } finally {
    server.close();
  }
}

async function testAuthenticatedLeadsNotLimited() {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/leads`;

  try {
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/`, { headers: { Authorization: 'Bearer invalid' } });
      assert(res.status !== 429, 'authenticated leads route should not inherit webhook limiter');
    }
  } finally {
    server.close();
  }
}

function testSeedAdminRequiresPassword() {
  const savedEmail = process.env.ADMIN_EMAIL;
  const savedPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;

  db.prepare('DELETE FROM admin').run();
  db.prepare("DELETE FROM clients WHERE id = 'kuja-ai-client-permanent-001'").run();

  const { seedAdmin } = require('./db');
  let threw = false;
  try {
    seedAdmin();
  } catch (e) {
    threw = true;
    assert(String(e.message).includes('ADMIN_EMAIL') || String(e.message).includes('ADMIN_PASSWORD'), 'seedAdmin should fail without credentials');
  } finally {
    if (savedEmail) process.env.ADMIN_EMAIL = savedEmail;
    else delete process.env.ADMIN_EMAIL;
    if (savedPassword) process.env.ADMIN_PASSWORD = savedPassword;
    else delete process.env.ADMIN_PASSWORD;
  }
  assert(threw, 'seedAdmin must throw when required credentials are missing');
}

async function run() {
  await testLoginLimiter();
  await testWebhookLimiter();
  await testAuthenticatedLeadsNotLimited();
  testSeedAdminRequiresPassword();
  console.log('✅ All rate limit/security tests passed');
}

run().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
