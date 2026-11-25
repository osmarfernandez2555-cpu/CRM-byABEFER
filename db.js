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
CREATE INDEX IF NOT EXISTS idx_chat_ts ON chats(session_id, last_ts);
`);

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
  listChats: db.prepare(`SELECT c.*, s.name AS session_name FROM chats c JOIN sessions s ON s.id = c.session_id
    WHERE (@session_id IS NULL OR c.session_id = @session_id) AND c.last_ts > 0
    ORDER BY c.last_ts DESC LIMIT @limit`),

  insertMsg: db.prepare(`INSERT INTO messages (session_id, id, jid, from_me, sender_name, ts, type, text, media_file, media_mime, file_name, seconds, ptt, status, raw)
    VALUES (@session_id, @id, @jid, @from_me, @sender_name, @ts, @type, @text, @media_file, @media_mime, @file_name, @seconds, @ptt, @status, @raw)
    ON CONFLICT(session_id, id) DO NOTHING`),
  getMsg: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id = ?'),
  setMsgMedia: db.prepare('UPDATE messages SET media_file = ?, media_mime = ? WHERE session_id = ? AND id = ?'),
  setMsgStatus: db.prepare('UPDATE messages SET status = MAX(status, ?) WHERE session_id = ? AND id = ?'),
  listMsgs: db.prepare(`SELECT session_id, id, jid, from_me, sender_name, ts, type, text, media_file, media_mime, file_name, seconds, ptt, status
    FROM messages WHERE session_id = ? AND jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?`),
};

export default db;
