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
        const theme = JSON.stringify({ presetId: 'forest', custom: null });
        const questions = JSON.stringify([
          { id: 'q_name', type: 'short_answer', title: 'Full Name', required: true, help: '', options: [], condition: null },
          { id: 'q_attend', type: 'yes_no_maybe', title: 'Will you attend?', required: true, help: '', options: [], condition: null },
        ]);
        await DB.prepare(
          `INSERT INTO events (id, slug, name, event_date, event_time, venue_name, venue_address, theme_json, questions_json, status, owner_email, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
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

    if (!sub) {
      if (method === 'GET') return json({ event });
      if (method === 'PUT') {
        const b = await request.json().catch(() => ({}));
        await DB.prepare(
          `UPDATE events SET name=?, event_date=?, event_time=?, venue_name=?, venue_address=?,
             theme_json=?, questions_json=?, status=?, google_sheet_id=?, updated_at=? WHERE slug = ?`
        )
          .bind(
            b.name ?? event.name, b.event_date ?? event.event_date, b.event_time ?? event.event_time,
            b.venue_name ?? event.venue_name, b.venue_address ?? event.venue_address,
            b.theme_json ?? event.theme_json, b.questions_json ?? event.questions_json,
            b.status ?? event.status, b.google_sheet_id ?? event.google_sheet_id, nowIso(), slug
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

        if (event.google_sheet_id && env.GOOGLE_SERVICE_ACCOUNT_JSON) {
          try {
            const qs = JSON.parse(event.questions_json || '[]');
            const row = qs
              .filter((q) => !['section_divider', 'title_block'].includes(q.type))
              .map((q) => { const v = answers[q.id]; return Array.isArray(v) ? v.join(', ') : v || ''; });
            await appendRowToSheet(env, event.google_sheet_id, [submittedAt, ...row]);
          } catch (err) {
            console.error('Google Sheets sync failed:', err.message);
          }
        }
        return json({ ok: true, id }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

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

function b64url(input) {
  const str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToBuf(pem) {
  const bin = atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function googleToken(env) {
  const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: creds.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToBuf(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claims));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claims + '.' + b64url(sig),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}
async function appendRowToSheet(env, sheetId, row) {
  const token = await googleToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }
  );
  if (!res.ok) throw new Error('Sheets append failed: ' + (await res.text()));
}
