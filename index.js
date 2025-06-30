/**
 * WhatsApp CSV Converter — v1.5 (attachment-fix)
 */
const express = require('express');
const twilio  = require('twilio');
const axios   = require('axios');
const { v4: uuid } = require('uuid');
require('dotenv').config();

console.log('ENV REDIS_URL =', process.env.REDIS_URL || 'undefined');
process.on('uncaughtException', e => { console.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('UNHANDLED', e); process.exit(1); });

const { parseVCF }    = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const sessionStore    = require('./src/session-store');

const app        = express();
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL || `https://localhost:${PORT}`; // use https in fallback
const MODE_LIVE  = process.env.WHATSAPP_MODE === 'live';
const FILE_TTL_S = 900;
const DUP_TIMEOUT = 60_000;
const CSV_MIME   = 'application/vnd.ms-excel';           // WhatsApp-safe

app.use(express.urlencoded({ extended: false }));

function twiml() { return new twilio.twiml.MessagingResponse(); }
const OK = '✅', WARN = '⚠️', THINK = '🤔';

/* ───────── webhook core ───────── */
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

    const key = Body.trim();
    if (key === '2') { rsp.message('👍 Send the next card when ready.'); return finish(res, rsp); }
    if (key === '1') { await startConversion({ From, rsp }); return finish(res, rsp); }

    rsp.message('👋 Send me WhatsApp contact cards and I’ll cook up a CSV for you!');
  } catch (e) {
    console.error(e);
    rsp.message(`${WARN} Oops – something broke. Give it another go.`);
  }
  finish(res, rsp);
});

/* intake, duplicates, CSV send — unchanged */
async function intakeMedia({ req, From, mediaCount }) {
  const pile = [];
  for (let i = 0; i < mediaCount; i++) {
    const url = req.body[`MediaUrl${i}`]; if (!url) continue;
    pile.push(...parseVCF(await dl(url)));
  }
  return sessionStore.appendContacts(From, pile);
}

async function startConversion({ From, rsp }) {
  const staged = await sessionStore.popContacts(From);
  if (!staged.length) { rsp.message(`${THINK} Nothing staged yet!`); return; }

  const { uniques, duplicates } = splitDup(staged);

  if (duplicates.length) {
    await sessionStore.setDupState(From, { uniques, duplicates, cursor: 0, chosen: [] }, DUP_TIMEOUT / 1000);
    promptDup({ From, rsp }); return;
  }
  await sendCsv({ From, list: uniques, rsp });
}

async function dupReply({ Body, From, rsp, dup }) {
  if (!/^[12]$/.test(Body.trim())) { rsp.message('Please tap 1️⃣ or 2️⃣.'); return; }
  dup.chosen.push(dup.duplicates[dup.cursor][Body.trim() === '1' ? 0 : 1]);
  dup.cursor++;

  if (dup.cursor < dup.duplicates.length) {
    await sessionStore.setDupState(From, dup, DUP_TIMEOUT / 1000);
    promptDup({ From, rsp }); return;
  }
  await sessionStore.clearDupState(From);
  await sendCsv({ From, list: dup.uniques.concat(dup.chosen), rsp });
}

/* helpers */
async function dl(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  return (await axios.get(url, { auth: { username: sid, password: tok }, responseType: 'text' })).data;
}
function splitDup(list) {
  const map=new Map();
  list.forEach(c=>{ if(!c.mobile) return; if(!map.has(c.mobile)) map.set(c.mobile,[]); map.get(c.mobile).push(c);});
  const uniques=[],dup=[]; map.forEach(a=>a.length===1?uniques.push(a[0]):dup.push(a)); return{uniques,duplicates:dup};}
function promptDup({From,rsp}){sessionStore.getDupState(From).then(s=>{const g=s.duplicates[s.cursor];rsp.message(`${WARN} Same number spotted: ${g[0].mobile}\n\n1️⃣ ${g[0].name||'No Name'}\n2️⃣ ${g[1].name||'No Name'}\n\nType 1 or 2 to keep one.`);});}

async function sendCsv({ From, list, rsp }) {
  const csv = generateCSV(list);
  const id  = uuid();
  await sessionStore.setTempFile(id,{content:csv,filename:`contacts_${Date.now()}.csv`},FILE_TTL_S);
  const url = `${BASE_URL}/files/${id}`;

  console.log(`📎 Sent CSV with ${list.length} entries to ${From}`);
  const m = rsp.message(`${OK} *Conversion complete!* – sending ${list.length} contacts…`);
  m.media(url);
}

function finish(res, t){res.type('text/xml').send(t.toString());}

/* ───────── file endpoints ───────── */
app.get('/files/:id', async (req,res)=>{
  const f=await sessionStore.getTempFile(req.params.id);
  if(!f) return res.status(404).send('Gone');
  res.setHeader('Content-Type', CSV_MIME);
  res.setHeader('Content-Disposition',`attachment; filename="${f.filename}"`);
  res.send(f.content);
});
app.head('/files/:id', async (req,res)=>{
  const f=await sessionStore.getTempFile(req.params.id);
  if(!f) return res.sendStatus(404);
  res.setHeader('Content-Type', CSV_MIME);
  res.setHeader('Content-Length', Buffer.byteLength(f.content));
  res.sendStatus(200);
});

/* boot */
app.listen(PORT, ()=>console.log(`🚀 CSV-bot @${PORT} (${MODE_LIVE?'live':'sandbox'})`));
