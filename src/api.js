/* HTTP API for Alliances on Cloudflare Pages Functions, backed by D1.
 * Every request is stateless. Game state lives in one D1 row per lobby and is updated with
 * optimistic concurrency (compare-and-swap on the version), so simultaneous orders never overwrite each other. */
import * as E from './engine.js';

const MAX_BODY = 8192;

export async function handle(request, env, now = Date.now) {
  const send = (status, body, headers) => new Response(status === 304 || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Server-Time': String(now()) }, headers || {}),
  });
  try { return await route(request, env, now, send); }
  catch (e) { console.error('alliances error', e && e.stack || e); return send(500, { error: 'Something went wrong on the server.' }); }
}

const getRow = (env, code) => env.DB.prepare('SELECT version, data FROM lobbies WHERE code = ?').bind(code).first();
async function cas(env, L, oldVersion) {
  const r = await env.DB.prepare('UPDATE lobbies SET data = ?, version = ?, updated = ? WHERE code = ? AND version = ?')
    .bind(JSON.stringify(L), L.version, L.updated, L.code, oldVersion).run();
  return r.meta.changes === 1;
}
async function bump(env, key, windowMs, t) {
  const exp = t + windowMs;
  const r = await env.DB.prepare('INSERT INTO limits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN exp < ? THEN 1 ELSE n + 1 END, exp = CASE WHEN exp < ? THEN ? ELSE exp END RETURNING n')
    .bind(key, exp, t, t, exp).first();
  return r.n;
}
async function readBody(request) {
  if (request.method !== 'POST') return {};
  const len = +request.headers.get('content-length') || 0;
  if (len > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
  if (!text) return {};
  try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : {}; } catch (e) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function authOf(L, request) {
  const au = { cc: null, master: false, pState: 'none', mState: 'none' };
  const p = E.normCode(request.headers.get('x-player-code')), m = E.normCode(request.headers.get('x-master-code'));
  if (p) {
    const cc = p.length === 15 && p.startsWith(L.code) ? E.findMine(L, await E.hashCode('p', L.code, p)) : null;
    if (cc) { au.cc = cc; au.pState = 'ok'; } else au.pState = 'invalid';
  }
  if (m) {
    if (m.length === 20 && m.startsWith(L.code) && (await E.hashCode('m', L.code, m)) === L.mh) { au.master = true; au.mState = 'ok'; } else au.mState = 'invalid';
  }
  return au;
}

async function route(request, env, now, send) {
  const url = new URL(request.url), segs = url.pathname.split('/').filter(Boolean);
  if (segs[0] !== 'api' || segs[1] !== 'lobbies' || segs.length > 4) return send(404, { error: 'Not found' });
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  let t = now();
  let body;
  try { body = await readBody(request); } catch (e) { return send(e.status || 400, { error: e.message }); }

  /* create a lobby */
  if (segs.length === 2) {
    if (request.method !== 'POST') return send(405, { error: 'Method not allowed' });
    if ((await bump(env, 'c:' + ip, 3600e3, t)) > 30) return send(429, { error: 'Too many lobbies created from this address. Try again later.' });
    const tz = body.tz || E.DEFAULT_TZ;
    if (!E.validTz(tz)) return send(400, { error: 'Unknown time zone.' });
    await env.DB.prepare('DELETE FROM lobbies WHERE updated < ?').bind(t - 60 * 864e5).run();
    await env.DB.prepare('DELETE FROM limits WHERE exp < ?').bind(t).run();
    for (let i = 0; i < 6; i++) {
      const code = E.randCode(5), master = code + E.randCode(15);
      const L = E.newLobby(code, await E.hashCode('m', code, master), tz, t);
      try {
        await env.DB.prepare('INSERT INTO lobbies (code, version, updated, data) VALUES (?, ?, ?, ?)').bind(code, L.version, L.updated, JSON.stringify(L)).run();
        return send(201, { lobby: code, master: E.fmtCode(master) });
      } catch (e) { if (!/unique|constraint/i.test(String(e && e.message))) throw e; }
    }
    return send(503, { error: 'Could not create a lobby. Try again.' });
  }

  const code = E.normCode(segs[2]), verb = segs[3] || null;
  if (code.length !== 5) return send(404, { error: 'No lobby has that code.' });
  const isGet = request.method === 'GET';
  if (!isGet && request.method !== 'POST') return send(405, { error: 'Method not allowed' });
  if (isGet && verb && verb !== 'export') return send(404, { error: 'Not found' });
  if (!isGet && !verb) return send(405, { error: 'Method not allowed' });

  const attempts = isGet ? 4 : 8;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.random() * 40));
    t = now();
    const row = await getRow(env, code);
    if (!row) return send(404, { error: 'No lobby has that code.' });
    const L = JSON.parse(row.data); L.version = row.version;
    const grantsChanged = E.applyGrants(L, t);
    const au = await authOf(L, request);
    if (au.pState === 'invalid' || au.mState === 'invalid') {
      if ((await bump(env, 'f:' + ip, 600e3, t)) > 60) return send(429, { error: 'Too many wrong codes. Wait a few minutes.' });
    }
    const commit = async () => { L.version = row.version + 1; L.updated = t; return cas(env, L, row.version); };

    if (isGet) {
      if (verb === 'export') {
        if (!au.master) return send(403, { error: 'The master code is required.' });
        const ex = JSON.parse(JSON.stringify(L)); delete ex.mh; for (const c of Object.keys(ex.players)) delete ex.players[c].h;
        ex.exportedAt = new Date(t).toISOString();
        return send(200, JSON.stringify(ex, null, 2), { 'Content-Disposition': 'attachment; filename="alliances-' + code + '.json"' });
      }
      if (grantsChanged && !(await commit()) && attempt < attempts - 1) continue;
      const host = url.searchParams.get('host') === '1';
      if (!host && url.searchParams.get('since') === String(L.version)) return send(304);
      return send(200, E.viewFor(L, au, host, t));
    }

    let r, extra = {};
    switch (verb) {
      case 'join': {
        const pc = code + E.randCode(10); r = E.join(L, await E.hashCode('p', code, pc), t);
        if (!r.err) { au.cc = r.cc; au.pState = 'ok'; extra.player = E.fmtCode(pc); }
        break;
      }
      case 'leave': r = E.leave(L, au.cc); if (!r.err) au.cc = null; break;
      case 'start': r = au.master ? E.start(L, t, body.tz) : { err: 'Only the host can start the game.' }; break;
      case 'reset':
        if (!au.master) { r = { err: 'Only the host can reset the game.' }; break; }
        Object.assign(L, E.newLobby(code, L.mh, L.tz, t)); au.cc = null; r = { ok: 'The lobby was reset.' };
        break;
      case 'newcode': {
        if (!au.master) { r = { err: 'Only the host can issue codes.' }; break; }
        const c = String(body.cc || '');
        if (!L.players[c]) { r = { err: 'That country is not in this game.' }; break; }
        const pc = code + E.randCode(10); L.players[c].h = await E.hashCode('p', code, pc); extra.player = E.fmtCode(pc); extra.cc = c; r = { ok: 'New code issued for ' + E.cname(c) + '.' };
        break;
      }
      case 'move': case 'sanction': case 'aid': case 'extend': case 'vote':
        r = E.perform(L, au.cc, { t: verb, dx: body.dx, dy: body.dy, cc: body.cc }, t); break;
      default: return send(404, { error: 'Unknown action' });
    }
    if (r.err) return send(400, { error: r.err });
    if (await commit()) return send(200, Object.assign({ ok: r.ok, view: E.viewFor(L, au, !!body.host, t) }, extra));
  }
  return send(409, { error: 'Lots of orders arrived at once. Please try again.' });
}
