// api/analytics-report.js
// Vercel cron: daily 08:00 AM & weekly Friday 09:00 AM Tallinn time
// Queries Resend for email stats → posts to Slack #kiirtesti-täitmised

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_KIIRTEST_CHANNEL_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL;

const DAILY_TARGET = 10; // paid Flow exams per day target

// Fetch emails from Resend (max 100 per call)
async function fetchResendEmails(limit = 100) {
  const res = await fetch(`https://api.resend.com/emails?limit=${limit}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  const data = await res.json();
  return data.data || [];
}

// Filter emails to a date range (YYYY-MM-DD strings, Tallinn TZ)
function inRange(email, fromDate, toDate) {
  const d = email.created_at?.slice(0, 10);
  return d >= fromDate && d <= toDate;
}

function isoToTallinn(date) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Tallinn' }));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

// Extract source channel from subject: "... [Google Ads] ..." → "Google Ads"
function extractSource(subject) {
  const m = subject?.match(/\[([^\]]+)\]/);
  if (!m) return 'Otse/Muu';
  const src = m[1].trim();
  // Normalise to clean labels
  if (src.startsWith('Google')) return 'Google Ads';
  if (src.startsWith('Meta') || src.startsWith('Facebook') || src.startsWith('Instagram')) return 'Meta';
  if (src.startsWith('Orgaaniline') || src.startsWith('Otselink')) return 'Orgaaniline';
  if (src.startsWith('E-post') || src.startsWith('Chipmonkey') || src.startsWith('email')) return 'E-post';
  if (src === 'Otse') return 'Otse/Muu';
  return src;
}

// Analyze email array for a given date range
function analyze(emails, fromDate, toDate) {
  const internal = emails.filter(
    e => e.to?.includes('registreerumised@ksa.ee') && inRange(e, fromDate, toDate)
  );
  // Exclude our own test/audit emails
  const real = internal.filter(
    e => !e.subject?.includes('audit-test') && !e.to?.some(t => t.includes('audit-test'))
  );

  const good     = real.filter(e => e.subject?.includes('✅'));
  const consult  = real.filter(e => !e.subject?.includes('📋') && (e.subject?.includes('ℹ️') || e.subject?.includes('Konsultatsioon')));
  const contact  = real.filter(e => e.subject?.includes('📋'));
  const install  = emails.filter(e => e.subject?.toLowerCase().includes('järelmaks') && !e.to?.includes('registreerumised@ksa.ee') && inRange(e, fromDate, toDate));

  // Source breakdown — count all leads (good + consult + contact) by channel
  const bySource = {};
  for (const e of real) {
    const src = extractSource(e.subject);
    if (!bySource[src]) bySource[src] = { total: 0, good: 0 };
    bySource[src].total++;
    if (e.subject?.includes('✅')) bySource[src].good++;
  }

  return { total: real.length, good: good.length, consult: consult.length, contact: contact.length, install: install.length, bySource };
}

function progressBar(value, target, width = 10) {
  const filled = Math.min(Math.round((value / target) * width), width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export default async function handler(req, res) {
  // Verify cron secret (Vercel sets this automatically for cron invocations)
  // Allow GET for cron, and also allow manual POST with ?type=daily|weekly
  const isWeekly = req.url?.includes('type=weekly') || req.headers['x-report-type'] === 'weekly';
  const now = isoToTallinn(new Date());

  let fromDate, toDate, reportTitle, periodLabel;

  if (isWeekly) {
    // Previous Mon–Sun week (cron runs Monday morning)
    const sun = new Date(now);
    sun.setDate(sun.getDate() - 1);   // yesterday = Sunday
    const mon = new Date(now);
    mon.setDate(mon.getDate() - 7);   // 7 days ago = last Monday
    fromDate = formatDate(mon);
    toDate = formatDate(sun);
    reportTitle = '📊 Nädalaaruanne — kiirtest.ksa.ee';
    periodLabel = `${fromDate} → ${toDate}`;
  } else {
    // Yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    fromDate = toDate = formatDate(yesterday);
    reportTitle = '☀️ Kiirtesti päevaaruanne';
    periodLabel = fromDate;
  }

  const emails = await fetchResendEmails(100);
  const stats = analyze(emails, fromDate, toDate);

  // Daily target context
  const days = isWeekly ? 7 : 1; // always 7 days for weekly (Mon–Sun)
  const targetTotal = DAILY_TARGET * days;
  const pct = stats.total > 0 ? Math.round((stats.good / stats.total) * 100) : 0;
  const bar = progressBar(stats.good, targetTotal);
  const targetNote = isWeekly
    ? `Eesmärk: ${targetTotal} liidi / nädal (${DAILY_TARGET}/päev)`
    : `Päeva eesmärk: ${DAILY_TARGET} Flow uuringut`;

  // Per-day breakdown for weekly
  let perDayText = '';
  if (isWeekly) {
    const byDay = {};
    const internal = emails.filter(e => e.to?.includes('registreerumised@ksa.ee') && !e.subject?.includes('audit-test'));
    for (const e of internal) {
      const d = e.created_at?.slice(0, 10);
      if (!d || d < fromDate || d > toDate) continue;
      byDay[d] = (byDay[d] || 0) + 1;
    }
    const days = Object.keys(byDay).sort().reverse();
    perDayText = days.map(d => `${d}: ${byDay[d]} liidi`).join('\n');
  }

  // Source breakdown text
  const sourceOrder = ['Google Ads', 'Meta', 'E-post', 'Orgaaniline', 'Otse/Muu'];
  const sourceEntries = Object.entries(stats.bySource);
  // Sort: known sources first, then alphabetical
  sourceEntries.sort(([a], [b]) => {
    const ai = sourceOrder.indexOf(a); const bi = sourceOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1; if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  const sourceLines = sourceEntries.map(([src, v]) => {
    const pct = v.total > 0 ? Math.round(v.good / v.total * 100) : 0;
    return `• *${src}:* ${v.total} liidi (${v.good} sobivat, ${pct}%)`;
  });
  const sourceText = sourceLines.length > 0
    ? sourceLines.join('\n')
    : '_Allikaandmed puuduvad (vanemad liidid ilma [märgendita])_';

  // Build Slack blocks
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: reportTitle },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📅 *Periood:* ${periodLabel}\n${targetNote}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📧 E-post jäetud (küsimustik täidetud):*\n${stats.total}` },
        { type: 'mrkdwn', text: `*✅ Sobiv Flow3 kandidaat:*\n${stats.good} (${pct}%)` },
        { type: 'mrkdwn', text: `*ℹ️ Soovitame konsultatsiooni:*\n${stats.consult}` },
        { type: 'mrkdwn', text: `*📋 Kontakt jäetud (nimi+tel):*\n${stats.contact}` },
        { type: 'mrkdwn', text: `*💳 Järelmaks huvi:*\n${stats.install}` },
        { type: 'mrkdwn', text: `*🎯 Progress (sobivad / eesmärk):*\n${bar} ${stats.good}/${targetTotal}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*📡 Reklaamiallikas — liidid allika järgi:*\n${sourceText}` },
    },
    ...(isWeekly && perDayText ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*📅 Päevade lõikes:*\n\`\`\`${perDayText}\`\`\`` },
    }] : []),
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_ℹ️ Andmed: Resend API. Allikamärgend ilmub alates 29.04.2026 saadetud liididel — vanemad on "Otse/Muu"._`,
      }],
    },
  ];

  // Post to Slack
  const slackRes = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!slackRes.ok) {
    console.error('Slack error:', slackRes.status, await slackRes.text());
    return res.status(500).json({ ok: false, error: 'Slack post failed' });
  }

  console.log(`Analytics report sent: ${reportTitle} | ${periodLabel} | total=${stats.total} good=${stats.good}`);
  return res.status(200).json({ ok: true, stats, period: periodLabel });
}
