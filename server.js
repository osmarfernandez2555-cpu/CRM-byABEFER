// CRM WhatsApp — servidor web + API + tiempo real
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { q, DATA_DIR } from './db.js';
import wa from './wa.js';
import ara, { getSettings, saveSettings, DEFAULT_INSTRUCTIONS, DEFAULT_KNOWLEDGE, DEFAULT_SKILLS, startStockSync } from './ara.js';
import * as stock from './stock.js';
import * as credito from './credito.js';
import * as market from './market.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PANEL_PASSWORD || 'cambiar123';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('crm-wa|' + PASSWORD).digest('hex');
const TOKEN = crypto.createHmac('sha256', SECRET).update('panel-ok').digest('hex');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const authed = (req) => req.cookies?.crm_token === TOKEN;
const guard = (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'No autorizado' });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  res.status(400).json({ error: e.message || 'Error' });
});

// ---------- Login ----------
app.post('/api/login', (req, res) => {
  if (req.body?.password !== PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.cookie('crm_token', TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, secure: req.secure || req.headers['x-forwarded-proto'] === 'https' });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('crm_token'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ ok: authed(req) }));

// ---------- Celulares ----------
app.get('/api/sessions', guard, (req, res) => res.json(wa.list()));
app.post('/api/sessions', guard, wrap(async (req, res) => {
  const id = wa.add((req.body?.name || '').trim() || 'Celular');
  await wa.start(id, { pairPhone: req.body?.pairPhone || undefined });
  res.json(wa.state(id));
}));
app.post('/api/sessions/:id/connect', guard, wrap(async (req, res) => {
  if (!q.getSession.get(req.params.id)) throw new Error('No existe');
  await wa.start(req.params.id, { pairPhone: req.body?.pairPhone || undefined });
  res.json(wa.state(req.params.id));
}));
app.patch('/api/sessions/:id', guard, wrap(async (req, res) => {
  q.renameSession.run((req.body?.name || '').trim() || 'Celular', req.params.id);
  wa.emitState(req.params.id);
  res.json(wa.state(req.params.id));
}));
app.post('/api/sessions/:id/logout', guard, wrap(async (req, res) => { await wa.logout(req.params.id); res.json({ ok: true }); }));
app.delete('/api/sessions/:id', guard, wrap(async (req, res) => { await wa.remove(req.params.id); res.json({ ok: true }); }));

// ---------- Chats y mensajes ----------
app.get('/api/chats', guard, (req, res) => {
  res.json(q.listChats.all({ session_id: req.query.session || null, limit: Math.min(+req.query.limit || 300, 2000) }));
});
app.get('/api/messages', guard, (req, res) => {
  const { session, jid } = req.query;
  const before = +req.query.before || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(+req.query.limit || 60, 300);
  res.json(q.listMsgs.all(session, jid, before, limit).reverse());
});
app.post('/api/read', guard, wrap(async (req, res) => {
  await wa.markRead(req.body.session, req.body.jid);
  res.json({ ok: true });
}));
app.post('/api/new-chat', guard, wrap(async (req, res) => {
  const jid = await wa.checkNumber(req.body.session, req.body.phone || '');
  res.json({ jid });
}));

// ---------- Enviar ----------
app.post('/api/send/text', guard, wrap(async (req, res) => {
  const { session, jid, text } = req.body;
  if (!text?.trim()) throw new Error('Mensaje vacío');
  res.json(await wa.sendText(session, jid, text));
}));
app.post('/api/send/voice', guard, upload.single('audio'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Falta el audio');
  res.json(await wa.sendVoice(req.body.session, req.body.jid, req.file.buffer));
}));
app.post('/api/send/file', guard, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Falta el archivo');
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json(await wa.sendFile(req.body.session, req.body.jid, req.file.buffer, req.file.mimetype || 'application/octet-stream', name, req.body.caption || undefined));
}));

// ---------- Media (descarga a demanda + soporte de adelantar/atrasar el audio) ----------
app.get('/media/:sid/:id', guard, wrap(async (req, res) => {
  const row = await wa.downloadMedia(req.params.sid, req.params.id);
  res.type(row.media_mime || 'application/octet-stream');
  if (req.query.dl) res.attachment(row.file_name || path.basename(row.media_file));
  res.sendFile(path.join(DATA_DIR, 'media', row.media_file), { maxAge: '7d' });
}));

// ---------- ARA (bot de IA) ----------
app.get('/api/ara/settings', guard, (req, res) => res.json({
  ...getSettings(),
  status: { marketKey: !!String(process.env.MARKET_KEY || '').trim(), ruthinaKey: !!credito.ruthinaConfig(getSettings()).key, anthropic: !!process.env.ANTHROPIC_API_KEY, gemini: !!ara.geminiKey(), audio: ara.audioProvider()?.name || null, openai: !!ara.audioProvider(), audioError: ara.lastAudioError || null },
  defaults: { instructions: DEFAULT_INSTRUCTIONS, knowledge: DEFAULT_KNOWLEDGE, skills: DEFAULT_SKILLS },
}));
app.put('/api/ara/settings', guard, wrap(async (req, res) => {
  const st = saveSettings(req.body || {});
  io.emit('arasettings', { enabled: st.enabled });
  res.json(st);
}));
app.post('/api/ara/test', guard, wrap(async (req, res) => res.json(await ara.simulate(req.body?.conversation, { voz: !!req.body?.voz }))));
app.post('/api/ara/chat', guard, wrap(async (req, res) => res.json(ara.setChat(req.body.session, req.body.jid, req.body.action))));
app.get('/api/ara/chat', guard, (req, res) => res.json(q.getBot.get(req.query.session, req.query.jid) || { paused_until: 0, needs_human: 0 }));
app.get('/api/ara/citas', guard, (req, res) => res.json(q.listCitas.all()));
app.patch('/api/ara/citas/:id', guard, wrap(async (req, res) => {
  const estados = ['pendiente', 'confirmada', 'asistio', 'no_vino', 'cancelada'];
  if (!estados.includes(req.body?.estado)) throw new Error('Estado inválido');
  q.setCitaEstado.run(req.body.estado, req.params.id);
  io.emit('citas', {});
  res.json(q.getCita.get(req.params.id));
}));
app.get('/api/ara/stock', guard, (req, res) => {
  const c = stock.getStock();
  res.json({ total: c.autos.length, updatedAt: c.updatedAt, error: c.error, errorAt: c.errorAt, source: c.source, autos: c.autos });
});
app.post('/api/ara/stock/refresh', guard, wrap(async (req, res) => {
  const c = await stock.refresh(getSettings().stockUrl);
  if (c.error && !c.autos.length) throw new Error(c.error);
  res.json({ total: c.autos.length, updatedAt: c.updatedAt, error: c.error });
}));
app.get('/api/ara/models', guard, wrap(async (req, res) => {
  let gemini = [], geminiError = null, geminiAuto = null;
  if (ara.geminiKey()) {
    try { gemini = await ara.geminiModels(); geminiAuto = await ara.resolveGemini('gemini-auto'); } catch (e) { geminiError = e.message; }
  }
  res.json({ gemini, geminiAuto, geminiError });
}));
app.post('/api/ara/test-audio', guard, wrap(async (req, res) => res.json(await ara.testOpenAI())));
app.post('/api/ara/transcribe', guard, wrap(async (req, res) => {
  const row = q.getMsg.get(req.body.session, req.body.id);
  if (!row || row.type !== 'audio') throw new Error('Audio no encontrado');
  res.json({ text: await ara.transcribe(req.body.session, row, { strict: true }) });
}));
app.post('/api/ara/contract', guard, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Falta el archivo');
  let text = '';
  if (/pdf$/i.test(req.file.mimetype) || /\.pdf$/i.test(req.file.originalname)) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(req.file.buffer));
    text = (await extractText(pdf, { mergePages: true })).text;
  } else text = req.file.buffer.toString('utf8');
  text = text.replace(/[ \t]+/g, ' ').replace(/_{3,}/g, '____').replace(/\n\s*\n+/g, '\n').replace(/CONTRATO DE CONSIGNACIÓN N°\s*\n?pág\. \d+/g, '').trim();
  if (text.length < 200) throw new Error('No pude leer texto en ese archivo (¿es un PDF escaneado como imagen?)');
  const st = saveSettings({ contract: text.slice(0, 60000), contractName: Buffer.from(req.file.originalname, 'latin1').toString('utf8') });
  res.json({ ok: true, chars: st.contract.length, name: st.contractName });
}));
app.post('/api/ara/test-ruthina', guard, wrap(async (req, res) => res.json(await credito.probarRuthina(getSettings()))));
app.post('/api/ara/test-market', guard, wrap(async (req, res) => {
  const autos = await market.autosMarket(getSettings(), { force: true });
  res.json({ ok: true, total: autos.length });
}));
app.get('/api/ara/creditos', guard, (req, res) => res.json(credito.creditos.todos.all()));
app.get('/api/ara/leads', guard, (req, res) => res.json(q.listLeads.all()));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Tiempo real ----------
io.use((socket, next) => {
  const cookies = Object.fromEntries((socket.handshake.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
  cookies.crm_token === TOKEN ? next() : next(new Error('No autorizado'));
});
for (const ev of ['session', 'message', 'media', 'status', 'refresh', 'removed', 'msgupdate']) {
  wa.on(ev, (data) => io.emit(ev, data));
}
for (const ev of ['bot', 'cita', 'citas', 'lead', 'actions', 'araerror', 'credito', 'recordatorio', 'tutumatch']) {
  ara.on(ev, (data) => io.emit(ev, data));
}
wa.on('message', (data) => { try { ara.onMessage(data); } catch (e) { console.error('ARA onMessage', e); } });

server.listen(PORT, () => {
  console.log(`CRM WhatsApp en http://localhost:${PORT}  (datos en ${DATA_DIR})`);
  console.log(`🤖 Claves de IA: Claude ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'} · Gemini ${ara.geminiKey() ? '✓' : '✗'}`);
  const audio = ara.audioProvider();
  console.log(audio ? `🎧 Audios: ARA escucha con ${audio.name} (${audio.model})` : '🎧 Audios: falta GROQ_API_KEY, ARA no puede escuchar audios');
  const st = getSettings();
  console.log(ara.geminiKey() ? `🗣️ Voz: si el cliente manda audio, ARA responde con audio (voz ${st.voiceName})${st.voiceReplies ? '' : ' [apagado]'}` : '🗣️ Voz: falta GEMINI_API_KEY para responder con audio');
  console.log(`🧠 ARA responde con: ${/^gemini/.test(st.model) ? 'Gemini (' + st.model + ')' : 'Claude (' + st.model + ')'}`);
  if (!process.env.PANEL_PASSWORD) console.warn('⚠️  Falta PANEL_PASSWORD: se usa la contraseña por defecto "cambiar123"');
  wa.startAll();
  startStockSync();
  ara.startCreditPoller();
  ara.startReminders();
  { const c = credito.ruthinaConfig(getSettings()); console.log(c.listo ? `💳 Crédito: ARA califica clientes con Ruthina (${c.url})` : `💳 Crédito: ${c.key ? 'apagado en el panel' : 'falta RUTHINA_BOT_KEY'} — ARA no califica`); }
});
