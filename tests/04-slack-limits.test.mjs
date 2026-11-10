// Slack Block Kit limits for every payload api/track.js can post, fed with worst-case
// input. A single violating field makes Slack answer 400 invalid_blocks and (before the
// 2026-06-17 sanitizer) silently lost the lead notification.
//
// Limits enforced (https://api.slack.com/reference/block-kit/blocks):
//   <= 50 blocks per message; header: plain_text, 1..150 chars; section: needs text or
//   fields, text 1..3000, <= 10 fields, each field 1..2000; context: <= 10 elements,
//   each mrkdwn text 1..2000; no lone UTF-16 surrogates anywhere (invalid UTF-8 on the wire).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSlackPayload } from './helpers/slack-validate.mjs';
import { bug, makeWorld, EVENT_PAYLOADS, LP_HEADERS, PERSON, ANSWERS_FLOW3, payload } from './helpers/harness.mjs';

const long = (n, ch = 'x') => ch.repeat(n);
const MD = '*_~`<>&|[]()!@#:' ;               // markdown-significant characters
const NAME60 = (MD + 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789').slice(0, 60);
// Emoji are 2 UTF-16 units; depending on the label prefix length slice(0,2000) / slice(0,3000)
// lands in the middle of a pair for one of these two strings.
const EMOJI_EVEN = '😀'.repeat(3000);
const EMOJI_ODD = 'a' + '😀'.repeat(3000);

const HOSTILE = {
  'very long strings (10 000 chars everywhere)': (p) => deepFill(p, long(10000)),
  'emoji everywhere': (p) => deepFill(p, '😀🔥👁️‍🗨️ ✅ ❤️'),
  '60-char names with markdown characters': (p) => withName(p, NAME60),
  'empty strings': (p) => deepFill(p, ''),
  'null / undefined': (p) => deepFill(p, null),
  'newlines and tabs': (p) => deepFill(p, 'a\n\n\n\tb\r\nc'),
  'only whitespace': (p) => deepFill(p, '   \n  '),
};

function deepFill(p, v) {
  // keep routing-critical fields; hostile-fill every free-text one
  const keep = new Set(['type', 'language', 'lp_source', 'result', 'timestamp', 'client_session_id', 'from', 'route']);
  const out = JSON.parse(JSON.stringify(p));
  const walk = (o, top) => {
    for (const k of Object.keys(o)) {
      if (top && keep.has(k)) continue;
      if (['age', 'vision'].includes(k) && o === out.answers) continue; // keep qualification so the event is not skipped
      if (o[k] && typeof o[k] === 'object') walk(o[k], false);
      else if (typeof o[k] === 'string') {
        if (k === 'email' && v) o[k] = `${PERSON.email.split('@')[0]}${String(v).slice(0, 5000).replace(/\s/g, '')}@gmail.com`;
        else if (k === 'phone') o[k] = v === '' || v === null ? PERSON.phone : (typeof v === 'string' ? '+372' + v : v);
        else o[k] = v;
      }
    }
  };
  walk(out, true);
  // contact must survive or the event is skipped as contact-less
  if (out.contact) { out.contact.phone ||= PERSON.phone; out.contact.email ||= PERSON.email; }
  if (out.phone === undefined || out.phone === '' || out.phone === null) { if ('phone' in out) out.phone = PERSON.phone; }
  if ('email' in out && !out.email) out.email = PERSON.email;
  return out;
}
function withName(p, name) {
  const out = JSON.parse(JSON.stringify(p));
  if (out.name !== undefined) out.name = name;
  if (out.contact) out.contact.name = name;
  out.utm = { ...(out.utm || {}), utm_campaign: name, utm_content: name };
  return out;
}

const SLACK_EVENTS = Object.keys(EVENT_PAYLOADS).filter((t) => !['book_now_clicked', 'bridge_19_book_clicked', 'eligible_gate_bridge_clicked', 'quiz_completed'].includes(t));

describe('validator self-test', () => {
  test('rejects obviously bad payloads', () => {
    assert.ok(validateSlackPayload({ blocks: [{ type: 'section', fields: Array(11).fill({ type: 'mrkdwn', text: 'a' }) }] }).length);
    assert.ok(validateSlackPayload({ blocks: [{ type: 'header', text: { type: 'plain_text', text: 'x'.repeat(151) } }] }).length);
    assert.ok(validateSlackPayload({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }] }).length);
    assert.ok(validateSlackPayload({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '' } }] }).length);
    assert.ok(validateSlackPayload({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x\uD83D' } }] }).length);
    assert.deepEqual(validateSlackPayload({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'ok 😀' } }] }), []);
  });
});

describe('normal payloads', () => {
  for (const type of SLACK_EVENTS) {
    test(`${type}: every Slack POST is valid`, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      await w.post(EVENT_PAYLOADS[type](), type.startsWith('lp_') ? { headers: LP_HEADERS } : {});
      assert.ok(w.net.slackAll().length > 0, 'expected a Slack post');
      for (const c of w.net.slackAll()) assert.deepEqual(validateSlackPayload(c.json), [], type);
    });
  }
});

const LEAD_EVENTS = SLACK_EVENTS.filter((t) => !t.startsWith('lp_'));
const LP_EVENTS = SLACK_EVENTS.filter((t) => t.startsWith('lp_'));

async function worstCase(type, label, mutate, t) {
  const w = await makeWorld('track');
  t.after(() => w.done());
  const opts = type.startsWith('lp_') ? { headers: LP_HEADERS } : {};
  let res;
  try { res = await w.post(mutate(EVENT_PAYLOADS[type]()), opts); }
  catch (e) { assert.fail(`handler threw: ${e.message}`); }
  assert.equal(res.statusCode < 500, true, `HTTP ${res.statusCode}`);
  for (const c of w.net.slackAll()) {
    assert.deepEqual(validateSlackPayload(c.json), [], `${type} / ${label}`);
  }
}

describe('worst-case payloads (lead events, sanitizeBlocks applies)', () => {
  for (const [label, mutate] of Object.entries(HOSTILE)) {
    describe(label, () => {
      for (const type of LEAD_EVENTS) {
        test(type, (t) => worstCase(type, label, mutate, t));
      }
    });
  }
});

describe('emoji at the truncation boundary', () => {
  for (const type of LEAD_EVENTS) {
    bug('F-SLACK-SURR', `${type}: slice() at 2000/3000 chars never leaves half an emoji (lone surrogate = invalid Unicode in the Slack request)`, async (t) => {
      const failures = [];
      for (const [label, str] of [['even', EMOJI_EVEN], ['odd', EMOJI_ODD]]) {
        const w = await makeWorld('track');
        try {
          await w.post(deepFill(EVENT_PAYLOADS[type](), str));
          for (const c of w.net.slackAll()) { const e = validateSlackPayload(c.json); if (e.length) failures.push(`${label}: ${e[0]}`); }
        } finally { w.done(); }
      }
      assert.deepEqual(failures, []);
    });
  }
});

describe('worst-case payloads (LP events - these bypass sanitizeBlocks)', () => {
  for (const type of LP_EVENTS) {
    bug('F-SLACK-LP', `${type}: oversized / hostile input still produces a valid Slack payload (LP branches post their blocks without sanitizeBlocks)`, async (t) => {
      const failures = [];
      for (const [label, mutate] of Object.entries(HOSTILE)) {
        const w = await makeWorld('track');
        try {
          const res = await w.post(mutate(EVENT_PAYLOADS[type]()), { headers: LP_HEADERS });
          for (const c of w.net.slackAll()) {
            const errs = validateSlackPayload(c.json);
            if (errs.length) failures.push(`${label}: ${errs[0]}`);
          }
        } finally { w.done(); }
      }
      assert.deepEqual(failures, []);
    });
  }
});

describe('field overflow', () => {
  test('lead field overflow: name+phone+email+Funnel -> the sanitizer silently cuts the 11th field (Funnel / discount code)', async (t) => {
    // Informational guard of CURRENT behaviour: leadFields().slice(0,10) drops the meta field.
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('qualified_flow3_phone_lead', { name: PERSON.name, phone: PERSON.phone, email: PERSON.email, ab_variant: 'B' }));
    const fields = w.net.slackLeads()[0].json.blocks.find((b) => b.fields).fields.map((f) => f.text).join('\n');
    assert.ok(!/Funnel/.test(fields), 'if this starts failing the meta field is no longer dropped - great, flip the assertion');
  });

  bug('F-SLACK-FIELDS', 'qualified_flow3_phone_lead with name+phone+email keeps the Funnel/variant field instead of silently cutting it (leadFields slice(0,10))', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('qualified_flow3_phone_lead', { name: PERSON.name, phone: PERSON.phone, email: PERSON.email, ab_variant: 'B' }));
    const text = JSON.stringify(w.net.slackLeads()[0].json);
    assert.ok(/Funnel/.test(text));
  });
});
