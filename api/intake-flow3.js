// api/intake-flow3.js
//
// Server-side proxy to Mai's CRM ticket intake API.
//
// WHY a proxy and not direct from browser:
//   - The API key (KSA_TICKETS_API_KEY) must never reach the browser
//   - We get a single chokepoint to log + Slack-notify alongside Mai's CRM
//   - We can fall back gracefully (still post to /api/track for Slack visibility)
//     if Mai's endpoint has a hiccup
//
// FLOW:
//   browser → POST /api/intake-flow3 (no auth needed for the callback form)
//          → server adds X-KSA-API-Key header
//          → forwards to https://my.ksa.ee/api/v1/tickets/intake/flow3
//          → also fires a Slack ping via /api/track (best effort)
//          → returns Mai's ticket envelope to browser
//
// MAI'S SPEC: see project_ksa_kiirtest_v3.md memory file (locked 2026-05-05).

// CRM endpoint — Mai's CRM lives at crm.ksa.ee (my.ksa.ee still routes to legacy
// Erply). URL clarified by Mai 2026-05-05 11:51. Override via env var if needed.
const KSA_TICKETS_ENDPOINT = process.env.KSA_TICKETS_ENDPOINT
  || 'https://crm.ksa.ee/api/v1/tickets/intake/flow3';
const KSA_TICKETS_API_KEY = process.env.KSA_TICKETS_API_KEY || '';

// Allowed enums per Mai's spec — we validate before forwarding to fail fast on bad input
const VALID_SOURCES = new Set(['kiirtest', 'sobivustest']);
const VALID_LANGS = new Set(['et', 'ru', 'en']);
const VALID_AGE_BANDS = new Set(['under_18', '18_45', 'over_45']);
const VALID_VISION = new Set(['myopia', 'hyperopia', 'presbyopia', 'other', 'unknown']);
const VALID_GROUPS = new Set([
  'flow3_eligible_myope',
  'audit_hyperope',
  'audit_over_45',
  'children_exam',
  'unclassified',
]);

// Light E.164 sanity check — accepts +CC followed by 7-15 digits
function isE164(p) {
  return typeof p === 'string' && /^\+[1-9]\d{6,14}$/.test(p.replace(/\s+/g, ''));
}

function normalisePhone(p) {
  if (typeof p !== 'string') return null;
  const cleaned = p.replace(/[\s\-()]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
  // Estonian no-prefix number — assume +372
  if (/^[1-9]\d{6,7}$/.test(cleaned)) return '+372' + cleaned;
  // 00-prefix → +
  if (/^00[1-9]\d{5,14}$/.test(cleaned)) return '+' + cleaned.slice(2);
  return null;
}

function badRequest(res, msg, details) {
  return res.status(400).json({ ok: false, error: { code: 'bad_request', message: msg, details } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'method_not_allowed' } });
  }

  if (!KSA_TICKETS_API_KEY) {
    console.error('[intake-flow3] KSA_TICKETS_API_KEY env var is not set');
    return res.status(500).json({ ok: false, error: { code: 'config_missing', message: 'API key not configured' } });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return badRequest(res, 'invalid JSON'); }
  }
  body = body || {};

  // ── Validate + normalise per Mai's payload spec ──────────────────────────────
  const source = body.source;
  const lang = body.lang;
  const contact = body.contact || {};
  const qualifying = body.qualifying || {};
  const groupHint = body.group_hint;
  const utm = body.utm || {};
  const sessionId = body.client_session_id || null;

  if (!VALID_SOURCES.has(source)) return badRequest(res, 'source must be kiirtest|sobivustest');
  if (!VALID_LANGS.has(lang)) return badRequest(res, 'lang must be et|ru|en');
  const phone = normalisePhone(contact.phone);
  if (!phone || !isE164(phone)) return badRequest(res, 'contact.phone must be E.164', { received: contact.phone });
  if (!VALID_AGE_BANDS.has(qualifying.age_band)) return badRequest(res, 'qualifying.age_band invalid');
  if (!VALID_VISION.has(qualifying.vision_issue)) return badRequest(res, 'qualifying.vision_issue invalid');
  if (!VALID_GROUPS.has(groupHint)) return badRequest(res, 'group_hint invalid');

  const payload = {
    source,
    lang,
    contact: {
      phone,
      ...(contact.name ? { name: String(contact.name).trim().slice(0, 200) } : {}),
      ...(contact.email ? { email: String(contact.email).trim().slice(0, 320) } : {}),
    },
    qualifying: {
      age_band: qualifying.age_band,
      vision_issue: qualifying.vision_issue,
      ...(typeof qualifying.prescription_sphere === 'number' ? { prescription_sphere: qualifying.prescription_sphere } : {}),
      ...(typeof qualifying.prescription_cylinder === 'number' ? { prescription_cylinder: qualifying.prescription_cylinder } : {}),
    },
    group_hint: groupHint,
    utm: {
      source: utm.source || null,
      medium: utm.medium || null,
      campaign: utm.campaign || null,
      content: utm.content || null,
      term: utm.term || null,
      gclid: utm.gclid || null,
      gbraid: utm.gbraid || null,
      wbraid: utm.wbraid || null,
      fbclid: utm.fbclid || null,
      entry_source: utm.entry_source || null,
      funnel: utm.funnel || null,
      slug: utm.slug || null,
      lang: utm.lang || lang,
    },
    ...(sessionId ? { client_session_id: String(sessionId).slice(0, 64) } : {}),
  };

  // ── Forward to Mai's CRM ────────────────────────────────────────────────────
  let crmResp;
  try {
    const r = await fetch(KSA_TICKETS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-KSA-API-Key': KSA_TICKETS_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* leave as text */ }
    crmResp = { status: r.status, ok: r.ok, body: parsed ?? text };
  } catch (err) {
    console.error('[intake-flow3] CRM forward failed:', err);
    crmResp = { status: 0, ok: false, body: { error: { code: 'upstream_unreachable', message: String(err) } } };
  }

  // Mai's CRM wraps the response: { data: { ticket: {...} }, meta: {...} }
  const ticket = crmResp.body?.data?.ticket || crmResp.body?.ticket || null;

  // ── Slack ping via /api/track (awaited — Vercel kills fire-and-forget) ──────
  // Mai's CRM has its own Lilia notification, but we keep #kiirtesti-täitmised
  // as the team's canonical channel. We await this to ensure delivery, but
  // we don't fail the request if Slack hiccups.
  try {
    const baseUrl = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const trackUrl = `${proto}://${baseUrl}/api/track`;
    await fetch(trackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'callback_requested',
        source: payload.source,
        contact: { name: contact.name || null, phone },
        code: body.code || null,
        from: body.from || null,
        crm_ticket_id: ticket?.id || null,
        crm_ticket_number: ticket?.number || null,
        crm_status: crmResp.status,
        utm: payload.utm,
        timestamp: new Date().toISOString(),
      }),
    }).catch((err) => { console.warn('[intake-flow3] track ping failed:', err); });
  } catch (err) {
    console.warn('[intake-flow3] track ping outer error:', err);
  }

  // ── Return CRM response (or graceful proxy error) to browser ────────────────
  if (!crmResp.ok) {
    return res.status(crmResp.status === 0 ? 502 : crmResp.status).json({
      ok: false,
      error: { code: 'upstream_error', message: 'CRM rejected the lead', upstream: crmResp.body },
    });
  }

  return res.status(201).json({
    ok: true,
    ticket,
    raw: crmResp.body,
  });
}
