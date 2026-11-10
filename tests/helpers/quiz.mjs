// Runs the REAL inline <script> of index.html / en.html / ru.html inside node:vm with a
// tiny DOM stub, so tests exercise the production routing, booking-link builder and
// outgoing payloads instead of a re-implementation.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './load-api.mjs';

export const QUIZ_FILES = { ET: 'index.html', EN: 'en.html', RU: 'ru.html' };

export function readPage(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** Inline <script> blocks (no src). */
export function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** The quiz logic script = the inline block that defines computeRoute. */
export function quizScript(html) {
  const s = inlineScripts(html).find((x) => x.includes('function computeRoute'));
  if (!s) throw new Error('quiz script not found');
  return s;
}

/** Text of a top-level function declaration, brace-matched. */
export function extractFunction(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function makeElement(id, store) {
  const el = {
    id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '',
    style: {}, dataset: {}, listeners: {}, offsetHeight: 0,
    classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el.classes.add(x)); }, remove(...c) { c.forEach((x) => el.classes.delete(x)); },
      toggle(c) { el.classes.has(c) ? el.classes.delete(c) : el.classes.add(c); }, contains(c) { return el.classes.has(c); },
    },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    setAttribute() {}, getAttribute() { return null; }, focus() {}, reset() {}, scrollIntoView() {},
    querySelector() { return makeElement('q', store); },
    querySelectorAll() { return []; },
    closest() { return makeElement('c', store); },
  };
  return el;
}

/**
 * @param {string} file  index.html | en.html | ru.html
 * @param {object} opts  { search: '?utm_source=...', referrer: '', hostname }
 */
export function loadQuiz(file, { search = '', referrer = '', hostname = 'kiirtest.ksa.ee', sessionBlocked = false } = {}) {
  const html = readPage(file);
  const src = quizScript(html);
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, makeElement(id, els)); return els.get(id); };

  const clientCalls = [];   // fetch() calls made by the page
  const beacons = [];       // navigator.sendBeacon calls
  const tracking = { gtag: [], fbq: [], dataLayer: [] };
  const mem = new Map();
  const storage = {
    getItem: (k) => { if (sessionBlocked) throw new Error('blocked'); return mem.has(k) ? mem.get(k) : null; },
    setItem: (k, v) => { if (sessionBlocked) throw new Error('blocked'); mem.set(k, String(v)); },
    removeItem: (k) => mem.delete(k),
  };

  const sandbox = {
    console, URL, URLSearchParams, Blob, JSON, Math, Date, Object, Array, String, Number, Promise,
    // Short timers (animations) stay inert. A wait of 800 ms or more is the lead-delivery retry
    // back-off, which must complete or the awaiting submit handler never returns.
    setTimeout: (fn, ms) => { if (ms >= 800) queueMicrotask(fn); return 0; }, clearTimeout() {}, requestAnimationFrame: (fn) => fn(),
    location: { search, hash: '', hostname, href: `https://${hostname}/` },
    sessionStorage: storage, localStorage: storage,
    navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
    document: {
      referrer, documentElement: { lang: file === 'index.html' ? 'et' : file === 'en.html' ? 'en' : 'ru' },
      getElementById: getEl,
      querySelector: () => makeElement('q', els),
      querySelectorAll: () => [],
      createElement: () => makeElement('new', els),
    },
    fetch: async (url, init = {}) => {
      clientCalls.push({ url, init, json: init.body ? safeParse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
    gtag: (...a) => tracking.gtag.push(a),
    fbq: (...a) => tracking.fbq.push(a),
  };
  sandbox.window = sandbox;
  sandbox.window.scrollTo = () => {};
  sandbox.dataLayer = tracking.dataLayer;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: file });

  const run = (code) => vm.runInContext(code, ctx);
  const api = {
    file, ctx, run, getEl, clientCalls, beacons, tracking, src,
    setAnswers(a) { run(`Object.assign(answers, ${JSON.stringify(a)})`); },
    answers() { return JSON.parse(run('JSON.stringify(answers)')); },
    route(a) { if (a) api.setAnswers(a); return run('computeRoute()'); },
    bookingUrl(route) { return run(`bookingUrl(${JSON.stringify(route)})`); },
    results() { return JSON.parse(run('JSON.stringify(RESULTS)')); },
    booking() { return JSON.parse(run('JSON.stringify(BOOKING)')); },
    strength() { return JSON.parse(run('JSON.stringify(STRENGTH)')); },
    const(name) { return run(name); },
    /** Fill the email gate and submit it, like a visitor would. */
    async submitGate({ email = 'mari.maasikas@gmail.com', name = 'Mari', consent = false } = {}) {
      getEl('gate-email').value = email;
      getEl('gate-name').value = name;
      getEl('gate-consent').checked = consent;
      const fns = getEl('gateForm').listeners.submit || [];
      for (const fn of fns) await fn({ preventDefault() {} });
    },
    async submitCallback({ phone = '+37255512345', name = 'Mari' } = {}) {
      getEl('cb-phone').value = phone;
      getEl('cb-name').value = name;
      await run('onCallbackSubmit')({ preventDefault() {} });
    },
    async bodyOf(call) { return call.json; },
    async beaconJson(i = beacons.length - 1) { return JSON.parse(await beacons[i].blob.text()); },
  };
  return api;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** Strip tags/scripts/styles -> visible-ish text, decode the entities that appear here. */
export function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '));
}
export function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€').replace(/&mdash;/g, '—').replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
