// Tutu Market / Tutu Match: búsqueda de autos de la red (stock de Ruthina). La carga de autos y fotos está en ruthina-sync.js

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');

let cache = { at: 0, autos: [], error: null, base: '' };

export async function autosMarket(s, { force = false } = {}) {
  const base = String(s.ruthinaUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Falta la dirección de Ruthina (ARA → General)');
  if (!force && cache.base === base && Date.now() - cache.at < 15 * 60 * 1000 && cache.autos.length) return cache.autos;
  try {
    const r = await fetch(base + '/api/market/autos', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.autos)) throw new Error(`Tutu Market respondió ${r.status}`);
    cache = { at: Date.now(), autos: d.autos, error: null, base };
  } catch (e) {
    cache.error = e.message;
    if (!cache.autos.length) throw e;
  }
  return cache.autos;
}
export const marketEstado = () => ({ total: cache.autos.length, at: cache.at, error: cache.error });

const linkDe = (s, a) => `${String(s.marketUrl || 'https://tutu-market-bytutumatch.up.railway.app').replace(/\/+$/, '')}/?auto=${a.id}`;

// Búsqueda en la red, salteando los autos que ya aparecen en la web de Tutu
export async function buscarMarket(s, f = {}, webAutos = []) {
  const autos = await autosMarket(s);
  const tokens = norm(f.texto).split(' ').filter(t => t.length > 1);
  const enWeb = (a) => webAutos.some(w => {
    const n = norm(w.nombre);
    return String(w.anio) === String(a.anio) && n.includes(norm(a.modelo).split(' ')[0])
      && (!a.km || !w.km || Math.abs(Number(a.km) - Number(w.km)) < 1500);
  });
  const res = autos.filter(a => {
    const hay = norm(`${a.marca} ${a.modelo} ${a.version} ${a.anio} ${a.color} ${a.tipo}`);
    if (tokens.length && !tokens.every(t => hay.includes(t))) return false;
    if (f.anio_min && +a.anio && +a.anio < +f.anio_min) return false;
    if (f.km_max && a.km && a.km > +f.km_max) return false;
    if (f.condicion === '0km' && a.km > 100) return false;
    if (f.condicion === 'usado' && a.km === 0) return false;
    if (f.tipo && /moto/i.test(f.tipo) !== (a.tipo === 'moto')) return false;
    return !enWeb(a);
  }).sort((a, b) => (b.fotos_reales - a.fotos_reales) || (+b.anio - +a.anio));
  return {
    total: res.length,
    autos: res.slice(0, 10).map(a => ({
      id: 'M' + a.id,
      nombre: [a.marca, a.modelo, a.version].filter(Boolean).join(' '),
      anio: a.anio, km: a.km, color: a.color || undefined,
      reservado: a.reservado || undefined,
      fotos: a.fotos_reales ? a.fotos.length : 0,
      link: linkDe(s, a),
      precio: 'a consultar con un asesor',
    })),
  };
}

export async function autoMarketPorId(s, id) {
  const n = String(id).replace(/^M/i, '');
  const a = (await autosMarket(s)).find(x => String(x.id) === n);
  if (!a) return null;
  return { ...a, nombre: [a.marca, a.modelo, a.version].filter(Boolean).join(' '), link: linkDe(s, a), fotosReales: a.fotos_reales ? a.fotos : [] };
}
