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
//   {
//     "email": "patient@example.com",
//     "source": "my.ksa.ee",
//     "service": "Flow3",
//     "booking_id": "12345",
//     "conversion_value": 69,
//     "currency": "EUR",
//     "gclid": "...",
//     "gbraid": "...",
//     "wbraid": "..."
//   }
//
// Approach: stateless. We use Resend's list-emails API to find any scheduled
// (unsent) emails to this recipient, then call Resend's cancel endpoint on each.
// No external KV/DB needed — works as long as the pending emails are within
// the latest ~200 records on the Resend account.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SHARED_TOKEN = process.env.LP_TRACK_SHARED_TOKEN;
const SLACK_KIIRTEST_WEBHOOK = process.env.SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL;
const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const GOOGLE_ADS_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const GOOGLE_ADS_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const GOOGLE_ADS_REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const GOOGLE_ADS_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '5380588148').replace(/\D/g, '');
const GOOGLE_ADS_LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');
const GOOGLE_ADS_BOOKING_CONVERSION_ACTION =
  process.env.GOOGLE_ADS_BOOKING_CONVERSION_ACTION ||
  'customers/5380588148/conversionActions/7579562619';
const FLOW3_SERVICE_PATTERN = /flow\s*3|flow3|laser|laserkorrektsioon|laserkirurgia|silmauuring|eye\s*exam|examination/i;

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

function getTracking(body) {
  const utm = body?.utm || {};
  return {
    gclid: body?.gclid || utm.gclid || null,
    gbraid: body?.gbraid || utm.gbraid || null,
    wbraid: body?.wbraid || utm.wbraid || null,
  };
}

function hasGoogleAdsConfig() {
  return Boolean(
    GOOGLE_ADS_DEVELOPER_TOKEN &&
    GOOGLE_ADS_CLIENT_ID &&
    GOOGLE_ADS_CLIENT_SECRET &&
    GOOGLE_ADS_REFRESH_TOKEN &&
    GOOGLE_ADS_CUSTOMER_ID &&
    GOOGLE_ADS_BOOKING_CONVERSION_ACTION
  );
}

function isCoreFlow3Booking(body) {
  const service = [
    body?.service,
    body?.service_name,
    body?.serviceName,
    body?.funnel,
    body?.booking_type,
    body?.bookingType,
  ].filter(Boolean).join(' ');

  const route = [
    body?.recommended_next_step,
    body?.next_step,
    body?.route,
    body?.result,
    body?.qualification,
    body?.utm?.funnel,
  ].filter(Boolean).join(' ');

  const age = Number(body?.age ?? body?.patient_age ?? body?.patientAge);
  const ageOk = !Number.isFinite(age) || (age >= 18 && age <= 45);

  const refraction = [
    body?.refraction,
    body?.minus_refraction,
    body?.myopia,
    body?.prescription,
    body?.diopters,
  ].filter(Boolean).join(' ');
  const refractionOk = !refraction || /minus|myop|lühinägel|luhinagel|-\d|−\d/i.test(refraction);

  const looksFlow3 = FLOW3_SERVICE_PATTERN.test(service) || /flow\s*3|flow3|good_candidate|eligible/i.test(route);
  const explicitlyNotFlow3 = /audit|dry|kuiv|kids|laste|child|icb|callback|other/i.test(service);

  return looksFlow3 && !explicitlyNotFlow3 && ageOk && refractionOk;
}

function tallinnGoogleAdsTime(value) {
  const date = value ? new Date(value) : new Date();
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Tallinn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const formatted = dtf.format(date).replace('T', ' ');
  const localAsUtc = new Date(`${formatted.replace(' ', 'T')}Z`);
  const offsetMin = Math.round((localAsUtc.getTime() - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${formatted}${sign}${hh}:${mm}`;
}

async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`Google OAuth failed: ${r.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function uploadGoogleAdsBooking(body, options = {}) {
  if (!hasGoogleAdsConfig()) {
    return { skipped: true, reason: 'missing_google_ads_env' };
  }

  if (!isCoreFlow3Booking(body)) {
    return { skipped: true, reason: 'not_core_flow3_booking' };
  }

  const tracking = getTracking(body);
  if (!tracking.gclid && !tracking.gbraid && !tracking.wbraid) {
    return { skipped: true, reason: 'missing_click_id' };
  }

  const accessToken = await googleAccessToken();
  const conversion = {
    conversionAction: GOOGLE_ADS_BOOKING_CONVERSION_ACTION,
    conversionDateTime: tallinnGoogleAdsTime(body?.conversion_date_time || body?.booking_time || body?.created_at),
    conversionValue: Number(body?.conversion_value ?? body?.value ?? 69),
    currencyCode: body?.currency || 'EUR',
    conversionEnvironment: 'WEB',
  };

  if (tracking.gclid) conversion.gclid = tracking.gclid;
  else if (tracking.wbraid) conversion.wbraid = tracking.wbraid;
  else if (tracking.gbraid) conversion.gbraid = tracking.gbraid;

  const orderId = body?.booking_id || body?.bookingId || body?.order_id || body?.orderId || null;
  if (orderId) conversion.orderId = String(orderId);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (GOOGLE_ADS_LOGIN_CUSTOMER_ID && !options.direct) {
    headers['login-customer-id'] = GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  const r = await fetch(`https://googleads.googleapis.com/v20/customers/${GOOGLE_ADS_CUSTOMER_ID}:uploadClickConversions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversions: [conversion],
      partialFailure: true,
      validateOnly: Boolean(body?.validate_only || body?.validateOnly),
      debugEnabled: true,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = JSON.stringify(data);
    if (!options.direct && /USER_PERMISSION_DENIED|login-customer-id|PERMISSION_DENIED/i.test(message)) {
      return uploadGoogleAdsBooking(body, { direct: true });
    }
    throw new Error(`Google Ads upload failed: ${r.status} ${message}`);
  }
  return {
    skipped: false,
    conversionAction: GOOGLE_ADS_BOOKING_CONVERSION_ACTION,
    clickIdType: conversion.gclid ? 'gclid' : (conversion.wbraid ? 'wbraid' : 'gbraid'),
    resultCount: Array.isArray(data.results) ? data.results.length : 0,
    partialFailureError: data.partialFailureError || null,
    jobId: data.jobId || null,
  };
}

async function notifySlack({ email, source, service, cancelled, failed, googleAds }) {
  const lines = [
    `:no_entry: *Broneering tehtud — e-postide jada peatatud*`,
    `*E-post:* ${email}`,
    source ? `*Allikas:* ${source}` : null,
    service ? `*Teenus:* ${service}` : null,
    `*Tühistatud kirjasid:* ${cancelled}${failed ? ` (ebaõn: ${failed})` : ''}`,
    googleAds?.skipped ? `*Google Ads:* vahele jäetud (${googleAds.reason})` : null,
    googleAds && !googleAds.skipped ? `*Google Ads:* booking conversion uploaded (${googleAds.clickIdType})${googleAds.partialFailureError ? ' — check partial failure' : ''}` : null,
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

  let googleAds = null;
  try {
    googleAds = await uploadGoogleAdsBooking(body);
  } catch (err) {
    console.error('Google Ads booking upload error:', err);
    googleAds = { skipped: true, reason: 'upload_error', error: err.message };
  }

  await notifySlack({ email, source, service, cancelled, failed, googleAds });

  return res.status(200).json({
    ok: true,
    email,
    matched: pending.length,
    cancelled,
    failed,
    ids,
    google_ads: googleAds,
  });
}
