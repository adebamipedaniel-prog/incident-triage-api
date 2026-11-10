const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function createDatabase(filename = process.env.DB_FILE || "./data/incidents.sqlite") {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
      service TEXT NOT NULL CHECK (length(service) BETWEEN 1 AND 100),
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'investigating', 'resolved')),
      assignee TEXT CHECK (assignee IS NULL OR length(assignee) <= 120),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_status_created_at
      ON incidents (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS incidents_severity_created_at
      ON incidents (severity, created_at DESC);
  `);

  return db;
}

module.exports = { createDatabase };
