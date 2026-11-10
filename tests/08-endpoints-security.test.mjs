// Auth, abuse and robustness of the public endpoints. Everything offline (mocked fetch,
// dummy env). Desired behaviour is asserted; today's gaps are marked as known bugs.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { apiSource } from './helpers/load-api.mjs';
import { installFakeSupabase } from './helpers/mock-fetch.mjs';
import { bug, makeWorld, invoke, payload, PERSON, EVENT_PAYLOADS, HOSTS, sleep, mockReq, mockRes } from './helpers/harness.mjs';

// ── /api/track abuse ─────────────────────────────────────────────────────────────────
describe('/api/track: abuse resistance', () => {
  bug('F-ABUSE-MAILBOMB', '25 requests for the same victim address send at most 1-2 result mails (no rate limit, no per-address/session dedupe: anyone can use noreply@ksa.ee to mail anybody)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (let i = 0; i < 25; i++) await w.post(payload('email_captured', { email: 'victim@gmail.com' }));
    assert.ok(w.net.resendCustomer().length <= 2, `${w.net.resendCustomer().length} mails to victim@gmail.com`);
  });

  bug('F-ABUSE-FLOOD', 'a burst of 50 anonymous leads from one client is throttled (429) before it floods Slack, the CRM and registreerumised@ksa.ee', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const codes = [];
    for (let i = 0; i < 50; i++) codes.push((await w.post(payload('email_captured', { email: `bot${i}@gmail.com` }), { headers: { 'x-forwarded-for': '203.0.113.7' } })).statusCode);
    assert.ok(codes.includes(429), `no 429 among ${codes.length} requests`);
  });

  bug('F-ABUSE-DEDUPE', 'the same client_session_id submitted twice creates one CRM ticket / one Slack card (idempotent lead id)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: PERSON.email }));
    await w.post(payload('email_captured', { email: PERSON.email }));
    assert.equal(w.net.crm().length, 1);
  });

  bug('F-ABUSE-SIZE', 'oversized free text is truncated/rejected before being forwarded to the CRM (300 kB answers.bother is POSTed verbatim in quiz_meta.quiz_answers)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: PERSON.email, answers: { age: '26-35', vision: 'Miinusprillid', bother: 'x'.repeat(300000) } }));
    const sent = w.net.crm()[0]?.bodyText.length ?? 0;
    assert.ok(sent < 50000, `CRM body ${sent} bytes`);
  });

  test('no honeypot / captcha / Turnstile field is evaluated anywhere in track.js (documented absence)', () => {
    assert.ok(!/turnstile|recaptcha|hcaptcha|honeypot/i.test(apiSource('track')));
  });

  test('CORS: only the known LP origins and *.vercel.app get Allow-Origin; others still get processed (CORS is not auth)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const bad = await w.post(payload('phone_lead', { phone: PERSON.phone }), { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    assert.equal(bad.statusCode, 200);               // processed anyway
    const ok = await w.post(payload('phone_lead', { phone: PERSON.phone }), { headers: { origin: 'https://glasses.ksa.ee' } });
    assert.equal(ok.headers['access-control-allow-origin'], 'https://glasses.ksa.ee');
    const pre = await invoke(w.handler, undefined, { method: 'OPTIONS' });
    assert.equal(pre.statusCode, 204);
    assert.equal((await invoke(w.handler, undefined, { method: 'GET' })).statusCode, 405);
  });

  test('LP events need the shared token AND an allowed origin; wrong token / origin -> 403', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const body = EVENT_PAYLOADS.lp_contact_submitted();
    assert.equal((await w.post(body, { headers: { origin: 'https://glasses.ksa.ee', 'x-track-source': 'wrong' } })).statusCode, 403);
    assert.equal((await w.post(body, { headers: { origin: 'https://evil.example', 'x-track-source': 'dummy-lp-token' } })).statusCode, 403);
    assert.equal((await w.post(body, { headers: { origin: 'https://glasses.ksa.ee' } })).statusCode, 403);
    assert.equal(w.net.calls.length, 0);
  });

  test('LP events fail closed when LP_TRACK_SHARED_TOKEN is not configured', async (t) => {
    const w = await makeWorld('track', { LP_TRACK_SHARED_TOKEN: undefined });
    t.after(() => w.done());
    const res = await w.post(EVENT_PAYLOADS.lp_contact_submitted(), { headers: { origin: 'https://glasses.ksa.ee', 'x-track-source': 'undefined' } });
    assert.equal(res.statusCode, 403);
  });

  bug('F-LP-FOOTER', 'lp_contact_submitted: the Slack footer says "Lead data email: registreerumised@ksa.ee" - an internal mail really is sent (today none is)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(EVENT_PAYLOADS.lp_contact_submitted(), { headers: { origin: 'https://glasses.ksa.ee', 'x-track-source': 'dummy-lp-token' } });
    assert.match(JSON.stringify(w.net.slackLeads()[0].json), /registreerumised@ksa\.ee/);
    assert.equal(w.net.resendInternal().length, 1);
  });

  bug('F-LP-NOSLACK', 'lp_contact_submitted with no SLACK_LP webhook configured is not a silent 200 (Brevo is then the only copy)', async (t) => {
    const w = await makeWorld('track', { SLACK_LP_CHANNEL_WEBHOOK_URL: undefined });
    t.after(() => w.done());
    const res = await w.post(EVENT_PAYLOADS.lp_contact_submitted(), { headers: { origin: 'https://glasses.ksa.ee', 'x-track-source': 'dummy-lp-token' } });
    assert.ok(res.statusCode >= 500 || w.net.slackAlerts().length > 0 || w.net.resendInternal().length > 0);
  });
});

// ── /api/track robustness ────────────────────────────────────────────────────────────
describe('/api/track: malformed input never crashes the function', () => {
  test('invalid JSON string -> 400; JSON string body (sendBeacon) is parsed', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    assert.equal((await w.post('{not json')).statusCode, 400);
    const ok = await w.post(JSON.stringify(payload('phone_lead', { phone: PERSON.phone })));
    assert.equal(ok.statusCode, 200);
    assert.equal(w.net.slackLeads().length, 2);
  });

  bug('F-ROBUST-BODY', 'bodies undefined / "null" / "" / [] / 5 are answered with 4xx or 200, never an unhandled exception (=500)', async (t) => {
    const crashed = [];
    for (const [label, body] of [['undefined', undefined], ['"null"', 'null'], ['""', ''], ['[]', []], ['5', 5]]) {
      const w = await makeWorld('track');
      try { const res = await w.post(body); if (res.statusCode >= 500) crashed.push(label); } catch (e) { crashed.push(`${label}: ${e.message}`); } finally { w.done(); }
    }
    assert.deepEqual(crashed, []);
  });

  bug('F-ROBUST-TYPES', 'fields of the wrong JSON type (language:5, lp_source:42, utm_source:7, utm.source:[..]) do not throw TypeError before any sink is reached (lead lost)', async (t) => {
    const crashed = [];
    for (const [label, extra] of [
      ['language: 5', { language: 5 }], ['lp_source: 42', { lp_source: 42 }], ['utm: {utm_source: 7}', { utm: { utm_source: 7 } }],
      ['utm: {source: ["a"]}', { utm: { source: ['a'] } }], ['answers: "text"', { answers: 'text' }], ['contact: "x"', { contact: 'x' }],
    ]) {
      const w = await makeWorld('track');
      try { const res = await w.post(payload('email_captured', { email: PERSON.email, ...extra })); if (res.statusCode >= 500) crashed.push(label); }
      catch (e) { crashed.push(`${label}: ${e.message}`); } finally { w.done(); }
    }
    assert.deepEqual(crashed, []);
  });
});

// ── /api/booking-completed ───────────────────────────────────────────────────────────
describe('/api/booking-completed', () => {
  const GOOD = { email: PERSON.email, phone: PERSON.phone, name: PERSON.name, source: 'booking.ksa.ee', service: 'Flow3 silmauuring', booking_id: 'B-100', gclid: 'G1', conversion_value: 39 };
  const auth = (w) => ({ headers: { authorization: `Bearer ${w.env.KIIRTEST_WEBHOOK_TOKEN}` } });
  const gEnv = { GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r' };

  test('401 without token, with the public LP token, with a wrong token', async (t) => {
    const w = await makeWorld('booking-completed');
    t.after(() => w.done());
    for (const a of [undefined, 'Bearer dummy-lp-token', 'Bearer nope', 'dummy-crm-webhook-token']) {
      const res = await w.post(GOOD, { headers: a ? { authorization: a } : {} });
      assert.equal(res.statusCode, 401, String(a));
    }
    assert.equal(w.net.resend().length, 0);
    assert.equal(w.net.crm().length, 0);
  });

  test('fails closed when KIIRTEST_WEBHOOK_TOKEN is unset ("Bearer undefined" is rejected)', async (t) => {
    const w = await makeWorld('booking-completed', { KIIRTEST_WEBHOOK_TOKEN: undefined });
    t.after(() => w.done());
    assert.equal((await w.post(GOOD, { headers: { authorization: 'Bearer undefined' } })).statusCode, 401);
  });

  bug('F-AUTH-BC-ALERT', 'an UNAUTHENTICATED request must not raise the red "Konversioonid põrkavad tagasi" Slack alert (any scanner/stranger can trigger it; without Supabase configured it is not even rate-limited)', async (t) => {
    const w = await makeWorld('booking-completed');
    t.after(() => w.done());
    for (let i = 0; i < 3; i++) await w.post(GOOD, { headers: {} });
    assert.equal(w.net.slackAll().length, 0, `${w.net.slackAll().length} Slack alerts from 3 anonymous requests`);
  });

  test('a caller that presents a WRONG token still raises the alert (rotated key = the 33-day outage), but only once per hour', async (t) => {
    // Production has Supabase configured; that is what makes the alert once-per-hour.
    const w = await makeWorld('booking-completed', { SUPABASE_URL: HOSTS.supabase, SUPABASE_SERVICE_KEY: 'sb' });
    t.after(() => w.done());
    installFakeSupabase(w.net);
    for (let i = 0; i < 3; i++) {
      const r = await w.post(GOOD, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(r.statusCode, 401);
    }
    assert.equal(w.net.slackAll().length, 1, 'one alert, rate-limited');
  });

  bug('F-AUTH-BC-TIMING', 'bearer tokens are compared with crypto.timingSafeEqual (not === / !==) in booking-completed, conversion-health and track (LP token)', () => {
    for (const f of ['booking-completed', 'conversion-health', 'track']) assert.match(apiSource(f), /timingSafeEqual/, f);
  });

  test('token is never written to the console on any path', async (t) => {
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
    const w = await makeWorld('booking-completed', gEnv);
    t.after(() => { Object.assign(console, orig); w.done(); });
    await w.post(GOOD, { headers: { authorization: 'Bearer leaked-wrong-token' } });
    await w.post(GOOD, auth(w));
    const all = logs.join('\n');
    assert.ok(!all.includes('leaked-wrong-token') && !all.includes('dummy-crm-webhook-token') && !all.includes('re_dummy'));
  });

  test('authorised booking: cancels pending follow-ups, uploads the conversion with orderId, posts a Slack card and a ledger mail', async (t) => {
    const w = await makeWorld('booking-completed', gEnv);
    t.after(() => w.done());
    w.net.on((c) => c.kind === 'resend-list', () => w.net.json(200, { data: [{ id: 'sched1', to: [PERSON.email], last_event: 'scheduled', scheduled_at: new Date(Date.now() + 3600e3).toISOString() }] }));
    const res = await w.post(GOOD, auth(w));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cancelled, 1);
    const up = w.net.calls.find((c) => c.url.includes('uploadClickConversions'));
    assert.equal(up.json.conversions[0].orderId, 'B-100');
    assert.equal(up.json.conversions[0].gclid, 'G1');
    assert.equal(w.net.slackAll().length, 1);
    assert.equal(w.net.resend().filter((c) => c.json?.subject).length, 1, 'one ledger mail (the cancel call has no subject)');
  });

  test('replaying the same booking_id does not post a second Slack card (Supabase dedupe)', async (t) => {
    const w = await makeWorld('booking-completed', { ...gEnv, SUPABASE_URL: HOSTS.supabase, SUPABASE_SERVICE_KEY: 'sb' });
    t.after(() => w.done());
    installFakeSupabase(w.net);
    await w.post(GOOD, auth(w));
    await w.post(GOOD, auth(w));
    assert.equal(w.net.slackAll().filter((c) => c.json?.text?.includes('Flow3 broneering')).length, 1);
  });

  bug('F-BC-IDEMPOTENT', 'replaying the same booking_id does not send a second ledger mail (it inflates "Kinnitatud broneeringud" and the progress counter in the daily report)', async (t) => {
    const w = await makeWorld('booking-completed', { ...gEnv, SUPABASE_URL: HOSTS.supabase, SUPABASE_SERVICE_KEY: 'sb' });
    t.after(() => w.done());
    installFakeSupabase(w.net);
    await w.post(GOOD, auth(w));
    await w.post(GOOD, auth(w));
    assert.equal(w.net.resend().length, 1, `${w.net.resend().length} ledger mails for one booking`);
  });

  bug('F-BC-ESC', 'ledger mail HTML-escapes name / source / promo (values come from the CRM webhook)', async (t) => {
    const w = await makeWorld('booking-completed');
    t.after(() => w.done());
    await w.post({ ...GOOD, name: '<img src=x onerror=alert(1)>' }, auth(w));
    assert.ok(!w.net.resend()[0].json.html.includes('<img src=x'));
  });

  test('missing click id raises exactly the "noclickid" alert; missing Google env raises "noenv"', async (t) => {
    const w = await makeWorld('booking-completed', gEnv);
    t.after(() => w.done());
    await w.post({ ...GOOD, gclid: undefined }, auth(w));
    assert.ok(w.net.slackAll().some((c) => /klikk-ID/.test(c.json?.text || '')));
    const w2 = await makeWorld('booking-completed');
    await w2.post(GOOD, auth(w2));
    assert.ok(w2.net.slackAll().some((c) => /seadistus puudub/.test(c.json?.text || '')));
    w2.done();
  });

  bug('F-BC-SIGNATURE', 'a "Flow Signature Line" booking is uploaded to Google Ads like other Flow bookings (FLOW3_SERVICE_PATTERN needs "flow3|laser|silmauuring..." so the service name "Flow Signature Line" is skipped as not_core_flow3_booking)', async (t) => {
    const w = await makeWorld('booking-completed', gEnv);
    t.after(() => w.done());
    const res = await w.post({ ...GOOD, service: 'Flow Signature Line' }, auth(w));
    assert.notEqual(res.body.google_ads?.reason, 'not_core_flow3_booking');
  });
});

// ── /api/conversion-health ───────────────────────────────────────────────────────────
describe('/api/conversion-health', () => {
  test('401 without Bearer token or cron header', async (t) => {
    const w = await makeWorld('conversion-health');
    t.after(() => w.done());
    assert.equal((await w.post(undefined, { method: 'GET' })).statusCode, 401);
    assert.equal((await w.post(undefined, { method: 'GET', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  });
  test('the shared LP token (which is in public LP page source) opens it - documented', async (t) => {
    const w = await makeWorld('conversion-health');
    t.after(() => w.done());
    const res = await w.post(undefined, { method: 'GET', headers: { authorization: 'Bearer dummy-lp-token' } });
    assert.notEqual(res.statusCode, 401);
  });
  bug('F-AUTH-CH-CRON', 'any value in the x-vercel-cron request header is NOT enough; verify Authorization: Bearer CRON_SECRET (the header is not a secret)', async (t) => {
    const w = await makeWorld('conversion-health', { CRON_SECRET: 'dummy-cron' });
    t.after(() => w.done());
    const res = await w.post(undefined, { method: 'GET', headers: { 'x-vercel-cron': '1' } });
    assert.equal(res.statusCode, 401);
  });
});

// ── /api/intake-flow3 ────────────────────────────────────────────────────────────────
describe('/api/intake-flow3', () => {
  const BODY = { source: 'kiirtest', lang: 'et', contact: { name: 'Mari', phone: '+372 5551 2345', email: PERSON.email }, qualifying: { age_band: '18_45', vision_issue: 'myopia' }, group_hint: 'flow3_eligible_myope', utm: { source: 'google' } };
  const withTrack = (w) => w.net.on((c) => c.url.startsWith('https://kiirtest.test/api/track'), () => w.net.json(200, { ok: true }));

  test('valid callback: CRM ticket created with normalised phone, then Slack ping via /api/track', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    withTrack(w);
    const res = await w.post(BODY, { headers: { host: 'kiirtest.test', 'x-forwarded-proto': 'https' } });
    assert.equal(res.statusCode, 201);
    assert.equal(w.net.crm()[0].json.contact.phone, '+37255512345');
    assert.ok(w.net.calls.some((c) => c.url === 'https://kiirtest.test/api/track'));
  });

  test('validation: bad enums / phone -> 400 and nothing is forwarded', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    for (const mut of [{ lang: 'de' }, { source: 'x' }, { contact: { phone: 'abc' } }, { group_hint: 'x' }]) {
      assert.equal((await w.post({ ...BODY, ...mut })).statusCode, 400);
    }
    assert.equal(w.net.calls.length, 0);
  });

  test('CRM down: caller gets the upstream error but the Slack ping is still sent (lead preserved in Slack)', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    withTrack(w);
    w.net.on((c) => c.kind === 'crm', () => w.net.json(500, 'down'));
    const res = await w.post(BODY, { headers: { host: 'kiirtest.test' } });
    assert.equal(res.statusCode, 500);
    assert.ok(w.net.calls.some((c) => c.url.endsWith('/api/track')));
  });

  bug('F-INTAKE-NOKEY', 'missing KSA_TICKETS_API_KEY still pings Slack (today it returns 500 BEFORE the Slack ping, and 19.html shows the visitor "we will call you")', async (t) => {
    const w = await makeWorld('intake-flow3', { KSA_TICKETS_API_KEY: undefined });
    t.after(() => w.done());
    withTrack(w);
    await w.post(BODY, { headers: { host: 'kiirtest.test' } });
    assert.ok(w.net.calls.some((c) => c.url.endsWith('/api/track')), 'lead lost: no CRM, no Slack');
  });

  bug('F-INTAKE-TESTMARK', 'test markers (TEST name, diagnostics-test@ksa.ee, @example.com) are suppressed BEFORE a CRM ticket is created (isTestPayload exists only in track.js; intake-flow3 creates the ticket first and drops the e-mail when pinging track)', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    withTrack(w);
    await w.post({ ...BODY, contact: { name: 'TEST Mari', phone: '+37255512345', email: 'diagnostics-test@ksa.ee' } }, { headers: { host: 'kiirtest.test' } });
    assert.equal(w.net.crm().length, 0, 'test lead created a real CRM ticket');
  });

  bug('F-INTAKE-HOST', 'the self-call to /api/track is built from a fixed/own origin, not from the request Host / X-Forwarded-Host header (a forged header would send name+phone to another host)', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    w.net.on((c) => c.host === 'kiirtest.test', () => w.net.json(200, {}));
    await w.post(BODY, { headers: { host: 'kiirtest.test', 'x-forwarded-host': 'kiirtest.test' } });
    const track = w.net.calls.find((c) => c.url.endsWith('/api/track'));
    assert.ok(track);
    assert.ok(!apiSource('intake-flow3').includes("req.headers['x-forwarded-host']"));
  });

  bug('F-INTAKE-AUTH', 'the endpoint is rate-limited / bot-protected (anonymous POST creates real CRM tickets and Slack pings)', async (t) => {
    const w = await makeWorld('intake-flow3');
    t.after(() => w.done());
    withTrack(w);
    const codes = [];
    for (let i = 0; i < 30; i++) codes.push((await w.post(BODY, { headers: { host: 'kiirtest.test' } })).statusCode);
    assert.ok(codes.includes(429));
  });
});

// ── /api/draw-entry ──────────────────────────────────────────────────────────────────
describe('/api/draw-entry', () => {
  const ENV = { SUPABASE_URL: HOSTS.supabase, SUPABASE_SERVICE_KEY: 'sb_dummy' };

  test('invalid e-mail -> 200 skipped, no database write', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    const res = await w.post({ email: 'nope' });
    assert.equal(res.body.skipped, 'no_valid_email');
    assert.equal(w.net.calls.length, 0);
  });

  test('new e-mail inserts one entry with extra_entries=1; second call for the same row is idempotent', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    await w.post({ email: PERSON.email, month: '2026-11', marketing_consent: false });
    const ins = w.net.calls.find((c) => c.method === 'POST');
    assert.equal(ins.json.extra_entries, 1);
    assert.equal(ins.json.marketing_consent, false);
    assert.equal(ins.json.entry_month, '2026-11-01');
  });

  bug('F-DRAW-GDPR', 'a caller that sends no consent flags does NOT create a row with gdpr_consent:true and marketing_consent:true for an arbitrary third-party e-mail', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    await w.post({ email: 'someone.else@gmail.com' });
    const ins = w.net.calls.find((c) => c.method === 'POST');
    assert.ok(ins, 'no insert');
    assert.notEqual(ins.json.gdpr_consent, true, 'gdpr_consent hard-coded true');
    assert.notEqual(ins.json.marketing_consent, true, 'marketing consent defaulted to true');
  });

  bug('F-DRAW-MONTH-SRV', 'the server decides the draw month (client "month" is ignored / limited to the current month): a caller can put entries into any past or future draw', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    await w.post({ email: PERSON.email, month: '1999-01' });
    assert.notEqual(w.net.calls.find((c) => c.method === 'POST').json.entry_month, '1999-01-01');
  });

  bug('F-DRAW-TESTMARK', 'test markers (example.com, smoke-test, "TEST " names) do not create draw entries', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    await w.post({ email: 'smoke-test@example.com', first_name: 'TEST Mari' });
    assert.equal(w.net.calls.filter((c) => c.method === 'POST').length, 0);
  });

  bug('F-ROBUST-DRAW', 'body "null" does not crash the function', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    let res; try { res = await w.post('null'); } catch (e) { assert.fail(e.message); }
    assert.ok(res.statusCode < 500);
  });

  test('Supabase failure is soft (200) - the visitor still sees the result', async (t) => {
    const w = await makeWorld('draw-entry', ENV);
    t.after(() => w.done());
    w.net.on((c) => c.kind === 'supabase', () => w.net.json(500, 'x'));
    assert.equal((await w.post({ email: PERSON.email })).statusCode, 200);
  });
});
