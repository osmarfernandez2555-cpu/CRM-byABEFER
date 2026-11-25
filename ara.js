// ARA — vendedora estrella de Tutu Automotores (bot de IA que responde los WhatsApp)
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { q, DATA_DIR } from './db.js';
import wa from './wa.js';
import { DEFAULT_SKILLS, SKILL_TEXT_MAX } from './skills.js';
export { DEFAULT_SKILLS };

const TZ = 'America/Argentina/Cordoba';
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const FOREVER = 9999999999;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Entrenamiento por defecto (se edita todo desde el panel → ARA)
// ---------------------------------------------------------------------------
export const DEFAULT_INSTRUCTIONS = `Sos ARA, la vendedora estrella de Tutu Automotores, una concesionaria de Córdoba (Argentina) con autos 0 km y usados seleccionados. Atendés a los clientes por WhatsApp.

PERSONALIDAD
- Cálida, segura, resolutiva y con mucha onda. Hablás en español rioplatense (vos, tenés, querés), como una vendedora cordobesa con experiencia.
- Sos asesora, no un formulario: escuchás, preguntás lo justo y recomendás.
- Mensajes cortos, como se escribe en WhatsApp. Una o dos preguntas por mensaje, nunca un interrogatorio.

OBJETIVO
Que cada cliente termine con una cita en el Polo 52 (Autopista Córdoba–Rosario) para ver el auto, hacer una prueba de manejo, tasar su usado o dejarlo en consignación.

VENTAS
1. Entendé qué busca: tipo de vehículo, uso (familia, trabajo, ciudad, ruta), presupuesto aproximado.
2. Preguntá si tiene un usado para entregar como parte de pago y si le interesa financiar.
3. Recomendá opciones del stock que figura en "Conocimiento". Si no hay algo que encaje, decilo y proponé alternativas o que un asesor le busque opciones.
4. Cerrá proponiendo una visita: "¿Te queda bien venir el jueves a la tarde así lo ves y lo manejás?".

CONSIGNACIÓN (el cliente quiere que vendamos su auto)
1. Explicá brevemente cómo funciona según "Conocimiento".
2. Pedí: marca, modelo, versión, año, kilómetros, estado general, precio que pretende y fotos.
3. Proponé una cita para tasarlo en el Polo 52.

USADOS / TASACIÓN
- Nunca des un precio de tasación por WhatsApp: la tasación se hace viendo el auto. Pedí los datos y citá al cliente.

CITAS
- Antes de agendar necesitás: nombre del cliente, día, hora y motivo. Ofrecé dos opciones concretas de día y horario dentro del horario de atención.
- Cuando el cliente confirma, registrá la cita y después confirmale con la dirección.

CUÁNDO PASAR CON UNA PERSONA
- Si el cliente lo pide, si está molesto, si es un reclamo o postventa, o si pregunta algo que no está en "Conocimiento" y es importante para cerrar.`;

export const DEFAULT_KNOWLEDGE = `DATOS DE LA EMPRESA
- Nombre: Tutu Automotores
- Dirección: Polo 52, Autopista Córdoba–Rosario, Córdoba [COMPLETAR: km / referencia / link de Google Maps]
- Marcas: JMC, Shineray [COMPLETAR: otras]
- Teléfono / web / Instagram: [COMPLETAR]

STOCK DESTACADO (actualizalo seguido)
- [COMPLETAR] Ej: JMC Vigus 4x4 2025 0 km — precio — colores
- [COMPLETAR] Ej: Toyota Corolla XEi 2019, 85.000 km — precio

FINANCIACIÓN
- [COMPLETAR] Bancos y entidades con las que trabajan, requisitos (DNI, recibo de sueldo, etc.), plazos.
- No informar tasas ni cuotas exactas si no están acá: se calculan con el asesor.

CONSIGNACIÓN
- [COMPLETAR] Cómo funciona, comisión, tiempo mínimo, quién paga la publicidad, qué documentación tiene que traer (título, cédula, 08, VTV, informe de dominio...).

TOMA DE USADOS
- Se aceptan usados como parte de pago, previa tasación presencial. [COMPLETAR: condiciones]

PROMOCIONES VIGENTES
- [COMPLETAR]`;

const DEFAULTS = {
  enabled: false,
  sessions: [],            // vacío = todos los celulares
  testNumbers: '',         // si tiene números, ARA solo responde a esos
  pauseHours: 12,          // si un humano escribe en el chat, ARA se calla estas horas
  delaySec: 8,             // espera a que el cliente termine de escribir
  model: 'claude-sonnet-5-5',
  maxPerSlot: 3,
  horarios: { 0: '', 1: '09:00-18:00', 2: '09:00-18:00', 3: '09:00-18:00', 4: '09:00-18:00', 5: '09:00-18:00', 6: '09:00-13:00' },
  instructions: DEFAULT_INSTRUCTIONS,
  knowledge: DEFAULT_KNOWLEDGE,
  skills: DEFAULT_SKILLS.map(sk => ({ ...sk, enabled: true, builtin: true })),
};

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(q.getSetting.get('ara')?.value || '{}'); } catch {}
  const def = JSON.parse(JSON.stringify(DEFAULTS)); // copia: nunca modificar los valores por defecto
  const st = { ...def, ...saved, horarios: { ...def.horarios, ...(saved.horarios || {}) } };
  if (Array.isArray(saved.skills)) {
    // habilidades nuevas que vengan en futuras versiones se agregan solas
    const ids = new Set(saved.skills.map(x => x.id));
    st.skills = [...saved.skills, ...def.skills.filter(x => !ids.has(x.id))];
  }
  return st;
}

function cleanSkills(list) {
  if (!Array.isArray(list)) return undefined;
  const builtinIds = new Set(DEFAULT_SKILLS.map(x => x.id));
  const seen = new Set();
  return list.slice(0, 40).map((x, i) => {
    let id = String(x.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'propia-' + Date.now().toString(36) + i;
    if (seen.has(id)) id += '-' + i;
    seen.add(id);
    return {
      id,
      nombre: String(x.nombre || 'Habilidad').slice(0, 80),
      descripcion: String(x.descripcion || '').slice(0, 200),
      texto: String(x.texto || '').slice(0, SKILL_TEXT_MAX),
      enabled: !!x.enabled,
      builtin: builtinIds.has(id),
    };
  }).filter(x => x.texto.trim() || x.builtin);
}
export function saveSettings(patch) {
  const allowed = Object.keys(DEFAULTS);
  const cur = getSettings();
  for (const k of allowed) if (patch[k] !== undefined) cur[k] = patch[k];
  if (patch.skills !== undefined) cur.skills = cleanSkills(patch.skills) || cur.skills;
  cur.pauseHours = Math.max(0, +cur.pauseHours || 0);
  cur.delaySec = Math.min(60, Math.max(2, +cur.delaySec || 8));
  cur.maxPerSlot = Math.max(1, +cur.maxPerSlot || 3);
  q.setSetting.run('ara', JSON.stringify(cur));
  return cur;
}

// ---------------------------------------------------------------------------
// Fechas y horarios
// ---------------------------------------------------------------------------
function nowParts() {
  const d = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const largo = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  return { iso, largo };
}
function horariosTexto(h) {
  return [1, 2, 3, 4, 5, 6, 0].map(i => `${DIAS[i]}: ${h[i] ? h[i].replace('-', ' a ') : 'cerrado'}`).join('\n');
}
const toMin = (hhmm) => { const [a, b] = String(hhmm).split(':').map(Number); return a * 60 + (b || 0); };

function validarCita(fecha, hora, s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return 'La fecha tiene que tener formato AAAA-MM-DD.';
  if (!/^\d{1,2}:\d{2}$/.test(hora || '')) return 'La hora tiene que tener formato HH:MM.';
  const hh = hora.padStart(5, '0');
  const ts = Date.parse(`${fecha}T${hh}:00-03:00`);
  if (isNaN(ts)) return 'Fecha inválida.';
  if (ts < Date.now() + 20 * 60 * 1000) return 'Ese horario ya pasó o es demasiado pronto. Proponé otro.';
  if (ts > Date.now() + 60 * 24 * 3600 * 1000) return 'Solo se agendan citas dentro de los próximos 60 días.';
  const dia = new Date(`${fecha}T12:00:00-03:00`).getUTCDay();
  const rango = s.horarios[dia];
  if (!rango) return `Ese día (${DIAS[dia]}) está cerrado. Horarios:\n${horariosTexto(s.horarios)}`;
  const [ab, ce] = rango.split('-');
  const m = toMin(hh);
  if (m < toMin(ab) || m > toMin(ce) - 30) return `Ese horario está fuera de atención (${DIAS[dia]} ${rango}). Proponé otro.`;
  if (q.citasDelSlot.get(fecha, hh).n >= s.maxPerSlot) return 'Ese horario ya está completo. Proponé otro cercano.';
  return null;
}

// ---------------------------------------------------------------------------
// Herramientas que ARA puede usar
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'agendar_cita',
    description: 'Registra una cita del cliente en el Polo 52. Usala solo cuando el cliente confirmó día y hora. Si devuelve error, explicale al cliente y proponé otro horario.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente' },
        fecha: { type: 'string', description: 'Fecha en formato AAAA-MM-DD' },
        hora: { type: 'string', description: 'Hora en formato HH:MM (24 h)' },
        motivo: { type: 'string', enum: ['compra', 'consignacion', 'tasacion', 'test_drive', 'financiacion', 'otro'] },
        vehiculo: { type: 'string', description: 'Vehículo de interés o el que trae a tasar/consignar' },
        notas: { type: 'string', description: 'Datos útiles para el vendedor que lo va a recibir' },
      },
      required: ['nombre', 'fecha', 'hora', 'motivo'],
    },
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela las citas pendientes de este cliente (por ejemplo para reprogramar: cancelás y agendás una nueva).',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } } },
  },
  {
    name: 'registrar_lead',
    description: 'Guarda o actualiza los datos comerciales del cliente apenas los conozcas. Mandá solo los campos que sepas.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        interes: { type: 'string', enum: ['compra', 'consignacion', 'tasacion', 'financiacion', 'otro'] },
        vehiculo_interes: { type: 'string' },
        presupuesto: { type: 'string' },
        usado_entrega: { type: 'string', description: 'Usado que entrega o que quiere consignar (marca, modelo, año, km)' },
        financiacion: { type: 'string' },
        notas: { type: 'string' },
      },
    },
  },
  {
    name: 'derivar_a_humano',
    description: 'Pasa la conversación a un vendedor humano y ARA deja de responder en este chat. Usala si el cliente lo pide, está molesto, es un reclamo/postventa, o necesita información que no tenés.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
  },
];

class Ara extends EventEmitter {
  constructor() {
    super();
    this.timers = new Map();
    this.running = new Set();
    this.pending = new Set();
    this.transcribing = new Map();
  }

  // ------------------------- contexto -------------------------
  buildSystem(s, ctx) {
    const { iso, largo } = nowParts();
    const lead = ctx.sid !== 'sim' ? q.getLead.get(ctx.sid, ctx.jid) : null;
    const citas = ctx.sid !== 'sim' ? q.citasDeChat.all(ctx.sid, ctx.jid) : [];
    const fijo = `${s.instructions}

=== CONOCIMIENTO (única fuente de datos de stock, precios y condiciones) ===
${s.knowledge}

${habilidadesTexto(s.skills)}=== REGLAS FIJAS (tienen prioridad sobre todo lo anterior) ===
- No inventes precios, stock, tasas, cuotas ni condiciones. Si algo no está en CONOCIMIENTO, decí que lo confirmás con un asesor y ofrecé una cita o usá derivar_a_humano.
- Usá registrar_lead cada vez que el cliente te dé datos útiles (nombre, interés, presupuesto, usado, financiación).
- Para agendar usá agendar_cita solo después de que el cliente confirme día y hora. Después de registrarla, confirmale día, hora y la dirección.
- Si te preguntan si sos un bot, una IA o una persona, respondé con la verdad: sos ARA, la asistente virtual de Tutu Automotores, y podés pasarlo con un asesor cuando quiera.
- Formato WhatsApp: texto plano, sin markdown (nada de **, #, ni tablas). Máximo 3 mensajes cortos, separados por una línea en blanco. Emojis con moderación.
- Si el último mensaje del cliente no necesita respuesta (por ejemplo un "ok" o un "gracias" después de despedirse), respondé exactamente: [SILENCIO]
- Los mensajes que dicen [Audio sin transcribir] son audios que no pudiste escuchar: pedí con amabilidad que lo escriba.

HORARIO DE ATENCIÓN (para citas)
${horariosTexto(s.horarios)}`;
    const dinamico = `=== AHORA ===
Hoy es ${largo} (fecha ${iso}). Zona horaria de Córdoba.

=== CLIENTE ===
Nombre en WhatsApp: ${ctx.nombreWa || 'desconocido'}
Teléfono: ${ctx.telefono || 'desconocido'}
${lead ? 'Datos ya registrados: ' + JSON.stringify(Object.fromEntries(Object.entries(lead).filter(([k, v]) => v && !['session_id', 'jid', 'updated_at'].includes(k)))) : 'Sin datos registrados todavía.'}
${citas.length ? 'Citas activas: ' + citas.map(c => `${c.fecha} ${c.hora} (${c.motivo})`).join(', ') : 'Sin citas activas.'}`;
    return [
      { type: 'text', text: fijo, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dinamico },
    ];
  }

  async transcribe(sid, row) {
    if (!process.env.OPENAI_API_KEY) return null;
    const k = sid + '|' + row.id;
    if (this.transcribing.has(k)) return this.transcribing.get(k);
    const p = (async () => {
      const r = await wa.downloadMedia(sid, row.id);
      const buf = fs.readFileSync(path.join(DATA_DIR, 'media', r.media_file));
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: r.media_mime || 'audio/mpeg' }), 'audio.mp3');
      fd.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
      fd.append('language', 'es');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: fd,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error?.message || 'Error al transcribir');
      const text = (d.text || '').trim();
      if (text) wa.setText(sid, row.id, text);
      return text || null;
    })().catch(e => { console.warn('Transcripción:', e.message); return null; })
      .finally(() => setTimeout(() => this.transcribing.delete(k), 60000));
    this.transcribing.set(k, p);
    return p;
  }

  // Últimos mensajes del chat en formato de la API
  async buildHistory(sid, jid) {
    const rows = q.listMsgs.all(sid, jid, Number.MAX_SAFE_INTEGER, 30).reverse();
    const imageIds = new Set(rows.filter(r => r.type === 'image' && !r.from_me).slice(-3).map(r => r.id));
    const turns = [];
    for (const r of rows) {
      const role = r.from_me ? 'assistant' : 'user';
      const blocks = [];
      let t = '';
      switch (r.type) {
        case 'audio': {
          let tx = r.text;
          if (!tx && !r.from_me) tx = await this.transcribe(sid, r);
          t = tx ? `[Audio] ${tx}` : '[Audio sin transcribir]';
          break;
        }
        case 'image':
          if (role === 'user' && imageIds.has(r.id)) {
            try {
              const m = await wa.downloadMedia(sid, r.id);
              const buf = fs.readFileSync(path.join(DATA_DIR, 'media', m.media_file));
              const mt = (m.media_mime || '').split(';')[0];
              if (buf.length < 4.5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mt)) {
                blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } });
              }
            } catch {}
          }
          t = r.text ? `[Foto] ${r.text}` : '[Foto]';
          break;
        case 'video': t = '[Video]' + (r.text ? ' ' + r.text : ''); break;
        case 'document': t = `[Documento: ${r.file_name || 'archivo'}]` + (r.text ? ' ' + r.text : ''); break;
        case 'sticker': t = '[Sticker]'; break;
        case 'location': t = '[Ubicación] ' + (r.text || ''); break;
        case 'contact': t = '[Contacto] ' + (r.text || ''); break;
        default: t = r.text || '';
      }
      if (t.trim()) blocks.push({ type: 'text', text: t });
      if (!blocks.length) continue;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else turns.push({ role, content: blocks });
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!turns.length || turns[turns.length - 1].role !== 'user') return null;
    return turns;
  }

  // ------------------------- IA -------------------------
  async callClaude(body) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Falta la variable ANTHROPIC_API_KEY en Railway');
    const res = await fetch(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Error de la API (${res.status})`);
    return data;
  }

  async runAgent(ctx, history, simulate) {
    const s = getSettings();
    const system = this.buildSystem(s, ctx);
    const messages = [...history];
    const actions = [];
    for (let i = 0; i < 5; i++) {
      const res = await this.callClaude({ model: s.model, max_tokens: 1024, system, messages, tools: TOOLS });
      messages.push({ role: 'assistant', content: res.content });
      const uses = (res.content || []).filter(b => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
        return { text, actions };
      }
      const results = [];
      for (const u of uses) {
        let out;
        try { out = await this.runTool(u.name, u.input || {}, ctx, simulate, s); }
        catch (e) { out = { ok: false, error: e.message }; }
        actions.push({ tool: u.name, input: u.input, result: out });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: '', actions };
  }

  async runTool(name, input, ctx, simulate, s) {
    const { sid, jid } = ctx;
    if (name === 'agendar_cita') {
      const hora = String(input.hora || '').padStart(5, '0');
      const err = validarCita(input.fecha, hora, s);
      if (err) return { ok: false, error: err };
      if (simulate) return { ok: true, simulado: true, mensaje: 'Cita registrada (simulación, no se guardó)' };
      const r = q.addCita.run({
        session_id: sid, jid, nombre: input.nombre || null, telefono: ctx.telefono || null, fecha: input.fecha, hora,
        motivo: input.motivo || 'otro', vehiculo: input.vehiculo || null, notas: input.notas || null, created_at: now(),
      });
      q.upsertLead.run({ session_id: sid, jid, nombre: input.nombre || null, interes: null, vehiculo_interes: null, presupuesto: null, usado_entrega: null, financiacion: null, notas: null, updated_at: now() });
      const cita = q.getCita.get(r.lastInsertRowid);
      this.emit('cita', { ...cita, session_name: q.getSession.get(sid)?.name });
      return { ok: true, cita_id: cita.id, mensaje: 'Cita registrada' };
    }
    if (name === 'cancelar_cita') {
      if (simulate) return { ok: true, simulado: true };
      const n = q.cancelCitasChat.run(sid, jid).changes;
      this.emit('citas', {});
      return { ok: true, canceladas: n };
    }
    if (name === 'registrar_lead') {
      if (simulate) return { ok: true, simulado: true };
      const f = (k) => (input[k] ? String(input[k]).slice(0, 500) : null);
      q.upsertLead.run({
        session_id: sid, jid, nombre: f('nombre'), interes: f('interes'), vehiculo_interes: f('vehiculo_interes'),
        presupuesto: f('presupuesto'), usado_entrega: f('usado_entrega'), financiacion: f('financiacion'), notas: f('notas'), updated_at: now(),
      });
      this.emit('lead', { session_id: sid, jid });
      return { ok: true };
    }
    if (name === 'derivar_a_humano') {
      if (simulate) return { ok: true, simulado: true, instruccion: 'Avisale al cliente que un asesor le escribe a la brevedad.' };
      q.setBot.run({ session_id: sid, jid, paused_until: FOREVER, needs_human: 1, reason: String(input.motivo || '').slice(0, 300) });
      this.emit('bot', { session_id: sid, jid, ...q.getBot.get(sid, jid), alerta: true, telefono: ctx.telefono, nombre: ctx.nombreWa });
      return { ok: true, instruccion: 'Avisale al cliente que un asesor le escribe a la brevedad. Después de esto no sigas la conversación.' };
    }
    return { ok: false, error: 'Herramienta desconocida' };
  }

  // ------------------------- disparadores -------------------------
  matchesTest(s, jid) {
    const list = String(s.testNumbers || '').split(/[\s,;]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 6);
    if (!list.length) return true;
    const num = jid.split('@')[0];
    return list.some(n => num.endsWith(n.slice(-8)));
  }

  canReply(sid, jid) {
    const s = getSettings();
    if (!s.enabled) return false;
    if (s.sessions?.length && !s.sessions.includes(sid)) return false;
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) return false; // nunca en grupos
    if (!this.matchesTest(s, jid)) return false;
    const b = q.getBot.get(sid, jid);
    if (b && b.paused_until > now()) return false;
    return true;
  }

  // Llamado por cada mensaje nuevo (entrante o saliente)
  onMessage({ message: m }) {
    const { session_id: sid, jid } = m;
    if (m.from_me) {
      // Un humano escribió (desde el panel o desde el celular): ARA se corre
      if (!m.by_bot && m.ts > now() - 120) {
        const s = getSettings();
        if (s.pauseHours > 0 && /@(s\.whatsapp\.net|lid)$/.test(jid)) {
          const b = q.getBot.get(sid, jid);
          const until = now() + s.pauseHours * 3600;
          if (!b || (b.paused_until < until && b.paused_until !== FOREVER)) {
            q.setBot.run({ session_id: sid, jid, paused_until: until, needs_human: 0, reason: 'Respondió una persona' });
            this.emit('bot', { session_id: sid, jid, ...q.getBot.get(sid, jid) });
          }
        }
        const k = sid + '|' + jid;
        clearTimeout(this.timers.get(k)); this.timers.delete(k);
      }
      return;
    }
    // Audios: transcribir para el panel aunque ARA esté apagada (si hay clave de OpenAI)
    if (m.type === 'audio' && !m.text && process.env.OPENAI_API_KEY) this.transcribe(sid, m);
    if (m.ts < now() - 600) return;          // mensajes viejos que llegan al reconectar
    if (!this.canReply(sid, jid)) return;
    const k = sid + '|' + jid;
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => { this.timers.delete(k); this.respond(sid, jid); }, getSettings().delaySec * 1000));
  }

  async respond(sid, jid) {
    const k = sid + '|' + jid;
    if (this.running.has(k)) { this.pending.add(k); return; }
    this.running.add(k);
    try {
      if (!this.canReply(sid, jid)) return;
      const history = await this.buildHistory(sid, jid);
      if (!history) return;
      const chat = q.getChat.get(sid, jid);
      const ctx = { sid, jid, telefono: '+' + jid.split('@')[0], nombreWa: chat?.name || q.getContact.get(sid, jid)?.name };
      await wa.typing(sid, jid, true);
      const { text, actions } = await this.runAgent(ctx, history, false);
      if (actions.length) this.emit('actions', { session_id: sid, jid, actions });
      // Si mientras pensaba escribió una persona, no mandamos nada
      const b = q.getBot.get(sid, jid);
      const humanTookOver = b && b.paused_until > now() && b.reason === 'Respondió una persona';
      if (!text || text.includes('[SILENCIO]') || humanTookOver) { await wa.typing(sid, jid, false); return; }
      const parts = splitMessages(text);
      for (let i = 0; i < parts.length; i++) {
        await wa.typing(sid, jid, true);
        await sleep(Math.min(4500, 900 + parts[i].length * 22));
        await wa.sendText(sid, jid, parts[i], { byBot: true });
      }
      await wa.typing(sid, jid, false);
    } catch (e) {
      console.error('ARA:', e);
      await wa.typing(sid, jid, false);
      this.emit('araerror', { session_id: sid, jid, error: e.message });
    } finally {
      this.running.delete(k);
      if (this.pending.delete(k)) this.respond(sid, jid);
    }
  }

  // Simulador del panel: misma ARA, sin WhatsApp y sin guardar nada
  async simulate(conversation) {
    const turns = [];
    for (const m of conversation || []) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const text = String(m.text || '').trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content.push({ type: 'text', text });
      else turns.push({ role, content: [{ type: 'text', text }] });
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!turns.length || turns.at(-1).role !== 'user') throw new Error('Escribí un mensaje como cliente');
    const { text, actions } = await this.runAgent({ sid: 'sim', jid: 'sim', telefono: '+5493510000000', nombreWa: 'Cliente de prueba' }, turns, true);
    const silent = !text || text.includes('[SILENCIO]');
    return { replies: silent ? [] : splitMessages(text), silent, actions };
  }

  setChat(sid, jid, action) {
    if (action === 'resume') q.setBot.run({ session_id: sid, jid, paused_until: 0, needs_human: 0, reason: null });
    else q.setBot.run({ session_id: sid, jid, paused_until: FOREVER, needs_human: 0, reason: 'Pausada a mano' });
    const st = { session_id: sid, jid, ...q.getBot.get(sid, jid) };
    this.emit('bot', st);
    return st;
  }
}

function habilidadesTexto(skills) {
  const on = (skills || []).filter(x => x.enabled && x.texto?.trim());
  if (!on.length) return '';
  return '=== HABILIDADES DE VENTA (aplicalas en cada conversación) ===\n\n'
    + on.map(x => `### ${x.nombre}\n${x.texto.trim()}`).join('\n\n') + '\n\n';
}

function splitMessages(text) {
  const clean = text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').trim();
  let parts = clean.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 3) parts = [parts[0], parts[1], parts.slice(2).join('\n\n')];
  return parts;
}

export default new Ara();
