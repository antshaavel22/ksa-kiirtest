// isTestPayload() in api/track.js drops internal smoke/diagnostic pings SILENTLY (HTTP 200,
// no Slack, no mail, no CRM). A false positive therefore loses a real patient without a
// trace, so the boundary between "marker" and "near miss" is pinned here.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { bug, makeWorld, payload, PERSON, EVENT_PAYLOADS } from './helpers/harness.mjs';

const MARKERS = [
  ['email diagnostics-test@ksa.ee', { email: 'diagnostics-test@ksa.ee' }],
  ['email smoke-test in local part', { email: 'smoke-test@gmail.com' }],
  ['email smoke_test', { email: 'my.smoke_test@gmail.com' }],
  ['email smoketest', { email: 'smoketest@gmail.com' }],
  ['email test+ prefix', { email: 'test+anna@gmail.com' }],
  ['email +test@', { email: 'anna+test@gmail.com' }],
  ['email @example.com', { email: 'anna@example.com' }],
  ['email @example.ee', { email: 'anna@example.ee' }],
  ['contact.email marker', { contact: { name: 'Mari', phone: PERSON.phone, email: 'x@example.com' } }],
  ['promoCode flow-test', { promoCode: 'FLOW-TEST', email: PERSON.email }],
  ['code flow-test', { code: 'flow-test', email: PERSON.email }],
  ['name "TEST " prefix', { name: 'TEST Mari', email: PERSON.email }],
  ['name " TEST Mai" leading space', { name: '  TEST Mai', email: PERSON.email }],
  ['utm.source smoke-test', { utm: { source: 'smoke-test' }, email: PERSON.email }],
  ['utm.source diagnostics-cron', { utm: { source: 'diagnostics-cron' }, email: PERSON.email }],
  ['utm.source cron_test', { utm: { source: 'cron_test' }, email: PERSON.email }],
];

const NEAR_MISSES = [
  ['testimonial@gmail.com', { email: 'testimonial@gmail.com' }],
  ['attest.mari@gmail.com', { email: 'attest.mari@gmail.com' }],
  ['contest.winner@gmail.com', { email: 'contest.winner@gmail.com' }],
  ['mari@example.com.au (suffix, not the reserved domain)', { email: 'mari@example.com.au' }],
  ['mari@myexample.com', { email: 'mari@myexample.com' }],
  ['name "Testi Tiit"', { name: 'Testi Tiit', email: PERSON.email }],
  ['name "Test" (case differs, no trailing token)', { name: 'Test', email: PERSON.email }],
  ['name "Tester Tamm"', { name: 'Tester Tamm', email: PERSON.email }],
  ['name "TESTIMONIAL Ott"', { name: 'TESTIMONIAL Ott', email: PERSON.email }],
  ['promoCode KIIRTEST39', { promoCode: 'KIIRTEST39', email: PERSON.email }],
  ['utm.source google', { utm: { source: 'google' }, email: PERSON.email }],
  ['utm.source diagnostika-blogi (Estonian word)', { utm: { source: 'diagnostika-blogi' }, email: PERSON.email }],
  ['utm.source "cron" alone', { utm: { source: 'cron' }, email: PERSON.email }],
];

const SIDE_EFFECTS = (w) => w.net.calls.length;

describe('markers are dropped silently, with zero side effects', () => {
  for (const [label, extra] of MARKERS) {
    test(label, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      // email_captured is the richest path (Slack + 2x Resend + CRM + Brevo): if anything leaks it shows.
      const res = await w.post(payload('email_captured', { consent: { marketing_email: true }, ...extra }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.skipped, 'test_or_diagnostic_event');
      assert.equal(SIDE_EFFECTS(w), 0, `leaked: ${w.net.calls.map((c) => c.kind).join(',')}`);
    });
  }

  test('marker in ANY event type drops it (callback_requested, book click, phone lead ...)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (const type of ['callback_requested', 'book_now_clicked', 'qualified_flow3_phone_lead', 'form_with_contact', 'installment_lead']) {
      const res = await w.post({ ...EVENT_PAYLOADS[type](), email: 'diagnostics-test@ksa.ee', contact: { ...PERSON, email: 'diagnostics-test@ksa.ee' } });
      assert.equal(res.body.skipped, 'test_or_diagnostic_event', type);
    }
    assert.equal(SIDE_EFFECTS(w), 0);
  });
});

describe('near-miss real patients are NOT dropped', () => {
  for (const [label, extra] of NEAR_MISSES) {
    test(label, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      const res = await w.post(payload('email_captured', { email: PERSON.email, ...extra }));
      assert.equal(res.statusCode, 200);
      assert.notEqual(res.body.skipped, 'test_or_diagnostic_event', `${label} was treated as a test payload`);
      assert.ok(w.net.slackLeads().length > 0 && w.net.crm().length === 1, 'lead must reach Slack and CRM');
    });
  }

  test('a normal patient using Gmail plus-addressing ("anna+kiirtest@gmail.com") is kept', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const res = await w.post(payload('email_captured', { email: 'anna+kiirtest@gmail.com' }));
    assert.notEqual(res.body.skipped, 'test_or_diagnostic_event');
  });
});

describe('residual risk of the silent drop', () => {
  bug('F-TEST-1', 'a dropped test payload is counted/logged somewhere staff can see (digest), so a false positive is detectable', async (t) => {
    // Today: console.log only. 200 + skipped is indistinguishable from success for the caller and invisible to ops.
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'anna+test@gmail.com' }));
    assert.ok(w.net.calls.length > 0, 'nothing recorded for the dropped payload');
  });

  bug('F-TEST-2', 'a REAL patient who types a +test address (anna+test@gmail.com) still gets the lead recorded (flag it, do not drop it)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const res = await w.post(payload('email_captured', { email: 'anna+test@gmail.com' }));
    assert.notEqual(res.body.skipped, 'test_or_diagnostic_event');
  });

  test('the quiz sends utm under prefixed keys (utm_source...), which the utm.source marker check never sees -> that marker is dead for quiz traffic', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const res = await w.post(payload('email_captured', { email: PERSON.email, utm: { utm_source: 'smoke-test' } }));
    assert.notEqual(res.body.skipped, 'test_or_diagnostic_event');
  });
});
