// Report contract: every e-mail subject api/track.js (and booking-completed.js) can emit is
// fed - as a Resend "list emails" record - to the REAL api/analytics-report.js, and we
// assert in which counter it lands. This is the test that would have caught the
// 2026-09-15 "0 qualified leads" incident (subject format drifted, counter went blind).
//
// The process runs with TZ=UTC like Vercel, and Date is mocked so "yesterday" is fixed.
process.env.TZ = 'UTC';
import test, { describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlackPayload } from './helpers/slack-validate.mjs';
import { bug, makeWorld, EVENT_PAYLOADS, payload, PERSON, ANSWERS_AUDIT, ANSWERS_KIDS, HOSTS } from './helpers/harness.mjs';

const DAY = '2026-11-09';                       // the day being reported
const CRON_NOW = Date.parse('2026-11-10T05:00:00Z');   // 07:00 Tallinn (winter), Tuesday
const MON_NOW = Date.parse('2026-11-09T05:30:00Z');    // weekly cron, Monday
const withDate = (ms, fn) => async (t) => { mock.timers.enable({ apis: ['Date'], now: ms }); try { return await fn(t); } finally { mock.timers.reset(); } };

const COUNTERS = ['total', 'good', 'consult', 'contact', 'install', 'qualifiedQuiz', 'phoneLead', 'bookingClick', 'bookingCompleted', 'callback'];
const DISPLAYED = ['qualifiedQuiz', 'phoneLead', 'bookingClick', 'bookingCompleted', 'callback', 'install'];
const zero = () => Object.fromEntries(COUNTERS.map((c) => [c, 0]));
const pick = (stats) => Object.fromEntries(COUNTERS.map((c) => [c, stats[c]]));

/** Run one event through track.js and return the Resend records the account would list. */
async function emit(buildBody, { headers, at = `${DAY} 10:00:00.000000+00`, api = 'track' } = {}) {
  const w = await makeWorld(api);
  try {
    const res = await w.post(buildBody(), headers ? { headers } : {});
    assert.equal(res.statusCode, 200);
    return w.net.resend().map((c, i) => ({ id: `em_${Math.random().toString(36).slice(2)}`, to: c.json.to, subject: c.json.subject, created_at: at, last_event: c.json.scheduled_at ? 'scheduled' : 'delivered' }));
  } finally { w.done(); }
}

async function emitBooking(at = `${DAY} 11:00:00.000000+00`) {
  const w = await makeWorld('booking-completed');
  try {
    const res = await w.post({ email: PERSON.email, phone: PERSON.phone, name: PERSON.name, source: 'booking.ksa.ee', service: 'Flow3 silmauuring', booking_id: 'B-1', kiirtest_lead_id: 'kt_abc123', gclid: 'G1' },
      { headers: { authorization: `Bearer ${w.env.KIIRTEST_WEBHOOK_TOKEN}` } });
    assert.equal(res.statusCode, 200);
    return w.net.resend().map((c) => ({ id: `em_${Math.random().toString(36).slice(2)}`, to: c.json.to, subject: c.json.subject, created_at: at }));
  } finally { w.done(); }
}

/** Fake Resend list endpoint: newest first, honours limit/after, reports has_more. */
function resendListRule(w, items) {
  w.net.on((c) => c.kind === 'resend-list', (call) => {
    const u = new URL(call.url);
    const limit = Math.min(Number(u.searchParams.get('limit') || 20), 100);
    const after = u.searchParams.get('after');
    let start = 0;
    if (after) start = items.findIndex((e) => e.id === after) + 1;
    const page = items.slice(start, start + limit);
    return w.net.json(200, { object: 'list', data: page, has_more: start + limit < items.length });
  });
}

async function runReport(items, { weekly = false, env = {}, headers = {} } = {}) {
  const w = await makeWorld('analytics-report', env);
  resendListRule(w, items);
  const res = await w.post(undefined, { method: 'GET', url: weekly ? '/api/analytics-report?type=weekly' : '/api/analytics-report', headers });
  const slack = w.net.slackAll()[0]?.json;
  const out = { res, slack, net: w.net, stats: res.body?.stats };
  w.done();
  return out;
}

const tiles = (slack) => {
  const f = slack.blocks.find((b) => b.fields)?.fields || [];
  return Object.fromEntries(f.map((x) => { const [k, v] = x.text.split(':*\n'); return [k.replace('*', ''), v]; }));
};

// ── A. subject -> counter contract ───────────────────────────────────────────────────
const CONTRACT = [
  ['email_captured, Flow3 candidate', () => EVENT_PAYLOADS.email_captured(), { total: 1, good: 1, qualifiedQuiz: 1 }],
  ['email_captured, Audit route', () => payload('email_captured', { email: PERSON.email, result: 'audit', route: 'audit', promoCode: 'BLOG139', answers: ANSWERS_AUDIT }), { total: 1, consult: 1 }],
  ['email_captured, kids route', () => payload('email_captured', { email: PERSON.email, result: 'kids', route: 'kids', promoCode: 'BLOGKIDS', answers: ANSWERS_KIDS }), { total: 1, consult: 1 }],
  ['qualified_flow3_phone_lead', () => EVENT_PAYLOADS.qualified_flow3_phone_lead(), { total: 1, good: 1, contact: 1, phoneLead: 1 }],
  ['callback_requested', () => EVENT_PAYLOADS.callback_requested(), { total: 1, contact: 1, callback: 1 }],
  ['book_now_clicked', () => EVENT_PAYLOADS.book_now_clicked(), { total: 1, bookingClick: 1 }],
  ['bridge_19_book_clicked', () => EVENT_PAYLOADS.bridge_19_book_clicked(), { total: 1, bookingClick: 1 }],
  ['eligible_gate_bridge_clicked', () => EVENT_PAYLOADS.eligible_gate_bridge_clicked(), { total: 1, bookingClick: 1 }],
  ['installment_lead (guide mail to the patient)', () => EVENT_PAYLOADS.installment_lead(), { install: 1 }],
  ['form_with_contact', () => EVENT_PAYLOADS.form_with_contact(), { total: 1, contact: 1 }],
];

describe('A. subject -> counter contract (current behaviour pinned)', () => {
  for (const [label, build, want] of CONTRACT) {
    test(label, withDate(CRON_NOW, async () => {
      const items = await emit(build);
      const { stats, res } = await runReport(items);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(pick(stats), { ...zero(), ...want }, `subjects: ${items.map((i) => i.subject).join(' || ')}`);
    }));
  }

  test('booking-completed ledger (booking.ksa.ee webhook)', withDate(CRON_NOW, async () => {
    const items = await emitBooking();
    const { stats } = await runReport(items);
    assert.deepEqual(pick(stats), { ...zero(), total: 1, good: 1, bookingCompleted: 1 });
  }));

  test('quiz_completed emits no e-mail at all, so the "qualified quiz" matcher in analyze() is a dead needle', withDate(CRON_NOW, async () => {
    const items = await emit(() => EVENT_PAYLOADS.quiz_completed());
    assert.deepEqual(items, []);
  }));

  test('source breakdown reads the [channel] from every ledger subject (Google Ads / Meta / E-post / Orgaaniline / custom)', withDate(CRON_NOW, async () => {
    const mk = (utm) => emit(() => payload('qualified_flow3_phone_lead', { name: PERSON.name, phone: PERSON.phone, email: PERSON.email, utm }));
    const items = [
      ...await mk({ utm_source: 'google', gclid: 'x', utm_campaign: 'Brand' }),
      ...await mk({ utm_source: 'facebook', fbclid: 'y', utm_campaign: 'Spring' }),
      ...await mk({ utm_source: 'newsletter', utm_medium: 'email' }),
      ...await mk({ referrer: 'https://ksa.ee/blogi/x' }),
      ...await mk({}),
      ...await mk({ utm_source: 'partner-site' }),
    ];
    const { stats } = await runReport(items);
    assert.deepEqual(Object.keys(stats.bySource).sort(), ['E-post', 'Google Ads', 'Meta', 'Orgaaniline', 'Otse/Muu', 'partner-site'].sort());
  }));

  test('ghost detector: every ledger subject track.js emits increments a displayed counter, except the explicit allow-list', withDate(CRON_NOW, async () => {
    const UNREPORTED_BY_DESIGN = new Set(['email_captured, Audit route', 'email_captured, kids route', 'form_with_contact']);
    const ghosts = [];
    for (const [label, build, want] of CONTRACT) {
      const shows = DISPLAYED.some((c) => want[c]);
      if (!shows && !UNREPORTED_BY_DESIGN.has(label)) ghosts.push(label);
    }
    assert.deepEqual(ghosts, []);
  }));
});

// ── B. report accuracy bugs ───────────────────────────────────────────────────────────
describe('B. accuracy', () => {
  bug('F-REPORT-CONTACT', 'form_with_contact (name+phone left) is counted in the "Kontakt jäetud (nimi+tel)" tile; today that tile only counts qualified_flow3_phone_lead', withDate(CRON_NOW, async () => {
    const items = await emit(() => EVENT_PAYLOADS.form_with_contact());
    const { slack } = await runReport(items);
    assert.ok(Number(tiles(slack)['📞 Kontakt jäetud (nimi+tel)']) >= 1);
  }));

  for (const type of ['phone_lead', 'hot_lead_lens_user']) {
    bug('F-REPORT-INVISIBLE', `${type} appears in the daily report (today it has no ledger mail, so it is invisible; analyze() even greps for 'Tagasihelistamise soov' which nothing emits)`, withDate(CRON_NOW, async () => {
      const w = await makeWorld('track');
      await w.post(EVENT_PAYLOADS[type]());
      assert.ok(w.net.resendInternal().length >= 1, `${type} writes no ledger mail`);
      w.done();
    }));
  }

  bug('F-REPORT-DOUBLE', 'one patient journey (Sobiv mail -> phone lead -> booking click -> booking completed) adds at most 1 to the "progress to 10/day" counter (today ✅ appears on 3 subjects => 3)', withDate(CRON_NOW, async () => {
    const items = [
      ...await emit(() => EVENT_PAYLOADS.email_captured()),
      ...await emit(() => EVENT_PAYLOADS.qualified_flow3_phone_lead()),
      ...await emit(() => EVENT_PAYLOADS.book_now_clicked()),
      ...await emitBooking(),
    ];
    const { stats } = await runReport(items);
    assert.ok(stats.good <= 1, `good=${stats.good} for ONE person`);
  }));

  bug('F-REPORT-INSTALL', 'installment_lead with phone only (no e-mail, so no guide mail) is still counted under "Järelmaks huvi"', withDate(CRON_NOW, async () => {
    const items = await emit(() => payload('installment_lead', { contact: { name: PERSON.name, phone: PERSON.phone } }));
    const { stats } = await runReport(items);
    assert.equal(stats.install, 1);
  }));

  bug('F-REPORT-SUBJECT-SPOOF', 'a visitor-chosen name cannot move counters (name "booking click ✅" inside the form_with_contact subject)', withDate(CRON_NOW, async () => {
    const items = await emit(() => payload('form_with_contact', { contact: { name: 'x booking click ✅ Flow3 phone lead', phone: PERSON.phone, email: PERSON.email } }));
    const { stats } = await runReport(items);
    assert.equal(stats.bookingClick + stats.phoneLead + stats.good, 0);
  }));

  bug('F-REPORT-ERR', 'when Resend answers 401/429 the report says so (error, alert) instead of posting "0 leads" as fact', withDate(CRON_NOW, async () => {
    const w = await makeWorld('analytics-report');
    w.net.on((c) => c.kind === 'resend-list', () => w.net.json(401, { name: 'restricted_api_key', message: 'API key is invalid' }));
    const res = await w.post(undefined, { method: 'GET' });
    const posted = w.net.slackAll()[0]?.json;
    w.done();
    assert.ok(res.statusCode >= 500 || /viga|error|ei õnnestunud/i.test(JSON.stringify(posted)), 'report silently posted zeros');
  }));

  bug('F-REPORT-SLACKLIMIT', '200 distinct campaign sources keep the report inside Slack limits (source section grows unbounded -> invalid_blocks -> no report)', withDate(CRON_NOW, async () => {
    const items = [];
    for (let i = 0; i < 90; i++) items.push({ id: `e${i}`, to: ['registreerumised@ksa.ee'], subject: `Kiirtest — ✅ Sobiv [partner-site-number-${i}-with-a-long-name] — x@y.ee`, created_at: `${DAY} 10:00:00+00` });
    const { slack } = await runReport(items);
    assert.deepEqual(validateSlackPayload(slack), []);
  }));
});

// ── C. truncation (limit=100, no pagination) ─────────────────────────────────────────
describe('C. >100 e-mails in the window', () => {
  function busyDay(nQualified, nCustomerMails) {
    const items = [];
    let n = 0;
    // newest first, as Resend lists them: each lead = customer result mail (newer) + internal copy
    for (let i = 0; i < nQualified; i++) {
      items.push({ id: `c${n++}`, to: [`patient${i}@gmail.com`], subject: 'Sinu kiirtesti tulemus: Flow3 uuring 39 €', created_at: `${DAY} 12:${String(59 - (i % 60)).padStart(2, '0')}:30+00` });
      items.push({ id: `i${n++}`, to: ['registreerumised@ksa.ee'], subject: `Kiirtest — ✅ Sobiv [Google Ads] — patient${i}@gmail.com`, created_at: `${DAY} 12:${String(59 - (i % 60)).padStart(2, '0')}:29+00` });
    }
    for (let i = 0; i < nCustomerMails; i++) items.push({ id: `x${n++}`, to: [`other${i}@gmail.com`], subject: 'Sinu kiirtesti tulemus — KSA Silmakeskus', created_at: `${DAY} 08:00:00+00` });
    return items;
  }

  test('sanity: with <=100 records the count is exact', withDate(CRON_NOW, async () => {
    const { stats } = await runReport(busyDay(20, 0));
    assert.equal(stats.qualifiedQuiz, 20);
  }));

  bug('F-REPORT-TRUNC', 'daily report on a day with 60 qualified leads (120 mails + customer mails) counts all 60 - analytics-report.js asks for limit=100 once and never follows has_more/after', withDate(CRON_NOW, async () => {
    const { stats, net } = await runReport(busyDay(60, 30));
    assert.equal(stats.qualifiedQuiz, 60, `report saw ${stats.qualifiedQuiz}/60; list requests: ${net.calls.filter((c) => c.kind === 'resend-list').map((c) => c.url).join(' ')}`);
  }));

  bug('F-REPORT-TRUNC-WEEK', 'weekly report over 7 days of 20 leads/day counts all 140 (worst-hit report: only the newest 100 records of the whole account are ever read)', withDate(MON_NOW, async () => {
    const items = [];
    for (let d = 0; d < 7; d++) {
      const day = `2026-11-0${2 + d}`;
      for (let i = 0; i < 20; i++) {
        items.push({ id: `c${d}-${i}`, to: [`p${d}${i}@gmail.com`], subject: 'Sinu kiirtesti tulemus: Flow3 uuring 39 €', created_at: `${day} 12:00:${String(59 - i).padStart(2, '0')}+00` });
        items.push({ id: `i${d}-${i}`, to: ['registreerumised@ksa.ee'], subject: 'Kiirtest — ✅ Sobiv [Otse] — x@y.ee', created_at: `${day} 12:00:${String(58 - i).padStart(2, '0')}+00` });
      }
    }
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const { stats } = await runReport(items, { weekly: true });
    assert.equal(stats.qualifiedQuiz, 140);
  }));
});

// ── D. Tallinn day boundary ──────────────────────────────────────────────────────────
describe('D. day boundaries (Tallinn vs the UTC date Resend returns)', () => {
  const lead = (id, created_at) => ({ id, to: ['registreerumised@ksa.ee'], subject: 'Kiirtest — ✅ Sobiv [Otse] — a@b.ee', created_at });

  test('"yesterday" at the 05:00 UTC cron is the previous Tallinn calendar day', withDate(CRON_NOW, async () => {
    const { res } = await runReport([]);
    assert.equal(res.body.period, DAY);
  }));

  test('DST end: cron on 2026-10-26 reports 2026-10-25', withDate(Date.parse('2026-10-26T05:00:00Z'), async () => {
    const { res } = await runReport([]);
    assert.equal(res.body.period, '2026-10-25');
  }));

  bug('F-REPORT-TZ-1', 'a lead at 00:30 Tallinn on 9 Nov (= 22:30 UTC on 8 Nov) belongs to the 9 Nov report', withDate(CRON_NOW, async () => {
    const { stats } = await runReport([lead('a', '2026-11-08 22:30:00.000000+00')]);
    assert.equal(stats.qualifiedQuiz, 1);
  }));

  bug('F-REPORT-TZ-2', 'a lead at 00:30 Tallinn on 10 Nov (= 22:30 UTC on 9 Nov) does NOT count towards the 9 Nov report', withDate(CRON_NOW, async () => {
    const { stats } = await runReport([lead('b', '2026-11-09 22:30:00.000000+00')]);
    assert.equal(stats.qualifiedQuiz, 0);
  }));
});

// ── E. who may trigger the report ─────────────────────────────────────────────────────
describe('E. access', () => {
  test('(current) an anonymous GET posts to Slack and returns the stats - no auth of any kind', withDate(CRON_NOW, async () => {
    const { res, net } = await runReport([]);
    assert.equal(res.statusCode, 200);
    assert.equal(net.slackAll().length, 1);
    assert.ok(res.body.stats);
  }));

  bug('F-AUTH-REPORT', 'GET /api/analytics-report without the cron secret is rejected (401) and posts nothing', withDate(CRON_NOW, async () => {
    const { res, net } = await runReport([], { env: { CRON_SECRET: 'dummy-cron-secret' } });
    assert.equal(res.statusCode, 401);
    assert.equal(net.slackAll().length, 0);
  }));

  test('with the correct "Authorization: Bearer <CRON_SECRET>" (what Vercel Cron sends) the report runs (guard: must keep working after auth is added)', withDate(CRON_NOW, async () => {
    const { res } = await runReport([], { env: { CRON_SECRET: 'dummy-cron-secret' }, headers: { authorization: 'Bearer dummy-cron-secret' } });
    assert.equal(res.statusCode, 200);
  }));
});
