/* Alliances game rules. Pure functions, no I/O, safe for the Workers runtime. */
export const SIZE = 25, AP_MIN = 20 * 60, WIN_END = 22 * 60 + 15, LOGMAX = 400;
export const START_STABILITY = 3, START_REACH = 2, EXTEND_COST = 2;
export const DEFAULT_TZ = 'America/Chicago';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODES = 'AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW VA PS'.split(' ');

let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* names fall back to codes */ }
export const cname = (cc) => { try { return (dn && dn.of(cc)) || cc; } catch (e) { return cc; } };
const colL = (i) => String.fromCharCode(65 + i);
const coord = (x, y) => colL(x) + (y + 1);

/* ---------- randomness and codes (WebCrypto) ---------- */
export function randInt(n) {
  const limit = Math.floor(4294967296 / n) * n, a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= limit);
  return a[0] % n;
}
export function randCode(n) { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[randInt(ALPHA.length)]; return s; }
export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const fmtCode = (s) => (s.match(/.{1,5}/g) || []).join('-');
export async function hashCode(kind, lobby, norm) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kind + ':' + lobby + ':' + norm));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- time (all rules run in the game's time zone) ---------- */
const fmtCache = {};
function parts(ms, tz) {
  let f = fmtCache[tz];
  if (!f) f = fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o = {}; for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value;
  if (o.hour === 24) o.hour = 0; return o;
}
export const dayIdx = (ms, tz) => { const p = parts(ms, tz); return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 864e5); };
export const minsOf = (ms, tz) => { const p = parts(ms, tz); return p.hour * 60 + p.minute + p.second / 60; };
export const grantDay = (ms, tz) => dayIdx(ms, tz) - (minsOf(ms, tz) < AP_MIN ? 1 : 0);
export const windowOpen = (ms, tz) => { const m = minsOf(ms, tz); return m >= AP_MIN && m < WIN_END; };
export function wallToEpoch(day, mins, tz) {
  const base = day * 864e5 + mins * 6e4; let t = base;
  for (let i = 0; i < 3; i++) { const p = parts(t, tz); t += base - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
  return t;
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length < 60; } catch (e) { return false; } };

/* ---------- game state ---------- */
export function newLobby(code, mh, tz, t) {
  const L = { code, mh, phase: 'lobby', tz, players: {}, jury: {}, log: [], seq: 0, lastGrant: 0, winner: null, version: 1, created: t, updated: t };
  push(L, t, { k: 'open' }); return L;
}
function push(L, t, e) { L.seq += 1; e.id = L.seq; e.t = t; L.log.push(e); if (L.log.length > LOGMAX) L.log.splice(0, L.log.length - LOGMAX); }
const alives = (L) => Object.keys(L.players).filter((c) => L.players[c].alive);
const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const occupied = (L, x, y) => alives(L).some((c) => L.players[c].x === x && L.players[c].y === y);
export const findMine = (L, h) => (h ? Object.keys(L.players).find((c) => L.players[c].h === h) : null);

/* Daily 8 pm grants are applied lazily whenever the lobby is touched. Returns true if anything changed. */
export function applyGrants(L, t) {
  if (L.phase !== 'running') return false;
  const cur = grantDay(t, L.tz); if (cur <= L.lastGrant) return false;
  for (let d = L.lastGrant + 1; d <= cur; d++) {
    const when = wallToEpoch(d, AP_MIN, L.tz), tally = {}; let best = 0, winners = [];
    for (const v of Object.keys(L.jury)) { const tg = L.jury[v]; if (L.players[tg] && L.players[tg].alive) tally[tg] = (tally[tg] || 0) + 1; }
    for (const c of Object.keys(tally)) { if (tally[c] > best) { best = tally[c]; winners = [c]; } else if (tally[c] === best) winners.push(c); }
    for (const c of alives(L)) L.players[c].ap += 1;
    push(L, when, { k: 'grant' });
    if (winners.length === 1) { L.players[winners[0]].ap += 1; push(L, when, { k: 'council', to: winners[0] }); }
    L.jury = {};
  }
  L.lastGrant = cur; return true;
}
export function join(L, h, t) {
  if (L.phase !== 'lobby') return { err: 'The game has already started.' };
  const free = CODES.filter((c) => !L.players[c]);
  if (!free.length) return { err: 'The lobby is full.' };
  const cc = free[randInt(free.length)];
  L.players[cc] = { h, alive: true }; push(L, t, { k: 'join', a: cc });
  return { ok: 'You are ' + cname(cc) + '.', cc };
}
export function leave(L, cc) {
  if (L.phase !== 'lobby') return { err: 'The game has already started.' };
  if (!cc) return { err: 'You have not joined this lobby.' };
  delete L.players[cc]; return { ok: 'You left the lobby.' };
}
export function start(L, t, tz) {
  if (L.phase !== 'lobby') return { err: 'The game has already started.' };
  const ids = Object.keys(L.players);
  if (ids.length < 2) return { err: 'At least 2 countries must join before the game can start.' };
  if (tz) { if (!validTz(tz)) return { err: 'Unknown time zone.' }; L.tz = tz; }
  const cells = []; for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) cells.push([x, y]);
  for (let i = cells.length - 1; i > 0; i--) { const j = randInt(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  ids.forEach((c, i) => { Object.assign(L.players[c], { x: cells[i][0], y: cells[i][1], lives: START_STABILITY, ap: 1, reach: START_REACH, alive: true }); });
  L.phase = 'running'; L.lastGrant = grantDay(t, L.tz); L.jury = {};
  push(L, t, { k: 'start', n: ids.length }); return { ok: 'The game has started.' };
}
export function perform(L, cc, a, t) {
  const p = cc && L.players[cc];
  if (a.t === 'vote') {
    if (L.phase !== 'running') return { err: 'The game is not running.' };
    if (!p || p.alive) return { err: 'Only fallen countries sit on the council.' };
    const tg = L.players[a.cc]; if (!tg || !tg.alive) return { err: 'Pick a country that is still in play.' };
    L.jury[cc] = a.cc; return { ok: 'Vote recorded. You can change it until 8:00 pm.' };
  }
  if (L.phase !== 'running') return { err: 'The game is not running.' };
  if (!p || !p.alive) return { err: 'You are not in play.' };
  if (!windowOpen(t, L.tz)) return { err: 'The action window is closed right now.' };
  const cost = a.t === 'extend' ? EXTEND_COST : 1;
  if (p.ap < cost) return { err: cost > 1 ? 'Extending your reach costs ' + cost + ' AP and you have ' + p.ap + '.' : 'You have no action points.' };
  if (a.t === 'move') {
    const dx = +a.dx, dy = +a.dy;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || !(dx || dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return { err: 'A country moves one square at a time.' };
    const nx = p.x + dx, ny = p.y + dy;
    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return { err: 'That is off the edge of the map.' };
    if (occupied(L, nx, ny)) return { err: 'That square is occupied.' };
    const fx = p.x, fy = p.y; p.x = nx; p.y = ny; p.ap -= 1;
    push(L, t, { k: 'move', a: cc, fx, fy, x: nx, y: ny }); return { ok: 'Moved to ' + coord(nx, ny) + '.' };
  }
  if (a.t === 'sanction' || a.t === 'aid') {
    const v = L.players[a.cc];
    if (!v || !v.alive || a.cc === cc) return { err: 'That is not a valid target.' };
    if (dist(p, v) > p.reach) return { err: 'That country is out of reach.' };
    p.ap -= 1;
    if (a.t === 'aid') {
      v.ap += 1; push(L, t, { k: 'gave', to: cc, b: a.cc }); push(L, t, { k: 'got', to: a.cc, a: cc });
      return { ok: 'Sent 1 AP in aid to ' + cname(a.cc) + '.' };
    }
    v.lives -= 1;
    if (v.lives > 0) {
      push(L, t, { k: 'hit', to: a.cc, a: cc, left: v.lives }); push(L, t, { k: 'shot', to: cc, b: a.cc });
      return { ok: 'Your sanction reached ' + cname(a.cc) + '.' };
    }
    const loot = v.ap; v.alive = false; v.lives = 0; v.ap = 0; p.ap += loot;
    push(L, t, { k: 'kill', a: cc, b: a.cc, x: v.x, y: v.y });
    if (loot > 0) push(L, t, { k: 'loot', to: cc, b: a.cc, n: loot });
    const left = alives(L);
    if (left.length <= 1) { L.phase = 'over'; L.winner = left[0] || cc; push(L, t, { k: 'win', a: L.winner }); }
    return { ok: 'Final sanction. ' + cname(a.cc) + ' has collapsed.' };
  }
  if (a.t === 'extend') { p.reach += 1; p.ap -= cost; push(L, t, { k: 'up', to: cc, r: p.reach }); return { ok: 'Your reach is now ' + p.reach + '.' }; }
  return { err: 'Unknown order.' };
}

/* ---------- what each viewer may see (the fog of war) ---------- */
export function viewFor(L, au, wantHost, t) {
  const v = { code: L.code, phase: L.phase, tz: L.tz, version: L.version, now: t, winner: L.winner, players: {}, me: au.cc || null, isMaster: !!au.master, codes: { player: au.pState, master: au.mState }, log: [], mine: null, myVote: null };
  for (const c of Object.keys(L.players)) {
    const p = L.players[c]; v.players[c] = { alive: p.alive };
    if (p.x != null) { v.players[c].x = p.x; v.players[c].y = p.y; }
  }
  if (au.cc) {
    const p = L.players[au.cc];
    if (p.x != null) v.mine = { lives: p.lives, ap: p.ap, reach: p.reach, alive: p.alive };
    v.myVote = L.jury[au.cc] || null;
  }
  v.log = L.log.filter((e) => !e.to || e.to === au.cc);
  if (au.master && wantHost) {
    v.host = Object.keys(L.players).map((c) => { const p = L.players[c]; return { cc: c, x: p.x, y: p.y, lives: p.lives, ap: p.ap, reach: p.reach, alive: p.alive }; });
  }
  return v;
}
