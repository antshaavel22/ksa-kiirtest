// api/booking-completed.js
//
// Webhook called when a customer completes a Flow3 booking on booking.ksa.ee.
// Cancels all pending email-sequence steps for that customer so they stop
// receiving "have you booked yet?" follow-ups after they've already booked.
//
// USAGE (from booking.ksa.ee, after a paid Flow3 booking is confirmed):
//   POST https://kiirtest.ksa.ee/api/booking-completed
//   Authorization: Bearer <LP_TRACK_SHARED_TOKEN>
//   Content-Type: application/json
//   {
//     "email": "patient@example.com",
//     "phone": "+372...",
//     "name": "Patient",
//     "source": "booking.ksa.ee",
//     "service": "Flow3",
//     "booking_id": "12345",
//     "kiirtest_lead_id": "...",
//     "ab_variant": "B",
//     "promo_code": "FLOW19",
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

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || null;
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

function contactFromBody(body) {
  const contact = body?.contact || {};
  return {
    name: firstValue(body?.name, body?.patient_name, body?.patientName, contact.name),
    phone: firstValue(body?.phone, body?.telephone, body?.patient_phone, body?.patientPhone, contact.phone),
    email: firstValue(body?.email, body?.patient_email, body?.patientEmail, contact.email),
  };
}

async function notifySlack({ contact, source, service, cancelled, failed, googleAds, body }) {
  const bookingId = firstValue(body?.booking_id, body?.bookingId, body?.order_id, body?.orderId);
  const promo = firstValue(body?.promo_code, body?.promoCode, body?.promokood, body?.code, body?.utm?.promokood);
  const leadId = firstValue(body?.kiirtest_lead_id, body?.kiirtestLeadId, body?.lead_id, body?.leadId, body?.utm?.kiirtest_lead_id);
  const variant = firstValue(body?.ab_variant, body?.variant, body?.funnel_variant, body?.utm?.ab_variant);
  const value = firstValue(body?.conversion_value, body?.value);
  const currency = body?.currency || 'EUR';
  const lines = [
    `:white_check_mark: *Flow3 broneering kinnitatud — Kiirtest*`,
    contact?.name ? `*Nimi:* ${contact.name}` : null,
    contact?.phone ? `*Telefon:* ${contact.phone}` : null,
    contact?.email ? `*E-post:* ${contact.email}` : null,
    bookingId ? `*Booking ID:* ${bookingId}` : null,
    source ? `*Allikas:* ${source}` : null,
    service ? `*Teenus:* ${service}` : null,
    variant ? `*Funnel:* ${variant}` : null,
    leadId ? `*Kiirtest lead ID:* ${leadId}` : null,
    promo ? `*Sooduskood:* ${promo}` : null,
    value ? `*Väärtus:* ${value} ${currency}` : null,
    contact?.email ? `*Tühistatud follow-up kirju:* ${cancelled}${failed ? ` (ebaõnnestus: ${failed})` : ''}` : `*Follow-up kirjad:* ei kontrollitud (e-post puudus payloadis)`,
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

async function sendBookingLedger({ contact, source, service, googleAds, body }) {
  if (!RESEND_API_KEY) return;
  const bookingId = firstValue(body?.booking_id, body?.bookingId, body?.order_id, body?.orderId);
  const promo = firstValue(body?.promo_code, body?.promoCode, body?.promokood, body?.code, body?.utm?.promokood);
  const leadId = firstValue(body?.kiirtest_lead_id, body?.kiirtestLeadId, body?.lead_id, body?.leadId, body?.utm?.kiirtest_lead_id);
  const variant = firstValue(body?.ab_variant, body?.variant, body?.funnel_variant, body?.utm?.ab_variant);
  const html = `<p><strong>KSA Kiirtest booking ledger</strong></p>
<table cellpadding="0" cellspacing="0" style="font-size:13px;font-family:Arial,sans-serif;border-collapse:collapse;">
<tr><td style="color:#888;padding:4px 10px 4px 0;">Event</td><td style="padding:4px 0;"><strong>booking_completed</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Nimi</td><td style="padding:4px 0;"><strong>${contact?.name || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Telefon</td><td style="padding:4px 0;"><strong>${contact?.phone || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">E-post</td><td style="padding:4px 0;"><strong>${contact?.email || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Allikas</td><td style="padding:4px 0;"><strong>${source || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Teenus</td><td style="padding:4px 0;"><strong>${service || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Booking ID</td><td style="padding:4px 0;"><strong>${bookingId || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Funnel</td><td style="padding:4px 0;"><strong>${variant || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Kiirtest lead ID</td><td style="padding:4px 0;"><strong>${leadId || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Sooduskood</td><td style="padding:4px 0;"><strong>${promo || '—'}</strong></td></tr>
<tr><td style="color:#888;padding:4px 10px 4px 0;">Google Ads</td><td style="padding:4px 0;"><strong>${googleAds?.skipped ? `skipped: ${googleAds.reason}` : 'uploaded / attempted'}</strong></td></tr>
</table>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Lilia – KSA Silmakeskus <noreply@ksa.ee>',
        to: ['registreerumised@ksa.ee'],
        reply_to: 'info@ksa.ee',
        subject: `✅ Kiirtest booking completed [${source || 'booking.ksa.ee'}]${variant ? ` [${variant}]` : ''}`,
        html,
      }),
    });
  } catch (err) {
    console.error('Booking ledger email error:', err);
  }
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
  const contact = contactFromBody(body);
  const email = (contact.email || '').trim().toLowerCase();
  contact.email = email || null;
  const source = body?.source || body?.utm?.source || null;
  const service = body?.service || body?.service_name || body?.serviceName || null;
  const bookingId = firstValue(body?.booking_id, body?.bookingId, body?.order_id, body?.orderId);
  if (!contact.email && !contact.phone && !bookingId) {
    return res.status(400).json({ ok: false, error: 'email, phone, or booking id required' });
  }

  let pending = [];
  if (contact.email && contact.email.includes('@') && RESEND_API_KEY) {
    let emails;
    try {
      emails = await fetchRecentEmails(3);
    } catch (err) {
      console.error('Resend list error:', err);
      return res.status(502).json({ ok: false, error: 'Resend list failed' });
    }
    pending = emails.filter(e => isPendingForRecipient(e, contact.email));
  }

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

  await notifySlack({ contact, source, service, cancelled, failed, googleAds, body });
  await sendBookingLedger({ contact, source, service, googleAds, body });

  return res.status(200).json({
    ok: true,
    email: contact.email,
    phone: contact.phone || null,
    booking_id: bookingId || null,
    matched: pending.length,
    cancelled,
    failed,
    ids,
    google_ads: googleAds,
  });
}
