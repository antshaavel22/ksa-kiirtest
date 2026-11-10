// Event -> sink contract for api/track.js.
//
//  Part A  pins WHICH sinks each event type writes to today (regression guard: if someone
//          adds/removes a sink the test says so).
//  Part B  states the DESIRED failure behaviour: when a sink answers 500 / drops the
//          connection the lead must not vanish silently (an ops alert, or a 5xx so the
//          caller can retry). Currently several paths are silent -> marked as known bugs.
//  Part C  alert rate limit (commit 839c168): it may only ever suppress OPS alerts, never a
//          lead notification.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeSupabase } from './helpers/mock-fetch.mjs';
import {
  bug, makeWorld, EVENT_PAYLOADS, LP_HEADERS, PERSON, payload, HOSTS, sleep, BASE_ENV,
} from './helpers/harness.mjs';

// Which sinks does each event write to? (staff-facing sinks: slack, internal mail, crm)
const CONTRACT = {
  email_captured:               { slack: 2, internal: 1, customer: 1, crm: 1, brevo: 1 },
  callback_requested:           { slack: 2, internal: 1, customer: 0, crm: 0, brevo: 0 },
  qualified_flow3_phone_lead:   { slack: 2, internal: 1, customer: 0, crm: 0, brevo: 0 },
  phone_lead:                   { slack: 2, internal: 0, customer: 0, crm: 0, brevo: 0 },
  form_with_contact:            { slack: 2, internal: 1, customer: 0, crm: 0, brevo: 0 },
  installment_lead:             { slack: 2, internal: 0, customer: 1, crm: 0, brevo: 0 },
  hot_lead_lens_user:           { slack: 2, internal: 0, customer: 0, crm: 1, brevo: 0 },
  book_now_clicked:             { slack: 0, internal: 1, customer: 0, crm: 1, brevo: 0 },
  bridge_19_book_clicked:       { slack: 0, internal: 1, customer: 0, crm: 1, brevo: 0 },
  eligible_gate_bridge_clicked: { slack: 0, internal: 1, customer: 0, crm: 1, brevo: 0 },
  quiz_completed:               { slack: 0, internal: 0, customer: 0, crm: 0, brevo: 0 },
  lp_contact_submitted:         { slack: 1, internal: 0, customer: 0, crm: 0, brevo: 1, lp: true },
  lp_guide_download:            { slack: 1, internal: 0, customer: 0, crm: 0, brevo: 1, lp: true },
};
const optsFor = (type) => (CONTRACT[type].lp ? { headers: LP_HEADERS } : {});

async function fire(w, type, bodyOverride) {
  w.net.calls.length = 0;
  const body = bodyOverride || EVENT_PAYLOADS[type]();
  const res = await w.post(body, optsFor(type));
  return res;
}

// ── Part A ──────────────────────────────────────────────────────────────────────────
describe('A. which sinks each event writes to', () => {
  for (const type of Object.keys(CONTRACT)) {
    test(`${type}`, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      const res = await fire(w, type);
      assert.equal(res.statusCode, 200, 'handler must answer 200');
      const want = CONTRACT[type];
      const got = {
        slack: w.net.slackLeads().length,
        internal: w.net.resendInternal().length,
        customer: w.net.resendCustomer().length,
        crm: w.net.crm().length,
        brevo: w.net.brevo().length,
      };
      assert.deepEqual(got, { slack: want.slack, internal: want.internal, customer: want.customer, crm: want.crm, brevo: want.brevo },
        `sink set changed for ${type}`);
      if (want.slack && !want.lp) {
        const urls = w.net.slackLeads().map((c) => c.url).sort();
        assert.deepEqual(urls, [HOSTS.slackKiirtest, HOSTS.slackMain].sort());
      }
      if (want.lp) assert.deepEqual(w.net.slackLeads().map((c) => c.url), [HOSTS.slackLp]);
    });
  }

  test('email-only lead (no phone) is POSTed to the CRM with contact.email and no phone', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await fire(w, 'email_captured');
    const c = w.net.crm()[0].json;
    assert.equal(c.contact.email, PERSON.email);
    assert.equal(c.contact.phone, undefined);
    assert.equal(c.source, 'kiirtest_lp_email_sobiv');
    assert.equal(c.client_session_id, 'kt_abc123');
  });

  test('unknown / diagnostic event types are accepted and do nothing (200, no sinks)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (const type of ['bridge_19_viewed', 'lilia_qr_page_open', 'something_new']) {
      w.net.calls.length = 0;
      const res = await w.post({ type, timestamp: new Date().toISOString() });
      assert.equal(res.statusCode, 200);
      assert.equal(w.net.calls.length, 0, type);
    }
  });

  test('quiz_completed produces NO ledger email (its rows carry no contact, so the "actionable contact" filter drops it) - the report counter for it is dead', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const res = await fire(w, 'quiz_completed');
    assert.equal(res.body.skipped, 'anonymous_quiz_completion_not_sent_to_slack');
    assert.equal(w.net.resend().length, 0);
  });

  test('CRM gets booking-intent events but NOT callback / contact / phone leads (documented gap, see bugs below)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (const type of ['callback_requested', 'form_with_contact', 'qualified_flow3_phone_lead', 'phone_lead', 'installment_lead']) {
      await fire(w, type);
      assert.equal(w.net.crm().length, 0, type);
    }
  });
});

// ── Part B ──────────────────────────────────────────────────────────────────────────
const STAFF_EVENTS = Object.keys(CONTRACT).filter((t) => CONTRACT[t].slack || CONTRACT[t].internal || CONTRACT[t].crm || CONTRACT[t].customer || CONTRACT[t].brevo);

function sinkMatcher(sink) {
  return {
    slack: (c) => c.kind === 'slack' && !c.url.endsWith('/alerts'),
    resend: (c) => c.kind === 'resend',
    crm: (c) => c.kind === 'crm',
    brevo: (c) => c.kind === 'brevo',
  }[sink];
}
const usedSinks = (type) => {
  const c = CONTRACT[type]; const s = [];
  if (c.slack) s.push('slack'); if (c.internal || c.customer) s.push('resend');
  if (c.crm) s.push('crm'); if (c.brevo) s.push('brevo');
  return s;
};

/** Ops alert = a plain-text Slack post to the alerts hook OR to any non-failing hook. */
function alertRaised(w, failingSink) {
  return w.net.slackAlerts().some((c) => failingSink !== 'slack' || c.url.endsWith('/alerts'));
}

describe('B. sink failure handling (desired: never silent)', () => {
  for (const type of STAFF_EVENTS) {
    bug(`F-LOSS-${type}`, `${type}: when any sink it uses fails (HTTP 500 or dropped connection) an ops alert is raised or the caller gets a 5xx`, async (t) => {
      const silent = [];
      for (const mode of ['http500', 'networkError']) {
        for (const sink of usedSinks(type)) {
          const w = await makeWorld('track');
          try {
            const m = sinkMatcher(sink);
            if (mode === 'http500') w.net.on(m, () => w.net.json(500, 'boom'));
            else w.net.on(m, () => { throw new TypeError('fetch failed'); });
            const res = await fire(w, type);
            if (!(alertRaised(w, sink) || res.statusCode >= 500)) silent.push(`${sink}/${mode}`);
          } finally { w.done(); }
        }
      }
      assert.deepEqual(silent, [], `${type}: silent when ${silent.join(', ')}`);
    });
  }

  describe('leads that live in exactly ONE staff sink can vanish', () => {
    for (const type of ['phone_lead', 'installment_lead']) {
      bug(`F-VANISH-${type}`, `${type}: if Slack is down the lead must still be stored somewhere staff will see (internal mail / CRM) or alerted`, async (t) => {
        const w = await makeWorld('track');
        t.after(() => w.done());
        w.net.on(sinkMatcher('slack'), () => w.net.json(500, 'boom'));
        const res = await fire(w, type);
        const staffCopy = w.net.resendInternal().length + w.net.crm().length;
        assert.ok(staffCopy > 0 || alertRaised(w, 'slack') || res.statusCode >= 500,
          `${type}: Slack failed, no internal mail, no CRM ticket, no alert, HTTP ${res.statusCode} -> lead lost without trace`);
      });
    }
  });

  bug('F-CRM-COVER', 'phone-bearing lead events (callback_requested, form_with_contact, qualified_flow3_phone_lead, phone_lead) create a CRM ticket - the CRM is where Lilia works the queue', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const missing = [];
    for (const type of ['callback_requested', 'form_with_contact', 'qualified_flow3_phone_lead', 'phone_lead']) {
      await fire(w, type);
      if (w.net.crm().length === 0) missing.push(type);
    }
    assert.deepEqual(missing, [], `no CRM ticket for: ${missing.join(', ')}`);
  });

  describe('CRM specifics (KAISA-436)', () => {
    bug('F-CRM-QUIET4XX', 'email_captured: a CRM 401/403/422 (rotated key, schema change) must raise an alert; quiet4xx currently swallows ALL 4xx forever', async (t) => {
      const silent = [];
      for (const status of [400, 401, 403, 404, 422]) {
        const w = await makeWorld('track');
        try {
          w.net.on(sinkMatcher('crm'), () => w.net.json(status, '{"error":"x"}'));
          await fire(w, 'email_captured');
          if (!alertRaised(w, 'crm')) silent.push(status);
        } finally { w.done(); }
      }
      assert.deepEqual(silent, [], `CRM answered ${silent.join(',')} and nobody was told`);
    });

    test('book_now_clicked: a CRM 500 raises a :warning: alert (non-quiet path works)', async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      w.net.on(sinkMatcher('crm'), () => w.net.json(500, 'boom'));
      await fire(w, 'book_now_clicked');
      assert.ok(w.net.slackAlerts().some((c) => /KAISA-436/.test(c.json.text)));
    });

    bug('F-CRM-NOKEY', 'KSA_TICKETS_API_KEY missing on the deployment -> alert (today: console.error only, every CRM ticket silently skipped)', async (t) => {
      const w = await makeWorld('track', { KSA_TICKETS_API_KEY: undefined });
      t.after(() => w.done());
      await fire(w, 'email_captured');
      await fire(w, 'book_now_clicked');
      assert.equal(w.net.crm().length, 0);
      assert.ok(w.net.slackAlerts().length > 0, 'CRM disabled by missing key and nobody alerted');
    });

    bug('F-CRM-PHONE', 'a phone that is not E.164 ("55512345") is normalised or alerted, not silently skipped (intake-flow3.js already has normalisePhone)', async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      await w.post(payload('hot_lead_lens_user', { phone: '55512345', email: '', name: PERSON.name }));
      assert.ok(w.net.crm().length === 1 || w.net.slackAlerts().length > 0, 'lead with local-format phone dropped from CRM silently');
    });
  });

  describe('misconfiguration is loud', () => {
    bug('F-ENV-RESEND', 'RESEND_API_KEY missing -> no customer email, no internal copy, no ledger: must alert', async (t) => {
      const w = await makeWorld('track', { RESEND_API_KEY: undefined });
      t.after(() => w.done());
      await fire(w, 'email_captured');
      assert.equal(w.net.resend().length, 0);
      assert.ok(w.net.slackAlerts().length > 0, 'result email silently not sent');
    });

    bug('F-ENV-SLACK', 'no Slack webhook configured -> lead notification skipped silently with HTTP 200', async (t) => {
      const w = await makeWorld('track', { SLACK_WEBHOOK_URL: undefined, SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL: undefined, SLACK_ALERTS_WEBHOOK_URL: undefined });
      t.after(() => w.done());
      const res = await fire(w, 'phone_lead');
      assert.ok(res.statusCode >= 500 || w.net.calls.length > 0, 'phone_lead accepted (200) but nothing was sent anywhere');
    });
  });
});

// ── Part B2: timeouts / ordering ────────────────────────────────────────────────────
describe('B2. hung sinks (no fetch timeout anywhere)', () => {
  bug('F-TIMEOUT', 'every outbound request carries an AbortSignal/timeout (a hung Slack/Resend/CRM/Brevo/Graph call otherwise runs until the platform kills the function)', async (t) => {
    const noTimeout = [];
    for (const type of Object.keys(CONTRACT)) {
      const w = await makeWorld('track', { META_SYSTEM_USER_TOKEN: 'meta_dummy' });
      try {
        await fire(w, type, { ...EVENT_PAYLOADS[type](), utm: { utm_source: 'facebook', utm_campaign: '6753232351941' } });
        for (const c of w.net.calls) if (!c.signal) noTimeout.push(`${type}: ${c.kind} ${c.host}`);
      } finally { w.done(); }
    }
    assert.deepEqual([...new Set(noTimeout)].slice(0, 8), [], `${noTimeout.length} un-timed requests, e.g. ${noTimeout.slice(0, 3).join(' | ')}`);
  });

  for (const [type, hung] of [['email_captured', 'resend'], ['callback_requested', 'resend'], ['qualified_flow3_phone_lead', 'resend'], ['form_with_contact', 'resend'], ['email_captured', 'crm'], ['email_captured', 'brevo']]) {
    bug(`F-ORDER-${type}-${hung}`, `${type}: the Slack lead alert is posted even if the ${hung} call hangs (today Slack is awaited LAST, behind every other sink)`, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      w.net.hang(sinkMatcher(hung));
      w.net.calls.length = 0;
      void w.post(EVENT_PAYLOADS[type]()).catch(() => {});
      await sleep(150);
      assert.ok(w.net.slackLeads().length > 0, `Slack never reached while ${hung} hangs`);
    });
  }

  bug('F-ORDER-meta', 'a hung Meta Graph name lookup (utmLabel awaits it first) must not block the whole lead', async (t) => {
    const w = await makeWorld('track', { META_SYSTEM_USER_TOKEN: 'meta_dummy' });
    t.after(() => w.done());
    w.net.hang((c) => c.kind === 'meta-graph');
    void w.post({ ...EVENT_PAYLOADS.email_captured(), utm: { utm_source: 'facebook', utm_campaign: '6753232351941' } }).catch(() => {});
    await sleep(150);
    assert.ok(w.net.slackLeads().length > 0 || w.net.crm().length > 0);
  });
});

// ── Part C ──────────────────────────────────────────────────────────────────────────
describe('C. alert rate limit (839c168) only ever suppresses ops alerts', () => {
  const ENV = { SUPABASE_URL: HOSTS.supabase, SUPABASE_SERVICE_KEY: 'sb_dummy' };

  test('lead notifications never go through the alert dedupe: with an alert already logged this hour every lead Slack/Resend/CRM write still happens', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    const rows = installFakeSupabase(w.net);
    for (const kind of ['brevo_push', 'brevo_attrs', 'brevo_unconfigured', 'general']) {
      rows.push({ key: `alert:track:${kind}`, kind: 'alert', posted_at: new Date().toISOString() });
    }
    for (const type of ['email_captured', 'callback_requested', 'qualified_flow3_phone_lead', 'phone_lead', 'form_with_contact', 'installment_lead', 'hot_lead_lens_user']) {
      const res = await fire(w, type);
      assert.equal(res.statusCode, 200);
      const want = CONTRACT[type];
      assert.equal(w.net.slackLeads().length, want.slack, `${type}: lead Slack post suppressed by alert window`);
      assert.equal(w.net.resendInternal().length, want.internal, type);
    }
  });

  test('first Brevo failure alerts, the second inside the hour does not - but the lead notification of the second lead is still delivered', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    installFakeSupabase(w.net);
    w.net.on(sinkMatcher('brevo'), () => w.net.json(500, 'brevo down'));
    await fire(w, 'email_captured');
    const first = w.net.slackAlerts().filter((c) => c.url.endsWith('/alerts')).length;
    // A second, different lead (an identical payload would be the page's retry of the first).
    await fire(w, 'email_captured', { ...EVENT_PAYLOADS.email_captured(), email: 'second.lead@gmail.com', client_session_id: 'kt_second' });
    const second = w.net.slackAlerts().filter((c) => c.url.endsWith('/alerts')).length;
    assert.equal(first, 1);
    assert.equal(second, 0, 'second alert inside the window must be suppressed (fire() resets the call log, so 0 new alerts)');
    assert.equal(w.net.slackLeads().length, 2, 'lead notification of the 2nd lead must still go out (main + kiirtest hook)');
  });

  test('different alert kinds do not suppress each other', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    const rows = installFakeSupabase(w.net);
    rows.push({ key: 'alert:track:brevo_push', kind: 'alert', posted_at: new Date().toISOString() });
    w.net.on(sinkMatcher('brevo'), (c) => c.json?.attributes ? w.net.json(400, 'Unknown attribute') : w.net.json(201, {}));
    await fire(w, 'email_captured');
    assert.ok(w.net.slackAlerts().some((c) => /atribuudid/.test(c.json.text)), 'brevo_attrs alert must not be eaten by brevo_push window');
  });

  test('alert window check fails open: Supabase down -> alert still goes out', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    w.net.on((c) => c.kind === 'supabase', () => w.net.json(500, 'down'));
    w.net.on(sinkMatcher('brevo'), () => w.net.json(500, 'brevo down'));
    await fire(w, 'email_captured');
    assert.equal(w.net.slackAlerts().filter((c) => c.url.endsWith('/alerts')).length, 1);
  });

  test('window expires after 60 minutes (a row older than an hour does not suppress)', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    const rows = installFakeSupabase(w.net);
    rows.push({ key: 'alert:track:brevo_push', kind: 'alert', posted_at: new Date(Date.now() - 61 * 60000).toISOString() });
    w.net.on(sinkMatcher('brevo'), () => w.net.json(500, 'down'));
    await fire(w, 'email_captured');
    assert.equal(w.net.slackAlerts().filter((c) => c.url.endsWith('/alerts')).length, 1);
  });

  test('alertSlack is used only for Brevo kinds (source scan) - no lead path can be rate-limited', async () => {
    const { apiSource } = await import('./helpers/load-api.mjs');
    const src = apiSource('track');
    const kinds = [...src.matchAll(/alertSlack\([\s\S]*?,\s*'([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(kinds)].sort(), ['brevo_attrs', 'brevo_push', 'brevo_unconfigured']);
  });

  bug('F-ALERT-ID', 'a Brevo alert names the affected lead (or session id) - with one alert per hour the 2nd..nth lost contact is otherwise unrecoverable from Slack', async (t) => {
    const w = await makeWorld('track', ENV);
    t.after(() => w.done());
    installFakeSupabase(w.net);
    w.net.on(sinkMatcher('brevo'), () => w.net.json(500, 'down'));
    await fire(w, 'email_captured');
    const text = w.net.slackAlerts().map((c) => c.json.text).join('\n');
    assert.ok(text.includes('kt_abc123') || text.includes(PERSON.email), 'alert contains neither session id nor email');
  });
});
