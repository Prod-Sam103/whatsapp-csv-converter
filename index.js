/**
 * WhatsApp CSV-→XLSX Converter  v1.5-xlsx
 * • multi-file intake ▸ confirmation ▸ duplicate resolver
 * • sends XLSX back as WhatsApp document (CSV blocked by WA)
 */

const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const XLSX     = require('xlsx');
const { v4: uuid } = require('uuid');
require('dotenv').config();

console.log('ENV REDIS_URL =', process.env.REDIS_URL || 'undefined');
process.on('uncaughtException', e => { console.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('UNHANDLED', e); process.exit(1); });

const { parseVCF }    = require('./src/vcf-parser');
const sessionStore    = require('./src/session-store');

const app        = express();
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL || `https://localhost:${PORT}`;
const MODE_LIVE  = process.env.WHATSAPP_MODE === 'live';
const FILE_TTL_S = 900;
const DUP_TIMEOUT = 60_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

app.use(express.urlencoded({ extended: false }));

function twiml() { return new twilio.twiml.MessagingResponse(); }
const OK = '✅', WARN = '⚠️', THINK = '🤔';

/* ───────── webhook entry ───────── */
app.post('/webhook', async (req, res) => {
  const { Body = '', From, NumMedia = 0 } = req.body;
  const mediaCount = +NumMedia || 0;
  const rsp = twiml();

  try {
    const dup = await sessionStore.getDupState(From);
    if (dup) { await dupReply({ Body, From, rsp, dup }); return finish(res, rsp); }

    if (mediaCount) {
      const total = await intakeMedia({ req, From, mediaCount });
      rsp.message(`📊 I’ve stashed *${total}* contacts so far.\n\n1️⃣ Crunch them now  |  2️⃣ Send more`);
      return finish(res, rsp);
    }

    const k = Body.trim();
    if (k === '2') { rsp.message('👍 Send the next card when ready.'); return finish(res, rsp); }
    if (k === '1') { await startConversion({ From, rsp }); return finish(res, rsp); }

    rsp.message('👋 Send me WhatsApp contact cards and I’ll cook up a spreadsheet for you!');
  } catch (e) {
    console.error(e);
    rsp.message(`${WARN} Oops – something broke. Give it another go.`);
  }
  finish(res, rsp);
});

/* ───────── intake & conversion ───────── */
async function intakeMedia({ req, From, mediaCount }) {
  const pile = [];
  for (let i = 0; i < mediaCount; i++) {
    const url = req.body[`MediaUrl${i}`];
    if (!url) continue;
    pile.push(...parseVCF(await fetchVCF(url)));
  }
  return sessionStore.appendContacts(From, pile);
}

async function startConversion({ From, rsp }) {
  const staged = await sessionStore.popContacts(From);
  if (!staged.length) { rsp.message(`${THINK} Nothing staged yet!`); return; }

  const { uniques, duplicates } = splitDup(staged);

  if (duplicates.length) {
    await sessionStore.setDupState(
      From,
      { uniques, duplicates, cursor: 0, chosen: [] },
      DUP_TIMEOUT / 1000
    );
    promptDup({ From, rsp });
    return;
  }
  await sendXlsx({ From, list: uniques, rsp });
}

async function dupReply({ Body, From, rsp, dup }) {
  if (!/^[12]$/.test(Body.trim())) { rsp.message('Please tap 1️⃣ or 2️⃣.'); return; }
  dup.chosen.push(dup.duplicates[dup.cursor][Body.trim() === '1' ? 0 : 1]);
  dup.cursor++;

  if (dup.cursor < dup.duplicates.length) {
    await sessionStore.setDupState(From, dup, DUP_TIMEOUT / 1000);
    promptDup({ From, rsp });
    return;
  }
  await sessionStore.clearDupState(From);
  await sendXlsx({ From, list: dup.uniques.concat(dup.chosen), rsp });
}

/* ───────── helpers ───────── */
async function fetchVCF(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  const r = await axios.get(url, { auth: { username: sid, password: tok }, responseType: 'text' });
  return r.data;
}

function splitDup(list) {
  const map = new Map();
  list.forEach(c => {
    if (!c.mobile) return;
    if (!map.has(c.mobile)) map.set(c.mobile, []);
    map.get(c.mobile).push(c);
  });
  const uniques = [], duplicates = [];
  map.forEach(arr => (arr.length === 1 ? uniques : duplicates).push(arr.length === 1 ? arr[0] : arr));
  return { uniques, duplicates };
}

function promptDup({ From, rsp }) {
  sessionStore.getDupState(From).then(s => {
    const g = s.duplicates[s.cursor];
    rsp.message(
      `${WARN} Same number spotted: ${g[0].mobile}\n\n` +
      `1️⃣ ${g[0].name || 'No Name'}\n` +
      `2️⃣ ${g[1].name || 'No Name'}\n\n` +
      'Type 1 or 2 to keep one.'
    );
  });
}

function listToWorkbook(list) {
  const header = ['Name', 'Phone', 'Email', 'Passes'];
  const rows = list.map(c => [c.name, c.mobile, c.email || '', c.passes || 1]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function sendXlsx({ From, list, rsp }) {
  const buf = listToWorkbook(list);
  const id  = uuid();

  await sessionStore.setTempFile(
    id,
    { content: buf.toString('base64'), filename: `contacts_${Date.now()}.xlsx`, b64: true },
    FILE_TTL_S
  );
  const url = `${BASE_URL}/files/${id}`;

  console.log(`📎 Sent XLSX with ${list.length} entries to ${From}`);

  const m = rsp.message(`${OK} *Conversion complete!* – sending ${list.length} contacts…`);
  m.media(url);
}

function finish(res, t) { res.type('text/xml').send(t.toString()); }

/* ───────── file endpoints ───────── */
app.get('/files/:id', async (req, res) => {
  const f = await sessionStore.getTempFile(req.params.id);
  if (!f) return res.status(404).send('Gone');
  const bin = Buffer.from(f.content, 'base64');
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.send(bin);
});

app.head('/files/:id', async (req, res) => {
  const f = await sessionStore.getTempFile(req.params.id);
  if (!f) return res.sendStatus(404);
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Length', Buffer.byteLength(Buffer.from(f.content, 'base64')));
  res.sendStatus(200);
});

/* ───────── boot ───────── */
app.listen(PORT, () => console.log(`🚀 XLSX-bot @${PORT} (${MODE_LIVE ? 'live' : 'sandbox'})`));
