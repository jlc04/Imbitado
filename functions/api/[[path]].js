// EleganteRSVP / Imbitado backend: ONE file that handles every /api/events... route.
// Needs a D1 database bound to this Pages project with the variable name DB.

const BUILD = '7';
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
function partyInfo(event, answers) {
  let qs = [];
  try { qs = JSON.parse(event.questions_json || '[]'); } catch (e) {}
  const yn = qs.filter((q) => q.type === 'yes_no_maybe' || q.type === 'yes_no');
  const aq = yn.find((q) => /attend|coming|rsvp|join|make it/i.test(q.title)) || yn[0];
  const attending = aq ? answers[aq.id] === 'Yes' : true;
  const nums = qs.filter((q) => q.type === 'number');
  const pq = nums.find((q) => /number of guest|party size|total guest|how many guest|guests/i.test(q.title)) || (nums.length === 1 ? nums[0] : null);
  let party = pq && answers[pq.id] ? Math.max(1, parseInt(answers[pq.id], 10) || 1) : 1;
  const pol = event.plus_one_policy || 'limited';
  const lim = parseInt(event.plus_one_limit, 10);
  let max = null;
  if (pol === 'none') max = 1;
  else if (pol === 'one') max = 2;
  else if (pol !== 'unlimited') max = 1 + (Number.isNaN(lim) ? 1 : Math.max(0, lim));
  if (max !== null) party = Math.min(party, max);
  return { attending, party };
}
function answerSummary(event, answers) {
  let qs = [];
  try { qs = JSON.parse(event.questions_json || '[]'); } catch (e) {}
  const nq = qs.find((q) => q.type === 'short_answer' && /name/i.test(q.title)) || qs.find((q) => q.type === 'short_answer');
  const yn = qs.filter((q) => q.type === 'yes_no_maybe' || q.type === 'yes_no');
  const aq = yn.find((q) => /attend|coming|rsvp|join|make it/i.test(q.title)) || yn[0];
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

    // ---------- /api/events ----------
    if (!slug) {
      if (method === 'GET') {
        const { results } = await DB.prepare(
          `SELECT e.id, e.slug, e.name, e.event_date, e.event_time, e.status, e.owner_email,
                  (SELECT COUNT(*) FROM responses r WHERE r.event_id = e.id) AS response_count
           FROM events e ORDER BY e.updated_at DESC`
        ).all();
        return json({ events: results });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const name = (body.name || 'Untitled Event').trim();
        const id = newId('ev');
        let s = slugify(name);
        const taken = await DB.prepare('SELECT id FROM events WHERE slug = ?').bind(s).first();
        if (taken) s = s + '-' + Math.random().toString(36).slice(2, 6);
        const now = nowIso();
        const theme = JSON.stringify({ presetId: 'luxury', customColors: null });
        const questions = JSON.stringify([
          { id: 'q_name', type: 'short_answer', title: 'Full Name', required: true, help: '', options: [], condition: null },
          { id: 'q_attend', type: 'yes_no_maybe', title: 'Will you attend?', required: true, help: '', options: [], condition: null },
        ]);
        await DB.prepare(
          `INSERT INTO events (id, slug, name, event_date, event_time, venue_name, venue_address, theme_json, questions_json, status, owner_email, created_at, updated_at, plus_one_policy, plus_one_limit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, 'limited', 1)`
        )
          .bind(id, s, name, body.event_date || '', body.event_time || '', body.venue_name || '', body.venue_address || '',
                theme, questions, body.owner_email || '', now, now)
          .run();
        const created = await DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
        return json({ event: created }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    const event = await DB.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first();
    if (!event) return json({ error: 'not found' }, 404);

    // ---------- /api/events/:slug ----------
    if (!sub) {
      if (method === 'GET') return json({ event, build: BUILD });
      if (method === 'PUT') {
        const b = await request.json().catch(() => ({}));
        await DB.prepare(
          `UPDATE events SET name=?, event_date=?, event_time=?, venue_name=?, venue_address=?,
             theme_json=?, questions_json=?, status=?,
             registry_url=?, cash_gift_enabled=?, cash_gift_title=?, cash_gift_note=?, payment_methods_json=?,
             sheet_webhook_url=?, intro_message=?, plus_one_policy=?, plus_one_limit=?,
             expected_attendees=?, thank_yes_message=?, thank_decline_message=?, gift_show_on=?, seating_json=?, updated_at=?
           WHERE slug = ?`
        )
          .bind(
            b.name ?? event.name, b.event_date ?? event.event_date, b.event_time ?? event.event_time,
            b.venue_name ?? event.venue_name, b.venue_address ?? event.venue_address,
            b.theme_json ?? event.theme_json, b.questions_json ?? event.questions_json,
            b.status ?? event.status,
            b.registry_url ?? event.registry_url, b.cash_gift_enabled ?? event.cash_gift_enabled,
            b.cash_gift_title ?? event.cash_gift_title, b.cash_gift_note ?? event.cash_gift_note,
            b.payment_methods_json ?? event.payment_methods_json,
            b.sheet_webhook_url ?? event.sheet_webhook_url,
            b.intro_message ?? event.intro_message, b.plus_one_policy ?? event.plus_one_policy, b.plus_one_limit ?? event.plus_one_limit,
            b.expected_attendees ?? event.expected_attendees, b.thank_yes_message ?? event.thank_yes_message, b.thank_decline_message ?? event.thank_decline_message,
            b.gift_show_on ?? event.gift_show_on,
            b.seating_json ?? event.seating_json,
            nowIso(), slug
          )
          .run();
        if (b.seating_json) {
          const cfg = sjParse(b.seating_json);
          const { results } = await DB.prepare('SELECT seat_id FROM seat_assignments WHERE event_id = ?').bind(event.id).all();
          for (const r of results) {
            if (!seatValid(r.seat_id, cfg)) await DB.prepare('DELETE FROM seat_assignments WHERE event_id = ? AND seat_id = ?').bind(event.id, r.seat_id).run();
          }
        }
        const updated = await DB.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first();
        return json({ event: updated });
      }
      if (method === 'DELETE') {
        await DB.prepare('DELETE FROM seat_assignments WHERE event_id = ?').bind(event.id).run();
        await DB.prepare('DELETE FROM responses WHERE event_id = ?').bind(event.id).run();
        await DB.prepare('DELETE FROM dashboard_access WHERE event_id = ?').bind(event.id).run();
        await DB.prepare('DELETE FROM events WHERE id = ?').bind(event.id).run();
        return json({ ok: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ---------- /api/events/:slug/responses ----------
    if (sub === 'responses') {
      // /api/events/:slug/responses/:id  -> remove one RSVP (only if it belongs to this event)
      if (segs[3]) {
        if (method === 'DELETE') {
          await DB.prepare('DELETE FROM seat_assignments WHERE event_id = ? AND rid = ?').bind(event.id, segs[3]).run();
          await DB.prepare('DELETE FROM responses WHERE id = ? AND event_id = ?').bind(segs[3], event.id).run();
          return json({ ok: true });
        }
        return json({ error: 'method not allowed' }, 405);
      }
      if (method === 'GET') {
        const { results } = await DB.prepare(
          'SELECT id, answers_json, submitted_at FROM responses WHERE event_id = ? ORDER BY submitted_at DESC'
        ).bind(event.id).all();
        return json({ responses: results.map((r) => ({ id: r.id, answers: JSON.parse(r.answers_json), submitted_at: r.submitted_at })) });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const answers = body.answers || {};
        const id = newId('r');
        const submittedAt = nowIso();
        await DB.prepare('INSERT INTO responses (id, event_id, answers_json, submitted_at) VALUES (?, ?, ?, ?)')
          .bind(id, event.id, JSON.stringify(answers), submittedAt).run();

        // Best-effort spreadsheet mirror — never blocks or fails the RSVP if it errors.
        if (event.sheet_webhook_url) {
          try {
            const qs = JSON.parse(event.questions_json || '[]');
            const row = [submittedAt, ...qs
              .filter((q) => !['section_divider', 'title_block'].includes(q.type))
              .map((q) => { const v = answers[q.id]; return Array.isArray(v) ? v.join(', ') : (v || ''); })];
            await fetch(event.sheet_webhook_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ row }),
            });
          } catch (err) {
            console.error('Spreadsheet webhook failed:', err.message);
          }
        }
        return json({ ok: true, id }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ---------- /api/events/:slug/seats ----------
    if (sub === 'seats') {
      const cfg = sjParse(event.seating_json);
      const now = nowIso();
      if (method === 'GET') {
        const q = new URL(request.url).searchParams;
        const nm = q.get('name');
        if (nm !== null) {
          const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const { results } = await DB.prepare('SELECT id, answers_json FROM responses WHERE event_id = ?').bind(event.id).all();
          const hits = results.filter((r) => { const a = JSON.parse(r.answers_json); return norm(answerSummary(event, a).name) === norm(nm) && partyInfo(event, a).attending; });
          if (hits.length === 1) return json({ found: true, rid: hits[0].id });
          return json({ found: false, ambiguous: hits.length > 1 });
        }
        const rid = q.get('rid');
        const m = await seatMap(DB, event.id);
        const mine = rid ? await mineFor(DB, event, rid) : null;
        return json({
          config: { enabled: cfg.enabled, guestPick: cfg.guestPick, layout: cfg.layout, count: cfg.count, perTable: cfg.perTable, names: cfg.names, blocked: cfg.blocked },
          assign: m.assign, src: m.src, mine,
        });
      }
      if (method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const op = b.op;
        const ins = (sid, key, source, mode) =>
          DB.prepare(`INSERT ${mode || ''} INTO seat_assignments (event_id, seat_id, person_key, rid, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(event.id, sid, key, String(key).split('#')[0], source, now);

        // ----- a guest choosing their own seats -----
        if (op === 'guest_pick') {
          if (!cfg.enabled || !cfg.guestPick) return json({ error: 'Seat choosing is not open for this event.' }, 403);
          const rid = String(b.rid || '');
          const mine = await mineFor(DB, event, rid);
          if (!mine) return json({ error: 'We could not find your RSVP.' }, 404);
          if (!mine.attending) return json({ error: 'Only guests who said Yes can choose seats.' }, 403);
          if (mine.locked) return json({ error: 'The hosts have already arranged your seating.' }, 403);
          const sids = [...new Set((Array.isArray(b.sids) ? b.sids : []).map(String))];
          if (sids.length === 0 || sids.length > mine.party) return json({ error: 'Please choose between 1 and ' + mine.party + ' seat' + (mine.party === 1 ? '' : 's') + '.' }, 400);
          for (const sid of sids) {
            if (!seatValid(sid, cfg)) return json({ error: 'That seat does not exist.' }, 400);
            if (cfg.blocked.includes(sid)) return json({ error: 'That seat is reserved.' }, 409);
          }
          try {
            await DB.batch([
              DB.prepare("DELETE FROM seat_assignments WHERE event_id = ? AND rid = ? AND source = 'guest'").bind(event.id, rid),
              ...sids.map((sid, i) => ins(sid, rid + '#' + i, 'guest')),
            ]);
          } catch (err) {
            const m = await seatMap(DB, event.id);
            return json({ error: 'Someone just took one of those seats — please choose again.', assign: m.assign, src: m.src, mine: await mineFor(DB, event, rid) }, 409);
          }
          const m = await seatMap(DB, event.id);
          return json({ ok: true, assign: m.assign, src: m.src, mine: await mineFor(DB, event, rid) });
        }

        // ----- the editor arranging seats -----
        if (op === 'set') {
          if (!seatValid(b.sid, cfg) || !/^[^#]+#\d+$/.test(String(b.key || ''))) return json({ error: 'bad seat' }, 400);
          const rid = String(b.key).split('#')[0];
          const ok = await DB.prepare('SELECT 1 AS x FROM responses WHERE id = ? AND event_id = ?').bind(rid, event.id).first();
          if (!ok) return json({ error: 'unknown guest' }, 404);
          await DB.batch([
            DB.prepare('DELETE FROM seat_assignments WHERE event_id = ? AND person_key = ?').bind(event.id, b.key),
            DB.prepare('DELETE FROM seat_assignments WHERE event_id = ? AND seat_id = ?').bind(event.id, b.sid),
            ins(b.sid, b.key, 'editor'),
          ]);
        } else if (op === 'unset' || op === 'prune') {
          const sids = op === 'unset' ? [b.sid] : (Array.isArray(b.sids) ? b.sids : []);
          if (sids.length) await DB.batch(sids.map((sid) => DB.prepare('DELETE FROM seat_assignments WHERE event_id = ? AND seat_id = ?').bind(event.id, String(sid))));
        } else if (op === 'bulk') {
          const pairs = (Array.isArray(b.pairs) ? b.pairs : []).filter((p) => Array.isArray(p) && seatValid(p[0], cfg) && /^[^#]+#\d+$/.test(String(p[1])));
          if (pairs.length) await DB.batch(pairs.map((p) => ins(p[0], p[1], 'editor', 'OR IGNORE')));
        } else if (op === 'clear') {
          await DB.prepare('DELETE FROM seat_assignments WHERE event_id = ?').bind(event.id).run();
        } else {
          return json({ error: 'unknown operation' }, 400);
        }
        const m = await seatMap(DB, event.id);
        return json({ ok: true, assign: m.assign, src: m.src });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ---------- /api/events/:slug/access ----------
    if (sub === 'access') {
      if (method === 'GET') {
        const { results } = await DB.prepare('SELECT email FROM dashboard_access WHERE event_id = ? ORDER BY added_at').bind(event.id).all();
        return json({ emails: results.map((r) => r.email) });
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const email = (body.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return json({ error: 'valid email required' }, 400);
        const exists = await DB.prepare('SELECT id FROM dashboard_access WHERE event_id = ? AND email = ?').bind(event.id, email).first();
        if (!exists) {
          await DB.prepare('INSERT INTO dashboard_access (id, event_id, email, added_at) VALUES (?, ?, ?, ?)')
            .bind(newId('acc'), event.id, email, nowIso()).run();
        }
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        const email = (new URL(request.url).searchParams.get('email') || '').trim().toLowerCase();
        await DB.prepare('DELETE FROM dashboard_access WHERE event_id = ? AND email = ?').bind(event.id, email).run();
        return json({ ok: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}
