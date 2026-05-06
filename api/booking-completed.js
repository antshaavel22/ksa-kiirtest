// api/booking-completed.js
//
// Webhook called when a customer completes a Flow3 booking on my.ksa.ee.
// Cancels all pending email-sequence steps for that customer so they stop
// receiving "have you booked yet?" follow-ups after they've already booked.
//
// USAGE (from my.ksa.ee booking system, after a paid Flow3 booking is confirmed):
//   POST https://kiirtest.ksa.ee/api/booking-completed
//   Authorization: Bearer <LP_TRACK_SHARED_TOKEN>
//   Content-Type: application/json
//   { "email": "patient@example.com", "source": "my.ksa.ee", "service": "Flow3" }
//
// Approach: stateless. We use Resend's list-emails API to find any scheduled
// (unsent) emails to this recipient, then call Resend's cancel endpoint on each.
// No external KV/DB needed — works as long as the pending emails are within
// the latest ~200 records on the Resend account.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SHARED_TOKEN = process.env.LP_TRACK_SHARED_TOKEN;
const SLACK_KIIRTEST_WEBHOOK = process.env.SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL;

async function fetchRecentEmails(maxPages = 3) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `https://api.resend.com/emails?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } });
    if (!r.ok) break;
    const data = await r.json();
    const batch = data.data || [];
    all.push(...batch);
    if (batch.length < 100) break;
    cursor = batch[batch.length - 1].id;
  }
  return all;
}

function isPendingForRecipient(e, email) {
  const targets = Array.isArray(e.to) ? e.to : (e.to ? [e.to] : []);
  if (!targets.some(t => (t || '').toLowerCase() === email.toLowerCase())) return false;
  // Resend marks scheduled emails with last_event === 'scheduled' until they fire.
  if (e.last_event && e.last_event !== 'scheduled') return false;
  if (e.scheduled_at) {
    return new Date(e.scheduled_at).getTime() > Date.now();
  }
  return e.last_event === 'scheduled';
}

async function cancelEmail(id) {
  const r = await fetch(`https://api.resend.com/emails/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  return r.ok;
}

async function notifySlack({ email, source, service, cancelled, failed }) {
  const lines = [
    `:no_entry: *Broneering tehtud — e-postide jada peatatud*`,
    `*E-post:* ${email}`,
    source ? `*Allikas:* ${source}` : null,
    service ? `*Teenus:* ${service}` : null,
    `*Tühistatud kirjasid:* ${cancelled}${failed ? ` (ebaõn: ${failed})` : ''}`,
    `_${new Date().toLocaleString('et-EE', { timeZone: 'Europe/Tallinn' })}_`,
  ].filter(Boolean);
  try {
    await fetch(SLACK_KIIRTEST_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
  } catch (_) { /* don't fail the request on slack errors */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${SHARED_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const email = (body?.email || '').trim().toLowerCase();
  const source = body?.source || null;
  const service = body?.service || null;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'email required' });
  }

  let emails;
  try {
    emails = await fetchRecentEmails(3);
  } catch (err) {
    console.error('Resend list error:', err);
    return res.status(502).json({ ok: false, error: 'Resend list failed' });
  }

  const pending = emails.filter(e => isPendingForRecipient(e, email));

  let cancelled = 0;
  let failed = 0;
  const ids = [];
  for (const e of pending) {
    const ok = await cancelEmail(e.id).catch(() => false);
    if (ok) { cancelled++; ids.push(e.id); }
    else { failed++; }
  }

  await notifySlack({ email, source, service, cancelled, failed });

  return res.status(200).json({
    ok: true,
    email,
    matched: pending.length,
    cancelled,
    failed,
    ids,
  });
}
