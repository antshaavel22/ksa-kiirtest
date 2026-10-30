// api/track.js — Vercel serverless function
// Slack notifications + Resend email auto-responder for kiirtest form submissions

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const SLACK_KIIRTEST_WEBHOOK = process.env.SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL || null;
const SLACK_LP_WEBHOOK = process.env.SLACK_LP_CHANNEL_WEBHOOK_URL || null;
const LP_TRACK_SHARED_TOKEN = process.env.LP_TRACK_SHARED_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Lilia – KSA Silmakeskus <noreply@ksa.ee>';
const INTERNAL_NOTIFY_EMAIL = 'registreerumised@ksa.ee';

// ── Meta campaign/ad name resolution via Graph API ───────────────────────────
const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN || null;
const _metaNameCache = {};
async function resolveMetaName(id) {
  if (!META_TOKEN || !id) return null;
  if (_metaNameCache[id]) return _metaNameCache[id];
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${id}?fields=name&access_token=${META_TOKEN}`);
    const d = await r.json();
    const name = d?.name || null;
    if (name) _metaNameCache[id] = name;
    return name;
  } catch { return null; }
}

// ── UTM / ad source label ─────────────────────────────────────────────────────
// Unresolved Google Ads ValueTrack placeholder, e.g. {campaignname}
const isPlaceholder = s => s && /^\{[^}]+\}$/.test(s.trim());
// Pure numeric Meta entity ID, e.g. 6753232351941
const isMetaId = s => s && /^\d{10,}$/.test(s.trim());

async function utmLabel(rawUtm) {
  if (!rawUtm) return 'Otse';
  // The quiz pages send the landing URL's parameters under their own names
  // (utm_source, utm_medium, utm_campaign, utm_content); this function was
  // written for source/medium/campaign/content. Without the mapping every
  // tagged Meta or newsletter visit fell through to "Otse".
  const utm = Object.assign({}, rawUtm, {
    source: rawUtm.source || rawUtm.utm_source,
    medium: rawUtm.medium || rawUtm.utm_medium,
    campaign: rawUtm.campaign || rawUtm.utm_campaign,
    content: rawUtm.content || rawUtm.utm_content,
  });

  // All fields empty → direct / no tracking
  const hasAny = utm.gclid || utm.gbraid || utm.wbraid || utm.fbclid || utm.source || utm.referrer || utm.campaign;
  if (!hasAny) return 'Otse';

  // Referrer-only (no ad click) — came from ksa.ee or another known page
  if (!utm.gclid && !utm.gbraid && !utm.wbraid && !utm.fbclid && !utm.source && utm.referrer) {
    try {
      const host = new URL(utm.referrer).hostname.replace('www.', '');
      if (host === 'ksa.ee') return 'Orgaaniline — ksa.ee';
      if (host === 'kiirtest.ksa.ee') return 'Otselink — kiirtest.ksa.ee';
      return `Orgaaniline — ${host}`;
    } catch { return 'Orgaaniline'; }
  }

  // Determine channel
  const src = (utm.source || '').toLowerCase();
  const med = (utm.medium || '').toLowerCase();
  let channel = '';
  if (utm.gclid || utm.gbraid || utm.wbraid || src === 'google') {
    channel = 'Google Ads';
  } else if (utm.fbclid || ['facebook', 'meta', 'instagram', 'fb'].includes(src)) {
    channel = 'Meta';
  } else if (med === 'email' || src === 'chipmonkey' || src === 'email') {
    channel = `E-post${utm.source && utm.source.toLowerCase() !== 'email' ? ' (' + utm.source + ')' : ''}`;
  } else if (utm.source) {
    channel = utm.source;
  }

  if (!channel) return utm.referrer ? `Orgaaniline — ${utm.referrer}` : 'Otse';

  // Build: Channel · Campaign · Ad/content
  const parts = [channel];

  // Campaign — skip unresolved ValueTrack placeholders, resolve Meta numeric IDs
  if (utm.campaign) {
    if (isPlaceholder(utm.campaign)) {
      parts.push('⚠️ GAds-ValueTrack');
      console.warn('UTM ValueTrack placeholder not resolved:', utm.campaign);
    } else if (isMetaId(utm.campaign)) {
      const name = await resolveMetaName(utm.campaign);
      parts.push(name || `ID:${utm.campaign}`);
    } else {
      parts.push(utm.campaign);
    }
  }

  if (utm.gbraid) parts.push('gbraid');
  if (utm.wbraid) parts.push('wbraid');

  // Content/term — same treatment
  if (utm.content) {
    if (isPlaceholder(utm.content)) {
      // skip — already flagged above
    } else if (isMetaId(utm.content)) {
      const name = await resolveMetaName(utm.content);
      parts.push(`kirja teema: ${name || `ID:${utm.content}`}`);
    } else {
      parts.push(`kirja teema: ${utm.content}`);
    }
  } else if (utm.term && !isPlaceholder(utm.term)) {
    parts.push(`märksõna: ${utm.term}`);
  }

  return parts.join(' · ');
}

// ── Server-side promo code ───────────────────────────────────────────────────
function getDailyCode() {
  return 'KIIRTEST39';
}

// ── KAISA-436: Mai CRM intake ────────────────────────────────────────────────
// Booking-intent events (book_now_clicked, bridge_19_book_clicked,
// eligible_gate_bridge_clicked) POST a ticket to crm.ksa.ee so Lilia sees
// kiirtest leads in her queue. Server dedupes same contact within 30 min →
// returns 200 {merged:true}. Failover: any non-2xx logs + Slack-alarms but
// the existing Slack + email + auto-responder path stays untouched.
const KSA_CRM_ENDPOINT = process.env.KSA_CRM_ENDPOINT || 'https://crm.ksa.ee/api/v1/tickets/intake/flow3';
const KSA_TICKETS_API_KEY = process.env.KSA_TICKETS_API_KEY;

// ── Brevo (Sendinblue) lead routing ─────────────────────────────────────────
// LP + guide leads pushed into a Brevo contact list for nurture/email.
// No-op unless BREVO_API_KEY and the relevant list id are set.
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
const BREVO_LP_LIST_ID = process.env.BREVO_LP_LIST_ID ? Number(process.env.BREVO_LP_LIST_ID) : null;
// Mai 2026-10-09: kiirtest leads go to their own list ("Kiirtest leadid", 27),
// never the newsletter list, and only with an explicit marketing tick.
const BREVO_KIIRTEST_LIST_ID = process.env.BREVO_KIIRTEST_LIST_ID ? Number(process.env.BREVO_KIIRTEST_LIST_ID) : null;
// Brevo's VANUS attribute is a category number, not the label the quiz stores.
const BREVO_AGE_CATEGORY = { '18-25': 1, '26-35': 2, '36-45': 3, '46-55': 4, '56+': 5, 'Alla 18': 6 };

// A failed Brevo push must be visible. Falls back to the general webhook rather
// than going quiet, because a lost consented contact cannot be recovered later.
const SLACK_ALERTS_WEBHOOK = process.env.SLACK_ALERTS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || null;
const ALERT_WINDOW_MIN = 60;
async function alertSlack(text, kind = 'general') {
  if (!SLACK_ALERTS_WEBHOOK) { console.error('ALERT (no webhook configured):', text); return; }
  // One alert per kind per hour. A broken integration fails on every single
  // lead, and ten identical red messages tell nobody more than one does — they
  // just train people to scroll past the channel.
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  const dedupKey = `alert:track:${kind}`;
  if (url && key) {
    try {
      const since = new Date(Date.now() - ALERT_WINDOW_MIN * 60000).toISOString();
      const r = await fetch(
        `${url}/rest/v1/kiirtest_slack_posts?key=eq.${encodeURIComponent(dedupKey)}&posted_at=gte.${since}&select=key`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' }
      );
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) return;
    } catch (e) {
      console.error('alert window check failed (alerting anyway):', e.message);
    }
  }
  try {
    await fetch(SLACK_ALERTS_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (url && key) {
      await fetch(`${url}/rest/v1/kiirtest_slack_posts`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key: dedupKey, kind: 'alert', posted_at: new Date().toISOString() }),
      });
    }
  } catch (e) { console.error('alertSlack failed:', e.message, '—', text); }
}
async function pushToBrevo({ email, name, phone, lp_source, campaign_code, diopter, lang, leadType, listId, attributes: attrOverride } = {}) {
  const targetList = listId || BREVO_LP_LIST_ID;
  if (!BREVO_API_KEY || !targetList || !email) return { skipped: true };
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const cleanPhone = String(phone || '').replace(/\s+/g, '');
  // Brevo rejects nulls, and an empty string overwrites a value the CRM set.
  const strip = (o) => Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const attributes = strip(attrOverride || {
    FIRSTNAME: firstName, LP_SOURCE: lp_source || '', LEAD_TYPE: leadType || '',
    LANGUAGE: lang || '', CAMPAIGN_CODE: campaign_code || '', DIOPTER: diopter || '',
  });
  if (isE164(cleanPhone)) attributes.SMS = cleanPhone;
  // updateEnabled lets the CRM and the quiz enrich the same contact. We never
  // send emailBlacklisted — someone who unsubscribed in Brevo stays unsubscribed,
  // whatever a later form says.
  const send = (attrs) => fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, attributes: attrs, listIds: [targetList], updateEnabled: true }),
  });
  try {
    let r = await send(attributes);
    if (r.status === 400) {
      // Usually an attribute that does not exist in Brevo yet. Keep the contact
      // rather than losing it, but say which attributes were dropped.
      const detail = await r.text();
      console.warn('Brevo 400, retry without attributes:', detail, Object.keys(attributes).join(','));
      await alertSlack(`:warning: Brevo võttis kontakti vastu, aga atribuudid jäid salvestamata (list ${targetList}). Kontrolli, kas need väljad on Brevos olemas: ${Object.keys(attributes).join(', ')}. Brevo vastus: ${detail.slice(0, 300)}`, 'brevo_attrs');
      r = await send(strip({ FIRSTNAME: firstName }));
    }
    if (!r.ok && r.status !== 204) { console.error('Brevo push error:', r.status, await r.text()); return { ok: false, status: r.status }; }
    return { ok: true };
  } catch (e) { console.error('Brevo fetch error:', e); return { ok: false, error: String(e) }; }
}

function isE164(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

function isEmailish(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Quiz stores prescription as a free string ("-4.5", "-6 kuni -9", "üle -9", "pluss").
// Only a clean single number becomes prescription_sphere; ranges stay raw in quiz_meta.
// Quiz gives a range ("−0,5 kuni −3", "+3 kuni +6") or an open end ("üle −9").
// A clean number is used as-is; a range becomes its midpoint (Mai's request,
// CRM-T175); an open end becomes the bound itself. Unicode minus is normalised.
function parseSphere(raw) {
  const t = String(raw ?? '').trim().replace(/[−–]/g, '-').replace(/,/g, '.');
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  const range = t.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:kuni|до|to|-)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (range) return Math.round(((Number(range[1]) + Number(range[2])) / 2) * 100) / 100;
  const open = t.match(/^(?:üle|более|over|>)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (open) return Number(open[1]);
  return null;
}

// Email-only kiirtest lead → CRM ticket. Shape per Mai 2026-09-15 (B = Sobiv
// kandidaat, C = Vajab konsultatsiooni). age_band/vision_issue use the enums the
// CRM already accepts from buildCRMPayload; the raw quiz answers ride along in
// quiz_meta.quiz_answers so nothing is lost.
function buildEmailLeadPayload({ body, answers, lang, email, result, promoCode, adSource, lp_source, consent }) {
  const good = result === 'good_candidate';
  // age_band must stay one of the CRM's three enums or the ticket is rejected,
  // so an unmapped age keeps the default — but the routing hint below must not
  // then claim Flow3 eligibility.
  const mappedAge = mapAgeBand(answers.age || answers.age_band);
  const ageBand = mappedAge || '18_45';
  const visionIssue = mapVisionIssue(answers.vision || answers.vision_issue);
  const sphere = parseSphere(answers.prescription ?? answers.prescription_sphere);
  const u = body?.utm || {};
  const ids = {};
  if (u.gclid)  ids.gclid  = u.gclid;
  if (u.gbraid) ids.gbraid = u.gbraid;
  if (u.wbraid) ids.wbraid = u.wbraid;
  if (u.fbclid) ids.fbclid = u.fbclid;
  return {
    source: good ? 'kiirtest_lp_email_sobiv' : 'kiirtest_lp_email_konsultatsioon',
    lang: (lang || 'et').toLowerCase(),
    intent: good ? 'kiirtest_email_qualified' : 'kiirtest_email_consultation',
    // Mai 2026-09-22: the CRM joins the lead to a later booking on this id, which
    // the quiz also puts on the booking link as kiirtest_lead_id.
    ...(typeof body?.client_session_id === 'string' && body.client_session_id
      ? { client_session_id: body.client_session_id.slice(0, 64) } : {}),
    contact: { email: String(email).trim() },
    qualifying: {
      age_band: ageBand,
      gender: answers.gender || null,
      vision_issue: visionIssue,
      ...(sphere !== null ? { prescription_sphere: sphere } : {}),
    },
    group_hint: mappedAge ? deriveGroupHint(ageBand, visionIssue) : 'unclassified',
    quiz_meta: {
      source: adSource || 'Otse',
      discount_code: promoCode || null,
      interest_level: answers.interest || null,
      quiz_answers: answers || {},
      lp_source: lp_source || null,
      ad_source: detectAdSource(u.source, u.medium),
      event_type: 'email_captured',
    },
    utm: { source: u.source || null, medium: u.medium || null, campaign: u.campaign || null },
    click_ids: Object.keys(ids).length ? ids : null,
    // Mai 2026-10-09: reception sees on the ticket whether this person agreed to
    // marketing email, when, and which wording they agreed to.
    consent: {
      marketing_email: consent?.marketing_email === true,
      text_version: consent?.text_version || null,
      given_at: consent?.given_at || null,
    },
  };
}

// The quiz offers exactly six bands in all three languages: Alla 18 / До 18 /
// Under 18 · 18-25 · 26-35 · 36-45 · 46-55 · 56+. Exact matches come first, the
// substring fallbacks stay for older payloads. '56+' was missing from the
// over_45 list until 2026-10-09, so those answers fell through to the caller's
// '18_45' default and were filed as Flow3-eligible — Mai found 16 of them, 8 in
// the Flow3 queue. An age we cannot map now yields 'unclassified' at the call
// sites rather than a band that implies eligibility.
function mapAgeBand(quizAge) {
  const a = String(quizAge || '').toLowerCase().trim();
  if (['18-25', '26-35', '36-45', '18_45'].includes(a)) return '18_45';
  if (['46-55', '56+', '56-65', '65+', 'over_45'].includes(a)) return 'over_45';
  if (['alla 18', 'до 18', 'under 18', 'under_18'].includes(a)) return 'under_18';
  if (['46-55', '56-65', '65+', 'over_45', 'üle 45', 'старше 45'].some(s => a.includes(s.toLowerCase()))) return 'over_45';
  if (a.includes('alla 18') || a.includes('under_18') || a.includes('до 18') || a.includes('under 18')) return 'under_18';
  return null;
}

// The quiz stores the same Estonian option values in all three language
// versions ("Miinusprillid" etc.), so exact matches come first. The substring
// fallbacks stay for older payloads. Mapping agreed with Mai (CRM-T175, 2026-09-21):
// Miinusprillid → myopia · Plussprillid → hyperopia · Lugemisprillid → presbyopia ·
// Ei tea → unknown · Ei kanna prille → other.
function mapVisionIssue(quizVision) {
  const raw = String(quizVision || '').trim();
  const v = raw.toLowerCase();
  const exact = {
    miinusprillid: 'myopia', plussprillid: 'hyperopia', lugemisprillid: 'presbyopia',
    'ei tea': 'unknown', 'ei kanna prille': 'other',
  };
  if (exact[v]) return exact[v];
  if (v === 'miinus' || v === 'myopia' || v.includes('miinus') || v.includes('minus') || v.includes('myop') || v.includes('близо')) return 'myopia';
  if (v === 'pluss' || v === 'hyperopia' || v.includes('pluss') || v.includes('plus') || v.includes('hyper') || v.includes('даль')) return 'hyperopia';
  if (v.includes('lugemis') || v.includes('presby') || v.includes('vana') || v.includes('пресби') || v.includes('reading')) return 'presbyopia';
  if (v) return 'other';
  return 'unknown';
}

function deriveGroupHint(ageBand, visionIssue) {
  if (ageBand === 'under_18') return 'children_exam';
  if (ageBand === 'over_45') return 'audit_over_45';
  if (visionIssue === 'myopia') return 'flow3_eligible_myope';
  if (visionIssue === 'hyperopia') return 'audit_hyperope';
  return 'unclassified';
}

function detectAdSource(utmSource, utmMedium) {
  const s = String(utmSource || '').toLowerCase();
  const m = String(utmMedium || '').toLowerCase();
  if (m === 'cpc' || m === 'paid' || s === 'google' || s === 'facebook' || s === 'meta' || s === 'instagram') return 'paid';
  if (s === 'blog' || s.includes('blog.ksa')) return 'blog';
  if (s) return 'organic';
  return 'direct';
}

async function postToCRM(payload, ctx = '', opts = {}) {
  if (!KSA_TICKETS_API_KEY) {
    console.error('KAISA-436: KSA_TICKETS_API_KEY missing — skipping CRM POST');
    return false;
  }
  // Contact gate. A phone, when given, must be E.164 (unchanged). Without a phone
  // an email is enough — Mai 2026-09-15: email-only kiirtest leads were dropped
  // here for 4 days (20 tickets entered by hand). Slack + email path is untouched.
  const phone = payload?.contact?.phone;
  if (phone && !isE164(phone)) {
    console.warn(`KAISA-436[${ctx}]: phone not E.164, skip CRM POST`, phone);
    return false;
  }
  if (!phone && !isEmailish(payload?.contact?.email)) {
    console.warn(`KAISA-436[${ctx}]: no phone and no email, skip CRM POST`);
    return false;
  }
  try {
    const res = await fetch(KSA_CRM_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-KSA-API-Key': KSA_TICKETS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`KAISA-436[${ctx}]: CRM POST ${res.status}`, text.slice(0, 400));
      // Best-effort Slack alarm; do not throw — Slack+email path already ran.
      // quiet4xx: caller knows the CRM may still reject this shape (schema not
      // yet updated) — log only, no alarm per lead.
      try {
        if (SLACK_WEBHOOK && !(opts.quiet4xx && res.status >= 400 && res.status < 500)) {
          await fetch(SLACK_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `:warning: KAISA-436 ${ctx} CRM POST failed (HTTP ${res.status}) — lead preserved in Slack/email`,
            }),
          });
        }
      } catch {}
      return false;
    }
    return true;
  } catch (e) {
    console.error(`KAISA-436[${ctx}]: CRM POST exception`, String(e));
    try {
      if (SLACK_WEBHOOK) {
        await fetch(SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `:warning: KAISA-436 ${ctx} CRM POST exception: ${String(e).slice(0, 200)}`,
          }),
        });
      }
    } catch {}
    return false;
  }
}

function buildCRMPayload({ body, leadData, lang, name, phone, email, adSource, code, eventType }) {
  const mappedAge = mapAgeBand(leadData.age || leadData.age_band);
  const ageBand = mappedAge || '18_45';
  const visionIssue = mapVisionIssue(leadData.vision || leadData.vision_issue);
  const groupHint = mappedAge ? deriveGroupHint(ageBand, visionIssue) : 'unclassified';
  return {
    source: 'kiirtest',
    lang: (lang || 'et').toLowerCase(),
    intent: eventType === 'callback_requested' ? 'callback' : 'book_now',
    contact: {
      name: name || null,
      phone: phone || null,
      email: email || null,
    },
    qualifying: {
      age_band: ageBand,
      vision_issue: visionIssue,
    },
    group_hint: groupHint,
    quiz_meta: {
      discount_code: code || body?.code || null,
      quiz_answers: leadData || {},
      ad_source: detectAdSource(body?.utm?.source, body?.utm?.medium),
      event_type: eventType,
    },
    utm: {
      source: body?.utm?.source || null,
      medium: body?.utm?.medium || null,
      campaign: body?.utm?.campaign || null,
    },
    // KAISA-436b (Google Ads): forward click IDs so bookings can be imported back to Ads (gclid match).
    // Frontend captures these into utm (index.html). CRM must accept + store gclid on the ticket.
    click_ids: (() => {
      const u = body?.utm || {};
      const ids = {};
      if (u.gclid)  ids.gclid  = u.gclid;
      if (u.gbraid) ids.gbraid = u.gbraid;
      if (u.wbraid) ids.wbraid = u.wbraid;
      if (u.fbclid) ids.fbclid = u.fbclid;
      return Object.keys(ids).length ? ids : null;
    })(),
  };
}

// ── 0% Installment consumer guide email ──────────────────────────────────────
function buildInstallmentGuideEmail(name) {
  const greeting = name ? `Tere, ${name}!` : 'Tere!';
  const section = (num, title, body) => `
  <tr><td style="background:#ffffff;padding:0 48px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="32" valign="top" style="padding-top:2px;">
          <span style="font-size:11px;font-weight:700;color:#87BE23;letter-spacing:0.05em;">${num}</span>
        </td>
        <td valign="top">
          <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#87BE23;margin:0 0 10px;">${title}</p>
          ${body}
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 48px;"><div style="height:1px;background:#F0EFED;margin:28px 0;"></div></td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F4F2;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F4F2;">
<tr><td align="center" style="padding:40px 16px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#0F0F0F;padding:28px 48px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td><span style="font-size:18px;font-weight:700;color:#87BE23;letter-spacing:-0.3px;">KSA</span><span style="font-size:18px;font-weight:300;color:#ffffff;letter-spacing:-0.3px;"> Silmakeskus</span></td>
      <td align="right"><span style="font-size:10px;font-weight:500;color:#888;letter-spacing:0.1em;text-transform:uppercase;">Järelmaksu juhend</span></td>
    </tr></table>
  </td></tr>

  <!-- Intro -->
  <tr><td style="background:#ffffff;padding:48px 48px 12px;">
    <p style="font-size:14px;color:#888;margin:0 0 20px;font-weight:400;">${greeting}</p>
    <h1 style="font-size:26px;font-weight:600;color:#0F0F0F;margin:0 0 20px;line-height:1.3;letter-spacing:-0.5px;">Flow3 protseduurile parimad järelmaksu tingimused 0%-se intressiga</h1>
    <p style="font-size:15px;color:#444;line-height:1.8;margin:0 0 12px;">Flow3 laserprotseduur maksab 2990 €. Inbanki ja LHV järelmaksu kasutades saad 16 kuud tasuda <strong style="color:#0F0F0F;">0% intressiga</strong> — ehk täpselt nii palju kui küsitakse, mitte senti rohkem.</p>
    <p style="font-size:15px;color:#444;line-height:1.8;margin:0;">Meie oleme pankadega klientide jaoks sellised head tingimused kokku leppinud — sinul on vaja ainult taotlus esitada.</p>
  </td></tr>

  <!-- Divider -->
  <tr><td style="background:#ffffff;padding:0 48px;"><div style="height:1px;background:#F0EFED;margin:36px 0 32px;"></div></td></tr>

  ${section('01', 'Kes kvalifitseerub?', `
    <ul style="font-size:14px;color:#444;line-height:2;margin:0 0 14px;padding-left:16px;">
      <li>Eesti resident vanuses 19–85 aastat</li>
      <li>Regulaarne sissetulek (palgatöö, ettevõte, pension, renditulu)</li>
      <li>Puhas krediidiajalugu — maksehäirete registris probleeme pole</li>
      <li>Suhe sissetulek/kohustused on mõistlik</li>
    </ul>
    <p style="font-size:13px;color:#888;line-height:1.7;margin:0;font-style:italic;">Nõuanne: kui sul on mõni väike laen või järelmaks, mille saaksid enne taotlust ära maksta — tee seda. See võib parandada su laenuvõimekust märgatavalt.</p>`)}

  ${section('02', 'Kuidas saada väiksem kuumakse?', `
    <ul style="font-size:14px;color:#444;line-height:2;margin:0 0 14px;padding-left:16px;">
      <li><strong style="color:#0F0F0F;">Pikem periood = väiksem kuumakse.</strong> Inbank pakub kuni 72 kuud (6 aastat). 2000 € jagatud 72 kuule = 40,93 €/kuus</li>
      <li><strong style="color:#0F0F0F;">Suurem sissemakse</strong> vähendab laenusummat ja kuumakset</li>
      <li>Ühistaotlus koos abikaasa/partneriga suurendab laenuvõimekust</li>
    </ul>
    <p style="font-size:13px;color:#888;line-height:1.7;margin:0;font-style:italic;">Nõuanne: Flow3 osamakse 60 kuul on vähem kui enamiku eestlaste kuised läätsekulu. Matemaatika töötab sinu kasuks.</p>`)}

  ${section('03', 'Mis juhtub, kui tahan varem tagasi maksta?', `
    <ul style="font-size:14px;color:#444;line-height:2;margin:0 0 14px;padding-left:16px;">
      <li>Saad igal ajal ennetähtaegselt tasuda — täielikult või osaliselt</li>
      <li>Lepingu lõpetamine enne 12 kuud: tasu järelmaksu jäägilt <strong style="color:#0F0F0F;">1%</strong></li>
      <li>Lepingu lõpetamine pärast 12 kuud: tasu järelmaksu jäägilt <strong style="color:#0F0F0F;">0,5%</strong></li>
    </ul>
    <p style="font-size:13px;color:#888;line-height:1.7;margin:0;font-style:italic;">Nõuanne: pikema perioodiga saad parima kuumakse. Kuumakset aitab vähendada ka sissemakse. Saad teha mõlemasse panka taotlused ja valida, mis sobib kõige paremini.</p>`)}

  ${section('04', 'Mida pead taotluseks ette valmistama?', `
    <ul style="font-size:14px;color:#444;line-height:2;margin:0;padding-left:16px;">
      <li>Isikut tõendav dokument (ID-kaart või pass)</li>
      <li>Pangakonto väljavõte viimase 3 kuu kohta <em>(mõnel juhul)</em></li>
      <li>FIE või ettevõtja — maksudeklaratsioon või raamatupidamisaruanne</li>
      <li>Palgatöötajal piisab sageli ainult isikukoodist — sissetulek kontrollitakse automaatselt</li>
    </ul>`)}

  ${section('05', 'Kuidas taotlus käib?', `
    <ol style="font-size:14px;color:#444;line-height:2;margin:0 0 14px;padding-left:16px;">
      <li>Broneeri Flow3 silmauuring (39 € tänase eripakkumisega)</li>
      <li>Uuring toimub — arst kinnitab, et sobid protseduurile</li>
      <li>KSA saadab sulle Inbanki/LHV taotluslingi</li>
      <li>Täidad taotluse veebis — otsus tuleb tavaliselt <strong style="color:#0F0F0F;">1–2 minuti jooksul</strong></li>
      <li>Protseduur toimub — maksad edaspidi kuumaksetena</li>
    </ol>
    <p style="font-size:13px;color:#888;line-height:1.7;margin:0;font-style:italic;">Nõuanne: tee taotlus enne protseduuri kuupäeva broneerimist, et vältida ootamist. Meie konsultant aitab kõiges.</p>`)}

  ${section('06', 'Lisainfo rahastamisvõimaluste kohta', `
    <ul style="font-size:14px;color:#444;line-height:2;margin:0 0 20px;padding-left:16px;">
      <li>Inbanki finantseerimislahendusele ei ole vaja tagatist ega raviplaani pärast protseduuri</li>
    </ul>
    <p style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#87BE23;margin:0 0 10px;">Maksa osades — alternatiivne võimalus</p>
    <ul style="font-size:14px;color:#444;line-height:2;margin:0;padding-left:16px;">
      <li>Ei ole krediiditoode — <strong style="color:#0F0F0F;">ei mõjuta su krediidiskoori</strong></li>
      <li>Flow3: <strong style="color:#0F0F0F;">490 € sissemaks</strong> + 12 × <strong style="color:#0F0F0F;">208,33 €/kuus</strong></li>
      <li>Kliendile alati tasuta — ei ole intressi, lepingutasu ega haldustasu</li>
    </ul>`)}

  <!-- CTA -->
  <tr><td style="background:#ffffff;padding:8px 48px 56px;text-align:center;">
    <p style="font-size:14px;color:#888;margin:0 0 24px;">Esimene samm: broneeri Flow3 silmauuring</p>
    <a href="https://booking.ksa.ee/?lang=et&promokood=${getDailyCode()}" style="display:inline-block;background:#87BE23;color:#0F0F0F;font-size:14px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:3px;letter-spacing:0.02em;">Broneeri uuring &rarr;</a>
    <p style="font-size:13px;color:#aaa;margin:24px 0 0;">Küsimused järelmaksu kohta? Meie konsultant võtab sinuga lähiajal ühendust.</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0F0F0F;padding:24px 48px;">
    <p style="font-size:12px;color:#555;margin:0;line-height:1.8;">KSA Silmakeskus · J. Vilmsi 5, Tallinn · Kvartali keskus, Riia mnt. 2, Tartu<br>
    <a href="tel:+3726445060" style="color:#87BE23;text-decoration:none;">+372 644 5060</a> · <a href="mailto:info@ksa.ee" style="color:#87BE23;text-decoration:none;">info@ksa.ee</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── Email content per language (Lilia's personal voice) ──────────────────────
const EMAIL = {
  ET: {
    greeting: 'Tere!',
    introGood: 'Tegid meie Flow3 kiirtesti ja sinu vastuste põhjal võiks Flow3 laserprotseduur sulle sobida. Kindla vastuse annab Flow3 silmauuring: 60 minutit optometristi ja silmaarsti juures (sh sarvkesta ja silmapõhja mõõtmised) ning kirjalik hinnang. Kui teed Flow3 või Flow Signature Line\'i protseduuri 60 päeva jooksul, arvestame selle hinnast maha uuringu täishinna 149 €. Uuring ei kohusta sind protseduuriks.',
    introConsult: 'Tegid meie Flow3 kiirtesti. Sinu vastuste põhjal sobib sulle nägemisuuring Audit — optometrist ja arst teevad põhjalikud uuringud ja saadavad kirjaliku raporti.',
    cta: 'Broneeri aeg — maksa veebis 39 €',
    ctaUrl: 'https://booking.ksa.ee/?lang=et&service=flow',
    ctaAudit: 'Broneeri nägemisuuring Audit',
    ctaAuditUrl: 'https://booking.ksa.ee/?lang=et&service=audit',
    introKids: 'Tegid meie Flow3 kiirtesti. Laste nägemine areneb kiiresti ja varajane kontroll on oluline. Meie spetsialistid teevad lapsele põhjaliku ja sõbraliku nägemiskontrolli.',
    ctaKids: 'Broneeri laste silmauuring',
    ctaKidsUrl: 'https://booking.ksa.ee/?lang=et&service=kids',
    contact: 'Kirjuta mulle: <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a> või helista: <a href="tel:+3726445060" style="color:#87BE23;">+372 644 5060</a>',
    signOff: 'Lilia<br><span style="font-weight:400;color:#888;">Kliendisuhete koordinaator · KSA Silmakeskus</span>',
  },
  EN: {
    greeting: 'Hello!',
    introGood: 'You completed our Flow3 quick test, and based on your answers the Flow3 laser procedure could suit you. The Flow3 eye exam gives the definite answer: 60 minutes with an optometrist and an eye doctor (including corneal and retinal measurements) and a written assessment. If you have Flow3 or Flow Signature Line within 60 days, we deduct the full exam price of 149 € from the procedure price. The exam does not commit you to the procedure.',
    introConsult: 'You completed our Flow3 quick test. Based on your answers, we recommend a Vision Audit exam — our optometrist and doctor will do a thorough assessment and send you a written report.',
    cta: 'Book your appointment — pay online €39',
    ctaUrl: 'https://booking.ksa.ee/?lang=en&service=flow',
    ctaAudit: 'Book Vision Audit exam',
    ctaAuditUrl: 'https://booking.ksa.ee/?lang=en&service=audit',
    introKids: 'You completed our Flow3 quick test. Children\'s vision develops fast and early checks matter. Our specialists give your child a thorough, friendly vision check.',
    ctaKids: 'Book a children\'s eye exam',
    ctaKidsUrl: 'https://booking.ksa.ee/?lang=en&service=kids',
    contact: 'Write to me: <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a> or call: <a href="tel:+3726445060" style="color:#87BE23;">+372 644 5060</a>',
    signOff: 'Lilia<br><span style="font-weight:400;color:#888;">Customer Relations Coordinator · KSA Eye Centre</span>',
  },
  RU: {
    greeting: 'Здравствуйте!',
    introGood: 'Вы прошли наш экспресс-тест Flow3, и по вашим ответам лазерная процедура Flow3 может вам подойти. Точный ответ даст обследование Flow3: 60 минут у оптометриста и глазного врача (в том числе измерения роговицы и глазного дна) и письменное заключение. Если вы сделаете процедуру Flow3 или Flow Signature Line в течение 60 дней, мы вычтем из ее цены полную стоимость обследования — 149 €. Обследование ни к чему вас не обязывает.',
    introConsult: 'Вы прошли наш экспресс-тест Flow3. По вашим ответам вам подойдёт обследование Audit — оптометрист и врач проведут детальную диагностику и составят письменное заключение.',
    cta: 'Записаться на приём — онлайн-оплата 39 €',
    ctaUrl: 'https://booking.ksa.ee/?lang=ru&service=flow',
    ctaAudit: 'Записаться на обследование Audit',
    ctaAuditUrl: 'https://booking.ksa.ee/?lang=ru&service=audit',
    introKids: 'Вы прошли наш экспресс-тест Flow3. Зрение детей развивается быстро, и ранняя проверка важна. Наши специалисты проведут ребенку полную и дружелюбную проверку зрения.',
    ctaKids: 'Записать ребенка на обследование',
    ctaKidsUrl: 'https://booking.ksa.ee/?lang=ru&service=kids',
    contact: 'Напишите мне: <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a> или позвоните: <a href="tel:+3726445060" style="color:#87BE23;">+372 644 5060</a>',
    signOff: 'Lilia<br><span style="font-weight:400;color:#888;">Координатор по работе с клиентами · KSA Silmakeskus</span>',
  },
};

// ── Promo code block per language ─────────────────────────────────────────────
const PROMO_TEXT = {
  ET: { label: 'Sinu sooduskood', sub: 'Allolev nupp lisab koodi broneeringule ise' },
  EN: { label: 'Your discount code', sub: 'The button below adds the code to your booking' },
  RU: { label: 'Ваш промокод', sub: 'Кнопка ниже сама добавит код к записи' },
};

// ── Personalised result block per language ────────────────────────────────────
function getResultBlock(lang, result, answers) {
  const good = result === 'good_candidate';

  const VISION_ET = { minus: 'lühinägelik', plus: 'kaugnägelik', astigmatism: 'astigmatismiga', muu: 'muu nägemishäire' };
  const VISION_EN = { minus: 'short-sighted', plus: 'long-sighted', astigmatism: 'astigmatism', muu: 'other vision issue' };
  const VISION_RU = { minus: 'близорукость', plus: 'дальнозоркость', astigmatism: 'астигматизм', muu: 'другое нарушение зрения' };

  // Prescription range → personalized sentence. Keys MUST match quiz option values in index.html.
  const PRESC_ET = {
    '-0.5 kuni -3':  'Sinu dioptriite vahemik on Flow3-le ideaalne — see on kõige ennustatavama tulemusega tsoon.',
    '-3 kuni -6':    'Sinu dioptriid sobivad Flow3 piirkonda — täpne sobivus kinnitub uuringul sarvkesta paksuse mõõtmisel.',
    '-6 kuni -9':    'Kõrgemad dioptriid nõuavad täpset hindamist — 75-minutiline Flow3 uuring annab selge vastuse.',
  };
  const PRESC_EN = {
    '-0.5 kuni -3':  'Your prescription range is ideal for Flow3 — this is the zone with the most consistent outcomes.',
    '-3 kuni -6':    'Your prescription falls within Flow3 range — exact suitability is confirmed by corneal thickness at the exam.',
    '-6 kuni -9':    'Higher prescriptions need careful assessment — the 75-minute Flow3 exam gives a clear answer.',
  };
  const PRESC_RU = {
    '-0.5 kuni -3':  'Ваш диапазон диоптрий идеален для Flow3 — это зона с наиболее предсказуемыми результатами.',
    '-3 kuni -6':    'Ваши диоптрии соответствуют диапазону Flow3 — точное соответствие подтверждается на обследовании.',
    '-6 kuni -9':    'Более высокие диоптрии требуют тщательной оценки — 75-минутное обследование Flow3 даст чёткий ответ.',
  };

  const prescMap = lang === 'EN' ? PRESC_EN : lang === 'RU' ? PRESC_RU : PRESC_ET;
  const visionMap = lang === 'EN' ? VISION_EN : lang === 'RU' ? VISION_RU : VISION_ET;
  const prescSentence = prescMap[answers.prescription] || '';

  if (lang === 'ET') {
    const headline = good ? '✅ Sobiv kandidaat' : 'ℹ️ Soovitame konsultatsiooni';
    const color = good ? '#2D6A00' : '#7A4F00';
    const bg = good ? '#F0FAE6' : '#FFF8E6';
    const border = good ? '#87BE23' : '#E0A030';
    const body = good
      ? `Sinu vastuste põhjal sobivad sinu silmad tõenäoliselt Flow3 laserprotseduurile. ${prescSentence} Järgmine samm: tasuta 75-minutiline Flow3 silmauuring, kus arst teeb täpsed mõõtmised ja kinnitab sobivuse.`
      : `Sinu vastuste põhjal soovitame enne otsust individuaalset konsultatsiooni KSA arstiga. See ei tähenda, et protseduur pole võimalik — vaid et su silmi tuleb lähemalt vaadata, enne kui saame täpse vastuse anda.`;
    return { headline, color, bg, border, body };
  } else if (lang === 'EN') {
    const headline = good ? '✅ Good candidate' : 'ℹ️ Consultation recommended';
    const color = good ? '#2D6A00' : '#7A4F00';
    const bg = good ? '#F0FAE6' : '#FFF8E6';
    const border = good ? '#87BE23' : '#E0A030';
    const body = good
      ? `Based on your answers, your eyes are likely suitable for Flow3 laser surgery. ${prescSentence} Next step: a free 75-minute Flow3 eye exam, where the doctor takes precise measurements and confirms suitability.`
      : `Based on your answers, we recommend an individual consultation with a KSA doctor before making a decision. This doesn't mean the procedure isn't possible — it just means we need to look more closely at your eyes before giving a precise answer.`;
    return { headline, color, bg, border, body };
  } else {
    const headline = good ? '✅ Подходящий кандидат' : 'ℹ️ Рекомендуем консультацию';
    const color = good ? '#2D6A00' : '#7A4F00';
    const bg = good ? '#F0FAE6' : '#FFF8E6';
    const border = good ? '#87BE23' : '#E0A030';
    const body = good
      ? `По вашим ответам ваши глаза, вероятно, подходят для лазерной процедуры Flow3. ${prescSentence} Следующий шаг: бесплатное 75-минутное обследование Flow3, в ходе которого врач сделает точные измерения и подтвердит соответствие.`
      : `По вашим ответам мы рекомендуем индивидуальную консультацию с врачом KSA перед принятием решения. Это не означает, что процедура невозможна — просто нам нужно внимательнее изучить ваши глаза, прежде чем дать точный ответ.`;
    return { headline, color, bg, border, body };
  }
}

// ── HTML email builder ─────────────────────────────────────────────────────────
function buildEmailHtml(lang, name, promoCode, result, answers) {
  const t = EMAIL[lang] || EMAIL.ET;
  const greeting = name ? `${t.greeting.replace('!', '')} ${name}!` : t.greeting;
  const isGood = result === 'good_candidate';

  // Lilia's intro paragraph
  const isKids = result === 'kids';
  const introText = isGood ? t.introGood : isKids ? t.introKids : t.introConsult;
  const introHtml = `
  <!-- INTRO -->
  <tr><td style="padding:4px 28px 20px;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.7;">${introText}</p>
  </td></tr>`;

  // Promo code block — only for good candidates
  const p = PROMO_TEXT[lang] || PROMO_TEXT.ET;
  const promoHtml = (promoCode && isGood) ? `
  <!-- PROMO CODE -->
  <tr><td style="padding:28px 28px 24px;background:#F6FCF0;border-top:3px solid #87BE23;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding-bottom:14px;">
          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#5A8A00;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px;">${p.label}</div>
          <div style="display:inline-block;background:#FFFFFF;border:2px dashed #87BE23;border-radius:8px;padding:12px 32px;">
            <span style="font-family:Courier New,Courier,monospace;font-size:32px;font-weight:700;color:#1A1A1A;letter-spacing:0.2em;">${promoCode}</span>
          </div>
        </td>
      </tr>
      <tr>
        <td align="center">
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
            <tr>
              <td style="font-family:Arial,sans-serif;font-size:22px;font-weight:700;color:#1A1A1A;padding-right:10px;">39&nbsp;€</td>
              <td style="font-family:Arial,sans-serif;font-size:14px;color:#999;text-decoration:line-through;padding-right:12px;">149&nbsp;€</td>
              <td style="font-family:Arial,sans-serif;font-size:12px;color:#5A8A00;font-weight:600;">Flow3 silmauuring</td>
            </tr>
          </table>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#888;margin-top:8px;">${p.sub}</div>
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  // 0% installment pill
  const PILL = {
    ET: { q: 'Ei jõua kohe maksta?', line1: 'Flow3 järelmaksuga <strong>~63&nbsp;€/kuus</strong> · praegune läätsekulu ~45&nbsp;€/kuus · <strong>vahe ainult 18&nbsp;€</strong>', line2: 'Pärast protseduuri säästad 45&nbsp;€/kuus igavesti · 0% intressiga — Inbank &amp; LHV' },
    EN: { q: "Can't pay all at once?", line1: 'Flow3 on instalment from <strong>~€63/month</strong> · current lens cost ~€45/month · <strong>difference just €18</strong>', line2: 'After the procedure you save €45/month forever · 0% interest — Inbank &amp; LHV' },
    RU: { q: 'Не можете оплатить сразу?', line1: 'Рассрочка Flow3 от <strong>~63&nbsp;€/мес</strong> · расходы на линзы ~45&nbsp;€/мес · <strong>разница всего 18&nbsp;€</strong>', line2: 'После процедуры экономите 45&nbsp;€/мес навсегда · 0% — Inbank и LHV' },
  };
  const pill = PILL[lang] || PILL.ET;
  const pillHtml = `
  <!-- INSTALLMENT PILL -->
  <tr><td style="padding:16px 28px;border-top:1px solid #F0EEE9;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F8FBF4;border-radius:6px;padding:0;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#1A1A1A;">💳 ${pill.q}</p>
        <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:12px;color:#374151;line-height:1.6;">${pill.line1}</p>
        <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#888;line-height:1.6;">${pill.line2}</p>
      </td></tr>
    </table>
  </td></tr>`;

  // CTA button — Audit link for not_ideal, Flow3 link for good
  const withPromoCode = (url, code) => {
    if (!code) return url;
    try {
      const u = new URL(url);
      u.searchParams.set('promokood', code);
      return u.toString();
    } catch (_) {
      return `${url}${url.includes('?') ? '&' : '?'}promokood=${encodeURIComponent(code)}`;
    }
  };
  // A minor's quiz routes to the children's exam (BLOGKIDS), never to Audit:
  // the Audit link with the kids code opened the wrong exam with a code it rejects.
  const ctaUrl = isGood
    ? withPromoCode(t.ctaUrl, promoCode)
    : withPromoCode(isKids ? t.ctaKidsUrl : t.ctaAuditUrl, promoCode);
  const ctaLabel = isGood ? t.cta : isKids ? t.ctaKids : t.ctaAudit;
  const ctaHtml = `
  <!-- CTA -->
  <tr><td style="padding:24px 28px 20px;text-align:center;">
    <a href="${ctaUrl}" style="display:inline-block;background:#87BE23;color:#0F0F0F;font-family:Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:16px 36px;border-radius:6px;letter-spacing:-0.2px;">${ctaLabel}</a>
  </td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EDECEA;font-family:Arial,Helvetica,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EDECEA;">
<tr><td align="center" style="padding:24px 12px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

  <!-- HEADER -->
  <tr><td style="background:#F5F5F3;padding:22px 28px 18px 28px;border-bottom:1px solid #DEDCD7;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td><span style="font-family:Arial,sans-serif;font-size:18px;font-weight:700;color:#87BE23;letter-spacing:-0.5px;">KSA</span><span style="font-family:Arial,sans-serif;font-size:12px;font-weight:400;color:#888;margin-left:5px;">Silmakeskus</span></td>
      <td align="right" style="padding-left:24px;white-space:nowrap;"><span style="font-family:Arial,sans-serif;font-size:11px;font-weight:600;color:#888;">Lilia</span></td>
    </tr></table>
  </td></tr>

  <!-- GREETING -->
  <tr><td style="padding:24px 28px 8px 28px;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;font-weight:600;color:#1A1A1A;">${greeting}</p>
  </td></tr>

  ${introHtml}

  ${promoHtml}

  ${isGood ? pillHtml : ''}

  ${ctaHtml}

  <!-- SIGN OFF -->
  <tr><td style="padding:20px 28px 24px 28px;border-top:1px solid #F0EEE9;">
    <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:13px;color:#374151;line-height:1.6;">${t.contact}</p>
    <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;font-weight:600;color:#1A1A1A;">${t.signOff}</p>
    <p style="margin:6px 0 0;font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;">Tallinn: J. Vilmsi 5 &nbsp;|&nbsp; Tartu: Kvartali keskus, Riia mnt. 2</p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#F5F5F3;padding:12px 28px;border-top:1px solid #DEDCD7;text-align:center;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;"><a href="https://ksa.ee" style="color:#87BE23;text-decoration:none;">ksa.ee</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// Subject line builder
function getSubject(lang, result) {
  const SUBJECTS = {
    ET: { good: 'Sinu kiirtesti tulemus: Flow3 uuring 39 €', audit: 'Sinu kiirtesti tulemus: nägemisuuring Audit', other: 'Sinu kiirtesti tulemus — KSA Silmakeskus' },
    EN: { good: 'Your quick test result: Flow3 exam for 39 €', audit: 'Your quick test result: Vision Audit exam', other: 'Your quick test result — KSA Eye Centre' },
    RU: { good: 'Результат теста: обследование Flow3 за 39 €', audit: 'Результат теста: обследование Audit', other: 'Ваш результат экспресс-теста — KSA Silmakeskus' },
  };
  const s = SUBJECTS[lang] || SUBJECTS.ET;
  if (result === 'good_candidate') return s.good;
  return result === 'audit' ? s.audit : s.other;
}

// ── Detect language from lp_source or language field ─────────────────────────
function detectLang(lp_source, language) {
  if (lp_source) {
    if (lp_source.includes('-EN')) return 'EN';
    if (lp_source.includes('-RU')) return 'RU';
  }
  if (language) {
    const l = language.toUpperCase();
    if (l === 'EN') return 'EN';
    if (l === 'RU') return 'RU';
  }
  return 'ET';
}

function valueOrDash(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function isQualifiedFlow3Answers(answers = {}) {
  const eligibleAge = ['18-25', '26-35', '36-45', '18_45'].includes(String(answers.age || answers.age_band || ''));
  const vision = String(answers.vision || answers.vision_issue || '').toLowerCase();
  const isMinus = vision === 'miinus' || vision === 'myopia' || vision.includes('minus') || vision.includes('myop');
  const prescription = String(answers.prescription || '').toLowerCase();
  const tooHighMinus = prescription.includes('rohkem kui -9') || prescription.includes('more than -9') || prescription.includes('больше -9');
  return eligibleAge && isMinus && !tooHighMinus;
}

function leadIntent(answers = {}, explicit) {
  if (explicit) return explicit;
  const parts = [];
  if (answers.interest) parts.push(`interest:${answers.interest}`);
  if (answers.painpoint) parts.push(`pain:${answers.painpoint}`);
  if (answers.lenses) parts.push(`lenses:${answers.lenses}`);
  return parts.join(' | ') || '—';
}

function leadAnswers(body, fallback = {}) {
  return body?.lead_context?.answers || body?.answers || fallback || {};
}

function leadPhone(body) {
  return body?.phone || body?.contact?.phone || body?.lead_context?.phone || null;
}

function leadName(body) {
  return body?.name || body?.contact?.name || body?.lead_context?.name || null;
}

function leadEmail(body) {
  return body?.email || body?.contact?.email || body?.lead_context?.email || null;
}

function leadVariant(body) {
  return body?.ab_variant || body?.lead_context?.ab_variant || body?.utm?.ab_variant || null;
}

function hasContactData(...values) {
  return values.some((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

async function sendInternalEventLedger({ subject, rows = [] }) {
  if (!RESEND_API_KEY || !subject) return;
  // Lilia request 2026-06-08: don't email registreerumised@ksa.ee for ledger
  // entries that carry no actionable contact info (anonymous quiz completions,
  // booking-click diagnostics with empty phone/email). They just take attention.
  // Heuristic: keep the ledger if either Phone or E-post row carries a value
  // that isn't a dash. Slack ping still fires independently of this email.
  const hasActionableContact = rows.some(([label, value]) => {
    if (!label) return false;
    const isContactRow = /^(Telefon|Phone|E-post|E-mail|Email)$/i.test(String(label).trim());
    const v = value === undefined || value === null ? '' : String(value).trim();
    return isContactRow && v !== '' && v !== '—';
  });
  if (!hasActionableContact) {
    console.log('Skip internal ledger email (no actionable contact):', subject);
    return;
  }
  const safeRows = rows
    .filter((row) => row && row[0])
    .map(([label, value]) => `<tr><td style="color:#888;padding:4px 10px 4px 0;">${label}</td><td style="padding:4px 0;"><strong>${value === undefined || value === null || value === '' ? '—' : String(value)}</strong></td></tr>`)
    .join('');
  const html = `<p><strong>KSA Kiirtest event ledger</strong></p>
<table cellpadding="0" cellspacing="0" style="font-size:13px;font-family:Arial,sans-serif;border-collapse:collapse;">
${safeRows}
</table>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [INTERNAL_NOTIFY_EMAIL],
        reply_to: 'info@ksa.ee',
        subject,
        html,
      }),
    });
  } catch (err) {
    console.error('Internal event ledger error:', err);
  }
}

function leadFields({ answers = {}, lang, name, phone, email, adSource, intent, code, extra = [] }) {
  const fields = [];
  if (name) fields.push({ type: 'mrkdwn', text: `*Nimi:*\n${valueOrDash(name)}` });
  if (phone) fields.push({ type: 'mrkdwn', text: `*Telefon:*\n<tel:${phone}|${phone}>` });
  if (email) fields.push({ type: 'mrkdwn', text: `*E-post:*\n${valueOrDash(email)}` });
  fields.push(
    { type: 'mrkdwn', text: `*Keel:*\n${valueOrDash(lang)}` },
    { type: 'mrkdwn', text: `*Allikas:*\n${valueOrDash(adSource)}` },
    { type: 'mrkdwn', text: `*Soov / intent:*\n${valueOrDash(intent)}` },
    { type: 'mrkdwn', text: `*Vanus:*\n${valueOrDash(answers.age || answers.age_band)}` },
    { type: 'mrkdwn', text: `*Nägemine:*\n${valueOrDash(answers.vision || answers.vision_issue)}` },
    { type: 'mrkdwn', text: `*Dioptrid:*\n${valueOrDash(answers.prescription || answers.prescription_sphere)}` },
    { type: 'mrkdwn', text: `*Läätsed:*\n${valueOrDash(answers.lenses)}` },
  );
  const meta = [];
  if (code) meta.push(`*Sooduskood:*\n${code}`);
  extra.forEach((item) => {
    if (item && item.text) meta.push(item.text);
  });
  if (meta.length) fields.push({ type: 'mrkdwn', text: meta.join('\n') });
  return fields.slice(0, 10);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOAP OPERA SEQUENCE — 6 follow-up emails (Brunson framework)
// Triggered automatically on email_captured. ET + EN. RU by Lilia.
// ══════════════════════════════════════════════════════════════════════════════

function buildSeqHtml(bodyHtml, ctaUrl, ctaText) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EDECEA;font-family:Arial,Helvetica,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EDECEA;">
<tr><td align="center" style="padding:24px 12px;">
<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
  <tr><td style="background:#F5F5F3;padding:20px 28px;border-bottom:1px solid #DEDCD7;">
    <span style="font-size:18px;font-weight:700;color:#87BE23;letter-spacing:-0.5px;">KSA</span>
    <span style="font-size:12px;font-weight:400;color:#888;margin-left:6px;">Silmakeskus</span>
  </td></tr>
  <tr><td style="padding:28px 28px 8px 28px;">${bodyHtml}</td></tr>
  ${ctaUrl ? `<tr><td style="padding:8px 28px 28px 28px;text-align:center;">
    <a href="${ctaUrl}" style="display:inline-block;background:#87BE23;color:#0F0F0F;font-family:Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:6px;">${ctaText || 'Broneeri →'}</a>
  </td></tr>` : ''}
  <tr><td style="background:#F5F5F3;padding:12px 28px;border-top:1px solid #DEDCD7;text-align:center;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;"><a href="https://ksa.ee" style="color:#87BE23;text-decoration:none;">ksa.ee</a> &nbsp;·&nbsp; Tallinn: J. Vilmsi 5 &nbsp;·&nbsp; Tartu: Riia mnt. 2</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const sp = (t) => `<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.75;">${t}</p>`;
const sh = (t) => `<p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#1A1A1A;">${t}</p>`;
const sl = (items) => `<ul style="margin:0 0 14px;padding-left:18px;">${items.map(i => `<li style="font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:1.75;margin-bottom:5px;">${i}</li>`).join('')}</ul>`;
const ssig = (name, title) => `<p style="margin:24px 0 0;font-family:Arial,sans-serif;font-size:13px;color:#374151;border-top:1px solid #F0EEE9;padding-top:16px;"><strong>${name}</strong><br><span style="color:#888;">${title}</span></p>`;

const SEQUENCE = {
  ET: [
    {
      delayHours: 24,
      subject: '27-st KSA töötajast 26 tegi sama otsuse...',
      build: (code) => buildSeqHtml(
        sp('Lilia siin, KSA-st. Meie kliiniku töötajates <strong>26 inimest, kaasa arvatud mina</strong>, on teinud Flow3 protseduuri ise.') +
        sp('Mitte sellepärast, et keegi käskis — vaid sellepärast, et me nägime iga päev tulemusi, kui meie kliendid käisid järelkontrollides. Me ei soovita klientidele teenuseid, mida me ise endale ei teeks.') +
        sp('Sinu online\'s tehtud kiirtesti tulemus näitas, et sobiksid tulema Flow3 uuringule, kus selguks, kas laserprotseduur oleks sinu silmadele parim lahendus. Kahjuks 30%-le uuringule tulijatest ütleme "EI".') +
        sp('Uuring sooduskoodiga vaid <strong>39€</strong> (tavahind 149€).') +
        ssig('Lilia', 'Kliendisuhete koordinaator · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Uuri kas sa kvalifitseerud Flow3-ks — 39€ →'
      ),
    },
    {
      delayHours: 72,
      subject: 'Mida optikapoed või prillipoe arstid sulle ei räägi?',
      build: (code) => buildSeqHtml(
        sp('Eestis on ligi 400 000 prilli- ja läätsekandjat. Optikafirmade käive on seetõttu soliidne — ja keegi sealt ei tule sulle ütlema, et kaaluks hoopis laserprotseduuri.') +
        sh('Faktid räägivad selget keelt:') +
        sl([
          'Läätsedega ujudes on silmapõletiku risk <strong>50-kordne</strong>.',
          'Prillide + läätsede kulu 10 aasta jooksul: <strong>3500–7000€</strong>. Flow3 laserprotseduur on ühekordne kulu, järelmaksu kuumakse algab vaid <strong>63€-st kuus</strong>.',
        ]) +
        sp('Flow3 ei sobi kõigile — sellepärast on uuringul käimine vajalik, et teada saada, kas kuulud 70% hulka kellele anname rohelise tule, või oled 30% hulgas, kellele ütleme selge "Ei".') +
        sp('Sinu sooduskood kehtib veel, et saaksid tulla uuringule <strong>39€-ga</strong> 149 asemel.') +
        ssig('Lilia', 'Kliendisuhete koordinaator · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Uuri kas su silmad sobivad Flow3-ks →'
      ),
    },
    {
      delayHours: 120,
      subject: 'Miks ma 30 aastat tagasi selle töö valisin',
      build: (code) => buildSeqHtml(
        sp('Tere, Dr. Ants Haavel siin KSA Silmakeskusest. Esimest korda kui nägin, kuidas inimene pärast laserprotseduuri nägi väga selgelt ilma prillita — sain aru, miks see töö on oluline.') +
        sp('Kui alustasin, arvasin, et KSA missioon on vaid muuta nägemine teravaks, kuid peagi saime aru, et kogu meie klientide elu muutus! Kõik elu aspektid on tulevikus teisiti, peale seda, kui nägemiskvaliteet on parem.') +
        sp('Me täna ei tea, kas Flow3 laserprotseduur võiks muuta ka Sinu elu paremaks, sest 30% inimestest, kes tunduvad sobivat, ei sobi meie valikukriteeriumide põhjal. Selleks ongi Flow3 uuring — et teada saada, kas saaksid kaaluda meie laserprotseduuri.') +
        sp('Kui teed esimese sammu ja registreerud uuringule, saame anda endast parima ja välja selgitada, kas sobiksid.') +
        ssig('Dr. Ants Haavel', 'KSA Silmakeskus, juhataja · silmakirurg 30+ aastat'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Uuri kas sa kvalifitseerud Flow3-ks — 39€ →'
      ),
    },
    {
      delayHours: 168,
      subject: '"7 päeva pärast olin tagasi matil" — Ekke lugu',
      build: (code) => buildSeqHtml(
        sp('Lilia siin. Tahan jagada lugu, mida Ekke Kõu Leitham ise rääkis — 8-kordne Eesti maadlusmeister, kellele treening on eluviis.') +
        sp('Ta pelgas kaua treeningutest eemal olla, aga juba 7. päeva pärast Flow3 laserprotseduuri oli ta tagasi maadlusmatil.') +
        sp('<em>"Kohe kui laseriruumist lahkusin, nägin juba palju selgemalt. Nädala pärast tegin täie hooga trenni ja 2 nädala pärast nägin juba 100% — see kõik oli nii imelik. Hea, aga imelik."</em>') +
        sp('Uuring <strong>39€.</strong>') +
        ssig('Lilia', 'Kliendisuhete koordinaator · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Uuri kas sa sobid Flow3-ks — 39€ →'
      ),
    },
    {
      delayHours: 240,
      subject: '5 asja, mida inimesed kardavad silmade laserprotseduuridel',
      build: (code) => buildSeqHtml(
        sp('Lilia siin. Olen aastaid KSA-s töötanud ja rääkinud tuhandete inimestega, kes Flow3-t kaaluvad. Siin on ausad vastused kõige sagedamini kuuldavatele küsimustele.') +
        sp('<strong>"Mis võib valesti minna?"</strong><br>21 aasta jooksul pole KSA-s olnud mitte ühtegi ektaasia juhtumit. See pole juhus — see on protokoll, tehnika ja range patsiendivalik.') +
        sp('<strong>"Kas protseduur on valulik?"</strong><br>Valutu. Silmad tuimestatakse tilkadega ja protseduur võtab vaid mõned minutid.') +
        sp('<strong>"Mis kui minu silmadele ei sobi laserprotseduur?"</strong><br>Saad vastuse Flow3 uuringul. ~30%-le ütleme "ei sobi" — ja seda ütleme ausalt välja.') +
        sp('<strong>"Liiga kallis."</strong><br>Järelmaksuga <strong>63€/kuus</strong>. 30 aasta jooksul säästad 18 000 eurot, mida muidu kulutaksid prillide ja läätsedega.') +
        sp('<strong>"Ootan veel."</strong><br>Iga aasta ootamist maksab ~500 eurot. Ootamine ei tee seda odavamaks.') +
        sp('Küsimusi? Kirjuta mulle — <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a>. Uuring <strong>39€.</strong>') +
        ssig('Lilia', 'Kliendisuhete koordinaator · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Uuri kas sinu silmad sobivad — 39€ →'
      ),
    },
    {
      delayHours: 336,
      subject: 'Viimane kiri KSA-st',
      build: (code) => buildSeqHtml(
        sp('Lilia siin. Miks me pakkusime Sulle Flow3 uuringut 39 euroga 149 asemel? Sellel oli kindel põhjus.') +
        sp('Keskmine prilli- ja läätsekandja kulutab iga kuu 46 eurot terava nägemise peale — ja see kulu on elu lõpuni. Juhul, kui teed protseduuri, maksab see vaid alates 63 eurot mõned aastad, ja seejärel on Sinu kulu null. Nii säästaksid edaspidi kuni <strong>18 000 eurot</strong>.') +
        sp('Selleks, et teada, kas Sul oleks juba täna raha protseduurile tulemiseks olemas, ongi meie poolt <strong>finantstest</strong>: 63 − 46 = <strong>17 eurot</strong>. Kui saad lubada endale täna 39-eurost uuringut, ilma et see Sind rahaliselt jalust niidaks, näitab see tõsiasi, et kogu raha protseduuriks on Sul juba täna olemas.') +
        sp('Nüüd on vaid vaja välja selgitada, kas laserprotseduur oleks Sinu silmadele parim valik.') +
        sp('Kui Sul on küsimusi, helista <a href="tel:+3726445060" style="color:#87BE23;">644 5060</a> ja küsi Liliat — või broneeri otse uuring online\'s.') +
        ssig('Lilia', 'Kliendisuhete koordinaator · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=et&promokood=${code}`,
        'Viimane võimalus: uuri kas sa kvalifitseerud — 39€ →'
      ),
    },
  ],

  EN: [
    {
      delayHours: 24,
      subject: '26 of our staff have done it themselves...',
      build: (code) => buildSeqHtml(
        sp('Lilia here, from KSA. Out of our clinic\'s staff, <strong>26 people — including myself</strong> — have had the Flow3 procedure.') +
        sp('Not because anyone told us to — but because we see the results every day when our patients come back for check-ups. We don\'t recommend services to clients that we wouldn\'t choose for ourselves.') +
        sp('Your online quick test showed you could be a candidate for the Flow3 exam, where we\'d find out whether laser surgery is the best solution for your eyes. Unfortunately, for 30% of people who come for the exam, our answer is "no".') +
        sp('Exam with promo code: <strong>€39</strong> (regular price €149).') +
        ssig('Lilia', 'Customer Relations Coordinator · KSA Eye Centre'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Find out if you qualify for Flow3 — €39 →'
      ),
    },
    {
      delayHours: 72,
      subject: 'What optical shops and their doctors don\'t tell you',
      build: (code) => buildSeqHtml(
        sp('There are nearly 400,000 glasses and contact lens wearers in Estonia. Optical retail is a solid business — and nobody there will come to you and say you should consider laser surgery instead.') +
        sh('The facts speak clearly:') +
        sl([
          'Swimming with contacts increases the risk of eye infection <strong>50-fold</strong>.',
          'Glasses + contacts over 10 years: <strong>€3,500–7,000</strong>. Flow3 is a one-time cost — monthly instalments from just <strong>€63/month</strong>.',
        ]) +
        sp('Flow3 isn\'t right for everyone — that\'s exactly why the exam exists: to find out whether you\'re among the 70% who get the green light, or the 30% who get an honest "no".') +
        sp('Your promo code is still valid — come for the exam at <strong>€39</strong> instead of €149.') +
        ssig('Lilia', 'Customer Relations Coordinator · KSA Eye Centre'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Find out if your eyes qualify for Flow3 →'
      ),
    },
    {
      delayHours: 120,
      subject: 'Why I chose this work 30 years ago',
      build: (code) => buildSeqHtml(
        sp('Hello, Dr. Ants Haavel here from KSA Eye Centre. The first time I saw a patient after laser surgery seeing clearly without glasses — I understood why this work matters.') +
        sp('When I started out, I thought KSA\'s mission was simply to sharpen vision. But we quickly realised that our patients\' entire lives changed. Every aspect of life is different once vision quality improves.') +
        sp('We don\'t know today whether Flow3 could change your life for the better — because 30% of people who seem suitable don\'t meet our selection criteria. That\'s exactly what the Flow3 exam is for: to find out whether you could consider our laser procedure.') +
        sp('If you take the first step and book the exam, we\'ll do our best to find out whether you\'re suitable.') +
        ssig('Dr. Ants Haavel', 'KSA Eye Centre, CEO · Eye surgeon 30+ years'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Find out if you qualify for Flow3 — €39 →'
      ),
    },
    {
      delayHours: 168,
      subject: '"7 days later I was back on the mat" — Ekke\'s story',
      build: (code) => buildSeqHtml(
        sp('Lilia here. I want to share a story that Ekke Kõu Leitham told me himself — an 8-time Estonian wrestling champion, for whom training is a way of life.') +
        sp('He dreaded being away from training for a long time. But just 7 days after the Flow3 procedure, he was back on the wrestling mat.') +
        sp('<em>"As soon as I left the laser room I could already see much more clearly. A week later I was training at full intensity, and after 2 weeks my vision was 100% — it was all so strange. Good strange."</em>') +
        sp('Exam <strong>€39.</strong>') +
        ssig('Lilia', 'Customer Relations Coordinator · KSA Eye Centre'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Find out if your eyes qualify for Flow3 →'
      ),
    },
    {
      delayHours: 240,
      subject: '5 things people fear about laser eye surgery',
      build: (code) => buildSeqHtml(
        sp('Lilia here. I\'ve worked at KSA for years and spoken with thousands of people considering Flow3. Here are honest answers to the most common concerns.') +
        sp('<strong>"What could go wrong?"</strong><br>In 21 years, KSA has had zero ectasia cases. Not luck — it\'s protocol, technique, and strict patient selection.') +
        sp('<strong>"Is the procedure painful?"</strong><br>Painless. Eyes are numbed with drops and the procedure takes only a few minutes.') +
        sp('<strong>"What if laser surgery isn\'t right for my eyes?"</strong><br>You\'ll get your answer at the Flow3 exam. We tell ~30% that it\'s not suitable — and we say so honestly.') +
        sp('<strong>"Too expensive."</strong><br>On instalments: <strong>€63/month</strong>. Over 30 years you\'d save €18,000 that would otherwise go on glasses and contacts.') +
        sp('<strong>"I\'ll wait."</strong><br>Every year of waiting costs ~€500. Waiting doesn\'t make it cheaper.') +
        sp('Questions? Write to me — <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a>. Exam <strong>€39.</strong>') +
        ssig('Lilia', 'Customer Relations Coordinator · KSA Eye Centre'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Find out if your eyes qualify for Flow3 →'
      ),
    },
    {
      delayHours: 336,
      subject: 'Last email from KSA',
      build: (code) => buildSeqHtml(
        sp('Lilia here. Why did we offer you the Flow3 exam for €39 instead of €149? There was a specific reason.') +
        sp('The average glasses or contact lens wearer spends €46 per month on clear vision — for life. If you have the procedure, the cost is from €63/month for a few years, then zero. You\'d save up to <strong>€18,000</strong> going forward.') +
        sp('To find out whether you already have the money for the procedure today, here\'s our <strong>financial test</strong>: 63 − 46 = <strong>€17</strong>. If you can afford today\'s €39 exam without it hitting you financially, that fact shows the money for the full procedure is already there.') +
        sp('All that remains is to find out whether laser surgery is the best choice for your eyes.') +
        sp('If you have questions, call <a href="tel:+3726445060" style="color:#87BE23;">644 5060</a> and ask for Lilia — or book your exam directly online.') +
        ssig('Lilia', 'Customer Relations Coordinator · KSA Eye Centre'),
        `https://booking.ksa.ee/?lang=en&promokood=${code}`,
        'Last chance: find out if you qualify — €39 →'
      ),
    },
  ],
  RU: [
    {
      delayHours: 24,
      subject: '26 из 27 сотрудников KSA сделали этот выбор...',
      build: (code) => buildSeqHtml(
        sp('На связи Лилия из KSA. В нашей клинике уже <strong>26 человек, включая меня</strong>, сделали процедуру Flow3.') +
        sp('И дело не в том, что нам так приказали — просто мы каждый день видели результаты наших клиентов, когда они приходили на контрольные осмотры. Мы не рекомендуем клиентам услуги, которые не выбрали бы для себя.') +
        sp('Ваш онлайн-тест показал, что вы — подходящий кандидат для обследования Flow3. Оно поможет окончательно выяснить, станет ли лазерная процедура лучшим решением для ваших глаз. К сожалению, 30% пришедших на обследование мы вынуждены сказать «НЕТ».') +
        sp('Обследование по промокоду — всего <strong>39 €</strong> (обычная цена 149 €).') +
        ssig('Лилия', 'Координатор по работе с клиентами · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Узнайте, подходит ли вам Flow3 — 39 € →'
      ),
    },
    {
      delayHours: 72,
      subject: 'О чём вам не расскажут в магазинах оптики?',
      build: (code) => buildSeqHtml(
        sp('В Эстонии почти 400 000 человек носят очки или линзы. Оборот компаний в сфере оптики огромен — неудивительно, что никто из них не предложит вам рассмотреть лазерную коррекцию как альтернативу.') +
        sh('Факты говорят сами за себя:') +
        sl([
          'При плавании в линзах риск воспаления глаз возрастает в <strong>50 раз</strong>.',
          'Расходы на очки и линзы за 10 лет: от <strong>3500 до 7000 €</strong>. Лазерная процедура Flow3 — разовое вложение, ежемесячный платёж по рассрочке от <strong>63 €</strong>.',
        ]) +
        sp('Flow3 подходит не всем. Именно поэтому необходимо пройти обследование: так мы узнаем, входите ли вы в те 70%, кому мы даём «зелёный свет», или же вы в числе тех 30%, кому мы скажем чёткое «нет».') +
        sp('Ваш промокод всё ещё действует — пройдите обследование всего за <strong>39 €</strong> вместо 149 €.') +
        ssig('Лилия', 'Координатор по работе с клиентами · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Узнайте, подходят ли ваши глаза для Flow3 →'
      ),
    },
    {
      delayHours: 120,
      subject: 'Почему 30 лет назад я выбрал именно эту работу',
      build: (code) => buildSeqHtml(
        sp('Здравствуйте! На связи доктор Антс Хаавель из глазного центра KSA. Когда я впервые увидел, как человек после лазерной процедуры обрёл чёткое зрение без очков, я понял, почему эта работа так важна.') +
        sp('В начале пути я думал, что миссия KSA — просто сделать зрение острым. Но вскоре мы осознали: меняется вся жизнь наших клиентов! После улучшения качества зрения все аспекты жизни в будущем становятся иными.') +
        sp('Сегодня мы ещё не знаем, сможет ли процедура Flow3 изменить к лучшему и вашу жизнь — 30% людей, которые на первый взгляд кажутся подходящими, не проходят наш строгий отбор. Именно для этого и проводится обследование Flow3: чтобы выяснить, подходит ли вам наша лазерная процедура.') +
        sp('Если вы сделаете первый шаг и запишетесь на обследование, мы приложим все усилия, чтобы определить, подходит ли вам этот метод.') +
        ssig('Д-р Антс Хаавель', 'Руководитель клиники · глазной хирург, 30+ лет опыта'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Узнайте, подходит ли вам Flow3 — 39 € →'
      ),
    },
    {
      delayHours: 168,
      subject: 'Через 7 дней я уже был на ковре — история Экке Кыу Лейтама',
      build: (code) => buildSeqHtml(
        sp('На связи Лилия. Хочу поделиться историей, которую рассказал нам Экке Кыу Лейтам — 8-кратный чемпион Эстонии по борьбе, для которого тренировки — это образ жизни.') +
        sp('Он долго опасался, что надолго выпадет из тренировочного процесса, но уже через 7 дней после лазерной процедуры Flow3 он вернулся на борцовский ковёр.') +
        sp('<em>«Как только я вышел из лазерного кабинета, я сразу стал видеть гораздо чётче. Через неделю я уже тренировался в полную силу, а через две недели зрение восстановилось на 100% — всё это было так необычно. Классно, но необычно».</em>') +
        sp('Обследование — <strong>39 €</strong>.') +
        ssig('Лилия', 'Координатор по работе с клиентами · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Узнайте, подходят ли ваши глаза для Flow3 →'
      ),
    },
    {
      delayHours: 240,
      subject: '5 вещей, которых люди боятся при лазерной коррекции зрения',
      build: (code) => buildSeqHtml(
        sp('На связи Лилия. Я работаю в KSA уже много лет и пообщалась с тысячами людей, которые задумываются о Flow3. Вот честные ответы на самые частые вопросы.') +
        sp('<strong>«Что может пойти не так?»</strong><br>За 21 год в KSA не было ни одного случая эктазии. Это не случайность, а результат чётких протоколов, технологий и строгого отбора пациентов.') +
        sp('<strong>«Болезненна ли процедура?»</strong><br>Нет, она безболезненна. Используются обезболивающие капли, и весь процесс занимает всего несколько минут.') +
        sp('<strong>«Что если моим глазам не подходит лазер?»</strong><br>Ответ вы получите на обследовании Flow3. Примерно 30% кандидатов мы говорим «не подходит» — и говорим это честно.') +
        sp('<strong>«Слишком дорого».</strong><br>При оплате в рассрочку — от <strong>63 € в месяц</strong>. За 30 лет вы сэкономите около 18 000 €, которые иначе ушли бы на очки и линзы.') +
        sp('<strong>«Я ещё подожду».</strong><br>Каждый год ожидания обходится примерно в 500 €. Дешевле от этого процедура не станет.') +
        sp('Есть вопросы? Напишите мне — <a href="mailto:lilia@ksa.ee" style="color:#87BE23;">lilia@ksa.ee</a>. Обследование — <strong>39 €</strong>.') +
        ssig('Лилия', 'Координатор по работе с клиентами · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Узнайте, подходят ли ваши глаза для Flow3 →'
      ),
    },
    {
      delayHours: 336,
      subject: 'Последнее письмо от KSA',
      build: (code) => buildSeqHtml(
        sp('На связи Лилия. Почему мы предложили вам обследование Flow3 всего за 39 € вместо 149 €? На это была конкретная причина.') +
        sp('В среднем человек, носящий очки или линзы, тратит на чёткое зрение около 46 € каждый месяц — и эти расходы сопровождают его всю жизнь. Если же вы сделаете процедуру, она будет стоить от 63 € в месяц в течение нескольких лет, а после — ваши расходы станут нулевыми. Так в будущем вы сэкономите до <strong>18 000 €</strong>.') +
        sp('Чтобы понять, есть ли у вас средства на процедуру уже сегодня, мы предлагаем простой <strong>финансовый тест</strong>: 63 − 46 = <strong>17 €</strong>. Если вы можете позволить себе обследование за 39 € без ущерба для бюджета, это доказывает, что вся сумма для процедуры у вас фактически уже есть.') +
        sp('Теперь осталось лишь выяснить, является ли лазерная коррекция лучшим решением именно для ваших глаз.') +
        sp('Если у вас есть вопросы, позвоните по номеру <a href="tel:+3726445060" style="color:#87BE23;">644 5060</a>, спросите Лилию — или забронируйте обследование прямо на сайте.') +
        ssig('Лилия', 'Координатор по работе с клиентами · KSA Silmakeskus'),
        `https://booking.ksa.ee/?lang=ru&promokood=${code}`,
        'Последний шанс: узнайте, подходит ли вам Flow3 — 39 € →'
      ),
    },
  ],
};

async function scheduleSequence(email, lang, promoCode) {
  const steps = SEQUENCE[lang] || SEQUENCE.ET;
  const sent = [];
  for (const step of steps) {
    const scheduledAt = new Date(Date.now() + step.delayHours * 3_600_000).toISOString();
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [email],
          reply_to: 'lilia@ksa.ee',
          subject: step.subject,
          html: step.build(promoCode),
          scheduled_at: scheduledAt,
        }),
      });
      const json = await res.json();
      if (res.ok) { sent.push(`+${step.delayHours}h:${json.id}`); }
      else { console.error(`Seq +${step.delayHours}h err:`, JSON.stringify(json)); }
    } catch (err) {
      console.error(`Seq +${step.delayHours}h fetch err:`, err);
    }
  }
  if (sent.length) console.log(`Sequence queued → ${email} (${lang}): ${sent.join(', ')}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // ── CORS for LP cross-origin requests ────────────────────────────────────
  const origin = req.headers.origin || '';
  const ALLOWED_ORIGINS = [
    'https://kiirtest.ksa.ee',
    'https://glasses.ksa.ee',
    'https://sports.ksa.ee',
    'https://finance.ksa.ee',
    'https://besttime.ksa.ee',
    'https://timetax.ksa.ee',
    'https://benefit.ksa.ee',
    // Vercel preview URLs (LPs)
  ];
  const isAllowedOrigin =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);

  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Track-Source');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { type, result, language, lp_source, answers: rawAnswers = {}, contact, promoCode: clientPromoCode, utm, timestamp } = body;
  const answers = rawAnswers || {};
  const adSource = await utmLabel(utm);
  const ts = new Date(timestamp || Date.now()).toLocaleString('et-EE', { timeZone: 'Europe/Tallinn' });

  // ── Diagnostics / test event suppression ─────────────────────────────────────
  // Ants 2026-06-23: Slack #kiirtesti-täitmised + registreerumised@ksa.ee feeds
  // should stay clean. Drop any payload that looks like an internal smoke /
  // diagnostic / test ping — these come from our own daily 07:00/19:00 cron and
  // ad-hoc curl smoke tests. Real leads never carry these markers.
  const isTestPayload = (function () {
    const norm = (v) => String(v || '').toLowerCase().trim();
    const email = norm(body?.email || body?.contact?.email || body?.lead_context?.email);
    const name = String(body?.name || body?.contact?.name || body?.lead_context?.name || '');
    const code = norm(body?.code);
    const promo = norm(clientPromoCode);
    const utmSrc = norm(utm?.source);
    if (email === 'diagnostics-test@ksa.ee') return true;
    if (/^test\+|\+test@|@example\.(com|ee)$|smoke[-_]?test/i.test(email)) return true;
    if (code === 'flow-test' || promo === 'flow-test') return true;
    if (/^\s*TEST\s/.test(name)) return true;                    // Mai's KAISA-436 convention
    if (/^(smoke[-_]?test|diagnostics?|cron[-_]?test)/i.test(utmSrc)) return true;
    return false;
  })();
  if (isTestPayload) {
    console.log('Drop test/diagnostic event (no Slack, no email):', { type, email: body?.email || body?.contact?.email });
    return res.status(200).json({ ok: true, skipped: 'test_or_diagnostic_event' });
  }

  // ── Slack blocks ────────────────────────────────────────────────────────────
  let blocks = [];

  // ── email_captured: patient entered email at gate — send combined KAISA email ─
  if (type === 'email_captured') {
    const { email } = body;
    if (!hasContactData(email)) {
      return res.status(200).json({ ok: true, skipped: 'email_capture_without_email' });
    }
    const lang = detectLang(lp_source, language);
    const promoCode = clientPromoCode || getDailyCode();
    const label = result === 'good_candidate' ? 'Sobiv kandidaat' : 'Vajab konsultatsiooni';

    // Slack: email captured. The first line answers what reception needs at a
    // glance — is this an 18–45 myope, how keen, what has already been sent —
    // and the quiz details follow on one line instead of ten fields.
    const HEAT = { 'Jah, aktiivselt': '🔥 kuum', 'Olen mõelnud': '🟡 soe', 'Alles uurin maad': '⚪ uurib' };
    const heat = HEAT[answers.interest] || (answers.interest ? answers.interest : 'huvi teadmata');
    const status = result === 'good_candidate'
      ? `🟢 *Sobiv kandidaat — Flow3* · ${heat}`
      : result === 'kids'
        ? `🧒 *Vajab konsultatsiooni — laste uuring*`
        : `⚪ *Vajab konsultatsiooni — Audit*`;
    const sent = result === 'good_candidate'
      ? `E-postiga läks kood *${promoCode}* (Flow3 uuring) — broneering tuleb siia eraldi teatena.`
      : `E-kirja broneerimisnupp sisaldab koodi *${promoCode}*.`;
    const profile = [answers.age, answers.vision, answers.prescription, answers.gender, lang]
      .filter(v => v && v !== 'N/A').join(' · ');
    blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${status}\n${sent}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `${profile || '—'}\n${email || '—'} · ${adSource || 'Otse'}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `📧 E-post kogutud — Kiirtest · _${ts}_` }] },
    ];

    // ── Send combined KAISA email via Resend ─────────────────────────────────
    if (email && RESEND_API_KEY) {
      try {
        const html = buildEmailHtml(lang, null, promoCode, result, answers);
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [email],
            reply_to: 'info@ksa.ee',
            subject: getSubject(lang, result),
            html,
          }),
        });
        const emailResult = await emailRes.json();
        if (!emailRes.ok) {
          console.error('Resend error (email_captured):', JSON.stringify(emailResult));
        } else {
          console.log('KAISA email sent:', emailResult.id, '→', email, `(${lang})`);
          // ── 6-email Soap Opera Sequence DISABLED 2026-05-04 by Ants ──────────
          // Reason: switching to v3 phone-gate + SMS + Lilia callback. The 6-email
          // drip wasn't moving leads to booking and felt spammy. Keep the Day-0
          // immediate email (above) — that's still useful as instant confirmation.
          // To re-enable, uncomment the line below and re-run cancel script first
          // if there's a queue from a previous run.
          // scheduleSequence(email, lang, promoCode).catch(err => console.error('Sequence err:', err));
        }
      } catch (err) {
        console.error('Resend fetch error:', err);
      }

      // ── Internal copy to registreerumised@ksa.ee ───────────────────────────
      try {
        const internalHtml = `<p><strong>Kiirtest — e-post kogutud</strong><br>${ts}</p>
<table cellpadding="4" style="font-size:13px;font-family:Arial,sans-serif;border-collapse:collapse;">
<tr><td style="color:#888;">E-post</td><td><strong>${email || '—'}</strong></td></tr>
<tr><td style="color:#888;">Tulemus</td><td>${result === 'good_candidate' ? '✅ Sobiv kandidaat' : 'ℹ️ Vajab konsultatsiooni'}</td></tr>
<tr><td style="color:#888;">Sooduskood</td><td><strong>${promoCode}</strong></td></tr>
<tr><td style="color:#888;">Keel</td><td>${lang}</td></tr>
<tr><td style="color:#888;">Reklaamiallikas</td><td><strong>${adSource || '—'}</strong></td></tr>
<tr><td style="color:#888;">Sugu</td><td>${answers.gender || '—'}</td></tr>
<tr><td style="color:#888;">Vanus</td><td>${answers.age || '—'}</td></tr>
<tr><td style="color:#888;">Nägemine</td><td>${answers.vision || '—'}</td></tr>
<tr><td style="color:#888;">Dioptrid</td><td>${answers.prescription || '—'}</td></tr>
<tr><td style="color:#888;">Huvi</td><td>${answers.interest || '—'}</td></tr>
</table>`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [INTERNAL_NOTIFY_EMAIL],
            reply_to: email || 'info@ksa.ee',
            subject: `Kiirtest — ${result === 'good_candidate' ? '✅ Sobiv' : 'ℹ️ Konsultatsioon'} [${adSource ? adSource.split(' · ')[0] : 'Otse'}] — ${email || '?'}`,
            html: internalHtml,
          }),
        });
      } catch (err) {
        console.error('Internal notify error:', err);
      }
    }

    // KAISA-436 (Mai 2026-09-15): email-only lead → CRM ticket so Lilia sees it.
    // The CRM schema still requires a phone until Mai's fix lands (~2026-09-17);
    // until then this returns 4xx — logged, no Slack alarm. Slack + email above
    // are untouched either way.
    const consent = body?.consent || {};
    await postToCRM(
      buildEmailLeadPayload({ body, answers, lang, email, result, promoCode, adSource, lp_source, consent }),
      type,
      { quiet4xx: true },
    );

    // ── Brevo: "Kiirtest leadid" list, consent-gated (Mai 2026-10-09) ────────
    // Three conditions, all required: an email, an explicit marketing tick, and
    // an age band that is not "Alla 18". Without the tick the CRM ticket still
    // happens exactly as before — only Brevo is withheld, so the result the
    // patient came for is never traded against a marketing consent.
    const brevoAllowed = consent.marketing_email === true && (answers.age || '') !== 'Alla 18';
    if (brevoAllowed) {
      const r = await pushToBrevo({
        email, lang, leadType: 'kiirtest',
        listId: BREVO_KIIRTEST_LIST_ID,
        // Only attributes that exist in Brevo. Unknown names are accepted and
        // then silently dropped, so inventing them loses the data without an
        // error: KEEL, VANUS, SUGU, SOODUSKOOD and OPT_IN are the real fields
        // (checked against the account's attribute list on 2026-10-12). The
        // quiz result, vision, interest level and consent version have no field
        // yet — Mai creates them, and they are added here when she has.
        attributes: {
          KEEL: (lang || 'et').toLowerCase(),
          VANUS: BREVO_AGE_CATEGORY[answers.age] || null,
          SUGU: answers.gender || null,
          SOODUSKOOD: promoCode || null,
          // We only reach this line with an explicit tick, so the flag is true
          // by construction rather than by assumption.
          OPT_IN: true,
        },
      });
      if (r && r.skipped) {
        // BREVO_API_KEY is Production-only, so previews would alert on every
        // test submit. Production silence here would hide a real misconfiguration.
        if (process.env.VERCEL_ENV === 'production') {
          await alertSlack(`:rotating_light: Kiirtest: nõusolek anti, aga Brevosse ei saadetud — BREVO_API_KEY või BREVO_KIIRTEST_LIST_ID on seadistamata. Keel: ${lang}.`, 'brevo_unconfigured');
        } else {
          console.log('Brevo skipped (not configured in this environment):', process.env.VERCEL_ENV);
        }
      } else if (r && r.ok === false) {
        await alertSlack(`:rotating_light: Kiirtest: Brevo push ebaõnnestus, list ${BREVO_KIIRTEST_LIST_ID}. Staatus: ${r.status || r.error}. Keel: ${lang}. Nõusolek oli antud, nii et see kontakt jäi listist välja.`, 'brevo_push');
      }
    } else {
      console.log('Brevo skipped (no marketing consent):', lang, answers.age || '—');
    }

  } else if (type === 'quiz_completed') {
    // Anonymous quiz completions are useful for analytics, but they are not
    // actionable for Lilia/CS. Keep them out of #kiirtesti-täitmised.
    if (!isQualifiedFlow3Answers(answers)) {
      return res.status(200).json({ ok: true, skipped: 'quiz_not_flow3_qualified' });
    }
    const variant = leadVariant(body);
    await sendInternalEventLedger({
      subject: `✅ Kiirtest qualified quiz [${adSource || 'Otse'}]${variant ? ` [${variant}]` : ''}`,
      rows: [
        ['Event', 'qualified_quiz'],
        ['Funnel', variant || 'control'],
        ['Allikas', adSource || '—'],
        ['Keel', language || 'ET'],
        ['Vanus', answers.age || '—'],
        ['Nägemine', answers.vision || '—'],
        ['Dioptrid', answers.prescription || '—'],
        ['Huvi', answers.interest || '—'],
        ['Aeg', ts],
      ],
    });
    return res.status(200).json({ ok: true, skipped: 'anonymous_quiz_completion_not_sent_to_slack' });

  } else if (type === 'installment_lead') {
    // 0% järelmaks — contact left phone number
    const { name, phone, email } = contact || {};
    if (!hasContactData(phone, email)) {
      return res.status(200).json({ ok: true, skipped: 'installment_without_contact' });
    }
    const lang = detectLang(lp_source, language);
    const label = result === 'good_candidate' ? 'Sobiv kandidaat' : 'Vajab konsultatsiooni';

    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `💳 Järelmaks — kontakt jäetud` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Nimi:*\n${name || '—'}` },
        { type: 'mrkdwn', text: `*Telefon:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*E-post:*\n${email || '—'}` },
        { type: 'mrkdwn', text: `*Tulemus:*\n${label}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
        { type: 'mrkdwn', text: `*Sugu:*\n${answers.gender || '—'}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${answers.age || '—'}` },
        { type: 'mrkdwn', text: `*Nägemine:*\n${answers.vision || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${answers.prescription || '—'}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: `📞 *CS — järgmised sammud:*\n• Helista *${phone || '?'}* 1 tööpäeva jooksul\n• Ütle: _"Saatsime teile järelmaksu juhendi e-postile — kas said kätte?_"\n• Selgita: 0% intress, paindlik periood kuni 72 kuud, ennetähtaegne tasumine tasuta\n• Kui kõhkleb: küsi mis takistab — enamasti on see krediidiajalugu või kuumakse suurus — mõlemal on lahendus\n• Kinnita, et meie konsultant aitab taotluse täitmisega` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_ · 90 min pärast saadetakse ${email || 'e-postile'} automaatne järelmaksu juhend` }] },
    ];

    // ── Send scheduled consumer guide email 90 minutes later ─────────────────
    if (email && RESEND_API_KEY) {
      try {
        const scheduledAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
        const guideHtml = buildInstallmentGuideEmail(name);
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [email],
            reply_to: 'info@ksa.ee',
            subject: 'KSA juhend: kuidas saada Flow3 protseduurile parimad järelmaksu tingimused 0%-se intressiga',
            html: guideHtml,
            scheduled_at: scheduledAt,
          }),
        });
        const emailResult = await emailRes.json();
        if (!emailRes.ok) {
          console.error('Resend scheduled error (installment):', JSON.stringify(emailResult));
        } else {
          console.log('Installment guide scheduled:', emailResult.id, '→', email, 'at', scheduledAt);
        }
      } catch (err) {
        console.error('Resend installment schedule error:', err);
      }
    }

  } else if (type === 'form_with_contact') {
    // Email already sent at email_captured stage — Slack CRM notification only
    const label = result === 'good_candidate' ? 'Sobiv kandidaat' : 'Vajab konsultatsiooni';
    const { name, phone, email } = contact || {};
    if (!hasContactData(phone, email)) {
      return res.status(200).json({ ok: true, skipped: 'form_contact_without_contact' });
    }
    const lang = detectLang(lp_source, language);
    const promoCode = clientPromoCode || getDailyCode();

    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📋 Kontakt jäetud — Kiirtest` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Nimi:*\n${name || '—'}` },
        { type: 'mrkdwn', text: `*Telefon:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*E-post:*\n${email || '—'}` },
        { type: 'mrkdwn', text: `*Tulemus:*\n${label}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*Sooduskood:*\n${promoCode}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
        { type: 'mrkdwn', text: `*Sugu:*\n${answers.gender || '—'}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${answers.age || '—'}` },
        { type: 'mrkdwn', text: `*Nägemine:*\n${answers.vision || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${answers.prescription || '—'}` },
        { type: 'mrkdwn', text: `*Huvi tase:*\n${answers.interest || '—'}` },
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_` }] },
    ];

    // ── Internal copy to registreerumised@ksa.ee ─────────────────────────────
    if (RESEND_API_KEY) {
      try {
        const { name: cName, phone: cPhone, email: cEmail } = contact || {};
        const internalHtml = `<p><strong>Kiirtest — kontakt jäetud</strong><br>${ts}</p>
<table cellpadding="4" style="font-size:13px;font-family:Arial,sans-serif;border-collapse:collapse;">
<tr><td style="color:#888;">Nimi</td><td><strong>${cName || '—'}</strong></td></tr>
<tr><td style="color:#888;">Telefon</td><td><strong>${cPhone || '—'}</strong></td></tr>
<tr><td style="color:#888;">E-post</td><td><strong>${cEmail || '—'}</strong></td></tr>
<tr><td style="color:#888;">Tulemus</td><td>${result === 'good_candidate' ? '✅ Sobiv kandidaat' : 'ℹ️ Vajab konsultatsiooni'}</td></tr>
<tr><td style="color:#888;">Keel</td><td>${detectLang(lp_source, language)}</td></tr>
<tr><td style="color:#888;">Reklaamiallikas</td><td><strong>${adSource || '—'}</strong></td></tr>
<tr><td style="color:#888;">Sugu</td><td>${answers.gender || '—'}</td></tr>
<tr><td style="color:#888;">Vanus</td><td>${answers.age || '—'}</td></tr>
<tr><td style="color:#888;">Nägemine</td><td>${answers.vision || '—'}</td></tr>
<tr><td style="color:#888;">Dioptrid</td><td>${answers.prescription || '—'}</td></tr>
</table>`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [INTERNAL_NOTIFY_EMAIL],
            reply_to: cEmail || 'info@ksa.ee',
            subject: `📋 Kiirtest kontakt [${adSource ? adSource.split(' · ')[0] : 'Otse'}] — ${cName || '?'} — ${cPhone || '?'}`,
            html: internalHtml,
          }),
        });
      } catch (err) {
        console.error('Internal notify error (contact):', err);
      }
    }

  } else if (type === 'lp_guide_download') {
    const providedToken = req.headers['x-track-source'] || '';
    if (providedToken !== LP_TRACK_SHARED_TOKEN) return res.status(403).json({ error: 'Invalid track source' });
    if (!isAllowedOrigin) return res.status(403).json({ error: 'Origin not allowed' });
    const { name, email, phone } = contact || body || {};
    const lang = detectLang(lp_source, language);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid payload' });
    const gBlocks = [
      { type: 'header', text: { type: 'plain_text', text: `📘 Teejuhi tellimus — ${lp_source || 'LP'}` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Nimi:*\n${name || '—'}` },
        { type: 'mrkdwn', text: `*E-post:*\n${email}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*LP allikas:*\n${lp_source || '—'}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_ · lead magnet (teejuht)` }] },
    ];
    if (SLACK_LP_WEBHOOK) {
      try {
        const r = await fetch(SLACK_LP_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks: gBlocks }) });
        if (!r.ok) console.error('Slack LP (guide) error:', r.status, await r.text());
      } catch (err) { console.error('Slack LP (guide) fetch error:', err); }
    }
    await pushToBrevo({ email, name, phone, lp_source, lang, leadType: 'guide_download' });
    return res.status(200).json({ ok: true });

  } else if (type === 'lp_contact_submitted') {
    // ── LP contact form submission → post to #lp-kontaktid ─────────────────
    // Shared token check (mild abuse filter)
    const providedToken = req.headers['x-track-source'] || '';
    if (providedToken !== LP_TRACK_SHARED_TOKEN) {
      return res.status(403).json({ error: 'Invalid track source' });
    }
    // Origin check
    if (!isAllowedOrigin) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    const { name, email, phone, age, diopter, campaign_code } = contact || body || {};
    const lang = detectLang(lp_source, language);

    // Basic validation — reject if critical fields missing or obviously invalid
    if (!name || !email || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // LP source label mapping → clean display name
    const LP_LABEL = {
      'LP-Glasses-ET':  'Glasses (prillidest loobumine)',
      'LP-Glasses-EN':  'Glasses (EN)',
      'LP-Glasses-RU':  'Glasses (RU)',
      'LP-Sports-ET':   'Sports (aktiivsed eluviisid)',
      'LP-Finance-ET':  'Finance (järelmaks)',
      'LP-BestTime-ET': 'Best Time (õige aeg)',
      'LP-TimeTax-ET':  'Time Tax (ajakulu)',
      'LP-Benefit-ET':  'Benefit (eelised)',
    };
    const lpLabel = LP_LABEL[lp_source] || lp_source || 'Unknown LP';

    // Use LP-specific webhook if set, else fall back to default Slack webhook
    const lpBlocks = [
      { type: 'header', text: { type: 'plain_text', text: `📝 LP-kontakt — ${lpLabel}` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Nimi:*\n${name}` },
        { type: 'mrkdwn', text: `*Telefon:*\n${phone}` },
        { type: 'mrkdwn', text: `*E-post:*\n${email}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${age || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${diopter || '—'}` },
        { type: 'mrkdwn', text: `*Kampaaniakood:*\n${campaign_code || '—'}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*LP allikas:*\n${lp_source || '—'}` },
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_ · Lead data email: registreerumised@ksa.ee` }] },
    ];

    // Post only to the LP channel webhook — do NOT post to kiirtest channels
    if (SLACK_LP_WEBHOOK) {
      try {
        const slackRes = await fetch(SLACK_LP_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks: lpBlocks }),
        });
        if (!slackRes.ok) console.error('Slack LP error:', slackRes.status, await slackRes.text());
      } catch (err) {
        console.error('Slack LP fetch error:', err);
      }
    }

    await pushToBrevo({ email, name, phone, lp_source, campaign_code, diopter, lang, leadType: 'booking' });

    return res.status(200).json({ ok: true });

  } else if (type === 'qualified_flow3_phone_lead') {
    // Qualified Kiirtest lead left a phone number before moving to the 19€ booking bridge.
    const lang = detectLang(lp_source, language);
    const leadData = leadAnswers(body, answers);
    const name = leadName(body);
    const phone = leadPhone(body);
    const email = leadEmail(body);
    const intent = leadIntent(leadData, body.intent);
    const variant = leadVariant(body);
    const qualified = isQualifiedFlow3Answers(leadData);
    if (!hasContactData(phone, email)) {
      return res.status(200).json({ ok: true, skipped: 'phone_lead_without_contact' });
    }
    if (!qualified) {
      return res.status(200).json({ ok: true, skipped: 'phone_lead_not_flow3_qualified' });
    }
    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📞 Flow3 kandidaat jättis telefoni` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Lilia / CS:* inimene liigub broneerima, aga jättis numbri. Kui broneeringut ei ilmu, aita leida sobiv aeg ja vasta küsimustele live-kõnes.` } },
      { type: 'section', fields: leadFields({ answers: leadData, lang, name, phone, email, adSource, intent, extra: variant ? [{ type: 'mrkdwn', text: `*Funnel:*\n${variant}` }] : [] }) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_ · Flow3-qualified by Kiirtest` }] },
    ];
    await sendInternalEventLedger({
      subject: `✅ Kiirtest Flow3 phone lead [${adSource || 'Otse'}]${variant ? ` [${variant}]` : ''}`,
      rows: [
        ['Event', 'qualified_phone_lead'],
        ['Funnel', variant || 'control'],
        ['Nimi', name || '—'],
        ['Telefon', phone || '—'],
        ['E-post', email || '—'],
        ['Allikas', adSource || '—'],
        ['Keel', lang],
        ['Vanus', leadData.age || leadData.age_band || '—'],
        ['Nägemine', leadData.vision || leadData.vision_issue || '—'],
        ['Dioptrid', leadData.prescription || leadData.prescription_sphere || '—'],
        ['Soov', intent || '—'],
        ['Aeg', ts],
      ],
    });

  } else if (['book_now_clicked', 'bridge_19_book_clicked', 'eligible_gate_bridge_clicked'].includes(type)) {
    // Diagnostic booking intent events. These are not confirmed bookings/conversions.
    const lang = detectLang(lp_source, language);
    const leadData = leadAnswers(body, answers);
    const name = leadName(body);
    const phone = leadPhone(body);
    const email = leadEmail(body);
    const intent = leadIntent(leadData, body.intent);
    const variant = leadVariant(body);
    if (!isQualifiedFlow3Answers(leadData)) {
      return res.status(200).json({ ok: true, skipped: 'booking_click_not_flow3_qualified' });
    }
    const eventLabels = {
      book_now_clicked: 'Kiirtest result booking click',
      bridge_19_book_clicked: 'Bridge /19 booking click',
      eligible_gate_bridge_clicked: 'Kiirtest booking handoff click',
    };
    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📅 ${eventLabels[type]}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `Diagnostiline sündmus: kasutaja vajutas broneerimise suunas. See ei ole veel kinnitatud online broneering.` } },
      { type: 'section', fields: leadFields({ answers: leadData, lang, name, phone, email, adSource, intent, code: body.code, extra: variant ? [{ type: 'mrkdwn', text: `*Funnel:*\n${variant}` }] : [] }) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_` }] },
    ];
    await sendInternalEventLedger({
      subject: `📅 Kiirtest booking click [${adSource || 'Otse'}]${variant ? ` [${variant}]` : ''}`,
      rows: [
        ['Event', type],
        ['Funnel', variant || 'control'],
        ['Nimi', name || '—'],
        ['Telefon', phone || '—'],
        ['E-post', email || '—'],
        ['Allikas', adSource || '—'],
        ['Keel', lang],
        ['Vanus', leadData.age || leadData.age_band || '—'],
        ['Nägemine', leadData.vision || leadData.vision_issue || '—'],
        ['Dioptrid', leadData.prescription || leadData.prescription_sphere || '—'],
        ['Soov', intent || '—'],
        ['Sooduskood', body.code || '—'],
        ['Aeg', ts],
      ],
    });

    // KAISA-436: also POST to Mai's CRM so Lilia sees this lead in her queue.
    // Best-effort; Slack + email ledger above stay untouched if CRM hiccups.
    await postToCRM(
      buildCRMPayload({ body, leadData, lang, name, phone, email, adSource, code: body.code, eventType: type }),
      type,
    );
    // Counted (ledger → daily report) and in Lilia's CRM queue, but not posted to
    // Slack: the same person's email_captured message is already there, and these
    // clicks were taken out of the channel as noise on 2026-06-17.
    return res.status(200).json({ ok: true, slack: 'skipped_booking_click' });

  } else if (type === 'hot_lead_lens_user') {
    // Daily lens user — high-value lead, flag for Lilia to call same day
    const leadData = leadAnswers(body, answers);
    if (!isQualifiedFlow3Answers(leadData)) {
      return res.status(200).json({ ok: true, skipped: 'hot_lead_not_flow3_qualified' });
    }
    const { email } = body;
    const lang = detectLang(lp_source, language);
    const phone = leadPhone(body);
    if (!hasContactData(phone, email)) {
      return res.status(200).json({ ok: true, skipped: 'hot_lead_without_contact' });
    }
    const intent = leadIntent(leadData, body.intent);
    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `🔥 Igapäevane läätsekandja — Flow3 kandidaat` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Lilia — helista täna!* See inimene kannab läätsesid iga päev (~500€/aastas). Flow3 tasub end ära ~5 aastaga — motivatsioon kõrge.` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Telefon:*\n${phone ? `<tel:${phone}|${phone}>` : '—'}` },
        { type: 'mrkdwn', text: `*E-post:*\n${email || '—'}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
        { type: 'mrkdwn', text: `*Sugu:*\n${leadData.gender || '—'}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${leadData.age || '—'}` },
        { type: 'mrkdwn', text: `*Nägemine:*\n${leadData.vision || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${leadData.prescription || '—'}` },
        { type: 'mrkdwn', text: `*Huvi tase:*\n${leadData.interest || '—'}` },
        { type: 'mrkdwn', text: `*Soov / intent:*\n${intent || '—'}` },
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_` }] },
    ];

    // KAISA-436: hot lens-user lead → CRM ticket (server dedupes if same contact)
    const hotName = leadName(body);
    await postToCRM(
      buildCRMPayload({ body, leadData, lang, name: hotName, phone, email, adSource, code: body.code, eventType: type }),
      type,
    );

  } else if (type === 'callback_requested') {
    // Bridge page (/19) — lead asked Lilia to call back. Highest-priority Slack ping.
    const { contact, code, from } = body;
    const cName = (contact && contact.name) || '—';
    const rawPhone = contact && contact.phone;
    const rawEmail = contact && contact.email;
    if (!hasContactData(rawPhone, rawEmail)) {
      return res.status(200).json({ ok: true, skipped: 'callback_without_contact' });
    }
    const cPhone = rawPhone || '—';
    const cEmail = rawEmail || '—';
    const lang = detectLang(lp_source, language || body.language);
    const leadData = leadAnswers(body, answers);
    const intent = leadIntent(leadData, body.intent);
    const variant = leadVariant(body);
    const sourceLabel = from === 'lilia' ? 'Lilia QR / e-kirjast' : (from === 'kiirtest' ? 'Kiirtest LP' : 'Bridge /19 (otse)');
    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📞 Tagasihelistamise soov — ${sourceLabel}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Lilia — helista 1 tööp jooksul!*\nIsik vajas broneerimisega abi ja jättis kontakti.` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Nimi:*\n${cName}` },
        { type: 'mrkdwn', text: `*Telefon:*\n<tel:${cPhone}|${cPhone}>` },
        { type: 'mrkdwn', text: `*E-post:*\n${cEmail}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*Allikas:*\n${sourceLabel}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
        { type: 'mrkdwn', text: `*Sooduskood:*\n${code || '—'}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${leadData.age || leadData.age_band || '—'}` },
        { type: 'mrkdwn', text: `*Nägemine:*\n${leadData.vision || leadData.vision_issue || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${leadData.prescription || leadData.prescription_sphere || '—'}` },
        { type: 'mrkdwn', text: `*Soov / intent:*\n${intent || '—'}` },
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_` }] },
    ];
    await sendInternalEventLedger({
      subject: `📞 Kiirtest callback request [${adSource || sourceLabel}]${variant ? ` [${variant}]` : ''}`,
      rows: [
        ['Event', 'callback_requested'],
        ['Funnel', variant || 'control'],
        ['Nimi', cName],
        ['Telefon', cPhone],
        ['E-post', cEmail],
        ['Allikas', sourceLabel],
        ['Reklaamiallikas', adSource || '—'],
        ['Keel', lang],
        ['Vanus', leadData.age || leadData.age_band || '—'],
        ['Nägemine', leadData.vision || leadData.vision_issue || '—'],
        ['Dioptrid', leadData.prescription || leadData.prescription_sphere || '—'],
        ['Soov', intent || '—'],
        ['Aeg', ts],
      ],
    });

  } else if (type === 'phone_lead') {
    // Email gate skip downsell — left phone number, wants callback
    const { phone } = body;
    if (!hasContactData(phone)) {
      return res.status(200).json({ ok: true, skipped: 'phone_lead_without_phone' });
    }
    const lang = detectLang(lp_source, language);
    const intent = leadIntent(answers, body.intent);
    blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📞 Tagasihelistamise soov` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Lilia — helista tagasi E-R 9–18!*\nIsik jättis numbri e-gate downsellil (ei tahtnud e-posti jätta, kuid nõustus tagasihelistamisega).` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Telefon:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*Keel:*\n${lang}` },
        { type: 'mrkdwn', text: `*Reklaamiallikas:*\n${adSource || '—'}` },
        { type: 'mrkdwn', text: `*Sugu:*\n${answers.gender || '—'}` },
        { type: 'mrkdwn', text: `*Vanus:*\n${answers.age || '—'}` },
        { type: 'mrkdwn', text: `*Nägemine:*\n${answers.vision || '—'}` },
        { type: 'mrkdwn', text: `*Dioptrid:*\n${answers.prescription || '—'}` },
        { type: 'mrkdwn', text: `*Huvi:*\n${answers.interest || '—'}` },
        { type: 'mrkdwn', text: `*Soov / intent:*\n${intent}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: `💡 *Helistamisskript:* "Tere, nägin et tegite meie Flow3 kiirtesti — teie tulemused näevad head välja. Kas sobib rääkida uuringust?"` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${ts}_` }] },
    ];

  } else {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // ── Defensive block sanitizer (fixes the 2026-06-17 invalid_blocks bug) ───
  // Slack rejects the whole payload (HTTP 400 invalid_blocks) when ANY field
  // violates: empty text, fields > 10 per section, text > 3000 chars,
  // missing required keys. We rebuild the blocks defensively so a real lead
  // never gets silently dropped on an edge-case payload.
  const sanitizeBlocks = (raw) => {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const b of raw) {
      if (!b || typeof b !== 'object' || !b.type) continue;

      if (b.type === 'header') {
        const t = String(b.text?.text || '').slice(0, 150).trim() || '—';
        out.push({ type: 'header', text: { type: 'plain_text', text: t } });
        continue;
      }

      if (b.type === 'divider') {
        out.push({ type: 'divider' });
        continue;
      }

      if (b.type === 'context') {
        const elements = Array.isArray(b.elements) ? b.elements : [];
        const safe = elements
          .filter((e) => e && e.type === 'mrkdwn' && typeof e.text === 'string')
          .map((e) => ({ type: 'mrkdwn', text: e.text.slice(0, 2000) || '—' }));
        if (safe.length) out.push({ type: 'context', elements: safe.slice(0, 10) });
        continue;
      }

      if (b.type === 'section') {
        const block = { type: 'section' };
        if (b.text?.type && typeof b.text?.text === 'string') {
          const t = b.text.text.slice(0, 3000).trim();
          if (t) block.text = { type: b.text.type, text: t };
        }
        if (Array.isArray(b.fields)) {
          const safeFields = b.fields
            .filter((f) => f && f.type === 'mrkdwn' && typeof f.text === 'string')
            .map((f) => ({ type: 'mrkdwn', text: (f.text.slice(0, 2000).trim() || '—') }))
            .slice(0, 10);
          if (safeFields.length) block.fields = safeFields;
        }
        // Must have either text or fields, else Slack rejects.
        if (block.text || block.fields) out.push(block);
        continue;
      }

      // Unknown block type → keep as-is, Slack will validate.
      out.push(b);
    }
    return out;
  };

  // ── Send Slack notification ─────────────────────────────────────────────────
  const sendToSlack = async (webhookUrl) => {
    try {
      const safeBlocks = sanitizeBlocks(blocks);
      if (!safeBlocks.length) {
        console.error('Slack: empty blocks after sanitize — falling back to plain text', { type });
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `:warning: KSA Kiirtest lead (${type}) — block payload was empty, check Vercel logs` }),
        });
        return;
      }
      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: safeBlocks }),
      });
      if (!slackRes.ok) {
        const errText = await slackRes.text();
        console.error('Slack error:', slackRes.status, errText);
        // Last-ditch: post plain-text alert so the lead notification never disappears.
        if (/invalid_blocks/i.test(errText)) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `:warning: KSA Kiirtest lead (${type}) — Slack rejected the rich block payload (invalid_blocks). Check Vercel logs for full data.` }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Slack fetch error:', err);
    }
  };

  const slackPromises = [];
  if (SLACK_WEBHOOK) slackPromises.push(sendToSlack(SLACK_WEBHOOK));
  if (SLACK_KIIRTEST_WEBHOOK) slackPromises.push(sendToSlack(SLACK_KIIRTEST_WEBHOOK));
  await Promise.all(slackPromises);

  return res.status(200).json({ ok: true });
}
