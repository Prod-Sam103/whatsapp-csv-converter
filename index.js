/**
 * WhatsApp CSV Converter — v1.5
 * • Multi-file intake ▸ confirmation ▸ duplicate resolver
 * • CSV pushed back **as a WhatsApp document** (no external link UI)
 * • Sandbox/live split via WHATSAPP_MODE
 */
const express = require('express');
const twilio  = require('twilio');
const axios   = require('axios');
const { v4: uuid } = require('uuid');
require('dotenv').config();

const { parseVCF }    = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const sessionStore    = require('./src/session-store');

const app        = express();
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL || `http://localhost:${PORT}`;
const MODE_LIVE  = process.env.WHATSAPP_MODE === 'live';
const FILE_TTL_S = 900;          // 15 min, enough for Twilio fetch
const DUP_TIMEOUT_MS = 60_000;

app.use(express.urlencoded({ extended: false }));

/* ───────── helpers ───────── */
function twiml() { return new twilio.twiml.MessagingResponse(); }
const OK = '✅'; const WARN = '⚠️'; const THINK = '🤔';

/* ───────── webhook ───────── */
app.post('/webhook', async (req, res) => {
  const { Body = '', From, NumMedia = 0 } = req.body;
  const mediaCount = parseInt(NumMedia, 10) || 0;
  const reply = twiml();

  try {
    /* 1 ▸ duplicate-resolver */
    const dup = await sessionStore.getDupState(From);
    if (dup) { await dupReply({ Body, From, reply, dup }); return finish(res, reply); }

    /* 2 ▸ media intake */
    if (mediaCount) {
      const total = await intakeMedia({ req, From, mediaCount });
      reply.message(
        `📊 I’ve stashed *${total}* contacts so far.\n\n` +
        `1️⃣ Crunch them now  |  2️⃣ Send more`
      );
      return finish(res, reply);
    }

    /* 3 ▸ command keys */
    const key = Body.trim();
    if (key === '2') { reply.message('👍 Send the next card when ready.'); return finish(res, reply); }
    if (key === '1') { await startConversion({ From, reply }); return finish(res, reply); }

    /* 4 ▸ fallback */
    reply.message('👋 Send me WhatsApp contact cards and I’ll cook up a CSV for you!');
  } catch (e) {
    console.error(e);
    reply.message(`${WARN} Oops – something broke. Give it another go.`);
  }

  finish(res, reply);
});

/* ───────── handlers ───────── */
async function intakeMedia({ req, From, mediaCount }) {
  const pile = [];
  for (let i = 0; i < mediaCount; i++) {
    const url = req.body[`MediaUrl${i}`]; if (!url) continue;
    pile.push(...parseVCF(await dl(url)));
  }
  return sessionStore.appendContacts(From, pile);
}

async function startConversion({ From, reply }) {
  const staged = await sessionStore.popContacts(From);
  if (!staged.length) { reply.message(`${THINK} Nothing staged yet!`); return; }

  const { uniques, duplicates } = splitDup(staged);

  if (duplicates.length) {
    await sessionStore.setDupState(From,{uniques,duplicates,cursor:0,chosen:[]},DUP_TIMEOUT_MS/1000);
    promptDup({ From, reply }); return;
  }
  await sendCsv({ From, list: uniques, reply });
}

async function dupReply({ Body, From, reply, dup }) {
  if (!/^[12]$/.test(Body.trim())) { reply.message('Please tap 1️⃣ or 2️⃣.'); return; }

  const pick = Body.trim() === '1' ? 0 : 1;
  dup.chosen.push(dup.duplicates[dup.cursor][pick]);
  dup.cursor++;

  if (dup.cursor < dup.duplicates.length) {
    await sessionStore.setDupState(From, dup, DUP_TIMEOUT_MS / 1000);
    promptDup({ From, reply }); return;
  }
  await sessionStore.clearDupState(From);
  await sendCsv({ From, list: dup.uniques.concat(dup.chosen), reply });
}

/* ───────── utilities ───────── */
async function dl(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  const r = await axios.get(url, { auth:{username:sid,password:tok}, responseType:'text' });
  return r.data;
}

function splitDup(arr){
  const m=new Map();arr.forEach(c=>{if(!c.mobile)return;(m.has(c.mobile)?m.get(c.mobile):m.set(c.mobile,[])).push(c);});
  const uniq=[],dup=[];m.forEach(v=>v.length===1?uniq.push(v[0]):dup.push(v));return{uniques:uniq,duplicates:dup};
}

function promptDup({ From, reply }) {
  sessionStore.getDupState(From).then(s => {
    const g = s.duplicates[s.cursor];
    reply.message(
      `${WARN} Same number spotted: ${g[0].mobile}\n\n` +
      `1️⃣ ${g[0].name || 'No Name'}\n` +
      `2️⃣ ${g[1].name || 'No Name'}\n\n` +
      'Type 1 or 2 to keep one.'
    );
  });
}

async function sendCsv({ From, list, reply }) {
  const csv  = generateCSV(list);
  const id   = uuid();
  await sessionStore.setTempFile(id,{content:csv,filename:`contacts_${Date.now()}.csv`},FILE_TTL_S);
  const url  = `${BASE_URL}/files/${id}`;

  /* TwiML with media attachment */
  const m = reply.message(`${OK} *Conversion complete!* – sending ${list.length} contacts…`);
  m.media(url);
}

/* ───────── tiny file endpoint ───────── */
app.get('/files/:id', async (req,res)=>{
  const f = await sessionStore.getTempFile(req.params.id);
  if(!f) return res.status(404).send('Gone');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${f.filename}"`);
  res.send(f.content);
});

/* ───────── boot ───────── */
app.listen(PORT, ()=>console.log(`🚀 CSV-bot @${PORT} (${MODE_LIVE?'live':'sandbox'})`));

function finish(r,t){r.type('text/xml').send(t.toString());}
