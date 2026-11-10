// Slack Block Kit limits (https://api.slack.com/reference/block-kit/blocks), as a pure function.
//   <= 50 blocks; header: plain_text, 1..150 chars; section: text or fields, text 1..3000,
//   <= 10 fields of 1..2000; context: <= 10 mrkdwn elements of 1..2000; no lone UTF-16 surrogates.
export function validateSlackPayload(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['payload is not an object'];
  if (p.blocks === undefined) {
    if (typeof p.text !== 'string' || !p.text.length) errs.push('text-only payload without text');
    return errs;
  }
  if (!Array.isArray(p.blocks)) return ['blocks not an array'];
  if (p.blocks.length === 0) errs.push('empty blocks');
  if (p.blocks.length > 50) errs.push(`${p.blocks.length} blocks > 50`);
  p.blocks.forEach((b, i) => {
    const at = `block[${i}] ${b?.type}`;
    if (b.type === 'header') {
      if (b.text?.type !== 'plain_text') errs.push(`${at}: header must be plain_text`);
      const n = [...String(b.text?.text ?? '')].length;
      if (n < 1 || n > 150) errs.push(`${at}: header length ${n}`);
    } else if (b.type === 'section') {
      if (!b.text && !(b.fields && b.fields.length)) errs.push(`${at}: needs text or fields`);
      if (b.text) {
        const n = b.text.text.length;
        if (n < 1 || n > 3000) errs.push(`${at}: text length ${n}`);
      }
      if (b.fields) {
        if (b.fields.length > 10) errs.push(`${at}: ${b.fields.length} fields > 10`);
        b.fields.forEach((f, j) => {
          if (f.type !== 'mrkdwn' && f.type !== 'plain_text') errs.push(`${at}.fields[${j}]: bad type`);
          if (!f.text || f.text.length < 1 || f.text.length > 2000) errs.push(`${at}.fields[${j}]: length ${f.text?.length}`);
        });
      }
    } else if (b.type === 'context') {
      if (!b.elements?.length || b.elements.length > 10) errs.push(`${at}: ${b.elements?.length} elements`);
      (b.elements || []).forEach((e, j) => {
        if (!e.text || e.text.length < 1 || e.text.length > 2000) errs.push(`${at}.elements[${j}]: length ${e.text?.length}`);
      });
    } else if (b.type !== 'divider') {
      errs.push(`${at}: unexpected block type`);
    }
  });
  // lone UTF-16 surrogates (a slice() through an emoji) are invalid Unicode on the wire
  const walk = (v) => {
    if (typeof v === 'string') { if (!v.isWellFormed()) errs.push('lone UTF-16 surrogate in payload'); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(p);
  return errs;
}

