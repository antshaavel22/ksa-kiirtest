// Eligibility truth table.
// Clinical rule (CLAUDE.md): Flow3 = age 18-45 AND confirmed myopia AND not above -9 D.
// Under 18 -> kids. Everything else -> audit.
//
// The REAL computeRoute() of index.html / en.html / ru.html is executed (node:vm), then
// compared (a) with each other, (b) with the written rule on a numeric grid
// (age in years x sphere in dioptres), and (c) with what the SERVER derives from the very
// same quiz answers (api/track.js mapAgeBand / deriveGroupHint / isQualifiedFlow3Answers).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, QUIZ_FILES, readPage, quizScript, extractFunction } from './helpers/quiz.mjs';
import { bug, makeWorld, payload, PERSON, EVENT_PAYLOADS } from './helpers/harness.mjs';

const LANGS = Object.keys(QUIZ_FILES);

// ── 1. The three copies of computeRoute() are byte-identical ─────────────────────────
describe('computeRoute() text', () => {
  test('identical character-for-character in index.html, en.html, ru.html', () => {
    const src = Object.fromEntries(LANGS.map((l) => [l, extractFunction(quizScript(readPage(QUIZ_FILES[l])), 'computeRoute')]));
    assert.equal(src.EN, src.ET, 'en.html computeRoute() differs from index.html');
    assert.equal(src.RU, src.ET, 'ru.html computeRoute() differs from index.html');
    // And it still contains the guarded clinical line verbatim.
    assert.match(src.ET, /if \(young && isMyope && !tooHigh\) return 'flow3';/);
    assert.match(src.ET, /\['18-25','26-35','36-45'\]\.includes\(answers\.age\)/);
  });
});

// ── 2. UI model: the quiz only offers bands, so years map onto bands ─────────────────
const bandFor = (years) =>
  years < 18 ? 'Alla 18' : years <= 25 ? '18-25' : years <= 35 ? '26-35' : years <= 45 ? '36-45' : years <= 55 ? '46-55' : '56+';

// Strength option the visitor would tick for a myopic sphere (negative number).
function minusCodeFor(sphere) {
  if (sphere < -9) return 'minus_high';          // "over -9"
  if (sphere <= -6) return 'minus_3';            // "-6 to -9"
  if (sphere <= -3) return 'minus_2';
  return 'minus_1';
}

/** The written rule, independent of the quiz code. */
function specRoute({ years, vision, sphere, forWhom = 'Endale' }) {
  if (forWhom === 'Oma lapsele') return 'kids';        // patient is a child
  if (years < 18) return 'kids';
  if (years >= 18 && years <= 45 && vision === 'myopia' && sphere >= -9) return 'flow3';
  return 'audit';
}

describe('computeRoute() behaviour (all three languages)', () => {
  for (const lang of LANGS) {
    describe(lang, () => {
      const q = loadQuiz(QUIZ_FILES[lang]);

      test('age boundary 17/18 and 45/46 map to the right band and route', () => {
        const myope = { vision: 'Miinusprillid', prescCode: 'minus_2', forWhom: 'Endale' };
        assert.equal(q.route({ ...myope, age: bandFor(17) }), 'kids');
        assert.equal(q.route({ ...myope, age: bandFor(18) }), 'flow3');
        assert.equal(q.route({ ...myope, age: bandFor(45) }), 'flow3');
        assert.equal(q.route({ ...myope, age: bandFor(46) }), 'audit');
        assert.equal(q.route({ ...myope, age: bandFor(60) }), 'audit');
      });

      test('dioptre boundary: -9 D stays Flow3, -9.25 D (over -9) goes to Audit', () => {
        const base = { vision: 'Miinusprillid', age: '26-35', forWhom: 'Endale' };
        assert.equal(q.route({ ...base, prescCode: minusCodeFor(-9) }), 'flow3');
        assert.equal(q.route({ ...base, prescCode: minusCodeFor(-9.25) }), 'audit');
        assert.equal(q.route({ ...base, prescCode: 'minus_1' }), 'flow3');
      });

      test('hyperopia, presbyopia/reading glasses, no glasses, "don\'t know" are never Flow3', () => {
        for (const vision of ['Plussprillid', 'Lugemisprillid', 'Ei kanna prille', 'Ei tea']) {
          for (const age of ['18-25', '26-35', '36-45']) {
            for (const prescCode of ['', 'plus_1', 'plus_high', 'read_1', 'read_unknown', 'plus_unknown', 'minus_1']) {
              assert.equal(q.route({ vision, age, prescCode, forWhom: 'Endale' }), 'audit',
                `${vision}/${age}/${prescCode} must be audit`);
            }
          }
        }
      });

      test('under 18 is always kids, whatever the glasses', () => {
        for (const vision of ['Miinusprillid', 'Plussprillid', 'Lugemisprillid', 'Ei kanna prille', 'Ei tea']) {
          assert.equal(q.route({ vision, age: 'Alla 18', prescCode: 'minus_1', forWhom: 'Endale' }), 'kids');
        }
      });

      test('numeric grid (age 0-99 x sphere -12..0 step 0.25) matches the written rule for forWhom=Endale', () => {
        let checked = 0;
        for (let years = 0; years <= 99; years++) {
          for (let sphere = 0; sphere >= -12; sphere -= 0.25) {
            const route = q.route({ vision: 'Miinusprillid', age: bandFor(years), prescCode: minusCodeFor(sphere), forWhom: 'Endale' });
            assert.equal(route, specRoute({ years, vision: 'myopia', sphere }), `years=${years} sphere=${sphere}`);
            checked++;
          }
        }
        assert.ok(checked > 4000);
      });

      test('unknown strength ("Ei tea") with minus glasses is routed to Flow3 (rule only excludes minus_high)', () => {
        // Documents current behaviour. Question for Ants: "confirmed myopia, not above -9" - is an
        // unknown strength allowed through to the Flow3 exam? (See audit F-ELIG-3.)
        assert.equal(q.route({ vision: 'Miinusprillid', age: '26-35', prescCode: 'minus_unknown', forWhom: 'Endale' }), 'flow3');
      });
    });
  }

  test('all three languages give identical routes for every age x vision x strength x forWhom combination', () => {
    const qs = Object.fromEntries(LANGS.map((l) => [l, loadQuiz(QUIZ_FILES[l])]));
    const strength = qs.ET.strength();
    const visions = ['Miinusprillid', 'Plussprillid', 'Lugemisprillid', 'Ei kanna prille', 'Ei tea'];
    const ages = ['Alla 18', '18-25', '26-35', '36-45', '46-55', '56+'];
    let n = 0;
    for (const vision of visions) {
      const codes = (strength[vision] || [['', '']]).map(([c]) => c);
      for (const age of ages) for (const prescCode of codes) for (const forWhom of ['Endale', 'Oma lapsele', 'Sõbrale või lähedasele']) {
        const a = { vision, age, prescCode, forWhom };
        const routes = LANGS.map((l) => qs[l].route(a));
        assert.deepEqual([...new Set(routes)].length, 1, `${JSON.stringify(a)} -> ${routes}`);
        n++;
      }
    }
    assert.ok(n > 200);
  });

  test('strength option codes are the same set in all three languages', () => {
    const codes = (l) => JSON.stringify(Object.fromEntries(Object.entries(loadQuiz(QUIZ_FILES[l]).strength())
      .map(([k, v]) => [k, v.map(([c]) => c)])));
    assert.equal(codes('EN'), codes('ET'));
    assert.equal(codes('RU'), codes('ET'));
  });

  test('the quiz asks no astigmatism / cylinder question (rule cannot screen it)', () => {
    // Informational guard: if a cylinder question is ever added, revisit the eligibility rule + CRM payload.
    for (const l of LANGS) {
      const html = readPage(QUIZ_FILES[l]);
      assert.ok(!/astigmat|cylinder|silindr|цилиндр|астигмат/i.test(html), `${l}: astigmatism now mentioned - update rule/tests`);
    }
  });

  bug('F-ELIG-1', 'parent answering for their CHILD (forWhom="Oma lapsele") must not be routed to Flow3 because the parent is 36-45 and short-sighted', () => {
    for (const l of LANGS) {
      const q = loadQuiz(QUIZ_FILES[l]);
      const route = q.route({ forWhom: 'Oma lapsele', age: '36-45', vision: 'Miinusprillid', prescCode: 'minus_2' });
      assert.notEqual(route, 'flow3', `${l}: Flow3 offered for a child because the parent's own age/glasses were ticked`);
    }
  });

  bug('F-ELIG-2', 'visitor answering for "a friend or relative" is not offered Flow3 on the visitor\'s own age', () => {
    // The age question reads "Your age" - for forWhom != Endale the clinical rule is applied to the wrong person.
    const q = loadQuiz(QUIZ_FILES.ET);
    assert.notEqual(q.route({ forWhom: 'Sõbrale või lähedasele', age: '36-45', vision: 'Miinusprillid', prescCode: 'minus_2' }), 'flow3');
  });
});

// ── 3. Server-side agreement ─────────────────────────────────────────────────────────
// The server never sees `route`; it re-derives age band / vision / group hint from the answers.
// We drive the real track.js with the quiz's own labels (all three languages) and compare.
describe('server-side mapping agrees with the quiz', () => {
  const qs = Object.fromEntries(LANGS.map((l) => [l, loadQuiz(QUIZ_FILES[l])]));
  const visions = ['Miinusprillid', 'Plussprillid', 'Lugemisprillid', 'Ei kanna prille', 'Ei tea'];
  const ages = ['Alla 18', '18-25', '26-35', '36-45', '46-55', '56+'];

  function combos(lang) {
    const strength = qs[lang].strength();
    const out = [];
    for (const vision of visions) {
      const opts = strength[vision] || [['', 'N/A']];
      for (const [code, label] of opts) for (const age of ages) out.push({ lang, vision, code, label, age });
    }
    return out;
  }

  test('book_now_clicked is accepted (CRM ticket + ledger) exactly when the quiz routed to flow3', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const mismatches = [];
    for (const lang of LANGS) {
      for (const c of combos(lang)) {
        const route = qs[lang].route({ forWhom: 'Endale', age: c.age, vision: c.vision, prescCode: c.code });
        w.net.calls.length = 0;
        const res = await w.post(payload('book_now_clicked', {
          language: lang, lp_source: `LP-Kiirtest-${lang}`, email: PERSON.email,
          answers: { forWhom: 'Endale', age: c.age, vision: c.vision, prescription: c.label, lenses: 'Mõnikord', interest: 'Olen mõelnud' },
        }));
        assert.equal(res.statusCode, 200);
        const accepted = w.net.crm().length === 1;
        if (accepted !== (route === 'flow3')) mismatches.push(`${lang} ${c.age} | ${c.vision} | ${c.label}: quiz=${route} server accepted=${accepted}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test('email_captured CRM age_band is under_18 / 18_45 / over_45 consistent with the quiz band', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const expectBand = { 'Alla 18': 'under_18', '18-25': '18_45', '26-35': '18_45', '36-45': '18_45', '46-55': 'over_45', '56+': 'over_45' };
    for (const lang of LANGS) {
      for (const age of ages) {
        w.net.calls.length = 0;
        await w.post(payload('email_captured', { language: lang, lp_source: `LP-Kiirtest-${lang}`, email: PERSON.email,
          answers: { forWhom: 'Endale', age, vision: 'Miinusprillid', prescription: '−3 kuni −6' } }));
        const crm = w.net.crm()[0].json;
        assert.equal(crm.qualifying.age_band, expectBand[age], `${lang} ${age}`);
      }
    }
  });

  test('email_captured CRM vision_issue mapping is the same for ET/EN/RU quiz values', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const expectV = { Miinusprillid: 'myopia', Plussprillid: 'hyperopia', Lugemisprillid: 'presbyopia', 'Ei tea': 'unknown', 'Ei kanna prille': 'other' };
    for (const [vision, want] of Object.entries(expectV)) {
      w.net.calls.length = 0;
      await w.post(payload('email_captured', { email: PERSON.email, answers: { age: '26-35', vision, prescription: 'N/A' } }));
      assert.equal(w.net.crm()[0].json.qualifying.vision_issue, want, vision);
    }
  });

  test('email_captured CRM group_hint never claims Flow3 for a visitor the quiz sent to audit/kids (excluding the -9 D case, tested below)', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    const bad = [];
    for (const lang of LANGS) {
      for (const c of combos(lang)) {
        if (c.code === 'minus_high') continue; // F-ELIG-4
        const route = qs[lang].route({ forWhom: 'Endale', age: c.age, vision: c.vision, prescCode: c.code });
        w.net.calls.length = 0;
        await w.post(payload('email_captured', { language: lang, lp_source: `LP-Kiirtest-${lang}`, email: PERSON.email,
          result: route === 'flow3' ? 'good_candidate' : route, route,
          answers: { forWhom: 'Endale', age: c.age, vision: c.vision, prescription: c.label } }));
        const hint = w.net.crm()[0].json.group_hint;
        if (route === 'flow3' && hint !== 'flow3_eligible_myope') bad.push(`${lang} ${c.age} ${c.vision} ${c.label}: flow3 but hint=${hint}`);
        if (route === 'kids' && hint !== 'children_exam') bad.push(`${lang} ${c.age}: kids but hint=${hint}`);
        if (route === 'audit' && ['flow3_eligible_myope', 'children_exam'].includes(hint)) bad.push(`${lang} ${c.age} ${c.vision} ${c.label}: audit but hint=${hint}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  bug('F-ELIG-4', 'a 26-35 y myope with "over -9" glasses is routed to Audit by the quiz, so the CRM group_hint must NOT be flow3_eligible_myope', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (const [lang, label] of [['ET', 'üle −9'], ['EN', 'over −9'], ['RU', 'свыше −9']]) {
      w.net.calls.length = 0;
      await w.post(payload('email_captured', { language: lang, lp_source: `LP-Kiirtest-${lang}`, email: PERSON.email, result: 'audit', route: 'audit',
        answers: { forWhom: 'Endale', age: '26-35', vision: 'Miinusprillid', prescription: label } }));
      assert.notEqual(w.net.crm()[0].json.group_hint, 'flow3_eligible_myope', `${lang}: deriveGroupHint ignores the prescription`);
    }
  });

  test('server isQualifiedFlow3Answers treats the "over -9" label of every language as not qualified', async (t) => {
    const w = await makeWorld('track');
    t.after(() => w.done());
    for (const [lang, label] of [['ET', 'üle −9'], ['EN', 'over −9'], ['RU', 'свыше −9']]) {
      w.net.calls.length = 0;
      await w.post(payload('book_now_clicked', { language: lang, email: PERSON.email,
        answers: { age: '26-35', vision: 'Miinusprillid', prescription: label } }));
      assert.equal(w.net.crm().length, 0, `${lang}: over -9 label was accepted as qualified`);
    }
  });

  test('every strength label of every language that the quiz can send is understood by the server (no label falls through)', () => {
    // The server decides "too high" by matching the visible LABEL text. Pin the three known labels so a copy edit
    // in the quiz (e.g. "yli −9") that the server does not know fails here instead of silently qualifying people.
    const over = LANGS.map((l) => qs[l].strength().Miinusprillid.find(([c]) => c === 'minus_high')[1].replace(/−/g, '-'));
    assert.deepEqual(over, ['üle -9', 'over -9', 'свыше -9']);
  });
});
