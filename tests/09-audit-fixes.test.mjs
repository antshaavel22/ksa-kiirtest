// Regression guards for the fixes made after the 2026-11-10 audit. Everything is offline.
// Quiz behaviour runs the real inline script of all three pages in a sandbox; server
// behaviour runs the real handlers against a mocked network.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './helpers/quiz.mjs';
import { makeWorld, payload, PERSON } from './helpers/harness.mjs';
import { installFakeSupabase } from './helpers/mock-fetch.mjs';

const QUIZ = ['index.html', 'en.html', 'ru.html'];
const FLOW3 = { age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', forWhom: 'Endale' };
const track = (q) => q.clientCalls.filter((c) => c.url === '/api/track');
const down = async () => { throw new TypeError('network'); };
const status = (code) => async () => ({ ok: code < 400, status: code, json: async () => ({}), text: async () => '' });

for (const file of QUIZ) {
  describe(`${file}: a lead is never lost on the way to the server`, () => {
    test('network down: retried once, then kept on the device; the visitor still gets the result', async () => {
      const q = loadQuiz(file);
      q.ctx.fetch = async (url, init) => { q.clientCalls.push({ url, init, json: JSON.parse(init.body) }); throw new TypeError('network'); };
      q.setAnswers(FLOW3);
      await q.submitGate({});
      assert.equal(track(q).length, 2, 'one try plus one retry');
      const kept = JSON.parse(q.run("localStorage.getItem('ksa_kiirtest_pending')"));
      assert.equal(kept.length, 1);
      assert.equal(JSON.parse(kept[0]).type, 'email_captured');
      assert.equal(q.getEl('resultReveal').style.display, 'block', 'the result is still shown');
      assert.equal(q.getEl('emailGate').style.display, 'none');
    });

    test('server error then success: delivered on the retry, nothing kept', async () => {
      const q = loadQuiz(file);
      let n = 0;
      q.ctx.fetch = async (url, init) => { q.clientCalls.push({ url, init, json: JSON.parse(init.body) }); return ++n === 1 ? status(503)() : status(200)(); };
      q.setAnswers(FLOW3);
      await q.submitGate({});
      assert.equal(track(q).length, 2);
      assert.equal(q.run("localStorage.getItem('ksa_kiirtest_pending')"), null);
    });

    test('a 4xx is not retried and not kept (retrying cannot help)', async () => {
      const q = loadQuiz(file);
      q.ctx.fetch = async (url, init) => { q.clientCalls.push({ url, init, json: JSON.parse(init.body) }); return status(400)(); };
      q.setAnswers(FLOW3);
      await q.submitGate({});
      assert.equal(track(q).length, 1);
      assert.equal(q.run("localStorage.getItem('ksa_kiirtest_pending')"), null);
    });

    test('a lead kept on the device is sent on the next visit and then cleared', async () => {
      const first = loadQuiz(file);
      first.ctx.fetch = down;
      first.setAnswers(FLOW3);
      await first.submitGate({});
      const kept = first.run("localStorage.getItem('ksa_kiirtest_pending')");
      const next = loadQuiz(file);
      next.run(`localStorage.setItem('ksa_kiirtest_pending', ${JSON.stringify(kept)})`);
      await next.run('flushPending()');
      assert.equal(track(next).length, 1);
      assert.equal(track(next)[0].json.type, 'email_captured');
      assert.equal(next.run("localStorage.getItem('ksa_kiirtest_pending')"), null);
    });

    test('the quiz no longer writes visitors into the prize draw', async () => {
      const q = loadQuiz(file);
      q.setAnswers(FLOW3);
      await q.submitGate({ consent: true });
      assert.equal(q.clientCalls.find((c) => c.url === '/api/draw-entry'), undefined);
      assert.ok(!/draw-entry|DRAW_MONTH/.test(q.src));
    });
  });

  describe(`${file}: callback form tells the truth`, () => {
    test('rejected request: the error with the phone number shows, no "thank you", the button works again', async () => {
      const q = loadQuiz(file);
      q.ctx.fetch = status(503);
      q.setAnswers(FLOW3);
      await q.submitCallback({});
      assert.match(q.getEl('cbError').textContent, /\+372 644 5060/);
      assert.notEqual(q.getEl('cbDone').style.display, 'block');
      assert.equal(q.getEl('cbBtn').disabled, false);
    });

    test('accepted request: the "thank you" shows', async () => {
      const q = loadQuiz(file);
      q.setAnswers(FLOW3);
      await q.submitCallback({});
      assert.equal(q.getEl('cbDone').style.display, 'block');
    });
  });

  describe(`${file}: restart, wording and attribution`, () => {
    test('"start again" gives the gate button back (it used to stay disabled with no label)', () => {
      const q = loadQuiz(file);
      const gb = q.getEl('gateBtn');
      gb.disabled = true; gb.classList.add('loading');
      try { q.run('restartQuiz()'); } catch { /* the page transition needs a real DOM; the reset runs first */ }
      assert.equal(gb.disabled, false);
      assert.equal(gb.classes.has('loading'), false);
    });

    test('questions are worded for the child / the friend, and go back for "myself"; routing is untouched', () => {
      const q = loadQuiz(file);
      const heads = Array.from({ length: 11 }, (_, i) => ({ textContent: `orig${i}`, dataset: {} }));
      q.ctx.document.querySelectorAll = (sel) => (sel === '.step-question' ? heads : []);
      q.run("applyWhoLabels('Oma lapsele')");
      for (const i of [1, 2, 3, 5, 6, 7, 9]) assert.notEqual(heads[i].textContent, `orig${i}`, `question ${i} reworded`);
      for (const i of [0, 4, 8, 10]) assert.equal(heads[i].textContent, `orig${i}`, `question ${i} left alone`);
      q.run("applyWhoLabels('Sõbrale või lähedasele')");
      assert.notEqual(heads[2].textContent, 'orig2');
      q.run("applyWhoLabels('Endale')");
      heads.forEach((h, i) => assert.equal(h.textContent, `orig${i}`));
      q.run("applyWhoLabels('Oma lapsele')");
      assert.ok(!/ё/i.test(heads.map((h) => h.textContent).join(' ')), 'no letter yo');
    });

    test('?source=blog&funnel=flow3 from our own links becomes utm_source / utm_medium', () => {
      const q = loadQuiz(file, { search: '?source=blog&funnel=flow3' });
      q.run('attrCapture()');
      const a = JSON.parse(q.run("sessionStorage.getItem('ksa_attribution')"));
      assert.equal(a.utm_source, 'blog');
      assert.equal(a.utm_medium, 'flow3');
    });

    test('real utm tags win over ?source=', () => {
      const q = loadQuiz(file, { search: '?source=blog&utm_source=facebook&utm_medium=paid_social' });
      q.run('attrCapture()');
      const a = JSON.parse(q.run("sessionStorage.getItem('ksa_attribution')"));
      assert.equal(a.utm_source, 'facebook');
      assert.equal(a.utm_medium, 'paid_social');
    });
  });
}

describe('/api/track: input handling', () => {
  test('a promo code from the browser that is not a code never reaches the email or Slack', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'promo.case@gmail.com', promoCode: '<img src=x onerror=alert(1)>', code: 'x' }));
    const html = w.net.resendCustomer()[0].json.html;
    assert.ok(!html.includes('onerror'), 'no injected markup in the customer mail');
    assert.ok(html.includes('KIIRTEST39'), 'falls back to the daily code');
    assert.ok(!JSON.stringify(w.net.slackLeads().map((c) => c.json)).includes('onerror'));
  });

  test('a real code in another shape is kept (BLOG139, KIIRTEST39, FLOW-L)', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'real.code@gmail.com', promoCode: 'BLOG139', code: 'BLOG139', result: 'audit', route: 'audit' }));
    assert.ok(w.net.resendCustomer()[0].json.html.includes('BLOG139'));
  });

  test('Slack and HTML special characters from the visitor are escaped (<!channel>, <@user>, tags)', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const evil = '<!channel> <@U123> <https://evil.test|click> <b>x</b>';
    await w.post(payload('email_captured', { email: 'escape.me@gmail.com', answers: { ...payload('email_captured').answers, vision: evil, interest: evil } }));
    const slack = JSON.stringify(w.net.slackLeads().map((c) => c.json));
    assert.ok(!slack.includes('<!channel>') && !slack.includes('<@U123>') && !slack.includes('<https://evil'), 'Slack text is neutral');
    assert.ok(slack.includes('&lt;!channel&gt;'));
    for (const m of w.net.resend()) assert.ok(!m.json.html.includes('<b>x</b>'), 'mail HTML is neutral');
  });

  test('a phone number cannot carry markup into the <tel:> link', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    await w.post(payload('callback_requested', { contact: { name: 'Mari', phone: '+372555"><script>x</script>', email: 'phone.test@gmail.com' } }));
    const all = JSON.stringify(w.net.calls.map((c) => c.json));
    assert.ok(!all.includes('<script'), 'no script tag anywhere');
  });

  test('an address that is not an address is skipped: no stranger mail, no empty ticket', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const r = await w.post(payload('email_captured', { email: 'not an email' }));
    assert.equal(r.statusCode, 200);
    assert.equal(w.net.resendCustomer().length, 0);
  });

  test('the same address twice within minutes: one result mail, but both leads still reach Slack and the CRM', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const e = 'repeat.address@gmail.com';
    await w.post(payload('email_captured', { email: e }));
    const slackPerLead = w.net.slackLeads().length;
    assert.ok(slackPerLead >= 1);
    await w.post(payload('email_captured', { email: e, result: 'audit', route: 'audit' }));
    assert.equal(w.net.resendCustomer().length, 1, 'the repeat does not mail the address again');
    assert.equal(w.net.slackLeads().length, 2 * slackPerLead, 'the repeat lead still reaches Slack');
    assert.equal(w.net.crm().length, 2, 'and the CRM');
  });

  test('a script burst from one address is throttled (429) while other visitors are not', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const bot = { 'x-forwarded-for': '203.0.113.50' };
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await w.post(payload('book_now_clicked', { email: `b${i}@gmail.com` }), { headers: bot })).statusCode);
    assert.ok(codes.slice(0, 30).every((c) => c === 200), 'first 30 pass');
    assert.ok(codes.slice(30).every((c) => c === 429), 'the rest are throttled');
    assert.equal((await w.post(payload('book_now_clicked'), { headers: { 'x-forwarded-for': '203.0.113.51' } })).statusCode, 200);
  });

  test('an identical lead re-sent within minutes (the page retries) is one Slack card and one CRM ticket', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const p = payload('email_captured', { email: 'dup.lead@gmail.com', client_session_id: 'kt_dup1' });
    await w.post(p);
    const r = await w.post(p);
    assert.equal(r.body.skipped, 'duplicate_recent');
    assert.equal(w.net.crm().length, 1);
  });

  test('one parent testing two children with the same address: same session, result and route, different answers = two real leads, never merged', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    const base = payload('email_captured', { email: 'two.kids@gmail.com', client_session_id: 'kt_family', result: 'kids', route: 'kids', promoCode: 'BLOGKIDS', code: 'BLOGKIDS' });
    await w.post({ ...base, answers: { ...base.answers, age: 'Alla 18', gender: 'Naine' } });
    await w.post({ ...base, answers: { ...base.answers, age: 'Alla 18', gender: 'Mees' } });
    assert.equal(w.net.crm().length, 2, 'both children reach the CRM');
  });

  test('with no client address the limiter stays out of the way (real visitors are never throttled together)', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    for (let i = 0; i < 80; i++) assert.equal((await w.post(payload('book_now_clicked'))).statusCode, 200);
  });

  test('our own links show up with a readable source in Slack (Blogi / newsletter / loos)', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'src.blog@gmail.com', utm: { utm_source: 'blog', utm_medium: 'flow3' } }));
    assert.match(JSON.stringify(w.net.slackLeads().map((c) => c.json)), /Blogi/);
  });

  test('the CRM ticket carries the real source (the quiz sends utm_source; it used to read utm.source and say "direct")', async (t) => {
    const w = await makeWorld('track'); t.after(() => w.done());
    await w.post(payload('email_captured', { email: 'crm.source@gmail.com' }));
    const ticket = w.net.crm()[0].json;
    assert.equal(ticket.utm.source, 'google');
    assert.equal(ticket.utm.medium, 'cpc');
    assert.equal(ticket.utm.campaign, 'flow3-search');
    assert.notEqual(ticket.quiz_meta.ad_source, 'direct');
    assert.equal(ticket.click_ids.gclid, 'GCLID123');
  });
});

describe('other endpoints', () => {
  test('/api/intake-flow3: a test-marked address creates no CRM ticket', async (t) => {
    const w = await makeWorld('intake-flow3'); t.after(() => w.done());
    const r = await w.post({ source: 'kiirtest', lang: 'et', contact: { name: 'Mari', phone: '+37255512345', email: 'smoke-test@ksa.ee' }, qualifying: { age_band: '18_45', vision_issue: 'myopia' }, group_hint: 'flow3_eligible_myope' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.skipped, 'test_or_diagnostic_event');
    assert.equal(w.net.crm().length, 0);
  });

  test('/api/draw-entry: a test-marked address writes no row, and a JSON "null" body does not crash it', async (t) => {
    const w = await makeWorld('draw-entry', { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'sb' }); t.after(() => w.done());
    installFakeSupabase(w.net);
    const r = await w.post({ email: 'smoke-test@ksa.ee', month: '2026-11', language: 'et' });
    assert.equal(r.body.skipped, 'test_or_diagnostic_event');
    assert.equal(w.net.calls.filter((c) => c.kind === 'supabase').length, 0);
    const r2 = await w.post('null');
    assert.equal(r2.statusCode, 200);
  });

  test('/api/analytics-report: with CRON_SECRET set, only the cron (or someone holding the secret) can run it', async (t) => {
    const w = await makeWorld('analytics-report', { CRON_SECRET: 's3cret' }); t.after(() => w.done());
    const anon = await w.post({}, { method: 'GET', headers: {} });
    assert.equal(anon.statusCode, 401);
    assert.equal(w.net.slackAll().length, 0, 'an anonymous call posted nothing to Slack');
    const wrong = await w.post({}, { method: 'GET', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.statusCode, 401);
    const ok = await w.post({}, { method: 'GET', headers: { authorization: 'Bearer s3cret' } });
    assert.equal(ok.statusCode, 200);
    assert.ok(w.net.slackAll().length >= 1);
  });

  test('/api/analytics-report: follows the Resend cursor past the first 100 emails', async (t) => {
    const w = await makeWorld('analytics-report'); t.after(() => w.done());
    const mk = (i) => ({ id: `em_${i}`, to: ['registreerumised@ksa.ee'], subject: `Kiirtest — ✅ Sobiv [Otse] — p${i}@x.ee`, created_at: new Date().toISOString() });
    let page = 0;
    w.net.on((c) => c.kind === 'resend-list', () => {
      page++;
      const data = Array.from({ length: 100 }, (_, i) => mk(page * 1000 + i));
      return w.net.json(200, { data, has_more: page < 3 });
    });
    await w.post({}, { method: 'GET' });
    assert.equal(page, 3, 'three pages were read');
  });
});
