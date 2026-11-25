// Stock de autos leído de la web de Tutu (WordPress + WooCommerce, API pública de la tienda)
import { q } from './db.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#8211;/g, '–').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

let cache = null;      // { autos, updatedAt, error, source }
let loading = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(q.getSetting.get('stock_cache')?.value || 'null'); } catch {}
  return cache || (cache = { autos: [], updatedAt: 0, error: null, source: null });
}

function attr(p, ...names) {
  const want = names.map(norm);
  const a = (p.attributes || []).find(x => want.includes(norm(x.name)));
  return a ? (a.terms || []).map(t => t.name).join(', ') : '';
}

export function parseProduct(p) {
  const minor = +(p.prices?.currency_minor_unit ?? 0);
  const precio = p.prices?.price ? Math.round(+p.prices.price / 10 ** minor) : null;
  const monedaAttr = norm(attr(p, 'Moneda'));
  const moneda = /usd|u\$d|dolar/.test(monedaAttr) ? 'USD' : (monedaAttr ? 'ARS' : (p.prices?.currency_code === 'USD' ? 'USD' : 'ARS'));
  const kms = attr(p, 'Kms', 'Km', 'Kilometros', 'Kilómetros');
  const name = strip(p.name);
  return {
    id: p.id,
    nombre: name,
    marca: attr(p, 'Marcas Tutu', 'Marca') || (p.brands || []).map(b => b.name).join(', '),
    anio: attr(p, 'Año', 'Ano') || (name.match(/\b(19|20)\d{2}\b/) || [''])[0],
    km: kms ? +String(kms).replace(/\D/g, '') : null,
    combustible: attr(p, 'Combustible'),
    transmision: attr(p, 'Transmisión', 'Transmision'),
    condicion: attr(p, 'Condición', 'Condicion') || (/\b0\s?km\b/i.test(name) ? '0 km' : ''),
    tipologia: attr(p, 'Tipología', 'Tipologia') || (p.categories || []).map(c => c.name).join(', '),
    color: attr(p, 'Color'),
    categorias: (p.categories || []).map(c => strip(c.name)).join(', '),
    precio, moneda,
    precioTexto: precio ? (moneda === 'USD' ? 'U$D ' : '$ ') + precio.toLocaleString('es-AR') : 'Consultar',
    link: p.permalink,
    fotos: (p.images || []).slice(0, 6).map(i => i.src).filter(Boolean),
    detalle: strip(p.short_description || p.description).slice(0, 300),
    disponible: p.is_in_stock !== false,
  };
}

export async function refresh(baseUrl) {
  if (loading) return loading;
  loading = (async () => {
    const base = String(baseUrl || 'https://tutuautomotores.com').replace(/\/+$/, '');
    const autos = [];
    try {
      for (let page = 1; page <= 30; page++) {
        const url = `${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (CRM Tutu - ARA)', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          if (page > 1 && (res.status === 400 || res.status === 404)) break;
          throw new Error(`La web respondió ${res.status}`);
        }
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('La web no devolvió una lista de productos');
        for (const p of list) { const a = parseProduct(p); if (a.disponible) autos.push(a); }
        const total = +res.headers.get('x-wp-totalpages') || 0;
        if (list.length < 100 || (total && page >= total)) break;
      }
      cache = { autos, updatedAt: Date.now(), error: null, source: base };
    } catch (e) {
      cache = { ...load(), error: e.message, errorAt: Date.now() };
    }
    q.setSetting.run('stock_cache', JSON.stringify(cache));
    return cache;
  })().finally(() => { loading = null; });
  return loading;
}

export function getStock() { return load(); }

export function stockResumen() {
  const { autos, updatedAt } = load();
  if (!autos.length) return '';
  const marcas = {};
  const tipos = {};
  for (const a of autos) {
    for (const m of (a.marca || 'Otras').split(',').slice(0, 1)) marcas[m.trim()] = (marcas[m.trim()] || 0) + 1;
    for (const t of (a.tipologia || '').split(',')) if (t.trim()) tipos[t.trim()] = (tipos[t.trim()] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ');
  return `Hay ${autos.length} unidades publicadas en la web (actualizado ${new Date(updatedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}).
Marcas: ${top(marcas)}.
Tipos: ${top(tipos)}.`;
}

// Búsqueda para la herramienta buscar_stock
export function buscar(f = {}) {
  const { autos } = load();
  const tokens = norm(f.texto).split(/\s+/).filter(t => t.length > 1);
  const tipo = norm(f.tipo);
  let res = autos.filter(a => {
    const hay = norm(`${a.nombre} ${a.marca} ${a.tipologia} ${a.categorias} ${a.color} ${a.combustible} ${a.condicion}`);
    if (tokens.length && !tokens.every(t => hay.includes(t))) return false;
    if (tipo && !norm(`${a.tipologia} ${a.categorias} ${a.nombre}`).includes(tipo.replace(/s$/, ''))) return false;
    if (f.condicion === '0km' && !(norm(a.condicion).includes('0') || norm(a.condicion).includes('nuevo') || a.km === 0)) return false;
    if (f.condicion === 'usado' && (a.km === 0 || norm(a.condicion).includes('0 km'))) return false;
    if (f.combustible && !norm(a.combustible).includes(norm(f.combustible))) return false;
    if (f.transmision && !norm(a.transmision).includes(norm(f.transmision).slice(0, 5))) return false;
    if (f.anio_min && +a.anio && +a.anio < +f.anio_min) return false;
    if (f.km_max && a.km != null && a.km > +f.km_max) return false;
    if (f.precio_max && a.precio && a.moneda === (f.moneda || a.moneda) && a.precio > +f.precio_max) return false;
    if (f.precio_min && a.precio && a.moneda === (f.moneda || a.moneda) && a.precio < +f.precio_min) return false;
    return true;
  });
  // Primero los de la moneda pedida y más cerca del presupuesto; si no, los más nuevos
  res.sort((a, b) => {
    if (f.moneda) { const d = (b.moneda === f.moneda) - (a.moneda === f.moneda); if (d) return d; }
    if (f.precio_max) return (b.precio || 0) - (a.precio || 0);
    return (+b.anio || 0) - (+a.anio || 0) || b.id - a.id;
  });
  const total = res.length;
  return {
    total,
    autos: res.slice(0, 8).map(a => ({
      id: a.id, nombre: a.nombre, anio: a.anio, km: a.km, precio: a.precioTexto, combustible: a.combustible,
      transmision: a.transmision, tipo: a.tipologia, color: a.color, condicion: a.condicion, link: a.link,
      fotos: a.fotos.length, detalle: a.detalle || undefined,
    })),
  };
}

export function porId(id) { return load().autos.find(a => String(a.id) === String(id)); }
