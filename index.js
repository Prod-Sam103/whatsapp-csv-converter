/**
 * WhatsApp CSV Converter – Set C UX
 * • multi-file intake ▸ confirmation ▸ duplicate resolver
 * • password-protected download-link flow (sandbox-friendly)
 */

const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const { v4: uuid } = require('uuid');
require('dotenv').config();

const { parseVCF }    = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const sessionStore    = require('./src/session-store');

const app        = express();
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL || `https://whatsapp-csv-converter-production.up.railway.app`;
const FILE_TTL_S = 7200;        // 2 h for download link
const DUP_TIMEOUT_MS = 60_000;

app.use(express.urlencoded({ extended: false }));

const twiml = () => new twilio.twiml.MessagingResponse();

/* ---------------- webhook ---------------- */
app.post('/webhook', async (req, res) => {
  const { Body = '', From, NumMedia = 0 } = req.body;
  const mediaCount = +NumMedia || 0;
  const rsp = twiml();

  try {
    /* 1. duplicate-resolver state */
    const dup = await sessionStore.getDupState(From);
    if (dup) {
      await handleDupReply({ Body, From, rsp, dup });
      return send(rsp, res);
    }

    /* 2. media intake */
    if (mediaCount) {
      const total = await handleMediaBatch({ req, From, mediaCount });
      rsp.message(
        `💾 *${total}* saved so far.\n` +
        `Tap 1️⃣ to export • 2️⃣ to keep loading`
      );
      return send(rsp, res);
    }

    /* 3. key commands */
    const key = Body.trim();
    if (key === '2') {
      rsp.message('👌 Fire away—waiting…');
      return send(rsp, res);
    }
    if (key === '1') {
      await beginConversion({ From, rsp });
      return send(rsp, res);
    }

    /* 4. idle / help */
    rsp.message('📨 Drop your contact cards—let’s bulk-load them! 🚀');
  } catch (err) {
    console.error(err);
    rsp.message('🛑 Glitch detected. Let’s try that again.');
  }
  send(rsp, res);
});

/* ---------------- handlers ---------------- */
async function handleMediaBatch({ req, From, mediaCount }) {
  const contacts = [];
  for (let i = 0; i < mediaCount; i++) {
    const url = req.body[`MediaUrl${i}`];
    if (!url) continue;
    contacts.push(...parseVCF(await fetchVCF(url)));
  }
  return sessionStore.appendContacts(From, contacts);
}

async function beginConversion({ From, rsp }) {
  const staged = await sessionStore.popContacts(From);
  if (!staged.length) {
    rsp.message('🕳️ Nothing here yet. Send a card to kick off.');
    return;
  }

  const { uniques, duplicates } = splitDuplicates(staged);

  if (duplicates.length) {
    await sessionStore.setDupState(
      From,
      { uniques, duplicates, cursor: 0, chosen: [] },
      DUP_TIMEOUT_MS / 1000
    );
    promptNextDup({ From, rsp });
    return;
  }

  await sendCsv({ From, list: uniques, rsp });
}

async function handleDupReply({ Body, From, rsp, dup }) {
  if (!/^[12]$/.test(Body.trim())) {
    rsp.message('⛔ Just 1 or 2, please.');
    return;
  }

  dup.chosen.push(dup.duplicates[dup.cursor][Body.trim() === '1' ? 0 : 1]);
  dup.cursor++;

  if (dup.cursor < dup.duplicates.length) {
    await sessionStore.setDupState(From, dup, DUP_TIMEOUT_MS / 1000);
    promptNextDup({ From, rsp });
    return;
  }

  await sessionStore.clearDupState(From);
  await sendCsv({ From, list: dup.uniques.concat(dup.chosen), rsp });
}

/* ---------------- utilities ---------------- */
async function fetchVCF(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  const r = await axios.get(url, {
    auth: { username: sid, password: tok }, responseType: 'text'
  });
  return r.data;
}

function splitDuplicates(list) {
  const map = new Map();
  list.forEach(c => {
    if (!c.mobile) return;
    if (!map.has(c.mobile)) map.set(c.mobile, []);
    map.get(c.mobile).push(c);
  });
  const uniques = [], duplicates = [];
  map.forEach(arr => (arr.length === 1 ? uniques : duplicates)
    .push(arr.length === 1 ? arr[0] : arr));
  return { uniques, duplicates };
}

function promptNextDup({ From, rsp }) {
  sessionStore.getDupState(From).then(state => {
    const g = state.duplicates[state.cursor];
    rsp.message(
      `🤹‍♂️ Duplicate spotted for ${g[0].mobile}:\n` +
      `1️⃣ ${g[0].name || 'No Name'}\n` +
      `2️⃣ ${g[1].name || 'No Name'}`
    );
  });
}

async function sendCsv({ From, list, rsp }) {
  const csv  = generateCSV(list);
  const id   = uuid();
  const pw   = Math.floor(100000 + Math.random() * 900000).toString();

  await sessionStore.setTempFile(id, {
    content: csv,
    filename: `contacts_${Date.now()}.csv`,
    password: pw,
    owner: From
  }, FILE_TTL_S);

  const link = `${BASE_URL}/download/${id}`;
  rsp.message(
    `🎉 Done! *${list.length}* contacts ready.\n` +
    `🔗 ${link} (PW ${pw}, 2 hrs)`
  );
}

function send(rsp, res) { res.type('text/xml').send(rsp.toString()); }

/* ---------------- download route ---------------- */
app.get('/download/:id', async (req, res) => {
  const file = await sessionStore.getTempFile(req.params.id);
  const p    = req.query.p;

  if (!file) return res.status(404).send('Link expired.');

  if (p !== file.password) {
    return res.status(401).send(`
      <h2>🔐 Enter 6-digit password</h2>
      <form method="GET">
        <input name="p" maxlength="6" pattern="[0-9]{6}" required autofocus>
        <button type="submit">Download CSV</button>
      </form>
      ${p ? '<p style="color:red">Incorrect password</p>' : ''}
    `);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

/* ---------------- boot ---------------- */
app.listen(PORT, () => console.log(`🚀 CSV-bot running on ${PORT}`));
