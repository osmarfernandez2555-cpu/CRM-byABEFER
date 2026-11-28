// Conexión del CRM/ARA con Ruthina y Tutu Market (lo que antes hacían los bots de venta y consignas):
//  1. Fotos que mandan los clientes  -> Tutu Market (Ruthina las mira con IA: solo se publican fotos de vehículos)
//  2. Auto que quiere consignar/vender -> stock de Ruthina (estado "A revisar")
//  3. Cliente que quiere comprar       -> tarjeta de cliente en Ruthina (buscador de clientes / matches)
//
// Variables de entorno (Railway):
//   MARKET_KEY   la misma que en Ruthina (compara-conejo). Sin ella no se suben fotos al Market.
//   RUTHINA_URL  (opcional) por defecto https://compara-conejo-production.up.railway.app
//   RUTHINA_SYNC=0  apaga todo esto
import db, { q } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS ruthina_envios (
  session_id TEXT NOT NULL, jid TEXT NOT NULL, tipo TEXT NOT NULL, ruthina_id INTEGER, updated_at INTEGER,
  PRIMARY KEY (session_id, jid, tipo))`);

const activo = () => process.env.RUTHINA_SYNC !== '0';
const ruthinaUrl = () => {
  let s = {}; try { s = JSON.parse(q.getSetting.get('ara')?.value || '{}'); } catch {}
  return String(process.env.RUTHINA_URL || s.ruthinaUrl || 'https://compara-conejo-production.up.railway.app').replace(/\/+$/, '');
};
// Teléfono como lo guardan los bots viejos: solo dígitos, sin el 54 del país
export const telDe = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '').replace(/^54/, '');
const telValido = (t) => t.length >= 9 && t.length <= 13;
const limpio = (v) => { const s = String(v ?? '').trim(); return !s || /^(x|xx+|si\/no|n\/a|na|-|\.)$/i.test(s) ? '' : s; };
const soloNum = (v) => {
  const t = String(v ?? '').toLowerCase();
  const n = Number(t.replace(/[^\d]/g, '')) || 0;
  return String(/mill|palo/.test(t) && n > 0 && n < 10000 ? n * 1000000 : n || '');   // "5 millones" -> 5000000
};

// ARA solo trabaja en los celulares elegidos en el panel (vacío = todos): la misma regla vale para las fotos
function sesionDeAra(sid) {
  let s = {}; try { s = JSON.parse(q.getSetting.get('ara')?.value || '{}'); } catch {}
  return !s.sessions?.length || s.sessions.includes(sid);
}

// 1) Foto de un cliente -> Tutu Market
export async function subirFotoMarket(sid, jid, buf, mime) {
  if (!activo() || !sesionDeAra(sid)) return 'apagado';
  const tel = telDe(jid);
  if (!jid?.endsWith('@s.whatsapp.net') || !telValido(tel)) return 'sin_telefono';
  const key = String(process.env.MARKET_KEY || '').trim();
  if (!key) { console.log('[Ruthina] Falta MARKET_KEY: la foto no se sube al Market'); return 'falta_clave'; }
  const m = String(mime || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(m)) return 'formato';
  try {
    const r = await fetch(ruthinaUrl() + '/api/market/fotos-wa', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-market-key': key },
      body: JSON.stringify({ telefono: tel, mime: m, base64: Buffer.from(buf).toString('base64') }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('[Ruthina] El Market rechazó la foto:', d.error || r.status); return 'rechazada:' + (d.error || r.status); }
    const est = d.repetida ? 'repetida' : d.ignorada ? 'tope' : d.estado || 'ok';
    console.log(`[Ruthina] Foto de ${tel} -> Market: ${est}${d.filtrada ? ' (no es un vehículo, no se publica)' : ''}`);
    return est;
  } catch (e) { console.error('[Ruthina] No se pudo subir la foto:', e.message); return 'error:' + e.message; }
}

// 2) Auto que el cliente quiere vender o dejar en consignación -> stock de Ruthina
export async function cargarAutoAStock({ tel, nombre, marca, modelo, version, anio, km, precio, estadoGeneral, color, moneda, detalles, consignacion }) {
  if (!activo()) return { ok: false, error: 'sincronización apagada' };
  tel = telDe(tel);
  const mod = limpio(modelo);
  if (!mod) return { ok: false, error: 'Falta el modelo del auto' };
  if (!telValido(tel)) return { ok: false, error: 'No tengo el teléfono del cliente' };
  const body = {
    marca: limpio(marca) || 'Sin especificar', modelo: mod, version: limpio(version), anio: limpio(anio),
    km: soloNum(km) || 0, color: limpio(color), precio: soloNum(precio) || '', moneda: moneda === 'USD' ? 'USD' : 'ARS', estado: 'A revisar',
    notas: `Cargado automático por ARA (WhatsApp). Precio pedido por el vendedor (${limpio(nombre) || 'sin nombre'}), sujeto a tasación e inspección de Tutu.`
      + (limpio(consignacion) ? ' Consignación: ' + limpio(consignacion) + '.' : '')
      + (limpio(estadoGeneral) ? ' Estado que cuenta el cliente: ' + limpio(estadoGeneral) + '.' : '')
      + (limpio(detalles) ? ' Detalles: ' + limpio(detalles) : ''),
    ubicacion: `${limpio(nombre) || 'Sin nombre'} - ${tel}`, telefono: tel,
  };
  try {
    const r = await fetch(ruthinaUrl() + '/api/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => ({}));
    if (d.ok) { console.log(`[Ruthina] Auto de ${tel} cargado al stock (${d.accion}): ${body.marca} ${body.modelo}`); return { ok: true, accion: d.accion }; }
    console.error('[Ruthina] Error al cargar el auto:', d.error || r.status);
    return { ok: false, error: d.error || 'Ruthina respondió ' + r.status };
  } catch (e) { console.error('[Ruthina] No se pudo cargar el auto:', e.message); return { ok: false, error: e.message }; }
}

// 3) Cliente que quiere comprar -> tarjeta en el buscador de clientes de Ruthina (crea o actualiza la misma)
export async function enviarClienteCompra(sid, jid, d) {
  if (!activo()) return false;
  const tel = telDe(jid);
  const modelo = limpio(d.vehiculo_interes);
  const nombre = limpio(d.nombre);
  if (!jid?.endsWith('@s.whatsapp.net') || !telValido(tel) || !modelo || !nombre) return false;
  const body = {
    nombre, telefono: tel, modelo, presupuesto: soloNum(d.presupuesto) || '',
    notas: ['Cargado automático por ARA (WhatsApp)', limpio(d.financiacion) && 'Financiación: ' + limpio(d.financiacion), limpio(d.notas)].filter(Boolean).join(' | '),
    tiene_permuta: limpio(d.usado_entrega) ? 'si' : 'no', auto_permuta: limpio(d.usado_entrega),
  };
  try {
    const previo = db.prepare('SELECT ruthina_id FROM ruthina_envios WHERE session_id=? AND jid=? AND tipo=?').get(sid, jid, 'compra');
    if (previo?.ruthina_id) {
      const pr = await fetch(`${ruthinaUrl()}/api/clientes/${previo.ruthina_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const pd = await pr.json().catch(() => ({}));
      if (pr.ok && pd.updated !== 0) { db.prepare('UPDATE ruthina_envios SET updated_at=? WHERE session_id=? AND jid=? AND tipo=?').run(Date.now(), sid, jid, 'compra'); return true; }
    }
    const r = await fetch(ruthinaUrl() + '/api/clientes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const dd = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('[Ruthina] Error al cargar el cliente:', dd.error || r.status); return false; }
    db.prepare(`INSERT INTO ruthina_envios (session_id, jid, tipo, ruthina_id, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id, jid, tipo) DO UPDATE SET ruthina_id=excluded.ruthina_id, updated_at=excluded.updated_at`).run(sid, jid, 'compra', dd.id || null, Date.now());
    console.log(`[Ruthina] Cliente ${tel} cargado en Ruthina: ${nombre} · ${modelo}`);
    return true;
  } catch (e) { console.error('[Ruthina] No se pudo cargar el cliente:', e.message); return false; }
}
