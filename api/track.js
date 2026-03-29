// Kiirtest Analytics — forwards events to Slack webhook
// Tracks: quiz completions (anonymous) + form submissions (with contact info)

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!slackWebhookUrl) {
      console.log('No SLACK_WEBHOOK_URL configured, logging only:', JSON.stringify(data));
      return res.status(200).json({ ok: true, note: 'No Slack webhook configured' });
    }

    // Build Slack message
    let emoji, title, color, fields;

    if (data.type === 'quiz_completed') {
      const isGood = data.result === 'good';
      emoji = isGood ? '✅' : 'ℹ️';
      title = isGood ? 'Kiirtest — Sobiv kandidaat!' : 'Kiirtest — Tulemus vaadatud';
      color = isGood ? '#87be23' : '#5a6b6c';

      fields = [
        { title: 'Tulemus', value: data.result === 'good' ? 'Sobiv ✓' : 'Vajab konsultatsiooni', short: true },
        { title: 'Keel', value: data.language || '?', short: true },
        { title: 'Sugu', value: data.answers?.gender || '?', short: true },
        { title: 'Vanus', value: data.answers?.age || '?', short: true },
        { title: 'Nägemine', value: data.answers?.vision || '?', short: true },
        { title: 'Dioptrid', value: data.answers?.prescription || '?', short: true },
        { title: 'Huvi tase', value: data.answers?.interest || '?', short: true }
      ];
    } else if (data.type === 'form_with_contact') {
      emoji = '🔥';
      title = 'Kiirtest — UUS KONTAKT!';
      color = '#87be23';

      fields = [
        { title: 'Nimi', value: data.contact?.name || '(tühi)', short: true },
        { title: 'Telefon', value: data.contact?.phone || '(tühi)', short: true },
        { title: 'E-post', value: data.contact?.email || '(tühi)', short: true },
        { title: 'Keel', value: data.language || '?', short: true },
        { title: 'Tulemus', value: data.result === 'good' ? 'Sobiv ✓' : 'Konsultatsioon', short: true },
        { title: 'Vanus', value: data.answers?.age || '?', short: true },
        { title: 'Nägemine', value: data.answers?.vision || '?', short: true },
        { title: 'Dioptrid', value: data.answers?.prescription || '?', short: true }
      ];
    } else {
      return res.status(200).json({ ok: true, note: 'Unknown event type' });
    }

    // Send to Slack
    const slackPayload = {
      text: `${emoji} ${title}`,
      attachments: [{
        color: color,
        fields: fields,
        footer: `KSA Kiirtest • ${data.timestamp || new Date().toISOString()}`,
        footer_icon: 'https://ksa.ee/wp-content/uploads/2025/08/favicon-ksa.webp'
      }]
    };

    await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload)
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Track error:', err);
    return res.status(200).json({ ok: true, note: 'Error logged' });
  }
};
