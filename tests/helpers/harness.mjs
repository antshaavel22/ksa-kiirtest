// Shared helpers: dummy env, fake req/res, "known bug" test wrapper, realistic payloads.
import test from 'node:test';
import { setEnv, restoreEnv, loadApi } from './load-api.mjs';
import { installFetch, HOSTS } from './mock-fetch.mjs';

export { HOSTS };
import { readFileSync } from 'node:fs';
const FIXED = new Set(JSON.parse(readFileSync(new URL('./fixed-bugs.json', import.meta.url), 'utf8')).fixed);

/** Dummy environment: every secret is a fake, every URL is on a reserved .test host. */
export const BASE_ENV = {
  SLACK_WEBHOOK_URL: HOSTS.slackMain,
  SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL: HOSTS.slackKiirtest,
  SLACK_ALERTS_WEBHOOK_URL: HOSTS.slackAlerts,
  SLACK_LP_CHANNEL_WEBHOOK_URL: HOSTS.slackLp,
  LP_TRACK_SHARED_TOKEN: 'dummy-lp-token',
  KIIRTEST_WEBHOOK_TOKEN: 'dummy-crm-webhook-token',
  RESEND_API_KEY: 're_dummy',
  KSA_TICKETS_API_KEY: 'crm_dummy_key',
  KSA_CRM_ENDPOINT: HOSTS.crm,
  KSA_TICKETS_ENDPOINT: HOSTS.crm,
  BREVO_API_KEY: 'brevo_dummy',
  BREVO_KIIRTEST_LIST_ID: '27',
  BREVO_LP_LIST_ID: '5',
  VERCEL_ENV: 'production',
};

/**
 * Known-bug test. The test body states the DESIRED behaviour. While the bug exists the
 * body fails; by default that is reported as `todo` (node --test exits 0 and lists them),
 * with STRICT=1 it is a hard failure so you can see the real fail count:
 *     STRICT=1 node --test tests/*.test.mjs
 * When the bug is fixed the test simply passes and the `bug` wrapper can be turned into
 * a plain `test`.
 */
export function bug(id, name, fn) {
  const label = `[${id}] ${name}`;
  // Bugs that have been fixed (tests/helpers/fixed-bugs.json) run as ordinary tests:
  // a regression is a hard failure, not a quiet `todo`.
  if (FIXED.has(label)) return test(label, fn);
  if (process.env.STRICT) return test(label, fn);
  return test(label, { todo: `known bug ${id}` }, fn);
}

export function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    send(b) { this.body = b; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

export function mockReq({ method = 'POST', headers = {}, body, url = '/api/track' } = {}) {
  return { method, headers: { origin: 'https://kiirtest.ksa.ee', ...headers }, body, url };
}

/** Invoke a handler like Vercel would. body may be an object or a raw string. */
export async function invoke(handler, body, opts = {}) {
  const res = mockRes();
  await handler(mockReq({ ...opts, body }), res);
  return res;
}

/**
 * Set up one test "world": fresh env, fresh mocked network, fresh copy of the api
 * module. Always call world.done() (use t.after).
 */
export async function makeWorld(apiName = 'track', env = {}, { net } = {}) {
  setEnv({ ...BASE_ENV, ...env });
  const network = net || installFetch();
  const { handler, mod } = await loadApi(apiName);
  return {
    handler, mod, net: network, env: { ...BASE_ENV, ...env },
    post: (body, opts) => invoke(handler, body, opts),
    done() { network.restore(); restoreEnv(); },
  };
}

// ── Realistic payload builders (none of these trip isTestPayload) ──────────────────
export const PERSON = { name: 'Mari Maasikas', email: 'mari.maasikas@gmail.com', phone: '+37255512345' };

export const ANSWERS_FLOW3 = {
  forWhom: 'Endale', gender: 'Naine', age: '26-35', vision: 'Miinusprillid',
  prescription: '−3 kuni −6', lenses: 'Jah, iga päev', stability: 'Jah, stabiilne',
  complaints: '—', complaintsOther: '', bother: '', extraSymptoms: '—', interest: 'Jah, aktiivselt',
};
export const ANSWERS_AUDIT = { ...ANSWERS_FLOW3, age: '46-55' };
export const ANSWERS_KIDS = { ...ANSWERS_FLOW3, age: 'Alla 18' };

export const UTM_QUIZ = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'flow3-search', gclid: 'GCLID123' };

export function payload(type, extra = {}) {
  return {
    type, language: 'ET', lp_source: 'LP-Kiirtest-ET', from: 'kiirtest',
    result: 'good_candidate', route: 'flow3', promoCode: 'KIIRTEST39', code: 'KIIRTEST39',
    client_session_id: 'kt_abc123', utm: { ...UTM_QUIZ }, answers: { ...ANSWERS_FLOW3 },
    timestamp: '2026-11-09T10:00:00.000Z', ...extra,
  };
}

/** One realistic payload per event type. */
export const EVENT_PAYLOADS = {
  email_captured: () => payload('email_captured', { email: PERSON.email, consent: { marketing_email: true, text_version: 'kiirtest-2026-10', given_at: '2026-11-09T10:00:00.000Z' } }),
  callback_requested: () => payload('callback_requested', { contact: { ...PERSON } }),
  qualified_flow3_phone_lead: () => payload('qualified_flow3_phone_lead', { name: PERSON.name, phone: PERSON.phone, email: PERSON.email }),
  phone_lead: () => payload('phone_lead', { phone: PERSON.phone }),
  form_with_contact: () => payload('form_with_contact', { contact: { ...PERSON } }),
  installment_lead: () => payload('installment_lead', { contact: { ...PERSON } }),
  hot_lead_lens_user: () => payload('hot_lead_lens_user', { email: PERSON.email, phone: PERSON.phone, name: PERSON.name }),
  book_now_clicked: () => payload('book_now_clicked', { email: PERSON.email, name: PERSON.name }),
  bridge_19_book_clicked: () => payload('bridge_19_book_clicked', { email: PERSON.email, phone: PERSON.phone }),
  eligible_gate_bridge_clicked: () => payload('eligible_gate_bridge_clicked', { email: PERSON.email, phone: PERSON.phone }),
  quiz_completed: () => payload('quiz_completed', { email: PERSON.email }),
  lp_contact_submitted: () => ({ type: 'lp_contact_submitted', lp_source: 'LP-Glasses-ET', language: 'ET', name: PERSON.name, email: PERSON.email, phone: PERSON.phone, age: '30', diopter: '-4', campaign_code: 'GLASSES' }),
  lp_guide_download: () => ({ type: 'lp_guide_download', lp_source: 'LP-Glasses-ET', language: 'ET', name: PERSON.name, email: PERSON.email }),
};

/** Headers the LP-only events need. */
export const LP_HEADERS = { origin: 'https://glasses.ksa.ee', 'x-track-source': BASE_ENV.LP_TRACK_SHARED_TOKEN };

/** Race a promise against a timer. Resolves 'timeout' if it did not settle. */
export async function settlesWithin(promise, ms) {
  let t;
  const timeout = new Promise((r) => { t = setTimeout(() => r('timeout'), ms); });
  try { return await Promise.race([promise.then(() => 'settled', () => 'rejected'), timeout]); }
  finally { clearTimeout(t); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
