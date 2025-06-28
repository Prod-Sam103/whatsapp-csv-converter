/**
 * Simple WhatsApp VCF parser – strips emoji, normalises numbers
 */
function stripEmoji(str = '') {
  return str.replace(/\p{Extended_Pictographic}/gu, '').trim();
}

function parseVCF(raw) {
  const contacts = [];
  const cards = raw
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split(/BEGIN:VCARD/i).filter(Boolean);

  for (const card of cards) {
    if (!card.includes('END:VCARD')) continue;
    const c = { name: '', mobile: '', email: '' };

    const lines = card.split('\n').map(l => l.trim()).filter(Boolean);

    /* name */
    const n = lines.find(l => /^N:/i.test(l));
    if (n) {
      const p = n.slice(2).split(';');
      c.name = `${p[1] || ''} ${p[0] || ''}`.trim();
    }
    if (!c.name) {
      const fn = lines.find(l => /^FN:/i.test(l));
      if (fn) c.name = fn.slice(3).trim();
    }
    c.name = stripEmoji(c.name);

    /* phone */
    const tel = lines.find(l => /^TEL.*:/i.test(l) || /^item\d+\.TEL/i.test(l));
    if (tel) {
      let num = tel.split(':').slice(1).join(':').replace(/[^\d+]/g, '');
      if (/^0[789]\d{9}$/.test(num)) num = '+234' + num.slice(1); // NG fix
      if (/^\d{10,}$/.test(num) && !num.startsWith('+')) num = '+' + num;
      c.mobile = num;
    }

    /* email (optional) */
    const em = lines.find(l => /^EMAIL/i.test(l) || /^item\d+\.EMAIL/i.test(l));
    if (em) c.email = em.split(':').pop().trim();

    if (c.name || c.mobile) contacts.push(c);
  }
  return contacts;
}

module.exports = { parseVCF };
