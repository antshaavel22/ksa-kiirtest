// Static + behavioural checks of the patient-facing pages (index/en/ru quiz, 19, lilia-qr,
// taname*) and of the links/e-mails built from them. The quiz script is executed in node:vm.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  loadQuiz, QUIZ_FILES, readPage, inlineScripts, jsonLdBlocks, visibleText, decodeEntities, quizScript,
} from './helpers/quiz.mjs';
import { ROOT, apiSource } from './helpers/load-api.mjs';
import { bug, makeWorld, payload, PERSON } from './helpers/harness.mjs';

const LANGS = Object.keys(QUIZ_FILES);
const QUIZ = Object.values(QUIZ_FILES);
const PATIENT_PAGES = [...QUIZ, '19.html', 'taname.html', 'taname-en.html', 'taname-ru.html'];
const ALL_PAGES = [...PATIENT_PAGES, 'lilia-qr.html'];
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// ── structure ────────────────────────────────────────────────────────────────────────
describe('page structure', () => {
  for (const f of ALL_PAGES) {
    test(`${f}: every inline <script> parses`, () => {
      const html = readPage(f);
      const scripts = inlineScripts(html);
      assert.ok(scripts.length >= 1);
      scripts.forEach((s, i) => assert.doesNotThrow(() => new vm.Script(s, { filename: `${f}#${i}` }), `${f} script #${i}`));
    });
    test(`${f}: JSON-LD blocks (if any) parse`, () => {
      for (const b of jsonLdBlocks(readPage(f))) assert.doesNotThrow(() => JSON.parse(b));
    });
  }

  test('<html lang> matches the file language', () => {
    assert.match(readPage('index.html'), /<html lang="et">/);
    assert.match(readPage('en.html'), /<html lang="en">/);
    assert.match(readPage('ru.html'), /<html lang="ru">/);
  });

  for (const f of QUIZ) {
    bug('F-SEO-1', `${f}: has <link rel="canonical"> and hreflang alternates (same quiz reachable as /, /index.html, /en, /en.html, /flow3/quicktest ...)`, () => {
      const html = readPage(f);
      assert.match(html, /<link[^>]+rel="canonical"/);
      assert.match(html, /<link[^>]+hreflang=/);
    });
  }

  test('the three quiz files offer the same answers (data-value sets) per step', () => {
    const steps = (html) => {
      const out = {};
      for (const m of html.matchAll(/<div class="quiz-step[^"]*" id="step-([\w]+)"[\s\S]*?(?=<div class="quiz-step|<!-- ── Result)/g)) {
        out[m[1]] = [...m[0].matchAll(/data-value="([^"]+)"/g)].map((x) => x[1]).sort();
      }
      return out;
    };
    const et = steps(readPage('index.html'));
    assert.ok(Object.keys(et).length >= 9, 'steps not found');
    assert.deepEqual(steps(readPage('en.html')), et);
    assert.deepEqual(steps(readPage('ru.html')), et);
  });

  test('RESULTS has the same keys, flags and bullet counts in all languages', () => {
    const shape = (l) => {
      const r = loadQuiz(QUIZ_FILES[l]).results();
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { keys: Object.keys(v).sort(), good: v.good, points: v.points?.length ?? 0 }]));
    };
    assert.deepEqual(Object.keys(shape('ET')).sort(), ['audit', 'flow3', 'kids']);
    assert.deepEqual(shape('EN'), shape('ET'));
    assert.deepEqual(shape('RU'), shape('ET'));
  });

  test('only the flow3 result talks about Flow3 candidacy; audit/kids results do not promise Flow3', () => {
    for (const l of LANGS) {
      const r = loadQuiz(QUIZ_FILES[l]).results();
      assert.equal(r.flow3.good, true);
      for (const k of ['audit', 'kids']) {
        assert.equal(r[k].good, false);
        assert.ok(!/flow ?3/i.test(JSON.stringify(r[k])), `${l}/${k} mentions Flow3`);
      }
    }
  });
});

// ── codes, prices, tier names ────────────────────────────────────────────────────────
describe('codes and prices', () => {
  const EXPECT = {
    flow3: { slug: 'flow', code: 'KIIRTEST39', price: '39 €', old: '149 €' },
    audit: { slug: 'audit', code: 'BLOG139', price: '139 €', old: '149 €' },
    kids: { slug: 'kids', code: 'BLOGKIDS', price: '79 €' },
  };
  for (const l of LANGS) {
    test(`${l} quiz BOOKING object is exactly the agreed codes/prices`, () => {
      assert.deepEqual(loadQuiz(QUIZ_FILES[l]).booking(), EXPECT);
    });
  }

  test('no retired code / tier name / host on any patient-facing page (HTML entities decoded)', () => {
    const RETIRED = [/FLOW19/, /\bBLOG39\b/, /\bFLOW-[PETKNRL]\b/, /Flow 1\b/, /Flow3 Vibe/i, /my\.ksa\.ee/];
    const hits = [];
    for (const f of ALL_PAGES) {
      let text = decodeEntities(readPage(f));
      if (f === '19.html') text = text.split('\n').filter((l) => !/FLOW19/.test(l) || /Old links|=== 'FLOW19'/.test(l) === false).join('\n');
      if (f === 'lilia-qr.html') text = text.split('\n').filter((l) => !/FLOW19 retired/.test(l)).join('\n');
      for (const re of RETIRED) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    assert.deepEqual(hits, []);
  });

  test('FLOW19 survives only as an INCOMING ?code= mapping to the day code on 19.html', () => {
    const src = readPage('19.html');
    assert.match(src, /if \(code === 'FLOW19'\) code = getTodayCode\(\);/);
  });

  bug('F-PRICE-19', 'no stale "19 €" price on any patient-facing page (taname.html / taname-ru.html still print "Veebis 19€ · Kliinikus 39€")', () => {
    const hits = [];
    for (const f of PATIENT_PAGES) {
      const t = visibleText(readPage(f));
      for (const m of t.matchAll(/(?<![\d.,])19\s?€|€\s?19(?![\d])/g)) hits.push(`${f}: "${t.slice(Math.max(0, m.index - 25), m.index + 12).replace(/\s+/g, ' ')}"`);
    }
    assert.deepEqual(hits, []);
  });

  bug('F-PRICE-19-META', '19.html reports value 19 EUR to Meta (InitiateCheckout / Lead) - the exam now costs 39 EUR', () => {
    assert.ok(!/value:\s*19\b/.test(readPage('19.html')));
  });

  test('every booking host in HTML and e-mail templates is booking.ksa.ee', () => {
    for (const f of [...ALL_PAGES, 'api/track.js']) {
      const src = f.startsWith('api') ? apiSource('track') : readPage(f);
      for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]*ksa\.ee)\/[^\s'"`<>)]*(?:promokood|service=)/gi)) {
        assert.equal(m[1], 'booking.ksa.ee', `${f}: ${m[0]}`);
      }
    }
  });

  bug('F-DUR', 'the exam length is the same on every surface (quiz/e-mail 60 min, 19.html 75 min, taname 45 min, dormant e-mail block 75 min)', () => {
    const found = {};
    for (const f of [...PATIENT_PAGES, 'api/track.js']) {
      const src = f.startsWith('api') ? apiSource('track') : readPage(f);
      for (const m of src.matchAll(/\b(45|60|75)[ -]?(min|minut|мин)/gi)) (found[f] ||= new Set()).add(m[1]);
    }
    const all = new Set(Object.values(found).flatMap((s) => [...s]));
    assert.equal(all.size, 1, JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v]]))));
  });
});

// ── booking links built by the quiz ──────────────────────────────────────────────────
describe('booking URL builder (executed quiz code)', () => {
  const ROUTES = { flow3: { service: 'flow', code: 'KIIRTEST39' }, audit: { service: 'audit', code: 'BLOG139' }, kids: { service: 'kids', code: 'BLOGKIDS' } };
  const SEARCH = '?gclid=G123&gbraid=GB1&wbraid=WB1&fbclid=F1&utm_source=google&utm_medium=cpc&utm_campaign=flow3&utm_content=ad1&utm_term=kw';

  for (const l of LANGS) {
    for (const [route, exp] of Object.entries(ROUTES)) {
      test(`${l}/${route}: all required parameters, click ids and utm_* carried`, () => {
        const q = loadQuiz(QUIZ_FILES[l], { search: SEARCH });
        const u = new URL(q.bookingUrl(route));
        assert.equal(u.origin, 'https://booking.ksa.ee');
        const p = Object.fromEntries(u.searchParams);
        assert.equal(p.service, exp.service);
        assert.equal(p.lang, l.toLowerCase());
        assert.equal(p.promokood, exp.code);
        assert.equal(p.source, 'kiirtest');
        assert.equal(p.funnel, route);
        assert.match(p.kiirtest_lead_id, /^kt_[a-z0-9]+$/);
        for (const [k, v] of Object.entries({ gclid: 'G123', gbraid: 'GB1', wbraid: 'WB1', fbclid: 'F1', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'flow3', utm_content: 'ad1', utm_term: 'kw' })) assert.equal(p[k], v, k);
      });
    }
    test(`${l}: no click-id / utm parameters invented when the landing URL had none`, () => {
      const p = Object.fromEntries(new URL(loadQuiz(QUIZ_FILES[l]).bookingUrl('flow3')).searchParams);
      for (const k of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'utm_source']) assert.equal(p[k], undefined, k);
    });
    test(`${l}: lead id is generated once per visit and reused by link, book-click beacon and gate payload`, async () => {
      const q = loadQuiz(QUIZ_FILES[l]);
      const id1 = new URL(q.bookingUrl('flow3')).searchParams.get('kiirtest_lead_id');
      const id2 = new URL(q.bookingUrl('audit')).searchParams.get('kiirtest_lead_id');
      q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescription: '−3 kuni −6', prescCode: 'minus_2', route: 'flow3', resultType: 'good_candidate' });
      q.run('ksaBookClick()');
      const beacon = await q.beaconJson();
      await q.submitGate({});
      const gate = q.clientCalls.find((c) => c.url === '/api/track').json;
      assert.equal(id1, id2);
      assert.equal(beacon.client_session_id, id1);
      assert.equal(gate.client_session_id, id1);
    });
  }

  test('referrer-only visit (no utm) is forwarded to the server as utm.referrer', async () => {
    const q = loadQuiz('index.html', { referrer: 'https://ksa.ee/blogi/silmad?x=1' });
    await q.submitGate({});
    assert.equal(q.clientCalls.find((c) => c.url === '/api/track').json.utm.referrer, 'https://ksa.ee/blogi/silmad');
  });

  bug('F-ATTR-SOURCE', 'source= / funnel= / slug= / ab_variant= query parameters from blog and newsletter links are captured and forwarded (ATTR_KEYS only lists gclid/gbraid/wbraid/fbclid/utm_*)', async () => {
    const q = loadQuiz('index.html', { search: '?source=blog&funnel=blog39&slug=laser-vs-lenses&ab_variant=B' });
    await q.submitGate({});
    const sent = JSON.stringify(q.clientCalls.find((c) => c.url === '/api/track').json.utm);
    for (const v of ['blog', 'blog39', 'laser-vs-lenses']) assert.ok(sent.includes(v), `${v} lost: ${sent}`);
  });

  for (const l of LANGS) {
    bug('F-ATTR-CRM', `${l}: the REAL quiz payload (utm_source/utm_medium keys) reaches the CRM with utm.source and ad_source filled - Slack shows "Google Ads" but buildCRMPayload reads utm.source and files everything as "direct"`, async (t) => {
      const q = loadQuiz(QUIZ_FILES[l], { search: '?utm_source=google&utm_medium=cpc&utm_campaign=flow3&gclid=G1' });
      q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', prescription: '−3 kuni −6', forWhom: 'Endale' });
      await q.submitGate({});
      const body = q.clientCalls.find((c) => c.url === '/api/track').json;
      const w = await makeWorld('track');
      t.after(() => w.done());
      await w.post(body);
      assert.match(JSON.stringify(w.net.slackLeads()[0].json), /Google Ads/, 'Slack label is right (guard)');
      const crm = w.net.crm()[0].json;
      assert.equal(crm.click_ids.gclid, 'G1', 'click ids are right (guard)');
      assert.equal(crm.utm.source, 'google');
      assert.equal(crm.quiz_meta.ad_source, 'paid');
    });
  }

  bug('F-ATTR-STORAGE', 'attribution and lead id survive when sessionStorage is blocked (Safari private mode, in-app browsers): today attrCapture swallows the error and the lead id changes on every call', () => {
    const q = loadQuiz('index.html', { search: '?gclid=G1', sessionBlocked: true });
    const a = new URL(q.bookingUrl('flow3')).searchParams;
    const b = new URL(q.bookingUrl('flow3')).searchParams;
    assert.equal(a.get('gclid'), 'G1');
    assert.equal(a.get('kiirtest_lead_id'), b.get('kiirtest_lead_id'));
  });

  bug('F-LANG-LINKS', 'language switch links keep the query string (gclid, utm_*, source=) instead of dropping it', () => {
    for (const f of QUIZ) {
      const q = loadQuiz(f, { search: '?gclid=abc&utm_source=google' });
      const anchors = ['/', '/ru', '/en'].map((h) => ({ href: '', getAttribute: () => h }));
      q.ctx.document.querySelectorAll = (sel) => (sel === '.lang-switch a' ? anchors : []);
      q.run('keepQueryOnLangLinks()');
      assert.deepEqual(anchors.map((a) => a.href), ['/?gclid=abc&utm_source=google', '/ru?gclid=abc&utm_source=google', '/en?gclid=abc&utm_source=google'], f);
    }
  });

  test('language switch targets are served paths (/, /ru, /en resolve to the quiz files)', () => {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const served = (href) => href === '/' ? 'index.html'
      : (v.rewrites.find((r) => r.source === href) || {}).destination?.replace(/^\//, '');
    for (const f of QUIZ) {
      const nav = readPage(f).match(/<nav class="lang-switch"[\s\S]*?<\/nav>/)[0];
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(hrefs, ['/', '/ru', '/en'], `${f}: switch links`);
      for (const h of hrefs) assert.ok(fs.existsSync(path.join(ROOT, served(h) || 'MISSING')), `${f}: ${h} is not served`);
    }
  });
});

// ── e-mails sent by track.js ─────────────────────────────────────────────────────────
describe('customer e-mail booking links', () => {
  const ROUTES = [['good_candidate', 'KIIRTEST39', 'flow'], ['audit', 'BLOG139', 'audit'], ['kids', 'BLOGKIDS', 'kids']];
  for (const lang of ['ET', 'EN', 'RU']) {
    for (const [result, code, service] of ROUTES) {
      test(`${lang}/${result}: CTA goes to booking.ksa.ee with service, lang and promokood`, async (t) => {
        const w = await makeWorld('track');
        t.after(() => w.done());
        await w.post(payload('email_captured', { email: PERSON.email, language: lang, lp_source: `LP-Kiirtest-${lang}`, result, promoCode: code, code }));
        const html = w.net.resendCustomer()[0].json.html;
        const href = [...html.matchAll(/href="(https:\/\/booking\.ksa\.ee\/[^"]*)"/g)].map((m) => m[1]).pop();
        const p = Object.fromEntries(new URL(href).searchParams);
        assert.equal(p.service, service);
        assert.equal(p.lang, lang.toLowerCase());
        assert.equal(p.promokood, code);
      });
    }
  }

  bug('F-MAIL-ATTR', 'e-mail CTA links carry the same attribution as the on-page link (source=kiirtest, funnel, kiirtest_lead_id, utm_*, gclid) - otherwise bookings made from the result mail cannot be joined to the lead or uploaded to Google Ads', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('email_captured', { email: PERSON.email, utm: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G123' } }));
    const html = w.net.resendCustomer()[0].json.html;
    const href = [...html.matchAll(/href="(https:\/\/booking\.ksa\.ee\/[^"]*)"/g)].map((m) => m[1]).pop();
    const p = Object.fromEntries(new URL(href).searchParams);
    for (const k of ['source', 'funnel', 'kiirtest_lead_id', 'utm_source', 'gclid']) assert.ok(p[k], `missing ${k} in ${href}`);
  });

  bug('F-MAIL-GUIDE-LINK', 'installment guide mail links to booking.ksa.ee WITH service=flow (today: lang+promokood only, so the booking page may open on a default service)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    await w.post(payload('installment_lead', { contact: { ...PERSON } }));
    assert.match(w.net.resendCustomer()[0].json.html, /booking\.ksa\.ee\/\?[^"]*service=/);
  });
});

// ── copy compliance ──────────────────────────────────────────────────────────────────
describe('copy compliance (patient-facing text)', () => {
  const text = (f) => (f === 'api/track.js' ? null : decodeEntities(stripJsComments(readPage(f))));

  test('forbidden words: aus*/honest/честно, Claude, AI - on every patient page', () => {
    const re = /(?<![\p{L}])aus(?:[a-zõäöü]*)(?![\p{L}])|\bhonest\w*|честн\w*|\bClaude\b|\bAI\b|tehisintellekt|искусственн/giu;
    const hits = [];
    for (const f of ALL_PAGES) for (const m of text(f).matchAll(re)) hits.push(`${f}: ${m[0]}`);
    // 19.html:343 "ausalt" is the known offender; everything else must be clean.
    assert.deepEqual(hits.filter((h) => !h.startsWith('19.html: ausalt')), []);
  });

  bug('F-COPY-AUS', '19.html FAQ says "ausalt" (forbidden word aus*)', () => {
    assert.ok(!/ausalt/.test(readPage('19.html')));
  });

  /** Segments of api/track.js. SEQUENCE is the disabled 6-mail drip (kept "to re-enable"). */
  const trackSrc = apiSource('track');
  const seqStart = trackSrc.indexOf('const SEQUENCE = {');
  const seqEnd = trackSrc.indexOf('async function scheduleSequence');
  const dormant = trackSrc.slice(seqStart, seqEnd);
  const live = trackSrc.slice(0, seqStart) + trackSrc.slice(seqEnd);
  const livePatientMail = (() => {
    const a = live.indexOf('function buildInstallmentGuideEmail'); const b = live.indexOf('// ── Detect language');
    return live.slice(a, b);
  })();

  test('segment sanity: dormant SEQUENCE found and scheduleSequence call is commented out', () => {
    assert.ok(dormant.length > 5000);
    assert.match(trackSrc, /\/\/ scheduleSequence\(email, lang, promoCode\)/);
  });

  test('LIVE patient e-mails (result mail, subjects, guide mail): no aus/honest/честно, no Claude/AI', () => {
    const re = /(?<![\p{L}])aus[a-zõäöü]*(?![\p{L}])|\bhonest\w*|честн\w*|\bClaude\b|\bAI\b/giu;
    assert.deepEqual([...livePatientMail.matchAll(re)].map((m) => m[0]), []);
  });

  bug('F-COPY-DORMANT', 'the dormant 6-mail SEQUENCE (re-enabled by uncommenting one line) contains forbidden words (ausad/ausalt, honest/honestly, честные/честно)', () => {
    const re = /(?<![\p{L}])aus[a-zõäöü]*(?![\p{L}])|\bhonest\w*|честн\w*/giu;
    assert.deepEqual([...dormant.matchAll(re)].map((m) => m[0]), []);
  });

  test('Russian: Таллинн with two н everywhere; never "Таллин" / "Таллина"', () => {
    for (const f of ['ru.html', 'taname-ru.html']) assert.ok(!/Таллин(?!н)/u.test(readPage(f)), f);
    assert.ok(!/Таллин(?!н)/u.test(trackSrc));
    assert.match(readPage('ru.html'), /Таллинн/);
  });

  bug('F-COPY-YO', 'Russian surfaces contain no letter ё (ru.html is clean; taname-ru.html and the live RU result mail use it)', () => {
    const hits = [];
    if (/ё/i.test(readPage('ru.html'))) hits.push('ru.html');
    if (/ё/i.test(readPage('taname-ru.html'))) hits.push('taname-ru.html');
    const ruBlock = live.slice(live.indexOf("  RU: {\n    greeting"), live.indexOf('// ── Promo code block'));
    if (/ё/i.test(ruBlock)) hits.push('api/track.js EMAIL.RU (live)');
    assert.deepEqual(hits, []);
  });

  bug('F-COPY-EN-SUPERL', 'English quiz copy has no superlatives (en.html: "suits you best" in meta description and Audit title)', () => {
    const t = visibleText(readPage('en.html')) + (readPage('en.html').match(/<meta name="description" content="([^"]+)"/)?.[1] || '') + JSON.stringify(loadQuiz('en.html').results());
    assert.deepEqual([...t.matchAll(/\b(best|greatest|leading|world[- ]class|ultimate|perfect|safest|most advanced)\b/gi)].map((m) => m[0]), []);
  });

  test('no money-back / refund guarantee wording anywhere', () => {
    const re = /money.?back|refund|raha tagasi|tagasimakse|вернём деньги|возврат денег/i;
    for (const f of [...ALL_PAGES, 'api/track.js']) assert.ok(!re.test(f.startsWith('api') ? trackSrc : readPage(f)), f);
  });

  test('nothing promises that people outside 18-45 myopes qualify for Flow3', () => {
    // "Valige kõik sobivad" / "Select all that apply" are quiz instructions, not promises.
    const re = /(kõik|everyone|everybody|все)\s+(?!sobivad\b)(saavad|qualify|подходят)|sobib kõigile|suitable for everyone|alati sobiv/i;
    for (const f of PATIENT_PAGES) assert.ok(!re.test(visibleText(readPage(f))), f);
  });

  // QUESTIONS FOR THE CLINIC'S LAWYER (Reklaamiseadus §22). Not asserted as illegal - listed so they cannot be
  // forgotten. Each test fails while the wording exists; resolve by lawyer sign-off OR by removing the wording.
  describe('LAWYER-Q: urgency / scarcity / result-promise wording', () => {
    const FAKE_URGENCY = /kehtib täna|kuni südaööni|valid today|until midnight|pakkumine aegub|offer expires|countdown|срок действия|до полуночи|Offer expires/i;
    bug('LAWYER-Q1', 'no "valid today until midnight" claim for a code that is valid every day (19.html, lilia-qr.html)', () => {
      const hits = ['19.html', 'lilia-qr.html'].filter((f) => FAKE_URGENCY.test(visibleText(readPage(f)) + readPage(f)));
      assert.deepEqual(hits, []);
    });
    bug('LAWYER-Q2', 'no countdown timer / "offer expires" banner on taname*.html (24 h timer is stored per browser in localStorage; the code never expires)', () => {
      const hits = ['taname.html', 'taname-en.html', 'taname-ru.html'].filter((f) => /id="countdown"|class="urgency-banner"/.test(readPage(f)));
      assert.deepEqual(hits, []);
    });
    bug('LAWYER-Q3', 'no "TÄNA / TODAY" price badge or "Last chance / Viimane võimalus" CTA on patient pages and mails', () => {
      const hits = [];
      if (/price-badge__label">\s*TÄNA/.test(readPage('19.html'))) hits.push('19.html TÄNA badge');
      if (/Last chance|Viimane võimalus|Последний шанс|tänase eripakkumisega/.test(livePatientMail)) hits.push('track.js live mail');
      assert.deepEqual(hits, []);
    });
    bug('LAWYER-Q4', 'no "book now" pressure in the quiz result ("Broneerige õige uuring kohe", "Book the right exam now")', () => {
      const hits = QUIZ.filter((f) => /uuring kohe —|exam now —|обследование сейчас —|right exam now/i.test(readPage(f)));
      assert.deepEqual(hits, []);
    });
    bug('LAWYER-Q5', 'no outcome / safety claims on pages: "7-year guarantee/warranty", "0 ectasia", "pain-free"', () => {
      const hits = [];
      for (const f of ['index.html', 'en.html', 'ru.html', '19.html']) if (/garantii|warranty|гаранти/i.test(visibleText(readPage(f)))) hits.push(`${f}: guarantee`);
      if (/ektaasiat/.test(readPage('19.html'))) hits.push('19.html: 0 ektaasiat');
      assert.deepEqual(hits, []);
    });
    bug('LAWYER-Q6', 'the quiz privacy line "we do not share your data with third parties" is accurate (data goes to Meta Pixel, Google Ads, Brevo, Slack, Resend)', () => {
      const hits = QUIZ.filter((f) => /kolmandate isikutega|third parties|третьим лицам/i.test(readPage(f)));
      assert.deepEqual(hits, []);
    });
  });
});

// ── tracking, consent, behaviour of the page ─────────────────────────────────────────
describe('tracking and consent', () => {
  test('same GTM / GA4 / Ads / Meta ids in all three languages', () => {
    const ids = (f) => { const h = readPage(f); return JSON.stringify([h.match(/GTM-[A-Z0-9]+/)?.[0], h.match(/G-[A-Z0-9]{8,}/)?.[0], h.match(/AW-\d+\/\w+/)?.[0], h.match(/fbq\('init', '(\d+)'/)?.[1]]); };
    assert.equal(ids('en.html'), ids('index.html'));
    assert.equal(ids('ru.html'), ids('index.html'));
    assert.deepEqual(JSON.parse(ids('index.html')), ['GTM-KCZVRJ8', 'G-7R7T8GF37J', 'AW-18030087653/lXXnCMHKwI8cEOWbtZVD', '116445785392738']);
  });

  for (const l of LANGS) {
    test(`${l}: gate submit fires Ads conversion, Meta Lead and dataLayer form_submission with the right lp_source`, async () => {
      const q = loadQuiz(QUIZ_FILES[l]);
      q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', prescription: 'x', forWhom: 'Endale' });
      await q.submitGate({});
      assert.ok(q.tracking.gtag.some((a) => a[0] === 'event' && a[1] === 'conversion' && a[2].send_to === 'AW-18030087653/lXXnCMHKwI8cEOWbtZVD'));
      assert.ok(q.tracking.fbq.some((a) => a[1] === 'Lead'));
      const dl = q.tracking.dataLayer.find((e) => e.event === 'form_submission');
      assert.equal(dl.lp_source, `LP-Kiirtest-${l}`);
      assert.equal(dl.quiz_route, 'flow3');
    });
    test(`${l}: result screen - booking click fires Meta Schedule path + beacon; callback fires Meta Contact`, async () => {
      const q = loadQuiz(QUIZ_FILES[l]);
      q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', prescription: 'x', forWhom: 'Endale' });
      await q.submitGate({});
      q.run('ksaBookClick()');
      assert.equal(q.beacons.length, 1);
      assert.equal((await q.beaconJson()).type, 'book_now_clicked');
      await q.submitCallback({});
      assert.ok(q.tracking.fbq.some((a) => a[1] === 'Contact'));
      assert.ok(q.clientCalls.some((c) => c.json?.type === 'callback_requested'));
    });
  }

  test('marketing consent: unticked by default, never true for "Alla 18", ticked only when ticked', async () => {
    const q = loadQuiz('index.html');
    q.setAnswers({ age: '26-35' });
    await q.submitGate({ consent: false });
    assert.equal(q.clientCalls.find((c) => c.url === '/api/track').json.consent.marketing_email, false);
    const q2 = loadQuiz('index.html'); q2.setAnswers({ age: '26-35' });
    await q2.submitGate({ consent: true });
    assert.equal(q2.clientCalls.find((c) => c.url === '/api/track').json.consent.marketing_email, true);
    const q3 = loadQuiz('index.html'); q3.setAnswers({ age: 'Alla 18' });
    await q3.submitGate({ consent: true });
    assert.equal(q3.clientCalls.find((c) => c.url === '/api/track').json.consent.marketing_email, false);
    // The quiz no longer writes visitors into the prize draw behind their back.
    assert.equal(q3.clientCalls.find((c) => c.url === '/api/draw-entry'), undefined);
  });

  bug('F-CONSENT-1', 'a consent-management platform (Cookiebot 71ecbe6c-f128-4b9b-aebe-6308d10bc05d) and a Consent Mode v2 default (gtag("consent","default",{...denied})) load BEFORE gtag/fbq in every quiz page (none is present in the repo)', () => {
    for (const f of QUIZ) {
      const h = readPage(f);
      assert.match(h, /71ecbe6c-f128-4b9b-aebe-6308d10bc05d/, `${f}: no Cookiebot`);
      assert.match(h, /gtag\(\s*['"]consent['"]\s*,\s*['"]default['"]/, `${f}: no Consent Mode default`);
    }
  });

  bug('F-DRAW-MONTH', 'the quiz no longer books every visitor into a (hard-coded, long-closed) prize draw', () => {
    for (const f of QUIZ) assert.ok(!/DRAW_MONTH|draw-entry/.test(readPage(f)), `${f}: still writes to the draw`);
  });

  bug('F-DRAW-CONSENT', 'the quiz tells the visitor they are entering a prize draw before draw-entry is called (page copy mentions the draw); today the e-mail gate never mentions it', () => {
    for (const f of QUIZ) assert.match(visibleText(readPage(f)), /loos|draw|розыгрыш|auhind|prize/i, `${f}: draw not disclosed`);
  });

  bug('F-RESTART-BTN', 'after "Alusta uuesti" the e-mail gate button is usable again (today #gateBtn keeps class "loading" and disabled=true from the first submit)', async () => {
    const q = loadQuiz('index.html');
    q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', forWhom: 'Endale' });
    await q.submitGate({});
    q.run('restartQuiz()');
    const btn = q.getEl('gateBtn');
    assert.equal(btn.disabled, false, 'gate button still disabled');
    assert.ok(!btn.classes.has('loading'), 'gate button still shows spinner');
  });

  bug('F-CB-SILENT', 'callback form shows "thank you" only if /api/track really accepted the request (today the success text is shown even when fetch fails or returns 5xx)', async () => {
    const q = loadQuiz('index.html');
    q.ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    q.setAnswers({ age: '26-35', vision: 'Miinusprillid', forWhom: 'Endale' });
    await q.submitCallback({});
    assert.notEqual(q.getEl('cbDone').style.display, 'block', 'visitor told "thanks" although the lead was rejected');
  });

  bug('F-GATE-SILENT', 'if /api/track fails the e-mail gate retries/queues the lead (localStorage / beacon) - today a failed fetch is swallowed and the result is revealed as if nothing happened', async () => {
    const q = loadQuiz('index.html');
    q.ctx.fetch = async () => { throw new TypeError('network'); };
    q.setAnswers({ age: '26-35', vision: 'Miinusprillid', prescCode: 'minus_2', forWhom: 'Endale' });
    await q.submitGate({});
    const stored = q.run("localStorage.getItem('ksa_kiirtest_pending')");
    assert.ok(stored || q.beacons.length > 0, 'lead is only in memory and is gone');
  });
});

describe('repo hygiene', () => {
  bug('F-PUBLIC-MIRROR', 'public/ does not contain stale copies of the quiz (vercel outputDirectory "." serves public/*.html at /public/index.html, and `npm start` / .claude/launch.json preview public/)', () => {
    for (const f of ['index.html', 'en.html', 'ru.html']) {
      if (!fs.existsSync(path.join(ROOT, 'public', f))) continue;
      assert.equal(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), fs.readFileSync(path.join(ROOT, f), 'utf8'), `public/${f} differs from ${f}`);
    }
  });

  test('vercel.json crons point at existing api files', () => {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    for (const c of v.crons) assert.ok(fs.existsSync(path.join(ROOT, c.path.split('?')[0].replace(/^\//, '') + '.js')), c.path);
    assert.deepEqual(v.crons.map((c) => c.schedule), ['0 5 * * *', '30 5 * * 1', '0 6 * * *']);
  });

  bug('F-DOC-1', 'CLAUDE.md matches reality: files it lists exist (uus.html does not on master), and it no longer says "There are no tests here"', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const listed = [...doc.matchAll(/^\| `([\w./*-]+)` /gm)].map((m) => m[1]).filter((f) => !f.includes('*') && !f.includes('/'));
    const missing = listed.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    assert.deepEqual(missing, []);
    assert.ok(!/There are no tests here/.test(doc));
  });
});
