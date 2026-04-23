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
  CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);
  CREATE INDEX IF NOT EXISTS idx_leads_date ON leads(created_at DESC);
`);

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM admin WHERE email = ?').get(process.env.ADMIN_EMAIL);
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    db.prepare('INSERT INTO admin (email, password) VALUES (?, ?)').run(process.env.ADMIN_EMAIL, hash);
    console.log('✅ Admin account created:', process.env.ADMIN_EMAIL);
  }
}

module.exports = { db, seedAdmin };
