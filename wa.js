// Gestor de celulares conectados a WhatsApp (Baileys, multi-dispositivo: el celular queda como "dispositivo vinculado").
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage,
  getContentType, normalizeMessageContent, BufferJSON, jidNormalizedUser, Browsers, generateMessageIDV2,
} from 'baileys';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import { q, DATA_DIR } from './db.js';
import { toVoiceNote, toMp3, durationOf } from './media.js';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const MAX_EAGER_BYTES = 16 * 1024 * 1024; // descarga automática de media hasta 16 MB

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf',
};
const extFor = (mime, fileName) => {
  if (fileName && path.extname(fileName)) return path.extname(fileName).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const base = (mime || '').split(';')[0].trim();
  return EXT[base] || base.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
};

const toNum = (t) => {
  if (t == null) return Math.floor(Date.now() / 1000);
  if (typeof t === 'object') return t.toNumber ? t.toNumber() : Number(t.low || 0);
  return Number(t);
};

const PREVIEW = {
  image: '📷 Foto', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Documento',
  sticker: '💟 Sticker', location: '📍 Ubicación', contact: '👤 Contacto', other: 'Mensaje',
};

function parseContent(message) {
  const content = normalizeMessageContent(message);
  const kind = getContentType(content);
  if (!content || !kind) return null;
  const m = content[kind];
  switch (kind) {
    case 'conversation': return { type: 'text', text: m };
    case 'extendedTextMessage': return { type: 'text', text: m.text };
    case 'imageMessage': return { type: 'image', text: m.caption, mime: m.mimetype, size: toNum(m.fileLength) };
    case 'videoMessage': return { type: 'video', text: m.caption, mime: m.mimetype, seconds: m.seconds, size: toNum(m.fileLength) };
    case 'audioMessage': return { type: 'audio', mime: m.mimetype, seconds: m.seconds, ptt: m.ptt ? 1 : 0, size: toNum(m.fileLength) };
    case 'documentMessage': return { type: 'document', text: m.caption, mime: m.mimetype, fileName: m.fileName || m.title, size: toNum(m.fileLength) };
    case 'stickerMessage': return { type: 'sticker', mime: m.mimetype || 'image/webp', size: toNum(m.fileLength) };
    case 'locationMessage':
    case 'liveLocationMessage':
      return { type: 'location', text: `https://maps.google.com/?q=${m.degreesLatitude},${m.degreesLongitude}${m.name ? ' — ' + m.name : ''}` };
    case 'contactMessage': return { type: 'contact', text: m.displayName };
    case 'contactsArrayMessage': return { type: 'contact', text: (m.contacts || []).map(c => c.displayName).join(', ') };
    case 'pollCreationMessage':
    case 'pollCreationMessageV3': return { type: 'text', text: '📊 Encuesta: ' + (m.name || '') };
    case 'buttonsResponseMessage': return { type: 'text', text: m.selectedDisplayText };
    case 'listResponseMessage': return { type: 'text', text: m.title };
    case 'templateButtonReplyMessage': return { type: 'text', text: m.selectedDisplayText };
    // Cosas internas que no son mensajes para mostrar
    case 'protocolMessage': case 'reactionMessage': case 'senderKeyDistributionMessage':
    case 'messageContextInfo': case 'pollUpdateMessage': case 'keepInChatMessage': case 'encReactionMessage':
      return null;
    default: return { type: 'other', text: '[' + kind.replace('Message', '') + ']' };
  }
}

class WAManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();   // id -> { sock, status, qr, pairingCode, qrCount, stopping }
    this.groupNames = new Map(); // `${sid}|${jid}` -> asunto del grupo
    this.downloads = new Map();  // descargas de media en curso
    this.skipDownload = new Set();
    this.botIds = new Set();     // ids de mensajes que mandó ARA
  }

  state(id) {
    const s = this.sessions.get(id);
    const row = q.getSession.get(id);
    return {
      id, name: row?.name, phone: row?.phone,
      status: s?.status || 'idle', qr: s?.qr || null, pairingCode: s?.pairingCode || null,
    };
  }
  list() { return q.listSessions.all().map(r => this.state(r.id)); }
  emitState(id) { this.emit('session', this.state(id)); }

  async startAll() {
    for (const r of q.listSessions.all()) {
      // Solo reconecta automáticamente los que ya estaban vinculados
      if (fs.existsSync(path.join(DATA_DIR, 'auth', r.id, 'creds.json'))) this.start(r.id).catch(e => logger.error(e));
    }
  }

  add(name) {
    const id = 's' + randomBytes(4).toString('hex');
    q.addSession.run(id, name || 'Celular', Date.now());
    return id;
  }

  async start(id, { pairPhone } = {}) {
    const old = this.sessions.get(id);
    if (old?.sock && ['connecting', 'qr', 'open'].includes(old.status)) {
      if (!pairPhone) return;
      old.stopping = true; try { old.sock.end(undefined); } catch {}
    }
    const authDir = path.join(DATA_DIR, 'auth', id);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch {}

    const sock = makeWASocket({
      version, auth: state, logger,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,   // así el celular sigue recibiendo notificaciones
      syncFullHistory: false,
      getMessage: async (key) => {
        const row = q.getMsg.get(id, key.id);
        if (!row?.raw) return undefined;
        try { return JSON.parse(row.raw, BufferJSON.reviver).message || undefined; } catch { return undefined; }
      },
    });

    const s = { sock, status: 'connecting', qr: null, pairingCode: null, qrCount: 0, stopping: false, pairPhone };
    this.sessions.set(id, s);
    this.emitState(id);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (s.stopping) return;
      if (u.qr) {
        s.qrCount++;
        if (s.qrCount > 6 && !state.creds.registered) {
          // Nadie escaneó: frenamos para no quedar en loop. Se reintenta desde el panel.
          s.stopping = true; s.status = 'idle'; s.qr = null; s.pairingCode = null;
          try { sock.end(undefined); } catch {}
          return this.emitState(id);
        }
        s.status = 'qr';
        s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 });
        if (s.pairPhone && !s.pairingCode) {
          try { s.pairingCode = await sock.requestPairingCode(s.pairPhone.replace(/\D/g, '')); }
          catch (e) { logger.warn(e, 'pairing code'); }
        }
        this.emitState(id);
      }
      if (u.connection === 'open') {
        s.status = 'open'; s.qr = null; s.pairingCode = null; s.qrCount = 0; s.pairPhone = null;
        const phone = sock.user?.id ? jidNormalizedUser(sock.user.id).split('@')[0] : null;
        if (phone) q.setSessionPhone.run(phone, id);
        this.emitState(id);
        this.loadGroups(id, sock).catch(() => {});
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        s.qr = null; s.pairingCode = null;
        if (code === DisconnectReason.loggedOut) {
          s.status = 'logged_out';
          fs.rmSync(authDir, { recursive: true, force: true });
          this.emitState(id);
        } else {
          s.status = 'connecting';
          this.emitState(id);
          const delay = code === DisconnectReason.restartRequired ? 500 : 3000;
          setTimeout(() => { if (this.sessions.get(id) === s && !s.stopping) { s.status = 'reconnecting'; this.start(id).catch(e => logger.error(e)); } }, delay);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try { await this.saveMessage(id, sock, m, { live: true, notify: type === 'notify' }); }
        catch (e) { logger.error(e, 'saveMessage'); }
      }
    });

    sock.ev.on('messaging-history.set', async ({ contacts, messages, chats }) => {
      for (const c of contacts || []) this.saveContact(id, c);
      for (const m of messages || []) {
        try { await this.saveMessage(id, sock, m, { live: false }); } catch {}
      }
      for (const c of chats || []) {
        if (!c.unreadCount) continue;
        const jid = await this.resolveJid(sock, c.id);
        q.upsertChat.run({ session_id: id, jid, name: null, is_group: jid.endsWith('@g.us') ? 1 : 0, last_ts: 0, last_preview: null, last_from_me: 0, unread: 0 });
        const ch = q.getChat.get(id, jid);
        if (ch && ch.unread === 0) q.upsertChat.run({ ...ch, unread: c.unreadCount, last_ts: 0 });
      }
      this.emit('refresh', { sessionId: id });
    });

    sock.ev.on('contacts.upsert', (cs) => cs.forEach(c => this.saveContact(id, c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach(c => this.saveContact(id, c)));

    sock.ev.on('messages.update', (ups) => {
      for (const { key, update } of ups) {
        if (update?.status != null) {
          q.setMsgStatus.run(update.status, id, key.id);
          this.emit('status', { sessionId: id, id: key.id, status: update.status });
        }
      }
    });

    sock.ev.on('groups.update', (gs) => {
      for (const g of gs) if (g.id && g.subject) {
        this.groupNames.set(`${id}|${g.id}`, g.subject);
        q.setChatName.run(g.subject, id, g.id);
      }
    });
  }

  async loadGroups(id, sock) {
    const groups = await sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) {
      this.groupNames.set(`${id}|${g.id}`, g.subject);
      q.setChatName.run(g.subject, id, g.id);
    }
    this.emit('refresh', { sessionId: id });
  }

  saveContact(sid, c) {
    let jid = c.id;
    if (jid?.endsWith('@lid') && c.phoneNumber) jid = c.phoneNumber;
    if (!jid || jid.endsWith('@g.us')) return;
    jid = jidNormalizedUser(jid);
    const name = c.name || c.verifiedName || c.notify || null;
    if (!name) return;
    q.upsertContact.run({ session_id: sid, jid, name });
    if (c.name) q.setChatName.run(c.name, sid, jid); // nombre agendado en el celu gana
  }

  // Los chats se guardan por número (@s.whatsapp.net). Si WhatsApp manda un @lid, lo traducimos.
  async resolveJid(sock, jid, alt) {
    if (jid?.endsWith('@lid')) {
      if (alt?.endsWith('@s.whatsapp.net')) return jidNormalizedUser(alt);
      try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
        if (pn) return jidNormalizedUser(pn);
      } catch {}
    }
    return jidNormalizedUser(jid);
  }

  async saveMessage(sid, sock, m, { live, notify }) {
    const key = m.key || {};
    const rawJid = key.remoteJid;
    if (!rawJid || !m.message) return;
    if (rawJid === 'status@broadcast' || rawJid.endsWith('@newsletter') || rawJid.endsWith('@broadcast')) return;
    const c = parseContent(m.message);
    if (!c) return;

    const jid = await this.resolveJid(sock, rawJid, key.remoteJidAlt);
    const isGroup = jid.endsWith('@g.us');
    const fromMe = key.fromMe ? 1 : 0;
    const ts = toNum(m.messageTimestamp);

    let senderName = null;
    if (isGroup && !fromMe) {
      const pj = await this.resolveJid(sock, key.participant, key.participantAlt);
      senderName = m.pushName || q.getContact.get(sid, pj)?.name || pj?.split('@')[0];
    }
    if (!isGroup && !fromMe && m.pushName) q.upsertContact.run({ session_id: sid, jid, name: m.pushName });

    const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(c.type);
    const row = {
      session_id: sid, id: key.id, jid, from_me: fromMe, sender_name: senderName, ts,
      type: c.type, text: c.text || null, media_file: null, media_mime: c.mime || null,
      file_name: c.fileName || null, seconds: c.seconds || null, ptt: c.ptt || 0,
      status: toNum(m.status ?? 0) || 0,
      raw: JSON.stringify({ key: m.key, message: m.message, messageTimestamp: ts }, BufferJSON.replacer),
      by_bot: this.botIds.has(key.id) ? 1 : 0,
    };
    const inserted = q.insertMsg.run(row).changes > 0;

    const chatName = isGroup ? this.groupNames.get(`${sid}|${jid}`) || null
      : q.getContact.get(sid, jid)?.name || null;
    const preview = (c.type === 'text' || c.type === 'location' ? '' : PREVIEW[c.type] + (c.text ? ' ' : '')) + (c.text && c.type !== 'location' ? c.text : '');
    if (inserted) {
      q.upsertChat.run({
        session_id: sid, jid, name: chatName, is_group: isGroup ? 1 : 0, last_ts: ts,
        last_preview: (preview || PREVIEW[c.type]).slice(0, 120), last_from_me: fromMe,
        unread: live && notify && !fromMe ? 1 : 0,
      });
    }
    if (!inserted || !live) return;

    const { raw, ...pub } = row;
    this.emit('message', { message: pub, chat: { ...q.getChat.get(sid, jid), session_name: q.getSession.get(sid)?.name } });

    if (isMedia && !this.skipDownload.has(key.id) && (!c.size || c.size <= MAX_EAGER_BYTES) && c.type !== 'video') {
      this.downloadMedia(sid, key.id).catch(e => logger.warn(e?.message, 'media'));
    }
  }

  // Descarga (si hace falta) y devuelve la fila del mensaje con media_file
  downloadMedia(sid, msgId) {
    const k = sid + '|' + msgId;
    if (this.downloads.has(k)) return this.downloads.get(k);
    const p = (async () => {
      const row = q.getMsg.get(sid, msgId);
      if (!row) throw new Error('Mensaje no encontrado');
      if (row.media_file && fs.existsSync(path.join(DATA_DIR, 'media', row.media_file))) return row;
      const msg = JSON.parse(row.raw, BufferJSON.reviver);
      const sock = this.sessions.get(sid)?.sock;
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage });
      return this.storeMedia(sid, row, buf);
    })().finally(() => this.downloads.delete(k));
    this.downloads.set(k, p);
    return p;
  }

  async storeMedia(sid, row, buf) {
    let out = buf, mime = (row.media_mime || 'application/octet-stream').split(';')[0];
    if (row.type === 'audio') {
      try { out = await toMp3(buf); mime = 'audio/mpeg'; } catch (e) { logger.warn(e.message); }
    }
    const dir = path.join(DATA_DIR, 'media', sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${sid}/${row.id.replace(/[^A-Za-z0-9_-]/g, '')}.${mime === 'audio/mpeg' ? 'mp3' : extFor(mime, row.file_name)}`;
    fs.writeFileSync(path.join(DATA_DIR, 'media', file), out);
    q.setMsgMedia.run(file, mime, sid, row.id);
    this.emit('media', { sessionId: sid, id: row.id, media_file: file, media_mime: mime });
    return { ...row, media_file: file, media_mime: mime };
  }

  sockOf(sid) {
    const s = this.sessions.get(sid);
    if (!s?.sock || s.status !== 'open') throw new Error('Ese celular no está conectado');
    return s.sock;
  }

  async afterSend(sid, sock, sent, buf) {
    await this.saveMessage(sid, sock, sent, { live: true, notify: false });
    if (buf) {
      const row = q.getMsg.get(sid, sent.key.id);
      if (row) await this.storeMedia(sid, row, buf);
    }
    this.skipDownload.delete(sent.key.id);
    return q.getMsg.get(sid, sent.key.id);
  }

  async sendText(sid, jid, text, { byBot } = {}) {
    const sock = this.sockOf(sid);
    const messageId = generateMessageIDV2(sock.user?.id);
    if (byBot) { this.botIds.add(messageId); setTimeout(() => this.botIds.delete(messageId), 10 * 60 * 1000); }
    const sent = await sock.sendMessage(jid, { text }, { messageId });
    return this.afterSend(sid, sock, sent);
  }

  // "Escribiendo..." en el celular del cliente
  async typing(sid, jid, on, mode = 'composing') {
    const s = this.sessions.get(sid);
    if (s?.status !== 'open') return;
    try { await s.sock.sendPresenceUpdate(on ? mode : 'paused', jid); } catch {}
  }

  setText(sid, id, text) {
    q.setMsgText.run(text, sid, id);
    this.emit('msgupdate', { sessionId: sid, id, text });
  }

  async sendVoice(sid, jid, recorded, { byBot } = {}) {
    const sock = this.sockOf(sid);
    const ogg = await toVoiceNote(recorded);
    const seconds = await durationOf(ogg);
    const messageId = generateMessageIDV2(sock.user?.id);
    this.skipDownload.add(messageId);
    if (byBot) { this.botIds.add(messageId); setTimeout(() => this.botIds.delete(messageId), 10 * 60 * 1000); }
    const sent = await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds }, { messageId });
    return this.afterSend(sid, sock, sent, ogg);
  }

  async sendFile(sid, jid, buf, mimetype, fileName, caption, { byBot } = {}) {
    const sock = this.sockOf(sid);
    let content;
    if (/^image\/(jpeg|png|webp)/.test(mimetype)) content = { image: buf, caption, mimetype };
    else if (mimetype === 'video/mp4') content = { video: buf, caption, mimetype };
    else if (mimetype.startsWith('audio/')) content = { audio: buf, mimetype };
    else content = { document: buf, mimetype, fileName, caption };
    const messageId = generateMessageIDV2(sock.user?.id);
    this.skipDownload.add(messageId);
    if (byBot) { this.botIds.add(messageId); setTimeout(() => this.botIds.delete(messageId), 10 * 60 * 1000); }
    const sent = await sock.sendMessage(jid, content, { messageId });
    return this.afterSend(sid, sock, sent, buf);
  }

  async markRead(sid, jid) {
    const chat = q.getChat.get(sid, jid);
    q.resetUnread.run(sid, jid);
    const s = this.sessions.get(sid);
    if (!chat?.unread || s?.status !== 'open') return;
    const rows = q.listMsgs.all(sid, jid, Number.MAX_SAFE_INTEGER, Math.min(chat.unread, 50)).filter(r => !r.from_me);
    const keys = rows.map(r => {
      try { return JSON.parse(q.getMsg.get(sid, r.id).raw, BufferJSON.reviver).key; } catch { return null; }
    }).filter(Boolean);
    if (keys.length) await s.sock.readMessages(keys).catch(() => {});
  }

  async checkNumber(sid, phone) {
    const sock = this.sockOf(sid);
    const [r] = await sock.onWhatsApp(phone.replace(/\D/g, ''));
    if (!r?.exists) throw new Error('Ese número no tiene WhatsApp');
    return jidNormalizedUser(r.jid);
  }

  async logout(id) {
    const s = this.sessions.get(id);
    if (s?.sock) {
      s.stopping = true;
      try { await s.sock.logout(); } catch {}
      try { s.sock.end(undefined); } catch {}
    }
    fs.rmSync(path.join(DATA_DIR, 'auth', id), { recursive: true, force: true });
    this.sessions.set(id, { status: 'logged_out' });
    this.emitState(id);
  }

  async remove(id) {
    await this.logout(id);
    this.sessions.delete(id);
    q.delSessionMsgs.run(id); q.delSessionChats.run(id); q.delSessionContacts.run(id); q.delSession.run(id);
    fs.rmSync(path.join(DATA_DIR, 'media', id), { recursive: true, force: true });
    this.emit('removed', { id });
  }
}

export default new WAManager();
