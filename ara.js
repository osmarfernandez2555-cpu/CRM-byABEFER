// ARA — vendedora estrella de Tutu Automotores (bot de IA que responde los WhatsApp)
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import db, { q, DATA_DIR } from './db.js';
import wa from './wa.js';
import { DEFAULT_SKILLS, SKILL_TEXT_MAX, SKILL_FIXES } from './skills.js';
import * as stock from './stock.js';
import { pcmToWav, toMp3 } from './media.js';
import * as credito from './credito.js';
import * as market from './market.js';
import * as ruthina from './ruthina-sync.js';
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

VENTA DEL AUTO DEL CLIENTE (consignación + Tutu Match)
1. Si quiere vender, explicale nuestro sistema de consignación según "Conocimiento". La prioridad es que lo deje en consignación con nosotros.
2. Contale también Tutu Match: cargamos su auto en nuestra base, del otro lado hay gente buscando autos, y si hay match nos comunicamos con él y con el comprador.
3. Pedí toda la info posible: marca, modelo, versión, año, kilómetros, color, monto pretendido, estado general, si es único dueño, service, detalles y fotos.
4. Proponé una cita para peritarlo en el Polo 52.

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

STOCK
- ARA lee el stock automáticamente de tutuautomotores.com (pestaña Stock). Acá solo agregá aclaraciones, por ejemplo unidades que llegan pronto o que no están publicadas.

FINANCIACIÓN
- [COMPLETAR] Bancos y entidades con las que trabajan, requisitos (DNI, recibo de sueldo, etc.), plazos.
- No informar tasas ni cuotas exactas si no están acá: se calculan con el asesor.

CONSIGNACIÓN
- [COMPLETAR] Cómo funciona, comisión, tiempo mínimo, quién paga la publicidad, qué documentación hace falta para la venta (título, cédula, 08, VTV, informe de dominio...) y cuál gestiona Tutu.

TOMA DE USADOS
- Se aceptan usados como parte de pago, previa tasación presencial. [COMPLETAR: condiciones]

PROMOCIONES VIGENTES
- [COMPLETAR]`;

const DEFAULTS = {
  enabled: false,
  sessions: [],            // vacío = todos los celulares
  testNumbers: '',         // si tiene números, ARA solo responde a esos
  pauseHours: 12,          // si un humano escribe en el chat, ARA se calla estas horas
  handoffHours: 4,         // si ARA deriva a un asesor y nadie contesta en estas horas, ARA retoma
  delaySec: 8,             // espera a que el cliente termine de escribir
  model: 'claude-sonnet-5-5',
  maxPerSlot: 3,
  stockEnabled: true,      // leer el stock de la web de Tutu
  stockUrl: 'https://tutuautomotores.com',
  stockMinutes: 720,       // 12 horas
  sendPhotos: true,        // ARA puede mandar fotos de los autos
  maxPhotos: 3,
  mapsUrl: 'https://maps.app.goo.gl/bruaSebsVVckhGna8',
  marketEnabled: true,     // buscar también en Tutu Market (red Tutu Match) y cargar autos de clientes
  marketUrl: 'https://tutu-market-bytutumatch.up.railway.app',   // ubicación del Polo 52 en Google Maps
  reminderEnabled: true,   // recordatorio por WhatsApp antes de cada cita
  reminderHours: 2,
  reminderText: '¡Hola {nombre}! 👋 Te recuerdo que {cuando} a las {hora} te esperamos en el Polo 52, Autopista Córdoba–Rosario.\n\n📍 Cómo llegar: {mapa}\n\nSi te surge algo y no podés venir, avisame por acá y lo reprogramamos 😊',
  creditEnabled: true,     // calificar clientes con Ruthina
  ruthinaUrl: 'https://compara-conejo-production.up.railway.app',
  voiceReplies: true,      // si el cliente manda audio, ARA responde con audio
  voiceName: 'Kore',
  voiceStyle: 'Hablá en español de Argentina, con acento rioplatense, tono cálido, simpático y seguro, como una vendedora cordobesa con mucha onda',
  horarios: { 0: '', 1: '09:00-18:00', 2: '09:00-18:00', 3: '09:00-18:00', 4: '09:00-18:00', 5: '09:00-18:00', 6: '09:00-13:00' },
  instructions: DEFAULT_INSTRUCTIONS,
  knowledge: DEFAULT_KNOWLEDGE,
  contract: '',            // contrato de consignación (privado: solo para responder dudas y objeciones)
  contractName: '',
  skills: DEFAULT_SKILLS.map(sk => ({ ...sk, enabled: true, builtin: true })),
};

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(q.getSetting.get('ara')?.value || '{}'); } catch {}
  const def = JSON.parse(JSON.stringify(DEFAULTS)); // copia: nunca modificar los valores por defecto
  if (String(process.env.GEMINI_API_KEY || '').trim()) def.model = 'gemini-auto'; // con clave de Gemini, responde Gemini por defecto
  if (saved.stockMinutes === 30) saved.stockMinutes = 720;
  if (typeof saved.reminderText === 'string') saved.reminderText = saved.reminderText.replace('Te recuerdo que hoy a las {hora}', 'Te recuerdo que {cuando} a las {hora}'); // el valor viejo por defecto pasa a 12 horas
  const st = { ...def, ...saved, horarios: { ...def.horarios, ...(saved.horarios || {}) } };
  if (Array.isArray(saved.skills)) {
    // habilidades nuevas que vengan en futuras versiones se agregan solas
    const ids = new Set(saved.skills.map(x => x.id));
    st.skills = [...saved.skills, ...def.skills.filter(x => !ids.has(x.id))];
    for (const sk of st.skills) for (const [viejo, nuevo] of SKILL_FIXES) if (sk.texto?.includes(viejo)) sk.texto = sk.texto.replace(viejo, nuevo);
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
  cur.handoffHours = Math.min(168, Math.max(0.5, +cur.handoffHours || 4));
  cur.delaySec = Math.min(60, Math.max(2, +cur.delaySec || 8));
  cur.maxPerSlot = Math.max(1, +cur.maxPerSlot || 3);
  cur.reminderHours = Math.min(48, Math.max(0.5, +cur.reminderHours || 2));
  cur.mapsUrl = String(cur.mapsUrl || '').trim().replace(/[?&]g_st=[^&]*/, '');
  cur.stockMinutes = Math.min(10080, Math.max(30, +cur.stockMinutes || 720));
  cur.maxPhotos = Math.min(6, Math.max(1, +cur.maxPhotos || 3));
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
    name: 'cargar_consignacion',
    description: 'Carga en la base de Ruthina / Tutu Match el auto que el cliente quiere vender (o dejar en consignación), para que un asesor lo evalúe, se publique en Tutu Market y se cruce con compradores. Usala apenas tengas al menos modelo, año y kilómetros, y volvé a usarla cada vez que sume datos (monto, estado, detalles) o cambie de idea sobre la consignación.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente' },
        marca: { type: 'string' }, modelo: { type: 'string' }, version: { type: 'string' },
        anio: { type: 'string' }, km: { type: 'string', description: 'Kilómetros' },
        color: { type: 'string' },
        precio_pedido: { type: 'string', description: 'Monto que pretende el cliente, si lo dijo' },
        moneda: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda del monto pretendido' },
        estado_general: { type: 'string', description: 'Estado que cuenta el cliente (chapa, pintura, mecánica, cubiertas, service, detalles)' },
        detalles: { type: 'string', description: 'Todo lo demás útil: único dueño, papeles al día, GNC, acepta permuta, ciudad, etc.' },
        consignacion: { type: 'string', enum: ['acepta', 'lo piensa', 'no quiere'], description: 'Qué dijo sobre dejarlo en consignación con Tutu' },
      },
      required: ['modelo'],
    },
  },
  {
    name: 'derivar_a_humano',
    description: 'Pasa la conversación a un vendedor humano y ARA deja de responder en este chat. Usala si el cliente lo pide, está molesto, es un reclamo/postventa, o necesita información que no tenés.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
  },
];

const STOCK_TOOLS = [
  {
    name: 'buscar_stock',
    description: 'Busca autos disponibles: primero en la web de Tutu (con precio y link) y después en la red Tutu Match / Tutu Market (sin precio). Usala SIEMPRE antes de recomendar un auto o dar un precio. Podés combinar filtros. Si no hay resultados, probá con filtros más amplios.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Marca y/o modelo, ej: "toyota hilux", "cronos", "jolion"' },
        tipo: { type: 'string', description: 'Tipo de vehículo: suv, sedan, hatchback, pick-up, utilitario' },
        condicion: { type: 'string', enum: ['0km', 'usado'] },
        precio_max: { type: 'number', description: 'Precio máximo (número, sin puntos)' },
        precio_min: { type: 'number' },
        moneda: { type: 'string', enum: ['ARS', 'USD'], description: 'Moneda del presupuesto' },
        anio_min: { type: 'number' },
        km_max: { type: 'number' },
        combustible: { type: 'string', description: 'nafta, diesel, gnc, eléctrico, híbrido' },
        transmision: { type: 'string', description: 'manual o automática' },
      },
    },
  },
];
const CREDIT_TOOL = {
  name: 'calificar_credito',
  description: 'Consulta en los bancos (a través de Ruthina) si el cliente tiene crédito disponible para financiar el auto. Necesita el DNI (7-8 números) o CUIL (11 números) del titular. Con DNI hay que indicar el sexo del titular para armar el CUIL.',
  input_schema: {
    type: 'object',
    properties: {
      documento: { type: 'string', description: 'DNI o CUIL tal cual lo pasó el cliente' },
      sexo: { type: 'string', enum: ['M', 'F'], description: 'Sexo del titular del DNI (deducilo del nombre o preguntalo)' },
      nombre: { type: 'string', description: 'Nombre del titular del DNI' },
      auto: { type: 'string', description: 'Auto que le interesa, si se sabe' },
      rol: { type: 'string', enum: ['titular', 'segundo'], description: '"segundo" si es otro DNI (pareja, familiar, garante) porque el primero no calificó' },
    },
    required: ['documento'],
  },
};
const PHOTO_TOOL = {
  name: 'enviar_fotos_auto',
  description: 'Manda al cliente por WhatsApp las fotos de un auto del stock (con nombre, precio y link). Usala cuando el cliente pide fotos o muestra interés concreto en una unidad. Usá el id que devuelve buscar_stock.',
  input_schema: { type: 'object', properties: { id: { type: 'string', description: 'id del auto tal cual lo devuelve buscar_stock (los de Tutu Market empiezan con M)' } }, required: ['id'] },
};

class Ara extends EventEmitter {
  constructor() {
    super();
    this.notas = new Map();
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
${s.contract ? `
=== CONTRATO DE CONSIGNACIÓN DE TUTU (CONFIDENCIAL: material interno de consulta) ===
${s.contract}
=== FIN DEL CONTRATO ===
` : ''}
${habilidadesTexto(s.skills)}=== REGLAS FIJAS (tienen prioridad sobre todo lo anterior) ===
- No inventes precios, stock, tasas, cuotas ni condiciones. Si algo no está en CONOCIMIENTO, decí que lo confirmás con un asesor y ofrecé una cita o usá derivar_a_humano.
- Si no sabés qué quiere el cliente, preguntá simple: "¿Estás buscando comprar un auto o querés vender el tuyo?". Nunca ofrezcas "vender" y "dejar en consignación" como opciones separadas.
${s.marketEnabled ? `- VENTA DEL AUTO DEL CLIENTE: si quiere vender, explicale nuestro sistema de consignación (según CONOCIMIENTO): la prioridad es convencerlo de dejarlo en consignación con nosotros, mostrando los beneficios. Además contale Tutu Match: cargamos su auto en nuestra base, del otro lado tenemos gente buscando autos, y si hay match (alguien busca un auto como el suyo) nos comunicamos con él y con el comprador. El precio no se publica.
- Pedile toda la información posible, de a poco (dos o tres datos por mensaje): marca, modelo, versión, año, kilómetros, color, monto pretendido, estado general, si es único dueño, service, detalles y fotos del auto (frente, atrás, costados, interior y tablero). Con eso lo cargás con cargar_consignacion. Después proponé la cita para peritarlo en el Polo 52.
` : ''}${s.stockEnabled || s.marketEnabled ? `- STOCK: antes de recomendar un auto o dar un precio, usá buscar_stock. Devuelve dos listas: "web" (autos de Tutu publicados en la web, con precio y link) y "red_tutu_match" (autos de la red Tutu Match / Tutu Market, sin precio). Mostrá SIEMPRE primero las opciones de la web; después ofrecé las de la red Tutu Match con su link, aclarando que el precio te lo confirma un asesor. Cuando pidan un modelo, mandá todas las opciones que haya (si son muchas, las de la web y las mejores de la red). Nunca ofrezcas un auto que no aparezca en esas listas.
${s.sendPhotos ? '- Si el cliente pide fotos o se interesa por una unidad concreta, usá enviar_fotos_auto (las fotos se mandan solas; después no repitas el link).\n' : ''}` : ''}${credito.ruthinaConfig(s).listo ? `- CRÉDITO: si el cliente quiere financiar o pregunta si le dan crédito, ofrecé consultarlo en el momento, sin compromiso: pedile el DNI del titular y consultalo con calificar_credito. El sexo del titular deducilo del nombre; si no te das cuenta, preguntalo con naturalidad.
- Nunca digas montos, cuotas, tasas ni nombres de bancos (ni los que aprobaron ni los que rechazaron). Si tiene crédito, decile: "¡Felicitaciones, [nombre]! Tenés crédito aprobado" y enseguida tratá de agendar la cita en el Polo 52, ofreciendo dos opciones concretas de día y horario.
- Si NO califica: decíselo con tacto, sin culpas, y pedile el DNI de otra persona de su entorno (pareja, familiar) que pueda ser titular o garante; consultalo con calificar_credito con rol "segundo". Si ese tampoco califica, ofrecé otras opciones (contado, permuta) y una cita con un asesor.
- Si la consulta queda pendiente, decile que lo estás consultando con los bancos y que le escribís en unos minutos. El sistema te avisa cuando llega el resultado. Nunca inventes un resultado.
` : ''}${s.contract ? `- CONTRATO DE CONSIGNACIÓN (CONFIDENCIAL): usalo solo para entender las condiciones y responder dudas y objeciones con tus propias palabras, en lenguaje simple. NUNCA lo envíes, no lo copies ni lo cites textual, no menciones cláusulas ni números de cláusula, no digas "según el contrato" y no ofrezcas mandarlo. Si el cliente pide ver o recibir el contrato, decile que el asesor se lo muestra y se lo explica en la agencia antes de firmar.
- Respondé siempre con la verdad y sin contradecir el contrato. Si el cliente pregunta por costos, plazos, exclusividad, retiro del auto o cómo y cuándo cobra, contestale lo que corresponda de forma clara y breve; no escondas una condición que pregunta directamente. Usá los beneficios (precio asegurado, alistamiento y fotos profesionales, publicación en la web, redes y portales, gestoría, poder seguir usando el auto mientras se vende) para responder objeciones y convencer.
` : ''}- Usá registrar_lead cada vez que el cliente te dé datos útiles (nombre, interés, presupuesto, usado, financiación).
- Para agendar usá agendar_cita solo después de que el cliente confirme día y hora. Después de registrarla, confirmale día, hora y la dirección.
${s.mapsUrl ? `- UBICACIÓN: cuando confirmes una cita o el cliente pregunte dónde están o cómo llegar, mandale el link de Google Maps: ${s.mapsUrl}` : ''}
- NUNCA le pidas al cliente que traiga algo a la cita (título, cédula, 08, VTV, informe de dominio, DNI, recibos, llaves, ni ningún papel) ni que mande documentos. Solo tiene que venir. La ÚNICA excepción: si quiere vender o consignar su auto, sí podés pedirle fotos del VEHÍCULO (frente, costados, atrás, interior, tablero), nunca fotos de documentos ni de personas.
- CARGA DEL AUTO: apenas tengas modelo, año y kilómetros usá cargar_consignacion (no esperes a tener todo) y volvé a usarla cuando sume datos. Las fotos del auto que mande se suben solas a Tutu Market: no le prometas precio de venta ni plazos; un asesor lo evalúa y lo contacta. Si manda una foto que no es de un auto, no la comentes como si lo fuera. Si viene al caso, podés contarle la documentación como parte del proceso ("la transferencia y los papeles los vemos nosotros en la agencia"), pero sin pedirle nada.
- Si te preguntan si sos un bot, una IA o una persona, respondé con la verdad: sos ARA, la asistente virtual de Tutu Automotores, y podés pasarlo con un asesor cuando quiera.
- Formato WhatsApp: texto plano, sin markdown (nada de **, #, ni tablas). Máximo 3 mensajes cortos, separados por una línea en blanco. Emojis con moderación.
- Si el último mensaje del cliente no necesita respuesta (por ejemplo un "ok" o un "gracias" después de despedirse), respondé exactamente: [SILENCIO]
- Los mensajes que dicen [Audio sin transcribir] son audios que no pudiste escuchar: pedí con amabilidad que lo escriba.

HORARIO DE ATENCIÓN (para citas)
${horariosTexto(s.horarios)}`;
    const voz = ctx.voz ? `=== MODO AUDIO ===
El cliente te está hablando por audio, así que tu respuesta se va a convertir en una nota de voz con tu voz. Escribí como se habla: natural, cálido, frases cortas, sin emojis, sin listas, sin markdown ni símbolos. Los precios y números escribilos como se dicen ("veinte mil doscientos dólares", "ochenta y tres mil kilómetros"). Un solo mensaje, de 15 a 40 segundos hablado como máximo. No leas links en voz alta: si hace falta mandar un link, ponelo al final en una línea aparte que empiece con LINK: y se manda escrito.

` : '';
    const dinamico = voz + `=== AHORA ===
Hoy es ${largo} (fecha ${iso}). Zona horaria de Córdoba.

${s.stockEnabled ? '=== STOCK EN LA WEB ===\n' + (stock.stockResumen() || 'El stock todavía no se cargó: si buscar_stock no devuelve nada, ofrecé que un asesor le pase las opciones.') + '\n\n' : ''}=== CLIENTE ===
Nombre en WhatsApp: ${ctx.nombreWa || 'desconocido'}
Teléfono: ${ctx.telefono || 'desconocido'}
${lead ? 'Datos ya registrados: ' + JSON.stringify(Object.fromEntries(Object.entries(lead).filter(([k, v]) => v && !['session_id', 'jid', 'updated_at'].includes(k)))) : 'Sin datos registrados todavía.'}
${(() => { const b = ctx.sid !== 'sim' ? q.getBot.get(ctx.sid, ctx.jid) : null; return b?.needs_human ? `IMPORTANTE: antes le pasaste este cliente a un asesor (motivo: ${b.reason || 'sin detalle'}) y todavía nadie del equipo le respondió. Retomá la charla con amabilidad, pedile disculpas por la demora y ayudalo en todo lo que puedas; el equipo ya fue avisado de nuevo. No vuelvas a derivar por el mismo motivo salvo que el cliente insista en hablar con una persona.\n` : ''; })()}${citas.length ? 'Citas activas: ' + citas.map(c => `${c.fecha} ${c.hora} (${c.motivo})`).join(', ') : 'Sin citas activas.'}`;
    return [
      { type: 'text', text: fijo, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dinamico },
    ];
  }

  // Proveedor para escuchar audios: Groq si está GROQ_API_KEY, si no OpenAI
  audioProvider() {
    const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
    const groq = clean(process.env.GROQ_API_KEY);
    if (groq) return { name: 'Groq', key: groq, base: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', model: process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo' };
    const oa = clean(process.env.OPENAI_API_KEY);
    if (oa) return { name: 'OpenAI', key: oa, base: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1' };
    return null;
  }
  openaiKey() { return this.audioProvider()?.key || ''; }

  // Transcribe un audio. Si falla, avisa en el panel y devuelve null (o tira el error si strict).
  async transcribe(sid, row, { strict = false } = {}) {
    const prov = this.audioProvider();
    if (!prov) { if (strict) throw new Error('Falta GROQ_API_KEY (u OPENAI_API_KEY) en Railway'); return null; }
    const k = sid + '|' + row.id;
    if (!this.transcribing.has(k)) {
      const p = (async () => {
        const r = await wa.downloadMedia(sid, row.id);
        const file = path.join(DATA_DIR, 'media', r.media_file);
        const buf = fs.readFileSync(file);
        const ext = (path.extname(file).slice(1) || 'mp3').toLowerCase();
        const mime = { mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm' }[ext] || r.media_mime || 'audio/mpeg';
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: mime }), 'audio.' + (ext === 'oga' || ext === 'opus' ? 'ogg' : ext));
        fd.append('model', prov.model);
        fd.append('language', 'es');
        fd.append('response_format', 'json');
        const res = await fetch(prov.base + '/audio/transcriptions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + prov.key }, body: fd, signal: AbortSignal.timeout(60000),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${prov.name} (${res.status}): ${d?.error?.message || 'error al transcribir'}`);
        const text = (d.text || '').trim();
        if (text) wa.setText(sid, row.id, text);
        console.log(`🎧 Audio transcripto con ${prov.name} (${row.seconds || '?'} s): ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
        return text || '(audio sin palabras)';
      })();
      this.transcribing.set(k, p);
      p.catch(() => {}).finally(() => setTimeout(() => this.transcribing.delete(k), 5000));
    }
    try {
      return await this.transcribing.get(k);
    } catch (e) {
      console.warn('🎧 Audio NO transcripto:', e.message);
      this.lastAudioError = { error: e.message, at: Date.now() };
      if (strict) throw e;
      if (!this._lastAudioToast || Date.now() - this._lastAudioToast > 60000) {
        this._lastAudioToast = Date.now();
        this.emit('araerror', { session_id: sid, jid: row.jid, error: 'No pude transcribir un audio. ' + e.message });
      }
      return null;
    }
  }

  async testOpenAI() {
    const prov = this.audioProvider();
    if (!prov) throw new Error('Falta GROQ_API_KEY (u OPENAI_API_KEY) en Railway');
    const res = await fetch(prov.base + '/models', { headers: { Authorization: 'Bearer ' + prov.key }, signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${prov.name} (${res.status}): ${d?.error?.message || 'clave inválida'}`);
    return { ok: true, proveedor: prov.name };
  }

  // Últimos mensajes del chat en formato de la API
  async buildHistory(sid, jid, { allowAssistantLast = false } = {}) {
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
          if (tx === '(audio sin palabras)') tx = null;
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
    if (!turns.length || (!allowAssistantLast && turns[turns.length - 1].role !== 'user')) return null;
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

  geminiKey() { return String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, ''); }

  // Lista de modelos de Gemini disponibles para la clave (se guarda 6 horas)
  async geminiAll() {
    if (this._gm && Date.now() - this._gm.at < 6 * 3600 * 1000) return this._gm.all;
    const key = this.geminiKey();
    if (!key) throw new Error('Falta la variable GEMINI_API_KEY en Railway');
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(base + '/models?pageSize=1000', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini (${res.status}): ${d?.error?.message || 'clave inválida'}`);
    const all = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), nombre: m.displayName || m.name }))
      .filter(m => /^gemini-/.test(m.id));
    this._gm = { at: Date.now(), all };
    return all;
  }

  async geminiModels() {
    return (await this.geminiAll()).filter(m => !/(image|tts|audio|live|embedding|vision|robotics|computer|native)/i.test(m.id));
  }

  // Modelo de voz (TTS) más nuevo disponible, preferentemente Flash
  async geminiTtsModel() {
    if (process.env.GEMINI_TTS_MODEL) return process.env.GEMINI_TTS_MODEL;
    const list = (await this.geminiAll()).filter(m => /tts/i.test(m.id));
    const ver = (id) => { const m = id.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
    const sorted = list.sort((a, b) => (/flash/.test(b.id) - /flash/.test(a.id)) || ver(b.id) - ver(a.id));
    if (!sorted[0]) throw new Error('Tu clave de Gemini no tiene modelos de voz (TTS) disponibles');
    return sorted[0].id;
  }

  // Texto -> audio (WAV) con la voz de Gemini
  async speak(text, s) {
    const key = this.geminiKey();
    if (!key) throw new Error('Falta GEMINI_API_KEY para que ARA hable');
    const model = await this.geminiTtsModel();
    const style = String(s.voiceStyle || '').trim().replace(/[:.\s]+$/, '');
    // Formato de "notas del director": el modelo lee SOLO lo que está bajo TRANSCRIPT
    const prompt = style
      ? `# AUDIO PROFILE: ARA\n## Vendedora de autos en Córdoba, Argentina\n\n### DIRECTOR'S NOTES\nStyle: ${style}.\nOnly speak the words under TRANSCRIPT. Never read these notes aloud.\n\n### TRANSCRIPT\n${text}`
      : text;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voiceName || 'Kore' } } } },
    };
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Voz Gemini ${model} (${res.status}): ${d?.error?.message || 'error'}`);
    const part = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) throw new Error('La voz de Gemini no devolvió audio');
    const buf = Buffer.from(part.inlineData.data, 'base64');
    const mime = part.inlineData.mimeType || '';
    if (/l16|pcm/i.test(mime) || !mime) return pcmToWav(buf, +(mime.match(/rate=(\d+)/) || [])[1] || 24000);
    return buf; // wav/mp3/ogg: ffmpeg lo reconoce solo
  }

  // "gemini-auto": el Flash estable más nuevo disponible
  async resolveGemini(model) {
    if (model !== 'gemini-auto') return model;
    const list = await this.geminiModels();
    const ver = (id) => { const m = id.match(/^gemini-(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
    const pick = (re) => list.filter(m => re.test(m.id)).sort((a, b) => ver(b.id) - ver(a.id))[0];
    const best = pick(/^gemini-\d+(\.\d+)?-flash$/) || pick(/^gemini-.*flash(?!.*lite)/) || pick(/^gemini-.*pro/) || list[0];
    if (!best) throw new Error('Tu clave de Gemini no tiene modelos disponibles');
    return best.id;
  }

  async callGemini(model, system, messages, tools) {
    const key = this.geminiKey();
    if (!key) throw new Error('Falta la variable GEMINI_API_KEY en Railway');
    const id = await this.resolveGemini(model);
    const names = {};
    for (const m of messages) for (const b of m.content || []) if (b.type === 'tool_use') names[b.id] = b.name;
    const contents = messages.map(m => {
      if (m._raw) return { role: 'model', parts: m._raw };
      const parts = m.content.map(b => {
        if (b.type === 'text') return { text: b.text };
        if (b.type === 'image') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
        if (b.type === 'tool_use') return { functionCall: { name: b.name, args: b.input || {} } };
        if (b.type === 'tool_result') {
          let r; try { r = JSON.parse(b.content); } catch { r = { resultado: b.content }; }
          return { functionResponse: { name: names[b.tool_use_id] || 'herramienta', response: r } };
        }
        return null;
      }).filter(Boolean);
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });
    const body = {
      systemInstruction: { parts: [{ text: system.map(b => b.text).join('\n\n') }] },
      contents,
      tools: tools.length ? [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }] : undefined,
      generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
    };
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${base}/models/${encodeURIComponent(id)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${id} (${res.status}): ${d?.error?.message || 'error'}`);
    const cand = d.candidates?.[0];
    if (!cand) throw new Error('Gemini no respondió' + (d.promptFeedback?.blockReason ? ` (bloqueado: ${d.promptFeedback.blockReason})` : ''));
    const raw = cand.content?.parts || [];
    const content = [];
    raw.forEach((p, i) => {
      if (p.functionCall) content.push({ type: 'tool_use', id: `g${Date.now()}_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} });
      else if (p.text && !p.thought) content.push({ type: 'text', text: p.text });
    });
    return { content, raw, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', model: id };
  }

  async runAgent(ctx, history, simulate) {
    const s = getSettings();
    const system = this.buildSystem(s, ctx);
    const messages = [...history];
    const actions = [];
    const gemini = /^gemini/.test(s.model);
    for (let i = 0; i < 5; i++) {
      const busca = s.stockEnabled || s.marketEnabled;
      const tools = [...TOOLS, ...(busca ? STOCK_TOOLS : []), ...(busca && s.sendPhotos ? [PHOTO_TOOL] : []), ...(credito.ruthinaConfig(s).listo ? [CREDIT_TOOL] : [])];
      const res = gemini
        ? await this.callGemini(s.model, system, messages, tools)
        : await this.callClaude({ model: s.model, max_tokens: 1024, system, messages, tools });
      messages.push(gemini ? { role: 'assistant', content: res.content, _raw: res.raw } : { role: 'assistant', content: res.content });
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
      if (simulate) return { ok: true, simulado: true, mensaje: 'Cita registrada (simulación, no se guardó)', ubicacion_google_maps: s.mapsUrl || undefined };
      const r = q.addCita.run({
        session_id: sid, jid, nombre: input.nombre || null, telefono: ctx.telefono || null, fecha: input.fecha, hora,
        motivo: input.motivo || 'otro', vehiculo: input.vehiculo || null, notas: input.notas || null, created_at: now(),
      });
      q.upsertLead.run({ session_id: sid, jid, nombre: input.nombre || null, interes: null, vehiculo_interes: null, presupuesto: null, usado_entrega: null, financiacion: null, notas: null, updated_at: now() });
      const cita = q.getCita.get(r.lastInsertRowid);
      this.emit('cita', { ...cita, session_name: q.getSession.get(sid)?.name });
      return { ok: true, cita_id: cita.id, mensaje: 'Cita registrada', ubicacion_google_maps: s.mapsUrl || undefined };
    }
    if (name === 'calificar_credito') {
      const r = await credito.calificar(s, { documento: input.documento, sexo: input.sexo, nombre: input.nombre || ctx.nombreWa, telefono: ctx.telefono, auto: input.auto, rol: input.rol });
      if (!r.ok) return r;
      const a = credito.paraAra(r.raw);
      const ai = credito.interno(r.raw);
      if (!simulate) {
        q.upsertLead.run({ session_id: sid, jid, nombre: null, interes: 'financiacion', vehiculo_interes: input.auto || null, presupuesto: null, usado_entrega: null, financiacion: null, notas: null, updated_at: now() });
        credito.creditos.add.run({
          session_id: sid, jid, documento: r.documento, cuil: r.cuil, nombre: input.nombre || ctx.nombreWa || null, rol: input.rol === 'segundo' ? 'segundo' : 'titular',
          solicitud_id: r.raw.solicitud_id != null ? String(r.raw.solicitud_id) : null, estado: a.respuesta_final ? 'final' : 'pendiente',
          resultado: a.tiene_credito ? 'califica' : a.califica === false ? 'no_califica' : null, bancos: JSON.stringify(ai.bancos_aprobados),
          avisado: a.respuesta_final ? 1 : 0, created_at: now(), updated_at: now(),
        });
        credito.creditos.leadCredito.run(credito.textoLead(r.raw) + (input.rol === 'segundo' ? ' (2do DNI)' : ''), sid, jid);
        this.emit('credito', { session_id: sid, jid, nombre: input.nombre || ctx.nombreWa, resultado: credito.textoLead(r.raw) });
        this.emit('lead', { session_id: sid, jid });
      }
      let instruccion;
      if (!a.respuesta_final) instruccion = 'Los bancos todavía están respondiendo. Decile que lo estás consultando y que le escribís en unos minutos con el resultado.';
      else if (a.tiene_credito) instruccion = `Tiene crédito aprobado. Decile "¡Felicitaciones, ${input.nombre || 'nombre del cliente'}! Tenés crédito aprobado" (sin montos ni bancos) y tratá de agendar la cita ya, ofreciendo dos opciones de día y horario.`;
      else if (a.califica === false) instruccion = input.rol === 'segundo'
        ? 'Este segundo DNI tampoco califica. Decíselo con tacto y ofrecé otras opciones (contado, permuta) y una cita con un asesor.'
        : 'No califica con este DNI. Decíselo con tacto y pedile el DNI de otra persona de su entorno (pareja, familiar) que pueda ser titular o garante.';
      else instruccion = 'Un asesor tiene que terminar de revisar la consulta. Decile que un asesor le confirma a la brevedad y proponé una cita.';
      return { ok: true, ...a, instruccion, simulacion: simulate ? 'Consulta real hecha desde el simulador (no se avisa por WhatsApp)' : undefined };
    }
    if (name === 'buscar_stock') {
      const web = s.stockEnabled && stock.getStock().autos.length ? stock.buscar(input) : { total: 0, autos: [] };
      let red = { total: 0, autos: [] }, redError;
      if (s.marketEnabled) {
        try { red = await market.buscarMarket(s, input, s.stockEnabled ? stock.getStock().autos : []); }
        catch (e) { redError = e.message; }
      }
      if (!web.total && !red.total && redError && !stock.getStock().autos.length) return { ok: false, error: 'El stock no está disponible ahora. Ofrecé que un asesor le pase opciones.' };
      return {
        ok: true,
        web: { total: web.total, autos: web.autos },
        red_tutu_match: { total: red.total, autos: red.autos },
        orden: 'Mostrá primero los de "web" y después los de "red_tutu_match".',
        nota: (web.total > web.autos.length || red.total > red.autos.length) ? 'Hay más resultados de los que se muestran. Afiná la búsqueda si hace falta.' : undefined,
      };
    }
    if (name === 'enviar_fotos_auto' && /^m/i.test(String(input.id))) {
      const a = await market.autoMarketPorId(s, input.id);
      if (!a) return { ok: false, error: 'No encontré ese auto en Tutu Market. Volvé a buscarlo con buscar_stock.' };
      const fotos = a.fotosReales.slice(0, s.maxPhotos);
      if (!fotos.length) return { ok: false, error: 'Ese auto de la red no tiene fotos reales todavía. Pasale el link.', link: a.link };
      const caption = `${a.nombre} ${a.anio}${a.km ? ' · ' + Number(a.km).toLocaleString('es-AR') + ' km' : ''}\n${a.link}`;
      if (simulate) return { ok: true, simulado: true, enviadas: fotos.length, fotos, caption };
      let enviadas = 0;
      for (let i = 0; i < fotos.length; i++) {
        try {
          const r = await fetch(fotos[i], { signal: AbortSignal.timeout(20000) });
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          let mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
          if (!/^image\/(jpeg|png|webp)$/.test(mime)) mime = 'image/jpeg';
          await wa.sendFile(sid, jid, buf, mime, 'foto.jpg', i === 0 ? caption : undefined, { byBot: true });
          enviadas++;
        } catch (e) { console.warn('Foto market no enviada:', e.message); }
      }
      return enviadas ? { ok: true, enviadas } : { ok: false, error: 'No se pudieron descargar las fotos. Pasale el link.', link: a.link };
    }
    if (name === 'enviar_fotos_auto') {
      const a = stock.porId(input.id);
      if (!a) return { ok: false, error: 'No encontré ese auto en el stock. Volvé a buscarlo con buscar_stock.' };
      const fotos = a.fotos.slice(0, s.maxPhotos);
      if (!fotos.length) return { ok: false, error: 'Ese auto no tiene fotos publicadas. Pasale el link.', link: a.link };
      const caption = `${a.nombre}\n${a.precioTexto}${a.km != null ? ' · ' + a.km.toLocaleString('es-AR') + ' km' : ''}\n${a.link}`;
      if (simulate) return { ok: true, simulado: true, enviadas: fotos.length, fotos, caption };
      let enviadas = 0;
      for (let i = 0; i < fotos.length; i++) {
        try {
          const r = await fetch(fotos[i], { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (CRM Tutu - ARA)' } });
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          let mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
          if (!/^image\/(jpeg|png|webp)$/.test(mime)) mime = 'image/jpeg';
          await wa.sendFile(sid, jid, buf, mime, 'foto.jpg', i === 0 ? caption : undefined, { byBot: true });
          enviadas++;
        } catch (e) { console.warn('Foto no enviada:', e.message); }
      }
      return enviadas ? { ok: true, enviadas } : { ok: false, error: 'No se pudieron descargar las fotos. Pasale el link.', link: a.link };
    }
    if (name === 'cancelar_cita') {
      if (simulate) return { ok: true, simulado: true };
      const n = q.cancelCitasChat.run(sid, jid).changes;
      this.emit('citas', {});
      return { ok: true, canceladas: n };
    }
    if (name === 'cargar_consignacion') {
      if (simulate) return { ok: true, simulado: true, mensaje: 'Auto cargado (simulación, no se guardó)' };
      const r = await ruthina.cargarAutoAStock({ tel: ctx.telefono, nombre: input.nombre || ctx.nombreWa, marca: input.marca, modelo: input.modelo, version: input.version, anio: input.anio, km: input.km, precio: input.precio_pedido, estadoGeneral: input.estado_general, color: input.color, moneda: input.moneda, detalles: input.detalles, consignacion: input.consignacion });
      if (r.ok) this.emit('tutumatch', { session_id: sid, jid, nombre: input.nombre || ctx.nombreWa, auto: [input.marca, input.modelo, input.anio].filter(Boolean).join(' '), accion: r.accion });
      if (!r.ok) return { ok: false, error: r.error, instruccion: 'No le avises nada al cliente de este error; seguí la charla y, si hace falta, derivá a un asesor para que cargue el auto.' };
      q.upsertLead.run({ session_id: sid, jid, nombre: input.nombre || null, interes: 'consignacion', vehiculo_interes: null, presupuesto: null, usado_entrega: [input.marca, input.modelo, input.version, input.anio, input.km && input.km + ' km', input.precio_pedido && 'pretende ' + input.precio_pedido + (input.moneda === 'USD' ? ' USD' : '')].filter(Boolean).join(' '), financiacion: null, notas: input.consignacion ? 'Consignación: ' + input.consignacion : null, updated_at: now() });
      this.emit('lead', { session_id: sid, jid });
      return { ok: true, mensaje: 'Auto cargado para evaluación', instruccion: 'Si todavía no mandó fotos, pedile fotos del auto (frente, costados, atrás, interior y tablero). Solo fotos del vehículo.' };
    }
    if (name === 'registrar_lead') {
      if (simulate) return { ok: true, simulado: true };
      const f = (k) => (input[k] ? String(input[k]).slice(0, 500) : null);
      q.upsertLead.run({
        session_id: sid, jid, nombre: f('nombre'), interes: f('interes'), vehiculo_interes: f('vehiculo_interes'),
        presupuesto: f('presupuesto'), usado_entrega: f('usado_entrega'), financiacion: f('financiacion'), notas: f('notas'), updated_at: now(),
      });
      this.emit('lead', { session_id: sid, jid });
      const L = q.getLead.get(sid, jid);
      if (L && L.interes === 'compra') ruthina.enviarClienteCompra(sid, jid, L).catch(() => {});
      return { ok: true };
    }
    if (name === 'derivar_a_humano') {
      if (simulate) return { ok: true, simulado: true, instruccion: 'Avisale al cliente que un asesor le escribe a la brevedad.' };
      q.setBot.run({ session_id: sid, jid, paused_until: now() + Math.round(s.handoffHours * 3600), needs_human: 1, reason: String(input.motivo || '').slice(0, 300) });
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
          if (!b || b.needs_human || (b.paused_until < until && b.paused_until !== FOREVER)) {
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
    if (m.type === 'audio' && !m.text && this.openaiKey()) this.transcribe(sid, m);
    if (m.ts < now() - 600) return;          // mensajes viejos que llegan al reconectar
    if (!this.canReply(sid, jid)) return;
    const bh = q.getBot.get(sid, jid);
    if (bh?.needs_human) {
      const key = sid + '|' + jid + '|' + bh.paused_until;
      this._avisados = this._avisados || new Set();
      if (!this._avisados.has(key)) {
        this._avisados.add(key);
        const chat = q.getChat.get(sid, jid);
        this.emit('bot', { session_id: sid, jid, ...bh, alerta: true, sigueEsperando: true, telefono: '+' + jid.split('@')[0], nombre: chat?.name });
        console.log(`🙋 ${chat?.name || jid.split('@')[0]} sigue esperando un asesor: nadie respondió en ${getSettings().handoffHours} h, ARA retoma la charla`);
      }
    }
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
      const notas = this.notas?.get(k) || [];
      this.notas?.delete(k);
      const history = await this.buildHistory(sid, jid, { allowAssistantLast: notas.length > 0 });
      if (!history) return;
      if (notas.length) {
        const last = history[history.length - 1];
        const block = { type: 'text', text: notas.join('\n') };
        if (last.role === 'user') last.content.push(block); else history.push({ role: 'user', content: [block] });
      }
      const chat = q.getChat.get(sid, jid);
      const s0 = getSettings();
      const ultimo = q.listMsgs.all(sid, jid, Number.MAX_SAFE_INTEGER, 30).find(r => !r.from_me);
      const voz = !!(s0.voiceReplies && ultimo?.type === 'audio' && this.geminiKey());
      const ctx = { sid, jid, voz, telefono: '+' + jid.split('@')[0], nombreWa: chat?.name || q.getContact.get(sid, jid)?.name };
      await wa.typing(sid, jid, true, voz ? 'recording' : 'composing');
      const { text, actions } = await this.runAgent(ctx, history, false);
      if (actions.length) this.emit('actions', { session_id: sid, jid, actions });
      // Si mientras pensaba escribió una persona, no mandamos nada
      const b = q.getBot.get(sid, jid);
      const humanTookOver = b && b.paused_until > now() && b.reason === 'Respondió una persona';
      if (!text || text.includes('[SILENCIO]') || humanTookOver) { await wa.typing(sid, jid, false); return; }
      if (voz) {
        const { hablado, links } = splitVoice(text);
        try {
          await wa.typing(sid, jid, true, 'recording');
          const audio = await this.speak(hablado, s0);
          await wa.sendVoice(sid, jid, audio, { byBot: true });
          console.log(`🗣️ ARA respondió con audio (${hablado.length} caracteres)`);
          for (const l of links) await wa.sendText(sid, jid, l, { byBot: true });
          await wa.typing(sid, jid, false);
          return;
        } catch (e) {
          console.warn('🗣️ No se pudo generar el audio, respondo por texto:', e.message);
          this.emit('araerror', { session_id: sid, jid, error: 'No pude responder con audio (mandé texto). ' + e.message });
        }
      }
      const parts = splitMessages(text.replace(/^LINK:\s*/gim, ''));
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

  // Recordatorio por WhatsApp X horas antes de cada cita
  startReminders() {
    const tick = async () => {
      const s = getSettings();
      if (!s.reminderEnabled) return;
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
      const manana = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + 48 * 3600 * 1000));
      for (const c of q.citasParaRecordar.all(hoy, manana)) {
        const cuando = Date.parse(`${c.fecha}T${String(c.hora).padStart(5, '0')}:00-03:00`);
        if (isNaN(cuando)) continue;
        const faltan = cuando - Date.now();
        const ventana = s.reminderHours * 3600 * 1000;
        if (faltan > ventana) continue;                       // todavía no
        if (faltan <= 0) { q.setRecordatorio.run(-1, c.id); continue; }       // ya pasó
        if (c.created_at * 1000 > cuando - ventana) { q.setRecordatorio.run(-1, c.id); continue; } // se agendó hace un rato: no hace falta
        const sess = wa.sessions.get(c.session_id);
        if (sess?.status !== 'open') continue;                // se reintenta cuando vuelva a conectarse
        const nombre = (c.nombre || q.getChat.get(c.session_id, c.jid)?.name || '').split(' ')[0];
        const texto = String(s.reminderText || DEFAULTS.reminderText)
          .replace(/\{nombre\}/g, nombre).replace(/\{hora\}/g, c.hora).replace(/\{mapa\}/g, s.mapsUrl || '')
          .replace(/\{dia\}/g, new Date(`${c.fecha}T12:00:00-03:00`).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }))
          .replace(/\{cuando\}/g, (() => { const hoyD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); const man = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + 86400000)); return c.fecha === hoyD ? 'hoy' : c.fecha === man ? 'mañana' : 'el ' + new Date(`${c.fecha}T12:00:00-03:00`).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', timeZone: TZ }); })())
          .replace(/\{motivo\}/g, c.motivo || '').replace(/\{vehiculo\}/g, c.vehiculo || '')
          .replace(/¡Hola !/g, '¡Hola!').replace(/\n*📍 Cómo llegar: *\n/g, '\n').trim();
        try {
          q.setRecordatorio.run(1, c.id);
          await wa.sendText(c.session_id, c.jid, texto, { byBot: true });
          console.log(`🔔 Recordatorio enviado: cita #${c.id} (${c.nombre || c.telefono}) ${c.fecha} ${c.hora}`);
          this.emit('recordatorio', { ...c, session_name: q.getSession.get(c.session_id)?.name });
          this.emit('citas', {});
        } catch (e) {
          q.setRecordatorio.run(0, c.id);
          console.warn('🔔 No se pudo mandar el recordatorio:', e.message);
        }
      }
    };
    setTimeout(() => tick().catch(() => {}), 5000);
    setInterval(() => tick().catch(() => {}), 60 * 1000);
  }

  // Revisa las consultas de crédito que quedaron pendientes y avisa al cliente cuando llega el resultado
  startCreditPoller() {
    this.notas = this.notas || new Map();
    const tick = async () => {
      const s = getSettings();
      if (!credito.ruthinaConfig(s).listo) return;
      for (const c of credito.creditos.pendientes.all(now() - 20 * 60)) {
        try {
          const r = await credito.consultarSolicitud(s, c.solicitud_id);
          const a = credito.interno(r);
          const vencido = c.created_at < now() - 12 * 60;
          if (!a.respuesta_final && !vencido) continue;
          const resultado = a.tiene_credito ? 'califica' : a.califica === false ? 'no_califica' : null;
          credito.creditos.upd.run({ id: c.id, estado: 'final', resultado, bancos: JSON.stringify(a.bancos_aprobados), avisado: 1, updated_at: now() });
          credito.creditos.leadCredito.run(credito.textoLead(r) + (c.rol === 'segundo' ? ' (2do DNI)' : ''), c.session_id, c.jid);
          this.emit('credito', { session_id: c.session_id, jid: c.jid, nombre: c.nombre, resultado: credito.textoLead(r) });
          this.emit('lead', { session_id: c.session_id, jid: c.jid });
          const resumen = resultado === 'califica' ? 'TIENE crédito aprobado (decile "¡Felicitaciones, [nombre]! Tenés crédito aprobado", sin montos ni bancos, y tratá de agendar la cita ya)'
            : resultado === 'no_califica' ? `NO califica${c.rol === 'segundo' ? ' (era el segundo DNI)' : ''}`
            : 'quedó para que la termine de revisar un asesor';
          const k = c.session_id + '|' + c.jid;
          this.notas.set(k, [...(this.notas.get(k) || []), `[Aviso del sistema, no lo escribió el cliente] Llegó el resultado de la consulta de crédito del DNI terminado en ${String(c.documento).slice(-3)} (${c.nombre || 'titular'}): ${resumen}. Escribile al cliente ahora para contarle, siguiendo las reglas de CRÉDITO.`]);
          this.respond(c.session_id, c.jid);
        } catch (e) { console.warn('Crédito (seguimiento):', e.message); }
      }
    };
    setInterval(() => tick().catch(() => {}), 20 * 1000);
  }

  // Simulador del panel: misma ARA, sin WhatsApp y sin guardar nada
  async simulate(conversation, { voz = false } = {}) {
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
    const { text, actions } = await this.runAgent({ sid: 'sim', jid: 'sim', voz, telefono: '+5493510000000', nombreWa: 'Cliente de prueba' }, turns, true);
    const silent = !text || text.includes('[SILENCIO]');
    if (!silent && voz) {
      const { hablado, links } = splitVoice(text);
      let audio = null, audioError = null;
      try { audio = 'data:audio/mpeg;base64,' + (await toMp3(await this.speak(hablado, getSettings()))).toString('base64'); }
      catch (e) { audioError = e.message; }
      return { replies: [hablado, ...links], audio, audioError, silent, actions };
    }
    return { replies: silent ? [] : splitMessages(text.replace(/^LINK:\s*/gim, '')), silent, actions };
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

// Separa lo que se dice en voz alta de los links (que van escritos)
function splitVoice(text) {
  const links = [];
  const lines = text.replace(/\*\*?|#+\s*/g, '').split('\n').filter(l => {
    const m = l.match(/^\s*LINK:\s*(.+)$/i);
    if (m) { links.push(m[1].trim()); return false; }
    return true;
  });
  let hablado = lines.join(' ').replace(/https?:\/\/\S+/g, (u) => { links.push(u); return ''; }).replace(/\s+/g, ' ').trim();
  if (!hablado) hablado = 'Te paso la info por acá.';
  return { hablado: hablado.slice(0, 1500), links: [...new Set(links)] };
}

function splitMessages(text) {
  const clean = text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').trim();
  let parts = clean.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 3) parts = [parts[0], parts[1], parts.slice(2).join('\n\n')];
  return parts;
}

// Derivaciones anteriores a este cambio quedaban pausadas para siempre: ahora vencen (ARA retoma si el cliente escribe)
try { db.prepare(`UPDATE chat_bot SET paused_until = ? WHERE needs_human = 1 AND paused_until >= ?`).run(Math.floor(Date.now() / 1000), FOREVER); } catch {}

// Sincroniza el stock de la web cada X minutos
export function startStockSync() {
  const tick = async () => {
    const s = getSettings();
    if (!s.stockEnabled) return;
    const c = stock.getStock();
    const last = Math.max(c.updatedAt || 0, c.errorAt || 0);
    if (Date.now() - last > s.stockMinutes * 60 * 1000 || c.source !== s.stockUrl.replace(/\/+$/, '')) {
      const r = await stock.refresh(s.stockUrl);
      console.log(r.error ? `Stock: error (${r.error})` : `Stock: ${r.autos.length} autos cargados`);
    }
  };
  setTimeout(tick, 3000);
  setInterval(tick, 60 * 1000);
}

export default new Ara();
