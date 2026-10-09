// EleganteRSVP / Imbitado backend: ONE file that handles every /api/events... route.
// Needs a D1 database bound to this Pages project with the variable name DB.

const HEADERS = { 'Content-Type': 'application/json' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const newId = (p) => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
const slugify = (name) =>
  (name || 'event').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event';

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Database not connected. Add a D1 binding named DB in Settings > Bindings.' }, 500);

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
      if (method === 'GET') return json({ event });
      if (method === 'PUT') {
        const b = await request.json().catch(() => ({}));
        await DB.prepare(
          `UPDATE events SET name=?, event_date=?, event_time=?, venue_name=?, venue_address=?,
             theme_json=?, questions_json=?, status=?,
             registry_url=?, cash_gift_enabled=?, cash_gift_title=?, cash_gift_note=?, payment_methods_json=?,
             sheet_webhook_url=?, intro_message=?, plus_one_policy=?, plus_one_limit=?,
             expected_attendees=?, thank_yes_message=?, thank_decline_message=?, gift_show_on=?, updated_at=?
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
            nowIso(), slug
          )
          .run();
        const updated = await DB.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first();
        return json({ event: updated });
      }
      if (method === 'DELETE') {
        await DB.prepare('DELETE FROM responses WHERE event_id = ?').bind(event.id).run();
        await DB.prepare('DELETE FROM dashboard_access WHERE event_id = ?').bind(event.id).run();
        await DB.prepare('DELETE FROM events WHERE id = ?').bind(event.id).run();
        return json({ ok: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ---------- /api/events/:slug/responses ----------
    if (sub === 'responses') {
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
