// Tester för mobilsidans Worker med Nodes inbyggda testlöpare och fejkad fetch mot GitHub API.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import worker, {behorighet, hantera, ikonPng, isoVecka, kontrolleraBetyg, kontrolleraVal, lika, token} from '../worker.js';

const NYCKEL = 'k'.repeat(48);
const ENV = {LANKNYCKEL: NYCKEL, GITHUB_TOKEN: 'ghp_fejk', GITHUB_REPO: 'agare/hem', WORKFLOW: 'vecka.yml', GREN: 'main'};
const NU = new Date('2026-10-28T10:00:00Z'); // onsdag vecka 44

// ---------- fejkat GitHub ----------

let gh;
function nyttGithub() {
  const filer = {
    '2026-v43.json': {middagar: [{dag: 'Måndag', ratt: 'Tacos'}, {dag: 'Tisdag', ratt: 'Lax'}]},
    '2026-v44-forslag.json': {kommentar: 'Bra vecka', ratter: [
      {ratt: 'Soppa', beskrivning: 'Varm', tid_min: 20, kampanjvaror: ['Morötter – Willys']},
      {ratt: 'Pasta', beskrivning: 'Snabb', tid_min: 15, kampanjvaror: []},
      {ratt: 'Fisk', beskrivning: 'Ugn', tid_min: 30, kampanjvaror: []}]},
    'betyg.json': [{ratt: 'Tacos', vecka: '2026-v43', betyg: 1, kommentar: 'god'}],
  };
  const andrad = {'2026-v44-forslag.json': '2026-10-26T06:00:00Z'};
  const g = {filer, andrad, anrop: [], dispatch: [], startade: 0, korning: {status: 'completed', conclusion: 'success'}};
  globalThis.fetch = async (url, opt = {}) => {
    const u = new URL(url);
    g.anrop.push([opt.method || 'GET', u.pathname + u.search, opt.headers]);
    assert.equal(u.origin, 'https://api.github.com');
    assert.equal(opt.headers.Authorization, 'Bearer ghp_fejk');
    const svar = (d, status = 200) => new Response(d === null ? null : JSON.stringify(d), {status});
    let m;
    if (u.pathname === '/repos/agare/hem/contents/data') return svar(Object.keys(g.filer).map((name) => ({name})));
    if ((m = /^\/repos\/agare\/hem\/contents\/data\/(.+)$/.exec(u.pathname))) {
      const namn = decodeURIComponent(m[1]);
      assert.equal(opt.headers.Accept, 'application/vnd.github.raw+json');
      return namn in g.filer ? new Response(JSON.stringify(g.filer[namn])) : svar({message: 'Not Found'}, 404);
    }
    if (u.pathname === '/repos/agare/hem/commits') {
      const namn = u.searchParams.get('path').replace('data/', '');
      return svar(g.andrad[namn] ? [{commit: {committer: {date: g.andrad[namn]}}}] : []);
    }
    if (u.pathname === '/repos/agare/hem/actions/workflows/vecka.yml/runs') {
      if (u.searchParams.get('event') === 'workflow_dispatch') {
        assert.match(u.searchParams.get('created'), /^>=2026-10-28T09:00:00Z$/);
        return svar({total_count: g.startade, workflow_runs: []});
      }
      return svar({workflow_runs: [{...g.korning, created_at: '2026-10-28T09:30:00Z', html_url: 'https://github.com/agare/hem/actions/runs/1', display_title: 'Veckohandla'}]});
    }
    if (u.pathname === '/repos/agare/hem/actions/workflows/vecka.yml/dispatches') {
      assert.equal(opt.method, 'POST');
      g.dispatch.push(JSON.parse(opt.body));
      return new Response(null, {status: 204});
    }
    throw new Error('oväntat anrop ' + url);
  };
  return g;
}
beforeEach(() => { gh = nyttGithub(); });

const anrop = (sokvag, opt = {}, nu = NU, env = ENV) => hantera(new Request('https://mobil.example.workers.dev' + sokvag, opt), env, nu);
const post = (sokvag, body) => anrop(sokvag, {method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'application/json'}});
const K = '?k=' + NYCKEL;

// ---------- veckor och kryptografi ----------

test('ISO-veckor', () => {
  assert.equal(isoVecka(NU), '2026-v44');
  assert.equal(isoVecka(new Date('2026-01-01T12:00:00Z')), '2026-v01');
  assert.equal(isoVecka(new Date('2027-01-01T12:00:00Z')), '2026-v53');
  assert.equal(isoVecka(new Date('2026-10-19T00:30:00Z')), '2026-v43');
});

test('samma HMAC som Python (veckohandla/mobil.py)', async () => {
  assert.equal(await token('nyckel', '2026-v44'), 'Sjw8DQBbjMYhOQ0V7TyGUAG9Yg_JSE_03nNubM65AMI');
});

test('lika jämför oberoende av längd', async () => {
  assert.equal(await lika('abc', 'abc'), true);
  assert.equal(await lika('abc', 'abd'), false);
  assert.equal(await lika('abc', 'abcd'), false);
  assert.equal(await lika('', NYCKEL), false);
});

// ---------- behörighet ----------

test('fel eller saknad nyckel ger 404 utan GitHub-anrop', async () => {
  for (const q of ['', '?k=fel', '?k=' + NYCKEL.slice(1), '?v=2026-v44&t=fel', '?v=x&t=y']) {
    const r = await anrop('/api/data' + q);
    assert.equal(r.status, 404, q);
  }
  assert.equal((await anrop('/' + K, {}, NU, {...ENV, LANKNYCKEL: ''})).status, 404);
  assert.equal((await anrop('/' + K, {}, NU, {...ENV, LANKNYCKEL: 'för-kort'})).status, 404);
  assert.deepEqual(gh.anrop, []);
});

test('veckolänken gäller sin vecka och veckan efter', async () => {
  const url = async (v) => new URL(`https://x/?v=${v}&t=${await token(NYCKEL, v)}`);
  assert.deepEqual(await behorighet(await url('2026-v44'), ENV, NU), {full: false, vecka: '2026-v44', fraga: `?v=2026-v44&t=${await token(NYCKEL, '2026-v44')}`});
  assert.equal((await behorighet(await url('2026-v43'), ENV, NU)).vecka, '2026-v43');
  assert.equal(await behorighet(await url('2026-v42'), ENV, NU), null);
  assert.equal(await behorighet(await url('2026-v45'), ENV, NU), null);
  const fel = new URL(`https://x/?v=2026-v44&t=${await token('annan-nyckel', '2026-v44')}`);
  assert.equal(await behorighet(fel, ENV, NU), null);
});

// ---------- sidan, manifest och ikon ----------

test('sidan går att lägga på hemskärmen och läcker inte nyckeln via referer', async () => {
  const r = await anrop('/' + K);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const html = await r.text();
  for (const del of ['<meta name="theme-color" content="#2a7a2a">', '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<link rel="manifest" href="/manifest.webmanifest${K}">`, `<link rel="apple-touch-icon" href="/ikon-180.png${K}">`,
    '<meta name="referrer" content="no-referrer">', 'lang="sv"']) assert.ok(html.includes(del), del);
  assert.ok(!/<script[^>]+src=|<link[^>]+stylesheet|https?:\/\/(?!www\.w3\.org)/.test(html.replace(/new URL\(lank\)\.host/, '')), 'inga externa beroenden');
  const m = await (await anrop('/manifest.webmanifest' + K)).json();
  assert.equal(m.start_url, '/' + K);
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.icons.map((i) => i.sizes), ['192x192', '512x512', 'any']);
});

test('PNG-ikonen är en giltig PNG i rätt storlek', async () => {
  const png = await ikonPng(192);
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer);
  assert.equal(String.fromCharCode(...png.slice(12, 16)), 'IHDR');
  assert.equal(dv.getUint32(16), 192);
  assert.equal(dv.getUint32(20), 192);
  assert.ok(png.length < 20000);
  const r = await anrop('/ikon-512.png' + K);
  assert.equal(r.headers.get('Content-Type'), 'image/png');
  assert.equal((await anrop('/ikon-64.png' + K)).status, 404);
});

// ---------- data ----------

test('data: förslag, förra veckans rätter med betyg och status', async () => {
  const d = await (await anrop('/api/data' + K)).json();
  assert.equal(d.vecka, '2026-v44');
  assert.equal(d.forslag.vecka, '2026-v44');
  assert.deepEqual(d.forslag.ratter.map((r) => [r.nummer, r.ratt]), [[1, 'Soppa'], [2, 'Pasta'], [3, 'Fisk']]);
  assert.deepEqual(d.betyg, {vecka: '2026-v43', ratter: [
    {dag: 'Måndag', ratt: 'Tacos', betyg: 1, kommentar: 'god'}, {dag: 'Tisdag', ratt: 'Lax', betyg: 0, kommentar: ''}]});
  assert.equal(d.mobillank, null);
  assert.equal(d.status.slutsats, 'success');
});

test('korglänken visas först när den är nyare än förslagen', async () => {
  gh.filer['2026-v44-mobillank.json'] = {kedja: 'willys', lank: 'https://www.willys.se/#veckohandla=abc'};
  gh.andrad['2026-v44-mobillank.json'] = '2026-10-20T06:00:00Z';
  assert.equal((await (await anrop('/api/data' + K)).json()).mobillank, null);
  gh.andrad['2026-v44-mobillank.json'] = '2026-10-28T09:40:00Z';
  assert.equal((await (await anrop('/api/data' + K)).json()).mobillank, 'https://www.willys.se/#veckohandla=abc');
});

test('veckolänken ser bara sin veckas förslag', async () => {
  const q = `?v=2026-v43&t=${await token(NYCKEL, '2026-v43')}`;
  const d = await (await anrop('/api/data' + q)).json();
  assert.equal(d.behorighet, 'vecka');
  assert.equal(d.forslag, null);
  assert.equal(d.betyg.vecka, '2026-v43'); // betygsknappen i v43-mejlet används veckan efter
  assert.equal((await post('/api/valj' + q, {nummer: [1]})).status, 409);
});

// ---------- val ----------

test('val startar workflowen med input val', async () => {
  const r = await post('/api/valj' + K, {nummer: [3, 1]});
  assert.equal(r.status, 200);
  assert.deepEqual(gh.dispatch, [{ref: 'main', inputs: {val: '3 1'}}]);
});

test('val med veckolänk för rätt vecka fungerar', async () => {
  const q = `?v=2026-v44&t=${await token(NYCKEL, '2026-v44')}`;
  assert.equal((await post('/api/valj' + q, {nummer: [2]})).status, 200);
  assert.deepEqual(gh.dispatch[0].inputs, {val: '2'});
});

test('ogiltiga val startar ingenting', async () => {
  for (const nummer of [[], [4], [0], [1, 1], [1.5], 'x', [1, 2, 3, 1, 2, 3, 1, 2]]) {
    const r = await post('/api/valj' + K, {nummer});
    assert.equal(r.status, 400, JSON.stringify(nummer));
  }
  assert.equal((await anrop('/api/valj' + K, {method: 'POST', body: 'inte json'})).status, 400);
  assert.deepEqual(gh.dispatch, []);
});

test('högst 10 POST per timme', async () => {
  gh.startade = 10;
  const r = await post('/api/valj' + K, {nummer: [1]});
  assert.equal(r.status, 429);
  assert.match((await r.json()).fel, /Högst 10 körningar per timme/);
  assert.deepEqual(gh.dispatch, []);
});

test('kontrollerna för sig', () => {
  assert.equal(kontrolleraVal([1, 2], 10), null);
  assert.match(kontrolleraVal([11], 10), /1–10/);
  assert.equal(kontrolleraBetyg([{ratt: 'A', betyg: -1}], [{ratt: 'A'}]), null);
  assert.match(kontrolleraBetyg([{ratt: 'A', betyg: 2}], [{ratt: 'A'}]), /\+ eller −/);
  assert.match(kontrolleraBetyg([{ratt: 'A', betyg: 1}, {ratt: 'A', betyg: -1}], [{ratt: 'A'}]), /två betyg/);
});

// ---------- betyg ----------

test('betyg startar workflowen med input betyg som JSON', async () => {
  const r = await post('/api/betyg' + K, {vecka: '2026-v43', betyg: [{ratt: 'Lax', betyg: -1, kommentar: ' för torr '}]});
  assert.equal(r.status, 200);
  assert.deepEqual(gh.dispatch.map((d) => JSON.parse(d.inputs.betyg)), [{vecka: '2026-v43', betyg: [{ratt: 'Lax', betyg: -1, kommentar: 'för torr'}]}]);
});

test('betyg för fel vecka eller okända rätter startar ingenting', async () => {
  assert.equal((await post('/api/betyg' + K, {vecka: '2026-v42', betyg: [{ratt: 'Lax', betyg: 1}]})).status, 409);
  assert.equal((await post('/api/betyg' + K, {vecka: '2026-v43', betyg: [{ratt: 'Pizza', betyg: 1}]})).status, 400);
  assert.equal((await post('/api/betyg' + K, {vecka: '2026-v43', betyg: [{ratt: 'Lax', betyg: 1, kommentar: 'x'.repeat(501)}]})).status, 400);
  assert.deepEqual(gh.dispatch, []);
});

// ---------- övrigt ----------

test('okända vägar och metoder ger 404, GitHub-fel ger ett begripligt fel utan token', async () => {
  assert.equal((await anrop('/hemlig' + K)).status, 404);
  assert.equal((await anrop('/api/data' + K, {method: 'DELETE'})).status, 404);
  globalThis.fetch = async () => new Response('{}', {status: 401});
  const r = await anrop('/api/data' + K);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.match(text, /GitHub svarade 401/);
  assert.ok(!text.includes('ghp_fejk') && !text.includes(NYCKEL));
});

test('default-exporten är en Worker', async () => {
  assert.equal(typeof worker.fetch, 'function');
  assert.equal((await worker.fetch(new Request('https://x/'), ENV)).status, 404);
});

test('sidans skript går att tolka', async () => {
  const html = await (await anrop('/' + K)).text();
  const skript = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(skript));
});
