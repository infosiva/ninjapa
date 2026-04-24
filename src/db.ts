/**
 * NinjaPA — SQLite database schema + all CRUD operations.
 * One file keeps it simple — no ORM needed.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'ninjapa.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,   -- Telegram user ID
    username    TEXT,
    first_name  TEXT,
    plan        TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'pro'
    profile     TEXT NOT NULL DEFAULT '{}',     -- JSON: age, weight, goals etc
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    description TEXT,
    priority    TEXT NOT NULL DEFAULT 'medium',  -- 'low'|'medium'|'high'
    due_at      TEXT,                             -- ISO datetime
    completed   INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    message     TEXT NOT NULL,
    cron_expr   TEXT,          -- cron for recurring  e.g. "0 9 * * *"
    once_at     TEXT,          -- ISO datetime for one-shot
    type        TEXT NOT NULL, -- 'once' | 'recurring'
    active      INTEGER NOT NULL DEFAULT 1,
    last_fired  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    invoice_no   TEXT NOT NULL,
    client_name  TEXT NOT NULL,
    client_email TEXT,
    items        TEXT NOT NULL,   -- JSON array: [{description, qty, rate}]
    currency     TEXT NOT NULL DEFAULT 'GBP',
    tax_pct      REAL NOT NULL DEFAULT 0,
    due_days     INTEGER NOT NULL DEFAULT 30,
    pdf_path     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flight_watches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    origin       TEXT NOT NULL,   -- IATA code e.g. LHR
    destination  TEXT NOT NULL,   -- IATA code e.g. MAA
    max_price    REAL NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'GBP',
    travel_date  TEXT,            -- YYYY-MM-DD
    last_price   REAL,
    last_checked TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS diet_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,   -- full plan text from AI
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL,   -- 'user' | 'assistant'
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── User ──────────────────────────────────────────────────────────────────────
export function upsertUser(id: number, username?: string, first_name?: string) {
  db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `).run(id, username ?? null, first_name ?? null);
}

export function getUser(id: number) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
}

export function updateProfile(userId: number, patch: Record<string, any>) {
  const user = getUser(userId);
  const current = JSON.parse(user?.profile ?? '{}');
  const merged = { ...current, ...patch };
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(merged), userId);
  return merged;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
export function addTask(userId: number, title: string, opts: {
  description?: string; priority?: string; due_at?: string
} = {}) {
  return db.prepare(`
    INSERT INTO tasks (user_id, title, description, priority, due_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, title, opts.description ?? null, opts.priority ?? 'medium', opts.due_at ?? null);
}

export function listTasks(userId: number, includeCompleted = false) {
  const q = includeCompleted
    ? 'SELECT * FROM tasks WHERE user_id = ? ORDER BY completed ASC, due_at ASC, created_at DESC'
    : 'SELECT * FROM tasks WHERE user_id = ? AND completed = 0 ORDER BY due_at ASC, created_at DESC';
  return db.prepare(q).all(userId) as any[];
}

export function completeTask(userId: number, taskId: number) {
  return db.prepare(`
    UPDATE tasks SET completed = 1, completed_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(taskId, userId);
}

export function deleteTask(userId: number, taskId: number) {
  return db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, userId);
}

export function findTaskByTitle(userId: number, search: string) {
  return db.prepare(`
    SELECT * FROM tasks WHERE user_id = ? AND completed = 0
    AND lower(title) LIKE lower(?) ORDER BY created_at DESC LIMIT 5
  `).all(userId, `%${search}%`) as any[];
}

// ── Reminders ─────────────────────────────────────────────────────────────────
export function addReminder(userId: number, message: string, opts: {
  type: 'once' | 'recurring'; once_at?: string; cron_expr?: string
}) {
  return db.prepare(`
    INSERT INTO reminders (user_id, message, type, once_at, cron_expr)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, message, opts.type, opts.once_at ?? null, opts.cron_expr ?? null);
}

export function listReminders(userId: number) {
  return db.prepare('SELECT * FROM reminders WHERE user_id = ? AND active = 1 ORDER BY created_at DESC').all(userId) as any[];
}

export function cancelReminder(userId: number, reminderId: number) {
  return db.prepare('UPDATE reminders SET active = 0 WHERE id = ? AND user_id = ?').run(reminderId, userId);
}

export function getAllActiveReminders() {
  return db.prepare('SELECT * FROM reminders WHERE active = 1').all() as any[];
}

export function markReminderFired(id: number) {
  db.prepare("UPDATE reminders SET last_fired = datetime('now') WHERE id = ?").run(id);
}

export function deactivateReminder(id: number) {
  db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(id);
}

// ── Notes ─────────────────────────────────────────────────────────────────────
export function saveNote(userId: number, content: string, tags: string[] = []) {
  return db.prepare('INSERT INTO notes (user_id, content, tags) VALUES (?, ?, ?)').run(userId, content, JSON.stringify(tags));
}

export function searchNotes(userId: number, query: string) {
  return db.prepare(`
    SELECT * FROM notes WHERE user_id = ? AND lower(content) LIKE lower(?)
    ORDER BY created_at DESC LIMIT 10
  `).all(userId, `%${query}%`) as any[];
}

export function listNotes(userId: number, limit = 10) {
  return db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as any[];
}

// ── Invoices ──────────────────────────────────────────────────────────────────
export function saveInvoice(userId: number, data: {
  invoice_no: string; client_name: string; client_email?: string;
  items: any[]; currency: string; tax_pct: number; due_days: number; pdf_path?: string;
}) {
  return db.prepare(`
    INSERT INTO invoices (user_id, invoice_no, client_name, client_email, items, currency, tax_pct, due_days, pdf_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, data.invoice_no, data.client_name, data.client_email ?? null,
    JSON.stringify(data.items), data.currency, data.tax_pct, data.due_days, data.pdf_path ?? null);
}

export function listInvoices(userId: number) {
  return db.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(userId) as any[];
}

export function getInvoiceCountThisMonth(userId: number) {
  return (db.prepare(`
    SELECT COUNT(*) as cnt FROM invoices WHERE user_id = ?
    AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(userId) as any).cnt;
}

// ── Flight Watches ────────────────────────────────────────────────────────────
export function addFlightWatch(userId: number, data: {
  origin: string; destination: string; max_price: number; currency: string; travel_date?: string;
}) {
  return db.prepare(`
    INSERT INTO flight_watches (user_id, origin, destination, max_price, currency, travel_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, data.origin, data.destination, data.max_price, data.currency, data.travel_date ?? null);
}

export function listFlightWatches(userId: number) {
  return db.prepare('SELECT * FROM flight_watches WHERE user_id = ? AND active = 1').all(userId) as any[];
}

export function getAllActiveFlightWatches() {
  return db.prepare('SELECT * FROM flight_watches WHERE active = 1').all() as any[];
}

export function updateFlightWatch(id: number, last_price: number) {
  db.prepare("UPDATE flight_watches SET last_price = ?, last_checked = datetime('now') WHERE id = ?").run(last_price, id);
}

// ── Diet Plans ────────────────────────────────────────────────────────────────
export function saveDietPlan(userId: number, content: string) {
  db.prepare('UPDATE diet_plans SET active = 0 WHERE user_id = ?').run(userId);
  return db.prepare('INSERT INTO diet_plans (user_id, content) VALUES (?, ?)').run(userId, content);
}

export function getActiveDietPlan(userId: number) {
  return db.prepare('SELECT * FROM diet_plans WHERE user_id = ? AND active = 1').get(userId) as any;
}

// ── Conversation History ──────────────────────────────────────────────────────
export function appendHistory(userId: number, role: 'user' | 'assistant', content: string) {
  db.prepare('INSERT INTO conversation_history (user_id, role, content) VALUES (?, ?, ?)').run(userId, role, content);
  // Keep last 20 messages per user
  db.prepare(`
    DELETE FROM conversation_history WHERE user_id = ? AND id NOT IN (
      SELECT id FROM conversation_history WHERE user_id = ? ORDER BY id DESC LIMIT 20
    )
  `).run(userId, userId);
}

export function getHistory(userId: number) {
  return db.prepare('SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY id ASC').all(userId) as { role: string; content: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function ensurePdfDir() {
  const dir = process.env.PDF_OUTPUT_DIR ?? './pdfs';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
