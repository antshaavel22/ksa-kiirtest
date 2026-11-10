// Loads the production api/*.js files WITHOUT editing them.
//
// The api files use ESM `export default` (track.js, analytics-report.js, ...) but the
// repo's package.json has no "type":"module", and draw-entry.js is CommonJS. Vercel
// compiles them itself; plain Node cannot import the .js files directly on every
// version. So, at run time, we COPY the untouched source into tests/.tmp/ with a
// .mjs (or .cjs) extension and a unique name and import the copy.
//
//   * the production file is only ever read, never written;
//   * a unique name per load means every load re-evaluates the module, which matters
//     because the api files read process.env at import time (const SLACK_WEBHOOK = ...);
//   * conversion-health.js imports './booking-completed.js' - in the copy that one
//     import specifier is pointed at the copied booking-completed.mjs.
//
// Environment: every process.env.NAME the api files mention is wiped first (so a real
// token in the developer's shell can never leak into a test) and then the dummy values
// passed in `env` are applied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });

let counter = 0;
const created = new Set();
process.on('exit', () => {
  for (const f of created) { try { fs.unlinkSync(f); } catch {} }
});

export function apiSource(name) {
  return fs.readFileSync(path.join(API, `${name}.js`), 'utf8');
}

/** Every env var name any api file reads. */
export function knownEnvNames() {
  const names = new Set();
  for (const f of fs.readdirSync(API)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(API, f), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return [...names];
}

const saved = new Map();
/** Wipe all known secrets, then apply `env` (undefined/null values stay unset). */
export function setEnv(env = {}) {
  restoreEnv();
  for (const k of [...knownEnvNames(), ...Object.keys(env)]) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null) process.env[k] = String(v);
  }
}
export function restoreEnv() {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  saved.clear();
}

function copyTo(name, ext, transform = (s) => s) {
  const file = path.join(TMP, `${name}.${process.pid}.${++counter}.${ext}`);
  fs.writeFileSync(file, transform(apiSource(name)));
  created.add(file);
  return file;
}

/**
 * Import a fresh copy of api/<name>.js. Returns { handler, mod }.
 * Call setEnv(...) BEFORE loadApi(...) - the env is read at import time.
 * Keep the env set while you invoke the handler (a few values are read per call).
 */
export async function loadApi(name) {
  const src = apiSource(name);
  const isCjs = /module\.exports\s*=/.test(src) && !/export\s+default/.test(src);
  let file;
  if (isCjs) {
    file = copyTo(name, 'cjs');
  } else if (name === 'conversion-health') {
    const dep = copyTo('booking-completed', 'mjs');
    file = copyTo(name, 'mjs', (s) =>
      s.replace(/from\s+['"]\.\/booking-completed\.js['"]/, `from './${path.basename(dep)}'`));
  } else {
    file = copyTo(name, 'mjs');
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod.default ?? mod;
  return { handler, mod };
}
