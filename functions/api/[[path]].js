// EleganteRSVP / Imbitado backend: ONE file that handles every /api/events... route.
// Needs a D1 database bound to this Pages project with the variable name DB.

const BUILD = '9';
const HEADERS = { 'Content-Type': 'application/json' };

// Self-healing database: creates any missing table/column automatically, so no manual SQL is ever needed again.
const BASE_DDL = [
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, event_date TEXT, event_time TEXT, venue_name TEXT, venue_address TEXT, theme_json TEXT NOT NULL DEFAULT '{}', questions_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', owner_email TEXT, google_sheet_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), answers_json TEXT NOT NULL, submitted_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_responses_event ON responses(event_id)",
  "CREATE TABLE IF NOT EXISTS dashboard_access (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), email TEXT NOT NULL, added_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_access_event ON dashboard_access(event_id)",
  "CREATE TABLE IF NOT EXISTS seat_assignments (event_id TEXT NOT NULL, seat_id TEXT NOT NULL, person_key TEXT NOT NULL, rid TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL, PRIMARY KEY (event_id, seat_id), UNIQUE (event_id, person_key))",
];
const EVENT_COLUMNS = [
  ['registry_url', "TEXT DEFAULT ''"], ['cash_gift_enabled', 'INTEGER DEFAULT 0'], ['cash_gift_title', "TEXT DEFAULT 'Cash Gift / Honeymoon Fund'"],
  ['cash_gift_note', "TEXT DEFAULT ''"], ['payment_methods_json', "TEXT DEFAULT '[]'"], ['sheet_webhook_url', "TEXT DEFAULT ''"],
  ['intro_message', "TEXT DEFAULT ''"], ['plus_one_policy', "TEXT DEFAULT 'limited'"], ['plus_one_limit', 'INTEGER DEFAULT 1'],
  ['expected_attendees', 'INTEGER DEFAULT 0'], ['thank_yes_message', "TEXT DEFAULT ''"], ['thank_decline_message', "TEXT DEFAULT ''"],
  ['gift_show_on', "TEXT DEFAULT 'no,maybe'"], ['seating_json', "TEXT DEFAULT ''"],
];
let schemaPromise = null;
async function ensureSchema(DB) {
  const run = async (sql) => { try { await DB.prepare(sql).run(); return true; } catch (e) { return false; } };
  for (const sql of BASE_DDL) await run(sql);
  let have = null;
  try {
    const r = await DB.prepare("SELECT name FROM pragma_table_info('events')").all();
    have = new Set(r.results.map((x) => x.name));
  } catch (e) {}
  for (const [col, ddl] of EVENT_COLUMNS) {
    if (have && have.has(col)) continue;
    await run('ALTER TABLE events ADD COLUMN ' + col + ' ' + ddl);
  }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const newId = (p) => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
const slugify = (name) =>
  (name || 'event').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event';

// ---- seat helpers (shared logic: how many people a guest is bringing, and the seating config) ----
function sjParse(raw) {
  let o = {};
  try { o = JSON.parse(raw || '{}') || {}; } catch (e) {}
  return {
    enabled: !!o.enabled,
    guestPick: o.guestPick !== false,
    layout: ['round', 'long', 'rows'].includes(o.layout) ? o.layout : 'round',
    count: Math.min(60, Math.max(1, parseInt(o.count, 10) || 8)),
    perTable: Math.min(30, Math.max(1, parseInt(o.perTable, 10) || 8)),
    names: o.names || {},
    blocked: Array.isArray(o.blocked) ? o.blocked.filter((x) => typeof x === 'string') : [],
  };
}
function seatValid(sid, cfg) {
  const m = /^(\d+):(\d+)$/.exec(String(sid));
  return !!m && +m[1] < cfg.count && +m[2] < cfg.perTable;
}
// ---- shared guest logic: IDENTICAL on the page and on the server, so counts and seats never disagree ----
const PLUS_RE = /plus.?one|\+\s?1\b|companion|additional guest|extra guest|bring(ing)?\s+(a|an|my)\s+(guest|date|partner|spouse|wife|husband|plus)/i;
const PARTY_RE = /number of (guest|attendee|people|person|pax)|party size|total (guest|attendee|people)|how many (guest|people|attendee|person)|guests|attendees|head ?count|pax/i;
function qAttendance(qs) {
  const yn = qs.filter((q) => q.type === 'yes_no_maybe' || q.type === 'yes_no');
  return yn.find((q) => /attend|coming|rsvp|join|make it/i.test(q.title) && !PLUS_RE.test(q.title)) || yn.find((q) => !PLUS_RE.test(q.title)) || yn[0];
}
function qName(qs) {
  const sa = qs.filter((q) => q.type === 'short_answer' && !PLUS_RE.test(q.title));
  return sa.find((q) => /name/i.test(q.title)) || sa[0] || qs.find((q) => q.type === 'short_answer');
}
function qParty(qs) {
  const nums = qs.filter((q) => q.type === 'number');
  return nums.find((q) => PARTY_RE.test(q.title)) || (nums.length === 1 ? nums[0] : null)
    || qs.find((q) => (q.type === 'dropdown' || q.type === 'multiple_choice') && PARTY_RE.test(q.title)) || null;
}
function qPlusNames(qs) { return qs.find((q) => (q.type === 'short_answer' || q.type === 'long_answer') && PLUS_RE.test(q.title)) || null; }
function qPlusYesNo(qs) {
  const aq = qAttendance(qs);
  return qs.find((q) => (q.type === 'yes_no' || q.type === 'yes_no_maybe') && q !== aq && PLUS_RE.test(q.title)) || null;
}
function splitNames(v) {
  return String(v == null ? '' : v).split(/[,;&\n\/+]|\band\b/i).map((x) => x.trim()).filter((x) => x && !/^(none|n\/a|na|no|nil|nobody|-+)$/i.test(x));
}
// How many people is this RSVP for? An explicit "number of guests" answer wins; otherwise count the plus-one names / a "yes" to a plus-one question.
function partyOf(qs, answers, maxParty) {
  let n = 1;
  const nq = qParty(qs), raw = nq ? answers[nq.id] : undefined;
  const parsed = (raw !== undefined && raw !== null && raw !== '') ? parseInt(String(raw), 10) : NaN;
  if (!Number.isNaN(parsed)) n = Math.max(1, parsed);
  else {
    const pq = qPlusNames(qs);
    if (pq && answers[pq.id]) n = Math.max(n, 1 + splitNames(answers[pq.id]).length);
    const yq = qPlusYesNo(qs);
    if (yq && answers[yq.id] === 'Yes') n = Math.max(n, 2);
  }
  return (maxParty !== null && maxParty !== undefined) ? Math.min(n, maxParty) : n;
}
// ---- end shared guest logic ----
function partyInfo(event, answers) {
  let qs = [];
  try { qs = JSON.parse(event.questions_json || '[]'); } catch (e) {}
  const aq = qAttendance(qs);
  const attending = aq ? answers[aq.id] === 'Yes' : true;
  const pol = event.plus_one_policy || 'limited';
  const lim = parseInt(event.plus_one_limit, 10);
  let max = null;
  if (pol === 'none') max = 1;
  else if (pol === 'one') max = 2;
  else if (pol !== 'unlimited') max = 1 + (Number.isNaN(lim) ? 1 : Math.max(0, lim));
  return { attending, party: partyOf(qs, answers, max) };
}
function answerSummary(event, answers) {
  let qs = [];
  try { qs = JSON.parse(event.questions_json || '[]'); } catch (e) {}
  const nq = qName(qs), aq = qAttendance(qs);
  return { name: nq && answers[nq.id] ? String(answers[nq.id]) : '', status: aq ? (answers[aq.id] || null) : null };
}
async function seatMap(DB, eventId) {
  const { results } = await DB.prepare('SELECT seat_id, person_key, source FROM seat_assignments WHERE event_id = ?').bind(eventId).all();
  const assign = {}, src = {};
  results.forEach((r) => { assign[r.seat_id] = r.person_key; src[r.seat_id] = r.source; });
  return { assign, src };
}
async function mineFor(DB, event, rid) {
  const row = await DB.prepare('SELECT id, answers_json FROM responses WHERE id = ? AND event_id = ?').bind(rid, event.id).first();
  if (!row) return null;
  const info = partyInfo(event, JSON.parse(row.answers_json));
  const { results } = await DB.prepare('SELECT seat_id, source FROM seat_assignments WHERE event_id = ? AND rid = ?').bind(event.id, rid).all();
  const sm = answerSummary(event, JSON.parse(row.answers_json));
  return { attending: info.attending, party: info.party, name: sm.name, status: sm.status, sids: results.map((r) => r.seat_id), locked: results.some((r) => r.source === 'editor') };
}
// ---- end seat helpers ----

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Database not connected. Add a D1 binding named DB in Settings > Bindings.' }, 500);
  schemaPromise = schemaPromise || ensureSchema(env.DB).catch(() => {});
  await schemaPromise;

  const segs = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const method = request.method;
  const DB = env.DB;

  try {
    if (segs[0] !== 'events') return json({ error: 'not found' }, 404);
    const slug = segs[1] || null;
    const sub = segs[2] || null;

    // ---------- /api/events ------
