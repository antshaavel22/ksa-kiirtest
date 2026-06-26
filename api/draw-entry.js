// ──────────────────────────────────────────────────────────────────────────
//  /api/draw-entry  —  Kiirtest 2× newsletter draw entry
//
//  Completing the kiirtest doubles the user's chance in the monthly draw.
//  Upserts into Supabase `newsletter_entries` (ksa-analytics project):
//    • existing email+month row  → set extra_entries = 1  (base 1 + extra 1 = 2×)
//    • no row yet                → create one (kiirtest becomes a draw on-ramp)
//  Idempotent: repeated calls never stack beyond a single extra entry.
//
//  ENV required on the kiirtest Vercel project (prj_VxnMSGuQItY29ydiuXxtRq5qW2wn):
//    SUPABASE_URL          e.g. https://hjnvvulgbccbvwapxtgv.supabase.co
//    SUPABASE_SERVICE_KEY  service-role key (server-only; bypasses RLS)
// ──────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function monthToDate(month) {
  // accepts "2026-07" or "2026-07-01" → returns "2026-07-01"
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})/.exec(String(month));
  return m ? `${m[1]}-${m[2]}-01` : null;
}

function isEmail(e) {
  return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
}

const { randomUUID } = require('crypto');

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { ok: res.ok, status: res.status, json };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'bad_json' });
  }

  const email = (body.email || '').trim().toLowerCase();
  const first_name = (body.first_name || '').trim() || null;
  const language = (body.language || 'et').toLowerCase();  // newsletter_entries CHECK requires 'et'|'ru'|'en'
  const source = (body.source || 'kiirtest').slice(0, 40);
  const entry_month = monthToDate(body.month) || monthToDate(new Date().toISOString());

  if (!isEmail(email)) {
    return res.status(200).json({ ok: true, skipped: 'no_valid_email' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    // Fail soft — never block the user's result on a missing env var.
    console.error('draw-entry: SUPABASE env not configured');
    return res.status(200).json({ ok: true, skipped: 'supabase_not_configured' });
  }

  try {
    // 1) existing row for this email + month?
    const q = `newsletter_entries?email=eq.${encodeURIComponent(email)}&entry_month=eq.${entry_month}&select=id,extra_entries`;
    const found = await sb(q, { method: 'GET' });

    if (found.ok && Array.isArray(found.json) && found.json.length > 0) {
      const row = found.json[0];
      if ((row.extra_entries || 0) >= 1) {
        return res.status(200).json({ ok: true, already_doubled: true });
      }
      const upd = await sb(`newsletter_entries?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ extra_entries: 1 }),
      });
      return res.status(200).json({ ok: upd.ok, doubled: upd.ok, mode: 'updated' });
    }

    // 2) no row → create one (kiirtest on-ramp into the draw)
    const ins = await sb('newsletter_entries', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        email,
        first_name,
        language,
        entry_month,
        extra_entries: 1,
        gdpr_consent: true,
        marketing_consent: true,
        referral_code: 'KT-' + randomUUID(),  // NOT NULL + UNIQUE in newsletter_entries
        prize_choice: 'giftcard',              // NOT NULL + CHECK (sunglasses|contacts|drops|giftcard); kiirtest has no preference → giftcard
      }),
    });
    return res.status(200).json({ ok: ins.ok, created: ins.ok, mode: 'inserted', status: ins.status });
  } catch (err) {
    console.error('draw-entry error:', err);
    // Soft-fail: user still sees their result.
    return res.status(200).json({ ok: false, error: 'exception' });
  }
};
