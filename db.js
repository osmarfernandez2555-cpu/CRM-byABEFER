// Base de datos SQLite (un solo archivo en DATA_DIR). Guarda celulares, chats y mensajes.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'auth'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'crm.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  session_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (session_id, jid)
);
CREATE TABLE IF NOT EXISTS chats (
  session_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  name TEXT,
  is_group INTEGER DEFAULT 0,
  last_ts INTEGER DEFAULT 0,
  last_preview TEXT,
  last_from_me INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, jid)
);
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  jid TEXT NOT NULL,
  from_me INTEGER DEFAULT 0,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT,
  text TEXT,
  media_file TEXT,
  media_mime TEXT,
  file_name TEXT,
  seconds INTEGER,
  ptt INTEGER DEFAULT 0,
  status INTEGER DEFAULT 0,
  raw TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(session_id, jid, ts);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS chat_bot (
  session_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  paused_until INTEGER DEFAULT 0,
  needs_human INTEGER DEFAULT 0,
  reason TEXT,
  PRIMARY KEY (session_id, jid)
);
CREATE TABLE IF NOT EXISTS citas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, jid TEXT, nombre TEXT, telefono TEXT,
  fecha TEXT, hora TEXT, motivo TEXT, vehiculo TEXT, notas TEXT,
  estado TEXT DEFAULT 'pendiente',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS leads (
  session_id TEXT NOT NULL, jid TEXT NOT NULL,
  nombre TEXT, interes TEXT, vehiculo_interes TEXT, presupuesto TEXT,
  usado_entrega TEXT, financiacion TEXT, notas TEXT, updated_at INTEGER,
  PRIMARY KEY (session_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_chat_ts ON chats(session_id, last_ts);
`);

// Migraciones simples para bases creadas con la versión anterior
try { db.exec('ALTER TABLE messages ADD COLUMN by_bot INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE citas ADD COLUMN recordatorio INTEGER DEFAULT 0'); } catch {} // 0 pendiente, 1 enviado, -1 no corresponde

export const q = {
  listSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (id, name, created_at) VALUES (?, ?, ?)'),
  setSessionPhone: db.prepare('UPDATE sessions SET phone = ? WHERE id = ?'),
  renameSession: db.prepare('UPDATE sessions SET name = ? WHERE id = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  delSessionChats: db.prepare('DELETE FROM chats WHERE session_id = ?'),
  delSessionMsgs: db.prepare('DELETE FROM messages WHERE session_id = ?'),
  delSessionContacts: db.prepare('DELETE FROM contacts WHERE session_id = ?'),

  upsertContact: db.prepare(`INSERT INTO contacts (session_id, jid, name) VALUES (@session_id, @jid, @name)
    ON CONFLICT(session_id, jid) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`),
  getContact: db.prepare('SELECT name FROM contacts WHERE session_id = ? AND jid = ?'),

  getChat: db.prepare('SELECT * FROM chats WHERE session_id = ? AND jid = ?'),
  upsertChat: db.prepare(`INSERT INTO chats (session_id, jid, name, is_group, last_ts, last_preview, last_from_me, unread)
    VALUES (@session_id, @jid, @name, @is_group, @last_ts, @last_preview, @last_from_me, @unread)
    ON CONFLICT(session_id, jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      is_group = excluded.is_group,
      last_ts = CASE WHEN excluded.last_ts >= chats.last_ts THEN excluded.last_ts ELSE chats.last_ts END,
      last_preview = CASE WHEN excluded.last_ts >= chats.last_ts THEN excluded.last_preview ELSE chats.last_preview END,
      last_from_me = CASE WHEN excluded.last_ts >= chats.last_ts THEN excluded.last_from_me ELSE chats.last_from_me END,
      unread = chats.unread + excluded.unread`),
  setChatName: db.prepare('UPDATE chats SET name = ? WHERE session_id = ? AND jid = ?'),
  resetUnread: db.prepare('UPDATE chats SET unread = 0 WHERE session_id = ? AND jid = ?'),
  listChats: db.prepare(`SELECT c.*, s.name AS session_name, b.paused_until, b.needs_human FROM chats c
    JOIN sessions s ON s.id = c.session_id
    LEFT JOIN chat_bot b ON b.session_id = c.session_id AND b.jid = c.jid
    WHERE (@session_id IS NULL OR c.session_id = @session_id) AND c.last_ts > 0
    ORDER BY c.last_ts DESC LIMIT @limit`),

  insertMsg: db.prepare(`INSERT INTO messages (session_id, id, jid, from_me, sender_name, ts, type, text, media_file, media_mime, file_name, seconds, ptt, status, raw, by_bot)
    VALUES (@session_id, @id, @jid, @from_me, @sender_name, @ts, @type, @text, @media_file, @media_mime, @file_name, @seconds, @ptt, @status, @raw, @by_bot)
    ON CONFLICT(session_id, id) DO NOTHING`),
  getMsg: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id = ?'),
  setMsgMedia: db.prepare('UPDATE messages SET media_file = ?, media_mime = ? WHERE session_id = ? AND id = ?'),
  setMsgStatus: db.prepare('UPDATE messages SET status = MAX(status, ?) WHERE session_id = ? AND id = ?'),
  setMsgText: db.prepare('UPDATE messages SET text = ? WHERE session_id = ? AND id = ?'),
  listMsgs: db.prepare(`SELECT session_id, id, jid, from_me, sender_name, ts, type, text, media_file, media_mime, file_name, seconds, ptt, status, by_bot
    FROM messages WHERE session_id = ? AND jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?`),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  getBot: db.prepare('SELECT * FROM chat_bot WHERE session_id = ? AND jid = ?'),
  setBot: db.prepare(`INSERT INTO chat_bot (session_id, jid, paused_until, needs_human, reason) VALUES (@session_id, @jid, @paused_until, @needs_human, @reason)
    ON CONFLICT(session_id, jid) DO UPDATE SET paused_until = excluded.paused_until, needs_human = excluded.needs_human, reason = excluded.reason`),

  addCita: db.prepare(`INSERT INTO citas (session_id, jid, nombre, telefono, fecha, hora, motivo, vehiculo, notas, estado, created_at)
    VALUES (@session_id, @jid, @nombre, @telefono, @fecha, @hora, @motivo, @vehiculo, @notas, 'pendiente', @created_at)`),
  getCita: db.prepare('SELECT * FROM citas WHERE id = ?'),
  listCitas: db.prepare(`SELECT c.*, s.name AS session_name FROM citas c LEFT JOIN sessions s ON s.id = c.session_id
    ORDER BY c.fecha DESC, c.hora DESC LIMIT 500`),
  citasDeChat: db.prepare(`SELECT * FROM citas WHERE session_id = ? AND jid = ? AND estado IN ('pendiente','confirmada') ORDER BY fecha, hora`),
  citasDelSlot: db.prepare(`SELECT COUNT(*) AS n FROM citas WHERE fecha = ? AND hora = ? AND estado IN ('pendiente','confirmada')`),
  setCitaEstado: db.prepare('UPDATE citas SET estado = ? WHERE id = ?'),
  citasParaRecordar: db.prepare(`SELECT * FROM citas WHERE estado IN ('pendiente','confirmada') AND COALESCE(recordatorio,0) = 0 AND fecha BETWEEN ? AND ?`),
  setRecordatorio: db.prepare('UPDATE citas SET recordatorio = ? WHERE id = ?'),
  cancelCitasChat: db.prepare(`UPDATE citas SET estado = 'cancelada' WHERE session_id = ? AND jid = ? AND estado IN ('pendiente','confirmada')`),

  getLead: db.prepare('SELECT * FROM leads WHERE session_id = ? AND jid = ?'),
  upsertLead: db.prepare(`INSERT INTO leads (session_id, jid, nombre, interes, vehiculo_interes, presupuesto, usado_entrega, financiacion, notas, updated_at)
    VALUES (@session_id, @jid, @nombre, @interes, @vehiculo_interes, @presupuesto, @usado_entrega, @financiacion, @notas, @updated_at)
    ON CONFLICT(session_id, jid) DO UPDATE SET
      nombre = COALESCE(excluded.nombre, leads.nombre), interes = COALESCE(excluded.interes, leads.interes),
      vehiculo_interes = COALESCE(excluded.vehiculo_interes, leads.vehiculo_interes), presupuesto = COALESCE(excluded.presupuesto, leads.presupuesto),
      usado_entrega = COALESCE(excluded.usado_entrega, leads.usado_entrega), financiacion = COALESCE(excluded.financiacion, leads.financiacion),
      notas = COALESCE(excluded.notas, leads.notas), updated_at = excluded.updated_at`),
  listLeads: db.prepare(`SELECT l.*, s.name AS session_name FROM leads l LEFT JOIN sessions s ON s.id = l.session_id ORDER BY l.updated_at DESC LIMIT 500`),
};

export default db;
