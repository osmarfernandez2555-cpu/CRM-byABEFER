// Calificación crediticia de clientes a través de Ruthina (POST /api/bot/calificar, el mismo que usa Kommo)
import db, { q } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS creditos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, jid TEXT,
  documento TEXT, cuil TEXT, nombre TEXT, rol TEXT DEFAULT 'titular',
  solicitud_id TEXT, estado TEXT, resultado TEXT, bancos TEXT,
  avisado INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cred_chat ON creditos(session_id, jid, created_at);
`);
try { db.exec('ALTER TABLE leads ADD COLUMN credito TEXT'); } catch {}

const st = {
  add: db.prepare(`INSERT INTO creditos (session_id, jid, documento, cuil, nombre, rol, solicitud_id, estado, resultado, bancos, avisado, created_at, updated_at)
    VALUES (@session_id, @jid, @documento, @cuil, @nombre, @rol, @solicitud_id, @estado, @resultado, @bancos, @avisado, @created_at, @updated_at)`),
  upd: db.prepare(`UPDATE creditos SET estado=@estado, resultado=@resultado, bancos=@bancos, avisado=@avisado, updated_at=@updated_at WHERE id=@id`),
  get: db.prepare('SELECT * FROM creditos WHERE id = ?'),
  pendientes: db.prepare(`SELECT * FROM creditos WHERE avisado = 0 AND solicitud_id IS NOT NULL AND estado = 'pendiente' AND created_at > ?`),
  deChat: db.prepare('SELECT * FROM creditos WHERE session_id = ? AND jid = ? ORDER BY created_at DESC LIMIT 5'),
  todos: db.prepare(`SELECT c.*, s.name AS session_name FROM creditos c LEFT JOIN sessions s ON s.id = c.session_id ORDER BY c.created_at DESC LIMIT 300`),
  leadCredito: db.prepare('UPDATE leads SET credito = ? WHERE session_id = ? AND jid = ?'),
};
export const creditos = st;

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

// Regla de AFIP: hombre 20, mujer 27; si el verificador da 10, prefijo 23
export function cuilDesdeDni(dni, sexo) {
  const d = soloDigitos(dni);
  if (d.length < 7 || d.length > 8) return '';
  const num = d.padStart(8, '0');
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const calc = (pre) => { const b = pre + num; const r = 11 - (w.reduce((a, x, i) => a + x * Number(b[i]), 0) % 11); return r === 11 ? 0 : r; };
  let pre = sexo === 'F' ? '27' : '20';
  let dv = calc(pre);
  if (dv === 10) { pre = '23'; dv = calc(pre); }
  return pre + num + dv;
}
export function cuilValido(c) {
  if (!/^\d{11}$/.test(c)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let dv = 11 - (w.reduce((a, x, i) => a + x * Number(c[i]), 0) % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(c[10]);
}

export function ruthinaConfig(settings) {
  const url = String(settings.ruthinaUrl || '').trim().replace(/\/+$/, '');
  const key = String(process.env.RUTHINA_BOT_KEY || '').trim().replace(/^["']|["']$/g, '');
  return { url, key, listo: !!(url && key && settings.creditEnabled) };
}

async function llamar(cfg, path, opts = {}) {
  const res = await fetch(cfg.url + path, {
    ...opts,
    headers: { 'x-api-key': cfg.key, 'content-type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });
  const d = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, d };
}

// Prueba de conexión: con un CUIL inválido Ruthina contesta 400 si la clave es correcta
export async function probarRuthina(settings) {
  const cfg = ruthinaConfig({ ...settings, creditEnabled: true });
  if (!cfg.url) throw new Error('Falta la dirección de Ruthina');
  if (!cfg.key) throw new Error('Falta la variable RUTHINA_BOT_KEY en Railway (la misma que tiene Ruthina)');
  const r = await llamar(cfg, '/api/bot/calificar?cuil=1', { method: 'GET', timeout: 20000 });
  if (r.status === 401) throw new Error('Ruthina rechazó la clave: RUTHINA_BOT_KEY no coincide con la de Ruthina');
  if (r.status === 503) throw new Error('Ruthina no tiene configurada RUTHINA_BOT_KEY');
  if (r.status === 400 || r.ok || r.status === 404) return { ok: true };
  throw new Error(`Ruthina respondió ${r.status}: ${r.d?.error || 'error'}`);
}

// Datos internos (panel y ficha del cliente): incluye bancos, nunca montos
export function interno(r) {
  return {
    respuesta_final: !!r.respuesta_final,
    califica: r.califica,
    tiene_credito: r.califica === true || (r.bancos_aprobados || []).length > 0,
    bancos_aprobados: r.bancos_aprobados || [],
  };
}

// Lo que ve ARA: solo si tiene crédito o no. Sin montos y sin nombres de bancos.
export function paraAra(r) {
  const i = interno(r);
  return {
    estado: r.estado,                                  // pendiente | parcial | resuelto | descartado
    respuesta_final: i.respuesta_final,
    califica: i.califica,                              // true | false | null
    tiene_credito: i.tiene_credito,
  };
}

export async function calificar(settings, { documento, sexo, nombre, telefono, auto, rol, esperar = 25 }) {
  const cfg = ruthinaConfig(settings);
  if (!cfg.listo) throw new Error('La consulta de crédito con Ruthina no está configurada');
  let doc = soloDigitos(documento);
  let cuil = '';
  if (doc.length === 11) cuil = doc;
  else if (doc.length >= 7 && doc.length <= 8) {
    const sx = /^f/i.test(sexo || '') ? 'F' : /^m/i.test(sexo || '') ? 'M' : '';
    if (!sx) return { ok: false, error: 'Para armar el CUIL con el DNI necesito saber si el titular es hombre o mujer. Deducilo por el nombre o preguntalo con naturalidad.' };
    cuil = cuilDesdeDni(doc, sx);
  } else {
    return { ok: false, error: 'El DNI tiene que tener 7 u 8 números (o el CUIL 11). Pedíselo de nuevo al cliente.' };
  }
  if (!cuilValido(cuil)) return { ok: false, error: 'Ese CUIL no es válido. Pedile al cliente que lo revise.' };
  const r = await llamar(cfg, '/api/bot/calificar', {
    method: 'POST',
    body: JSON.stringify({ cuil, nombre, telefono, auto, esperar_segundos: Math.min(55, esperar), origen: 'ara', ...(rol === 'segundo' ? { rol: 'garante' } : {}) }),
    timeout: (Math.min(55, esperar) + 20) * 1000,
  });
  if (r.status === 400) return { ok: false, error: r.d?.mensaje_cliente || r.d?.error || 'Dato inválido' };
  if (!r.ok) throw new Error(`Ruthina (${r.status}): ${r.d?.error || 'error'}`);
  return { ok: true, cuil, documento: doc, raw: r.d };
}

export async function consultarSolicitud(settings, id) {
  const cfg = ruthinaConfig(settings);
  if (!cfg.listo) throw new Error('Ruthina no configurada');
  const r = await llamar(cfg, '/api/bot/calificar/' + encodeURIComponent(id), { method: 'GET', timeout: 20000 });
  if (!r.ok) throw new Error(`Ruthina (${r.status}): ${r.d?.error || 'error'}`);
  return r.d;
}

export function textoLead(r) {
  const a = interno(r);
  if (a.califica === true || a.tiene_credito) return `Califica${a.bancos_aprobados.length ? ' (' + a.bancos_aprobados.join(', ') + ')' : ''}`;
  if (a.califica === false) return 'No califica';
  return a.estado === 'pendiente' ? 'Consultando…' : 'A revisar por un asesor';
}
