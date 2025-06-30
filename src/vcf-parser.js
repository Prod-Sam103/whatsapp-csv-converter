// src/vcf-parser.js
// Robust vCard → JS-object parser – handles WhatsApp Web & Mobile exports

const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Emoji}\u200d]+/gu;
const PHONE_CLEAN = /[^0-9+]/g;

/**
 * Parse a raw vCard string into an array of contact objects:
 *   { name, mobile, email, passes }
 */
function parseVCF(raw) {
  if (!raw) return [];

  // 1. normalise CR/LF & unfold RFC6350 long lines
  let data = raw.replace(/\r\n/g, '\n')
                .replace(/\n /g, '');          // folded line (leading space)

  // 2. split into individual cards
  const cards = data.split(/BEGIN:VCARD/i)
                    .slice(1)                  // first chunk is before the first BEGIN
                    .map(chunk => 'BEGIN:VCARD' + chunk);

  return cards.map(parseCard).filter(Boolean);
}

/* ---------------- helpers ---------------- */

function parseCard(card) {
  const lines = card.split('\n');

  let name = '';
  let mobile = '';
  let email = '';
  let passes = 1;

  for (const ln of lines) {
    const line = ln.trim();

    if (!name && /^FN:/i.test(line)) {
      name = line.replace(/^FN:/i, '');
      continue;
    }
    if (!mobile && /^TEL/i.test(line)) {
      mobile = cleanPhone(line.split(':').pop());
      continue;
    }
    if (!email && /^EMAIL/i.test(line)) {
      email = line.split(':').pop().trim();
      continue;
    }
  }

  // Fallback: some WA-Web cards omit FN
  if (!name) {
    const label = lines.find(l => /item\d+\.X-ABLabel/i.test(l));
    if (label) name = label.split(':').pop().trim();
    else if (mobile) name = mobile;            // use number as name
  }

  name = name.replace(EMOJI_REGEX, '').trim();

  if (!mobile) return null;                    // skip invalid entries
  return { name, mobile, email, passes };
}

function cleanPhone(tel) {
  const n = tel.replace(PHONE_CLEAN, '');
  if (n.startsWith('00')) return '+' + n.slice(2);
  if (n.startsWith('0'))  return '+234' + n.slice(1);   // 🇳🇬 default
  return n.startsWith('+') ? n : '+' + n;
}

module.exports = { parseVCF };
