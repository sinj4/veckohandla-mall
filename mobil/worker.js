// Veckohandla mobil: en Cloudflare Worker med en mobilsida för att välja rätter, sätta betyg och se status.
//
// - Varje anrop kräver ?k=<LANKNYCKEL> (full behörighet) eller en signerad veckolänk ?v=<vecka>&t=<HMAC>
//   från mejlet (bara den veckan). Fel nyckel ger 404. Jämförelsen sker i konstant tid.
// - Förslag, planer och korglänkar läses från repot via GitHub API. Val och betyg startar workflowen
//   (workflow_dispatch) med inputs val respektive betyg. Inget sparas i Workern.
// - Högst 10 POST per timme, räknat på workflow-körningar som startats manuellt den senaste timmen.
// - Inga externa beroenden. Secrets: GITHUB_TOKEN, LANKNYCKEL. Vars i wrangler.toml: GITHUB_REPO, WORKFLOW, GREN.

const MAX_POST_PER_TIMME = 10;
const FARG = '#2a7a2a';
const enc = new TextEncoder();

// ---------- tid och veckor ----------

export function isoVecka(datum) {
  const d = new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate()));
  const dag = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dag);
  const arStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const vecka = Math.ceil(((d - arStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-v${String(vecka).padStart(2, '0')}`;
}

const VECKA = /^\d{4}-v\d{2}$/;
const forraVeckan = (nu) => isoVecka(new Date(nu.getTime() - 7 * 86400000));

// ---------- behörighet ----------

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function token(nyckel, vecka) {
  const k = await crypto.subtle.importKey('raw', enc.encode(nyckel), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(`veckohandla:${vecka}`)));
}

// Konstant tid oavsett var strängarna skiljer sig: jämför SHA-256 av båda (samma längd) byte för byte
export async function lika(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x);
  const w = new Uint8Array(y);
  let skillnad = 0;
  for (let i = 0; i < u.length; i++) skillnad |= u[i] ^ w[i];
  return skillnad === 0;
}

// {full: true} med k, {full: false, vecka} med en giltig veckolänk, annars null
export async function behorighet(url, env, nu) {
  if (!env.LANKNYCKEL || env.LANKNYCKEL.length < 32) return null;
  const k = url.searchParams.get('k');
  if (k) return (await lika(k, env.LANKNYCKEL)) ? {full: true, fraga: `?k=${encodeURIComponent(k)}`} : null;
  const v = url.searchParams.get('v');
  const t = url.searchParams.get('t');
  if (!v || !t || !VECKA.test(v)) return null;
  if (!(await lika(t, await token(env.LANKNYCKEL, v)))) return null;
  // Länken från mejlet gäller den veckan och veckan efter (betyg sätts ofta veckan efter)
  if (v !== isoVecka(nu) && v !== forraVeckan(nu)) return null;
  return {full: false, vecka: v, fraga: `?v=${v}&t=${encodeURIComponent(t)}`};
}

// ---------- GitHub ----------

function github(env) {
  const repo = env.GITHUB_REPO;
  const gren = env.GREN || 'main';
  const workflow = env.WORKFLOW || 'vecka.yml';
  const anrop = async (sokvag, opt = {}) => {
    const r = await fetch(`https://api.github.com${sokvag}`, {
      ...opt,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'veckohandla-mobil',
        ...(opt.body ? {'Content-Type': 'application/json'} : {}),
      },
    });
    if (r.status === 404 && opt.saknasOk) return null;
    if (!r.ok) throw new GithubFel(r.status, sokvag);
    return r.status === 204 ? true : (opt.raw ? r.text() : r.json());
  };
  return {
    filer: async () => ((await anrop(`/repos/${repo}/contents/data?ref=${gren}`, {saknasOk: true})) || []).map((f) => f.name),
    las: async (namn) => {
      const t = await anrop(`/repos/${repo}/contents/data/${encodeURIComponent(namn)}?ref=${gren}`, {raw: true, saknasOk: true});
      return t == null ? null : JSON.parse(t);
    },
    andrad: async (namn) => {
      const c = await anrop(`/repos/${repo}/commits?path=${encodeURIComponent('data/' + namn)}&sha=${gren}&per_page=1`);
      return c.length ? c[0].commit.committer.date : null;
    },
    korningar: async () => (await anrop(`/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`)).workflow_runs || [],
    startadeSenasteTimmen: async (nu) => {
      const fran = new Date(nu.getTime() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
      const r = await anrop(`/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=${encodeURIComponent('>=' + fran)}&per_page=1`);
      return r.total_count || 0;
    },
    starta: (inputs) => anrop(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST', body: JSON.stringify({ref: gren, inputs}),
    }),
  };
}

class GithubFel extends Error {
  constructor(status, sokvag) {
    super(`GitHub svarade ${status} (${sokvag.split('?')[0]})`);
    this.status = status;
  }
}

// ---------- data till sidan ----------

const FORSLAG = /^(\d{4}-v\d{2})-forslag\.json$/;
const PLAN = /^(\d{4}-v\d{2})\.json$/;

export async function lasData(gh, nu, beh) {
  const filer = await gh.filer();
  const forslagsveckor = filer.map((f) => FORSLAG.exec(f)?.[1]).filter(Boolean).sort();
  const planveckor = filer.map((f) => PLAN.exec(f)?.[1]).filter(Boolean).sort();
  const denna = isoVecka(nu);

  // Förslag: de senaste (med veckolänk bara den veckans)
  let forslag = null;
  const fv = beh.full ? forslagsveckor.at(-1) : forslagsveckor.find((v) => v === beh.vecka);
  if (fv) {
    const f = await gh.las(`${fv}-forslag.json`);
    forslag = {
      vecka: fv, kommentar: f.kommentar || '',
      ratter: f.ratter.map((r, i) => ({nummer: i + 1, ratt: r.ratt, beskrivning: r.beskrivning, tid_min: r.tid_min, kampanjvaror: r.kampanjvaror || []})),
    };
  }

  // Korglänk: veckans mobillänk, om den är nyare än förslagen (valet är gjort)
  let mobillank = null;
  const kv = forslag?.vecka || (beh.full ? denna : beh.vecka);
  if (filer.includes(`${kv}-mobillank.json`)) {
    const nyare = !forslag || (await gh.andrad(`${kv}-mobillank.json`)) > (await gh.andrad(`${kv}-forslag.json`));
    if (nyare) mobillank = (await gh.las(`${kv}-mobillank.json`)).lank;
  }

  // Betyg: förra veckans rätter (senaste planen före den här veckan), med veckolänk bara veckan före länkens
  const tillatna = beh.full ? null : [forraVeckan(new Date(veckansMandag(beh.vecka))), beh.vecka];
  const bv = planveckor.filter((v) => v < denna && (!tillatna || tillatna.includes(v))).at(-1);
  let betyg = null;
  if (bv) {
    const plan = await gh.las(`${bv}.json`);
    const satta = filer.includes('betyg.json') ? (await gh.las('betyg.json')).filter((b) => b.vecka === bv) : [];
    betyg = {
      vecka: bv,
      ratter: plan.middagar.map((m) => {
        const b = satta.find((x) => x.ratt === m.ratt);
        return {dag: m.dag, ratt: m.ratt, betyg: b?.betyg ?? 0, kommentar: b?.kommentar || ''};
      }),
    };
  }

  const k = (await gh.korningar())[0];
  const status = k ? {status: k.status, slutsats: k.conclusion, skapad: k.created_at, url: k.html_url, namn: k.display_title} : null;
  return {behorighet: beh.full ? 'full' : 'vecka', vecka: denna, forslag, mobillank, betyg, status};
}

function veckansMandag(vecka) {
  const [ar, v] = vecka.split('-v').map(Number);
  const jan4 = new Date(Date.UTC(ar, 0, 4));
  const mandag = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
  return mandag.getTime() + (v - 1) * 7 * 86400000;
}

// ---------- val och betyg ----------

export function kontrolleraVal(nummer, antal) {
  if (!Array.isArray(nummer) || !nummer.length) return 'Välj minst en rätt.';
  if (nummer.length > 7) return 'Högst 7 rätter (en per veckodag).';
  if (nummer.some((n) => !Number.isInteger(n) || n < 1 || n > antal)) return `Numren ska vara 1–${antal}.`;
  if (new Set(nummer).size !== nummer.length) return 'Samma rätt är vald två gånger.';
  return null;
}

export function kontrolleraBetyg(poster, ratter) {
  if (!Array.isArray(poster) || !poster.length) return 'Sätt minst ett betyg.';
  const namn = new Set(ratter.map((r) => r.ratt));
  for (const p of poster) {
    if (!p || !namn.has(p.ratt)) return 'Okänd rätt.';
    if (p.betyg !== 1 && p.betyg !== -1) return 'Betyget ska vara + eller −.';
    if (p.kommentar != null && (typeof p.kommentar !== 'string' || p.kommentar.length > 500)) return 'Kommentaren får vara högst 500 tecken.';
  }
  if (new Set(poster.map((p) => p.ratt)).size !== poster.length) return 'Samma rätt har fått två betyg.';
  return null;
}

// ---------- svar ----------

const SAKERHET = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const svar = (body, status, typ, extra = {}) => new Response(body, {status, headers: {'Content-Type': typ, ...SAKERHET, ...extra}});
const json = (data, status = 200) => svar(JSON.stringify(data), status, 'application/json; charset=utf-8');
const hittadesInte = () => svar('Hittades inte', 404, 'text/plain; charset=utf-8');

export async function hantera(request, env, nu = new Date()) {
  const url = new URL(request.url);
  const beh = await behorighet(url, env, nu);
  if (!beh) return hittadesInte();
  const gh = github(env);
  try {
    if (request.method === 'GET') {
      if (url.pathname === '/') return svar(sida(beh.fraga), 200, 'text/html; charset=utf-8',
        {'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'"});
      if (url.pathname === '/manifest.webmanifest') return svar(JSON.stringify(manifest(beh.fraga)), 200, 'application/manifest+json');
      if (url.pathname === '/ikon.svg') return svar(IKON_SVG, 200, 'image/svg+xml');
      const png = /^\/ikon-(180|192|512)\.png$/.exec(url.pathname);
      if (png) return svar(await ikonPng(Number(png[1])), 200, 'image/png');
      if (url.pathname === '/api/data') return json(await lasData(gh, nu, beh));
      return hittadesInte();
    }
    if (request.method === 'POST' && (url.pathname === '/api/valj' || url.pathname === '/api/betyg')) {
      let body;
      try { body = await request.json(); } catch { return json({fel: 'Ogiltig förfrågan.'}, 400); }
      const data = await lasData(gh, nu, beh);
      let inputs;
      if (url.pathname === '/api/valj') {
        if (!data.forslag) return json({fel: 'Det finns inga förslag att välja bland.'}, 409);
        const fel = kontrolleraVal(body.nummer, data.forslag.ratter.length);
        if (fel) return json({fel}, 400);
        inputs = {val: body.nummer.join(' ')};
      } else {
        if (!data.betyg || body.vecka !== data.betyg.vecka) return json({fel: 'Det finns inga rätter att sätta betyg på för den veckan.'}, 409);
        const fel = kontrolleraBetyg(body.betyg, data.betyg.ratter);
        if (fel) return json({fel}, 400);
        const poster = body.betyg.map((p) => ({ratt: p.ratt, betyg: p.betyg, kommentar: (p.kommentar || '').trim()}));
        inputs = {betyg: JSON.stringify({vecka: body.vecka, betyg: poster})};
      }
      if ((await gh.startadeSenasteTimmen(nu)) >= MAX_POST_PER_TIMME) {
        return json({fel: `Högst ${MAX_POST_PER_TIMME} körningar per timme. Försök igen lite senare.`}, 429);
      }
      await gh.starta(inputs);
      return json({ok: true, meddelande: url.pathname === '/api/valj' ? 'Valet är skickat. Körningen startar nu.' : 'Betygen är skickade.'});
    }
    return hittadesInte();
  } catch (e) {
    if (e instanceof GithubFel) return json({fel: `${e.message}. Kontrollera GITHUB_TOKEN och GITHUB_REPO.`}, 502);
    throw e;
  }
}

export default {fetch: (request, env) => hantera(request, env)};

// ---------- hemskärmsapp: manifest och ikon ----------

function manifest(fraga) {
  return {
    name: 'Veckohandla', short_name: 'Veckohandla', lang: 'sv', dir: 'ltr',
    start_url: `/${fraga}`, scope: '/', display: 'standalone',
    background_color: '#ffffff', theme_color: FARG,
    icons: [
      {src: `/ikon-192.png${fraga}`, sizes: '192x192', type: 'image/png'},
      {src: `/ikon-512.png${fraga}`, sizes: '512x512', type: 'image/png'},
      {src: `/ikon.svg${fraga}`, sizes: 'any', type: 'image/svg+xml'},
    ],
  };
}

const IKON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${FARG}"/><path d="M30 40 A20 20 0 0 1 70 40" fill="none" stroke="#fff" stroke-width="6"/><path d="M20 40 H80 L72 78 H28 Z" fill="#fff"/></svg>`;

// Samma motiv som SVG:n, ritat pixel för pixel: grön bakgrund, vit korg med handtag
function ikonPixel(x, y) {
  const korg = y >= 0.4 && y <= 0.78 && x >= 0.2 + (y - 0.4) * 0.21 && x <= 0.8 - (y - 0.4) * 0.21;
  const r = Math.hypot(x - 0.5, y - 0.4);
  const handtag = y <= 0.4 && r >= 0.17 && r <= 0.23;
  return korg || handtag ? [255, 255, 255] : [0x2a, 0x7a, 0x2a];
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(typ, data) {
  const ut = new Uint8Array(12 + data.length);
  const dv = new DataView(ut.buffer);
  dv.setUint32(0, data.length);
  ut.set(enc.encode(typ), 4);
  ut.set(data, 8);
  dv.setUint32(8 + data.length, crc32(ut.subarray(4, 8 + data.length)));
  return ut;
}

export async function ikonPng(storlek) {
  const rad = storlek * 3 + 1;
  const ra = new Uint8Array(rad * storlek);
  for (let y = 0; y < storlek; y++) {
    ra[y * rad] = 0;
    for (let x = 0; x < storlek; x++) ra.set(ikonPixel((x + 0.5) / storlek, (y + 0.5) / storlek), y * rad + 1 + x * 3);
  }
  const zlib = new Uint8Array(await new Response(new Blob([ra]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, storlek);
  dv.setUint32(4, storlek);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const delar = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array())];
  const ut = new Uint8Array(delar.reduce((s, d) => s + d.length, 0));
  let i = 0;
  for (const d of delar) { ut.set(d, i); i += d.length; }
  return ut;
}

// ---------- sidan ----------

function sida(fraga) {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="${FARG}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Veckohandla">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest${fraga}">
<link rel="apple-touch-icon" href="/ikon-180.png${fraga}">
<link rel="icon" href="/ikon.svg${fraga}" type="image/svg+xml">
<title>Veckohandla</title>
<style>
:root{--g:${FARG};--bg:#f6f7f5;--kort:#fff;--text:#1d1f1c;--svag:#666;--kant:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#111;--kort:#1c1e1b;--text:#eee;--svag:#aaa;--kant:#333}}
*{box-sizing:border-box}body{margin:0;font:17px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);padding:env(safe-area-inset-top) 0 calc(72px + env(safe-area-inset-bottom))}
header{padding:16px 16px 4px}h1{margin:0;font-size:24px}h2{font-size:19px;margin:20px 16px 8px}.svag{color:var(--svag);font-size:14px}
main{padding:0 12px}.kort{background:var(--kort);border:1px solid var(--kant);border-radius:14px;padding:12px 14px;margin:10px 0}
.kort.vald{border:2px solid var(--g)}.rad{display:flex;gap:12px;align-items:flex-start}.rad input[type=checkbox]{width:26px;height:26px;margin-top:2px;accent-color:var(--g)}
.nr{font-weight:700;color:var(--g)}button{font:inherit;border-radius:10px;border:1px solid var(--kant);background:var(--kort);color:var(--text);padding:10px 14px;min-height:44px}
button.stor,a.stor{display:block;width:100%;background:var(--g);color:#fff;border:0;font-weight:700;padding:14px;text-align:center;text-decoration:none;border-radius:12px;margin:14px 0}
button:disabled{opacity:.5}.ordning{display:flex;align-items:center;gap:8px;margin:6px 0}.ordning span{flex:1}.ordning button{padding:6px 12px;min-height:40px}
.betyg button{min-width:56px;font-size:20px}.betyg button.pa{background:var(--g);color:#fff}.betyg textarea{width:100%;margin-top:8px;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--kant);background:var(--bg);color:var(--text)}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:var(--kort);border-top:1px solid var(--kant);padding-bottom:env(safe-area-inset-bottom)}nav button{flex:1;border:0;border-radius:0;background:none;padding:14px 0}nav button.pa{color:var(--g);font-weight:700}
.meddelande{margin:10px 0;padding:12px;border-radius:10px;background:#eaf2fb;color:#1a4f8b}.fel{background:#fdecea;color:#8a1c12}[hidden]{display:none!important}
</style>
</head>
<body>
<header><h1>🛒 Veckohandla</h1><div class="svag" id="undertitel"></div></header>
<main>
<section id="valj"></section>
<section id="betyg" hidden></section>
<section id="status" hidden></section>
</main>
<nav><button data-vy="valj">Välj</button><button data-vy="betyg">Betyg</button><button data-vy="status">Status</button></nav>
<script>
(() => {
  const Q = location.search;
  const $ = (s) => document.querySelector(s);
  const el = (tag, attr = {}, ...barn) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attr)) k === 'text' ? (e.textContent = v) : k.startsWith('on') ? (e[k] = v) : e.setAttribute(k, v);
    for (const b of barn) if (b) e.append(b);
    return e;
  };
  let data = null;
  let ordning = [];
  let bevakar = null;

  const visaVy = (vy) => {
    for (const s of ['valj', 'betyg', 'status']) $('#' + s).hidden = s !== vy;
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('pa', b.dataset.vy === vy));
  };
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => visaVy(b.dataset.vy)));

  const meddela = (yta, text, fel) => { yta.querySelector('.meddelande')?.remove(); yta.prepend(el('div', {class: 'meddelande' + (fel ? ' fel' : ''), text})); };

  async function skicka(sokvag, body) {
    const r = await fetch(sokvag + Q, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const d = await r.json().catch(() => ({fel: 'Oväntat svar (' + r.status + ').'}));
    if (!r.ok) throw new Error(d.fel || 'Något gick fel.');
    return d;
  }

  function korgknapp(lank) {
    return el('div', {},
      el('a', {class: 'stor', href: lank, rel: 'noreferrer', text: '📱 Fyll korgen på mobilen'}),
      el('div', {class: 'svag', text: 'Öppnar ' + new URL(lank).host + '. Logga in om det behövs och kör sedan bokmärket eller genvägen Veckohandla.'}));
  }

  function ritaValj() {
    const s = $('#valj');
    s.replaceChildren();
    const f = data.forslag;
    if (!f) { s.append(el('p', {class: 'svag', text: 'Inga förslag just nu.'})); return; }
    s.append(el('h2', {text: 'Välj rätter ' + f.vecka}));
    if (data.mobillank) s.append(el('div', {class: 'meddelande', text: 'Rätterna är valda och korgfilen är klar.'}), korgknapp(data.mobillank));
    if (f.kommentar) s.append(el('p', {class: 'svag', text: f.kommentar}));
    for (const r of f.ratter) {
      const vald = ordning.includes(r.nummer);
      const ruta = el('input', {type: 'checkbox', 'aria-label': 'Välj ' + r.ratt});
      ruta.checked = vald;
      ruta.onchange = () => { ordning = ruta.checked ? [...ordning, r.nummer] : ordning.filter((n) => n !== r.nummer); ritaValj(); };
      s.append(el('label', {class: 'kort' + (vald ? ' vald' : '')}, el('div', {class: 'rad'}, ruta,
        el('div', {}, el('div', {}, el('span', {class: 'nr', text: r.nummer + '. '}), el('b', {text: r.ratt}), el('span', {class: 'svag', text: ' (' + r.tid_min + ' min)'})),
          el('div', {text: r.beskrivning}), r.kampanjvaror.length ? el('div', {class: 'svag', text: 'Kampanj: ' + r.kampanjvaror.join(', ')}) : null))));
    }
    if (ordning.length) {
      const dagar = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
      const lista = el('div', {class: 'kort'}, el('b', {text: 'Ordning'}));
      ordning.forEach((n, i) => {
        const flytta = (d) => { const o = [...ordning]; [o[i], o[i + d]] = [o[i + d], o[i]]; ordning = o; ritaValj(); };
        lista.append(el('div', {class: 'ordning'}, el('span', {text: (dagar[i] || '') + ': ' + f.ratter[n - 1].ratt}),
          el('button', {text: '↑', 'aria-label': 'Flytta upp', onclick: () => flytta(-1), ...(i ? {} : {disabled: ''})}),
          el('button', {text: '↓', 'aria-label': 'Flytta ned', onclick: () => flytta(1), ...(i < ordning.length - 1 ? {} : {disabled: ''})})));
      });
      s.append(lista);
    }
    const klar = el('button', {class: 'stor', text: ordning.length ? 'Klar – handla ' + ordning.length + ' rätter' : 'Kryssa i rätterna du vill ha'});
    klar.disabled = !ordning.length;
    klar.onclick = async () => {
      klar.disabled = true;
      try {
        const d = await skicka('/api/valj', {nummer: ordning});
        ordning = [];
        visaVy('status');
        meddela($('#status'), d.meddelande);
        bevaka();
      } catch (e) { meddela(s, e.message, true); klar.disabled = false; }
    };
    s.append(klar);
  }

  function ritaBetyg() {
    const s = $('#betyg');
    s.replaceChildren();
    const b = data.betyg;
    if (!b) { s.append(el('p', {class: 'svag', text: 'Inga rätter att sätta betyg på just nu.'})); return; }
    s.append(el('h2', {text: 'Betyg ' + b.vecka}));
    for (const r of b.ratter) {
      const knapp = (v, t) => el('button', {class: r.betyg === v ? 'pa' : '', text: t, 'aria-label': (v > 0 ? 'Gillade ' : 'Gillade inte ') + r.ratt,
        onclick: () => { r.betyg = r.betyg === v ? 0 : v; ritaBetyg(); }});
      const text = el('textarea', {rows: '2', maxlength: '500', placeholder: 'Kommentar (valfritt)'});
      text.value = r.kommentar;
      text.oninput = () => { r.kommentar = text.value; };
      s.append(el('div', {class: 'kort betyg'}, el('div', {class: 'svag', text: r.dag}), el('b', {text: r.ratt}),
        el('div', {class: 'ordning'}, knapp(1, '👍 +'), knapp(-1, '👎 −')), text));
    }
    const spara = el('button', {class: 'stor', text: 'Spara betyg'});
    spara.onclick = async () => {
      const betyg = b.ratter.filter((r) => r.betyg).map((r) => ({ratt: r.ratt, betyg: r.betyg, kommentar: r.kommentar}));
      if (!betyg.length) { meddela(s, 'Sätt + eller − på minst en rätt.', true); return; }
      spara.disabled = true;
      try { meddela(s, (await skicka('/api/betyg', {vecka: b.vecka, betyg})).meddelande); bevaka(); }
      catch (e) { meddela(s, e.message, true); }
      spara.disabled = false;
    };
    s.append(spara);
  }

  function ritaStatus() {
    const s = $('#status');
    const gammalt = s.querySelector('.meddelande');
    s.replaceChildren();
    if (gammalt) s.append(gammalt);
    s.append(el('h2', {text: 'Senaste körningen'}));
    const k = data.status;
    if (!k) { s.append(el('p', {class: 'svag', text: 'Ingen körning ännu.'})); }
    else {
      const text = k.status !== 'completed' ? '⏳ Pågår…' : k.slutsats === 'success' ? '✅ Klar' : '❌ Misslyckades (' + k.slutsats + ')';
      s.append(el('div', {class: 'kort'}, el('b', {text}), el('div', {class: 'svag', text: new Date(k.skapad).toLocaleString('sv-SE')}),
        el('a', {href: k.url, rel: 'noreferrer', text: 'Visa loggen på GitHub'})));
    }
    if (data.mobillank) s.append(korgknapp(data.mobillank));
  }

  async function ladda() {
    const r = await fetch('/api/data' + Q);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).fel || 'Kunde inte läsa data (' + r.status + ').');
    data = await r.json();
    $('#undertitel').textContent = 'Vecka ' + data.vecka.split('-v')[1] + (data.behorighet === 'vecka' ? ' · länk från mejlet' : '');
    ritaValj(); ritaBetyg(); ritaStatus();
    return data;
  }

  function bevaka() {
    clearInterval(bevakar);
    let varv = 0;
    bevakar = setInterval(async () => {
      varv++;
      try {
        await ladda();
        if ((data.status && data.status.status === 'completed' && varv > 2) || varv > 90) clearInterval(bevakar);
      } catch { /* försök igen nästa varv */ }
    }, 10000);
  }

  const start = new URLSearchParams(Q).get('vy');
  ladda().then(() => visaVy(start === 'betyg' ? 'betyg' : start === 'status' ? 'status' : 'valj'))
    .catch((e) => { meddela($('#valj'), e.message, true); visaVy('valj'); });
})();
</script>
</body>
</html>`;
}
