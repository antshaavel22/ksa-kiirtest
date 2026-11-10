// Offline fetch mock. Nothing here ever touches the network: unknown hosts THROW so a
// test can never silently reach a real endpoint.
//
//   const net = installFetch();        // replaces globalThis.fetch
//   net.fail('crm.test', 500);         // every call to that host answers 500
//   net.hang('api.resend.com');        // never resolves (simulates a timeout)
//   net.calls                          // every request made, parsed
//   net.restore();
//
// Dummy hosts (all *.test, reserved by RFC 2606, never resolvable):
export const HOSTS = {
  slackMain: 'https://hooks.slack.test/main',
  slackKiirtest: 'https://hooks.slack.test/kiirtest',
  slackAlerts: 'https://hooks.slack.test/alerts',
  slackLp: 'https://hooks.slack.test/lp',
  crm: 'https://crm.test/api/v1/tickets/intake/flow3',
  supabase: 'https://supabase.test',
};

const KNOWN_HOSTS = [
  'hooks.slack.test', 'crm.test', 'supabase.test', 'api.resend.com', 'api.brevo.com',
  'graph.facebook.com', 'googleads.googleapis.com', 'oauth2.googleapis.com', 'kiirtest.test',
];

function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' },
  });
}

export function installFetch() {
  const original = globalThis.fetch;
  const calls = [];
  const rules = []; // newest first
  let resendSeq = 0;

  function classify(url, method) {
    const u = new URL(url);
    const host = u.host;
    if (host === 'hooks.slack.test') return 'slack';
    if (host === 'api.resend.com') return method === 'GET' ? 'resend-list' : 'resend';
    if (host === 'crm.test') return 'crm';
    if (host === 'api.brevo.com') return 'brevo';
    if (host === 'supabase.test') return 'supabase';
    if (host === 'graph.facebook.com') return 'meta-graph';
    if (host === 'googleads.googleapis.com' || host === 'oauth2.googleapis.com') return 'google';
    return 'other';
  }

  function defaultResponse(call) {
    switch (call.kind) {
      case 'slack': return jsonResponse(200, 'ok');
      case 'resend': return jsonResponse(200, { id: `em_${++resendSeq}` });
      case 'resend-list': return jsonResponse(200, { data: [], has_more: false });
      case 'crm': return jsonResponse(201, { data: { ticket: { id: 't_1', number: 'T-1' } } });
      case 'brevo': return jsonResponse(201, { id: 1 });
      case 'supabase': return jsonResponse(200, []);
      case 'meta-graph': return jsonResponse(200, { name: 'Dummy campaign' });
      case 'google':
        return call.url.includes('oauth2') ? jsonResponse(200, { access_token: 'tok' })
          : jsonResponse(200, { results: [{}], jobId: '1' });
      default: return null;
    }
  }

  // Like the real fetch: when the caller's AbortSignal fires, the pending call rejects.
  // Without this a mocked "hung" service could never exercise a request deadline.
  const fetchMock = (input, init = {}) => {
    const work = fetchMockInner(input, init);
    if (!init.signal) return work;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject);
    });
  };
  const fetchMockInner = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const host = new URL(url).host;
    if (!KNOWN_HOSTS.includes(host)) {
      throw new Error(`OFFLINE GUARD: unexpected network call to ${url}`);
    }
    const bodyText = typeof init.body === 'string' ? init.body
      : init.body instanceof URLSearchParams ? init.body.toString() : (init.body == null ? '' : String(init.body));
    let json = null;
    try { json = bodyText ? JSON.parse(bodyText) : null; } catch {}
    const call = {
      url, method, host, kind: classify(url, method), headers: init.headers || {},
      bodyText, json, signal: init.signal || null, seq: calls.length,
    };
    calls.push(call);
    for (const r of rules) {
      if (r.match(call)) {
        const out = await r.respond(call);
        if (out !== undefined) return out;
      }
    }
    const d = defaultResponse(call);
    if (!d) throw new Error(`OFFLINE GUARD: no mock for ${url}`);
    return d;
  };

  globalThis.fetch = fetchMock;

  const toMatch = (m) => typeof m === 'function' ? m
    : (call) => call.url.includes(m);

  const api = {
    calls,
    rules,
    restore() { globalThis.fetch = original; },
    reset() { calls.length = 0; rules.length = 0; resendSeq = 0; },
    /** respond(call) -> Response | Promise<Response> | undefined (undefined = fall through) */
    on(match, respond) { rules.unshift({ match: toMatch(match), respond }); return api; },
    fail(match, status = 500, body = 'boom') { return api.on(match, () => jsonResponse(status, body)); },
    hang(match) { return api.on(match, () => new Promise(() => {})); },
    throwNetwork(match) { return api.on(match, () => { throw new TypeError('fetch failed'); }); },
    json: jsonResponse,
    since(mark) { return calls.slice(mark); },

    // ── convenient views over calls ────────────────────────────────────────
    slackAll: () => calls.filter((c) => c.kind === 'slack'),
    /** Slack posts that carry lead blocks */
    slackLeads: () => calls.filter((c) => c.kind === 'slack' && c.json?.blocks),
    /** Plain-text Slack posts = ops alerts / warnings */
    slackAlerts: () => calls.filter((c) => c.kind === 'slack' && c.json && !c.json.blocks && c.json.text),
    resend: () => calls.filter((c) => c.kind === 'resend'),
    resendInternal: () => calls.filter((c) => c.kind === 'resend' && c.json?.to?.includes('registreerumised@ksa.ee')),
    resendCustomer: () => calls.filter((c) => c.kind === 'resend' && !c.json?.to?.includes('registreerumised@ksa.ee')),
    crm: () => calls.filter((c) => c.kind === 'crm'),
    brevo: () => calls.filter((c) => c.kind === 'brevo'),
    summary() {
      return {
        slackLead: api.slackLeads().length,
        slackAlert: api.slackAlerts().length,
        resendInternal: api.resendInternal().length,
        resendCustomer: api.resendCustomer().length,
        crm: api.crm().length,
        brevo: api.brevo().length,
      };
    },
  };
  return api;
}

/**
 * Tiny in-memory stand-in for the Supabase REST table kiirtest_slack_posts, enough for
 * the "one alert per kind per hour" window check and the booking dedupe.
 */
export function installFakeSupabase(net) {
  const rows = [];
  net.on((c) => c.kind === 'supabase', (call) => {
    const u = new URL(call.url);
    if (call.method === 'GET') {
      const q = u.searchParams;
      const key = q.get('key')?.replace(/^eq\./, '');
      const since = q.get('posted_at')?.replace(/^gte\./, '');
      const person = q.get('person_hash')?.replace(/^eq\./, '');
      const kind = q.get('kind')?.replace(/^eq\./, '');
      const out = rows.filter((r) =>
        (!key || r.key === key) &&
        (!since || new Date(r.posted_at) >= new Date(since)) &&
        (!person || r.person_hash === person) &&
        (!kind || r.kind === kind));
      return jsonResponse(200, out);
    }
    if (call.method === 'POST') {
      const row = { posted_at: new Date().toISOString(), ...(call.json || {}) };
      const i = rows.findIndex((r) => r.key === row.key);
      if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
      return jsonResponse(201, '');
    }
    return jsonResponse(200, []);
  });
  return rows;
}
