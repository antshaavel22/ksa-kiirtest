// api/conversion-health.js
//
// A daily canary for the booking → Google Ads conversion pipeline.
//
// Why: in the six months to October 2026 this pipeline broke three times and
// every break was silent. Google retired the v20 API in August. Booking links
// lost their click IDs on 12 September and nobody noticed for eleven days. A
// token mismatch returned 401 from 9 September to 12 October — thirty-three
// days, several hundred rejected conversions, found only because Mai went
// looking at a number. A conversion that never arrives looks exactly like a
// quiet week, so nothing ever prompts anyone to check.
//
// This sends one validate-only conversion to Google Ads every morning. Nothing
// is recorded on the account — validateOnly means Google checks the request and
// throws it away — but the whole chain has to work for it to come back: OAuth
// refresh, developer token, customer id, conversion action, API version. If any
// of those die, Slack says so the next morning instead of six weeks later.
//
// The deliberately fake click id comes back as UNPARSEABLE_GCLID. That is the
// expected answer and means the pipe is open: Google parsed the request, found
// the conversion action and rejected only the made-up id. What matters is that
// a jobId came back at all.
//
// Real-time problems — a 401, a booking with no click id, an upload error —
// alert from booking-completed.js at the moment they happen. This only catches
// the failures that are invisible because nothing is flowing.

import { uploadGoogleAdsBooking } from './booking-completed.js';

const SLACK = process.env.SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
const SHARED_TOKEN = process.env.LP_TRACK_SHARED_TOKEN;

async function say(text) {
  if (!SLACK) { console.error('conversion-health (no webhook):', text); return; }
  try {
    await fetch(SLACK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('conversion-health slack failed:', err.message);
  }
}

export default async function handler(req, res) {
  // Vercel sets x-vercel-cron on scheduled invocations. Anything else needs the
  // shared token, so a stranger cannot use this to post into Slack.
  const isCron = Boolean(req.headers['x-vercel-cron']);
  const authed = SHARED_TOKEN && req.headers['authorization'] === `Bearer ${SHARED_TOKEN}`;
  if (!isCron && !authed) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const probe = {
    service: 'Flow3 silmauuring',
    age: 30,
    refraction: '-3.5',
    gclid: 'canary-not-a-real-gclid',
    conversion_value: 149,
    currency: 'EUR',
    validate_only: true,
  };

  let result = null;
  let failure = null;
  try {
    result = await uploadGoogleAdsBooking(probe);
  } catch (err) {
    failure = err.message || String(err);
  }

  // Healthy means Google answered. A jobId, or a partial failure that is only
  // about our fake click id, both prove the chain is intact.
  const partial = JSON.stringify(result?.partialFailureError || '');
  const onlyFakeId = /UNPARSEABLE_GCLID/.test(partial);
  const healthy = !failure && !!result && !result.skipped && (Boolean(result.jobId) || onlyFakeId);

  if (!healthy) {
    const why = failure
      ? `viga: ${failure}`
      : result?.skipped
        ? `vahele jäetud: ${result.reason}`
        : 'Google ei tagastanud jobId-d';
    await say(
      ':rotating_light: *Konversioonitoru ei vasta.*\n' +
      `Igahommikune kontroll ei jõudnud Google Adsini — ${why}\n` +
      'Kuni see on parandamata, ei jõua ükski broneering Adsi ja kampaaniate tulemused ' +
      'näevad välja kehvemad, kui nad on. Vaata `/api/booking-completed` logisid.'
    );
  }

  return res.status(healthy ? 200 : 503).json({
    ok: healthy,
    checked_at: new Date().toISOString(),
    jobId: result?.jobId || null,
    reason: healthy ? null : (failure || result?.reason || 'no_job_id'),
  });
}
