const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'kuja.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    agency_name TEXT NOT NULL,
    website     TEXT,
    api_key     TEXT UNIQUE NOT NULL,
    plan        TEXT DEFAULT 'active',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login  DATETIME
  );
  CREATE TABLE IF NOT EXISTS leads (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    name         TEXT,
    phone        TEXT,
    email        TEXT,
    transcript   TEXT,
    source_page  TEXT,
    ip_address   TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_at      DATETIME,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
  CREATE TABLE IF NOT EXISTS admin (
    id       INTEGER PRIMARY KEY,
    email    TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listings (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    address       TEXT NOT NULL,
    suburb        TEXT,
    price         TEXT,
    bedrooms      INTEGER,
    bathrooms     INTEGER,
    property_type TEXT,
    description   TEXT,
    url           TEXT,
    status        TEXT DEFAULT 'active',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
  CREATE TABLE IF NOT EXISTS calendar_connections (
    client_id      TEXT PRIMARY KEY,
    google_email   TEXT,
    access_token   TEXT,
    refresh_token  TEXT,
    token_expiry   INTEGER,
    connected_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    lead_name    TEXT,
    lead_email   TEXT,
    lead_phone   TEXT,
    start_time   DATETIME NOT NULL,
    end_time     DATETIME NOT NULL,
    status       TEXT DEFAULT 'confirmed',
    google_event_id TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
  CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);
  CREATE INDEX IF NOT EXISTS idx_leads_date ON leads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_listings_client ON listings(client_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(start_time);
`);

// Migrations: SQLite has no "ADD COLUMN IF NOT EXISTS", so we check
// pragma table_info first and only alter if the column is actually missing.
// Safe to run on every startup — never touches existing rows.
const clientCols = db.prepare("PRAGMA table_info(clients)").all().map(c => c.name);
if (!clientCols.includes('calendly_url')) {
  db.exec('ALTER TABLE clients ADD COLUMN calendly_url TEXT');
  console.log('✅ Migration: added calendly_url column to clients');
}
if (!clientCols.includes('booking_hours')) {
  // JSON string, e.g. {"days":[1,2,3,4,5],"start":"09:00","end":"17:00","slotMinutes":30}
  db.exec('ALTER TABLE clients ADD COLUMN booking_hours TEXT');
  console.log('✅ Migration: added booking_hours column to clients');
}
if (!clientCols.includes('assistant_auto_confirm')) {
  db.exec('ALTER TABLE clients ADD COLUMN assistant_auto_confirm INTEGER DEFAULT 0');
  console.log('✅ Migration: added assistant_auto_confirm column to clients');
}

const listingCols = db.prepare("PRAGMA table_info(listings)").all().map(c => c.name);
if (!listingCols.includes('image_url')) {
  db.exec('ALTER TABLE listings ADD COLUMN image_url TEXT');
  console.log('✅ Migration: added image_url column to listings');
}

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
if (!leadCols.includes('summary')) {
  db.exec('ALTER TABLE leads ADD COLUMN summary TEXT');
  console.log('✅ Migration: added summary column to leads');
}
if (!leadCols.includes('followup_sent')) {
  db.exec('ALTER TABLE leads ADD COLUMN followup_sent INTEGER DEFAULT 0');
  console.log('✅ Migration: added followup_sent column to leads');
}
if (!leadCols.includes('agent_reminder_sent')) {
  db.exec('ALTER TABLE leads ADD COLUMN agent_reminder_sent INTEGER DEFAULT 0');
  console.log('✅ Migration: added agent_reminder_sent column to leads');
}

function seedAdmin() {
  // Seed admin account
  const existing = db.prepare('SELECT id FROM admin WHERE email = ?').get(process.env.ADMIN_EMAIL);
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    db.prepare('INSERT INTO admin (email, password) VALUES (?, ?)').run(process.env.ADMIN_EMAIL, hash);
    console.log('✅ Admin account created:', process.env.ADMIN_EMAIL);
  }

  // Seed Kuja AI as a permanent client with a FIXED api_key
  // This means it survives every redeploy
  const KUJA_API_KEY = 'kuja_7828916b91d242599da5efe7692840fa';
  const KUJA_CLIENT_ID = 'kuja-ai-client-permanent-001';

  const existingClient = db.prepare('SELECT id FROM clients WHERE id = ?').get(KUJA_CLIENT_ID);
  if (!existingClient) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'kujaai2026', 12);
    db.prepare(`
      INSERT INTO clients (id, name, email, password, agency_name, website, api_key, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      KUJA_CLIENT_ID,
      'Ezekiel',
      process.env.ADMIN_EMAIL || 'info@kujaai.com',
      hash,
      'Kuja AI',
      'https://kujaai.com',
      KUJA_API_KEY
    );
    console.log('✅ Kuja AI client seeded with API key:', KUJA_API_KEY);
  }
}

module.exports = { db, seedAdmin };
