/**
 * WhatsApp CSV Converter – v1-sandbox
 * Multi-file intake ▸ confirmation ▸ duplicate resolver ▸ CSV generator
 * Mode controlled by WHATSAPP_MODE (sandbox | live)
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
const BASE_URL   = process.env.BASE_URL || `http://localhost:${PORT}`;
const MODE_LIVE  = process.env.WHATSAPP_MODE === 'live';   // sandbox by default
const FILE_TTL_S = 7200;                                   // 2 h
const DUP_TIMEOUT_MS = 60_000;                             // 60 s

app.use(express.urlencoded({ extended: false }));

/* ---------- helpers ------------------------------------------------------- */
function twiml() { return new twilio.twiml.MessagingResponse(); }
const OK_EMOJI  = '\u2705';  // ✅
const ERR_EMOJI = '\u274C';  // ❌

/* ---------- webhook ------------------------------------------------------- */
app.post('/webhook', async (req, res) => {
  const { Body = '', From, NumMedia = 0 } = req.body;
  const mediaCount = parseInt(NumMedia, 10) || 0;
  const reply = twiml();

  try {
    /* 1 ▸ waiting for duplicate choice? */
    const dupState = await sessionStore.getDupState(From);
    if (dupState) {
      await handleDuplicateReply({ Body, From, reply, dupState });
      return finish(res, reply);
    }

    /* 2 ▸ media upload(s) */
    if (mediaCount > 0) {
      const total = await handleMediaBatch({ req, From, mediaCount });
      reply.message(
        `Collected ${total} contacts so far.\n` +
        `1 – Convert to CSV\n2 – Add more contacts`
      );
      return finish(res, reply);
    }

    /* 3 ▸ confirmation keys */
    const clean = Body.trim();
    if (clean === '2') {
      reply.message('Sure – send the next contact file.');
      return finish(res, reply);
    }
    if (clean === '1') {
      await beginConversion({ From, reply });
      return finish(res, reply);
    }

    /* 4 ▸ fallback / help */
    reply.message(
      'Hi! Send me WhatsApp contact cards and I’ll turn them into a ' +
      'password-protected CSV.\nType *help* for more.'
    );

  } catch (err) {
    console.error(err);
    reply.message(`${ERR_EMOJI} Unexpected error – please try again later.`);
  }

  finish(res, reply);
});

/* ---------- handlers ------------------------------------------------------ */
async function handleMediaBatch({ req, From, mediaCount }) {
  const contacts = [];
  for (let i = 0; i < mediaCount; i += 1) {
    const mediaUrl = req.body[`MediaUrl${i}`];
    if (!mediaUrl) continue;
    const vcf = await downloadVCF(mediaUrl);
    contacts.push(...parseVCF(vcf));
  }
  return sessionStore.appendContacts(From, contacts);
}

async function beginConversion({ From, reply }) {
  const staged = await sessionStore.popContacts(From);
  if (!staged.length) {
    reply.message('No contacts staged – send some vCards first.');
    return;
  }

  const { uniques, duplicates } = splitDuplicates(staged);

  if (duplicates.length) {
    await sessionStore.setDupState(From, {
      uniques, duplicates, cursor: 0, selected: []
    }, DUP_TIMEOUT_MS / 1000);
    promptNextDuplicate({ From, reply });
    return;
  }

  await deliverCsv({ From, contacts: uniques, reply });
}

async function handleDuplicateReply({ Body, From, reply, dupState }) {
  const choice = Body.trim();
  if (!/^[12]$/.test(choice)) {
    reply.message('Please reply 1 or 2.');
    return;
  }

  const idx   = dupState.cursor;
  const pair  = dupState.duplicates[idx];
  dupState.selected.push(pair[parseInt(choice) - 1]);
  dupState.cursor++;

  if (dupState.cursor < dupState.duplicates.length) {
    await sessionStore.setDupState(From, dupState, DUP_TIMEOUT_MS / 1000);
    promptNextDuplicate({ From, reply });
    return;
  }

  await sessionStore.clearDupState(From);
  const finalList = dupState.uniques.concat(dupState.selected);
  await deliverCsv({ From, contacts: finalList, reply });
}

/* ---------- helpers ------------------------------------------------------- */
async function downloadVCF(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const resp = await axios.get(url, {
    auth: { username: sid, password: token }, responseType: 'text'
  });
  return resp.data;
}

function splitDuplicates(list) {
  const map = new Map();
  list.forEach(c => {
    if (!c.mobile) return;
    if (!map.has(c.mobile)) map.set(c.mobile, []);
    map.get(c.mobile).push(c);
  });
  const uniques = [], duplicates = [];
  map.forEach(arr => arr.length === 1 ? uniques.push(arr[0]) : duplicates.push(arr));
  return { uniques, duplicates };
}

function promptNextDuplicate({ From, reply }) {
  sessionStore.getDupState(From).then(state => {
    const grp = state.duplicates[state.cursor];
    const phone = grp[0].mobile;
    reply.message(
      `Duplicate found for ${phone}\n` +
      `1) ${grp[0].name || 'Unnamed'}\n` +
      `2) ${grp[1].name || 'Unnamed'}\n` +
      `Reply 1 or 2 to keep that version`
    );
  });
}

async function deliverCsv({ From, contacts, reply }) {
  const csv      = generateCSV(contacts);
  const fileId   = uuid();
  const password = Math.floor(100000 + Math.random() * 900000).toString();

  await sessionStore.setTempFile(fileId, {
    content: csv,
    filename: `contacts_${Date.now()}.csv`,
    password,
    owner: From
  }, FILE_TTL_S);

  const url = `${BASE_URL}/download/${fileId}`;
  reply.message(
    `${OK_EMOJI} *Conversion complete!* – ${contacts.length} contacts converted.\n` +
    `Download: ${url}\nPassword: ${password}\n(Link valid 2 h)`
  );
}

function finish(res, twimlObj) {
  res.type('text/xml').send(twimlObj.toString());
}

/* ---------- password-protected download route ----------------------------- */
app.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  const { p }  = req.query;       // ?p=123456
  const file   = await sessionStore.getTempFile(id);

  if (!file) return res.status(404).send('❌ Link expired or file not found');

  if (!p || p !== file.password) {
    return res.send(`<!DOCTYPE html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Enter Password</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial;
             display:flex;justify-content:center;align-items:center;
             min-height:100vh;margin:0;background:#f5f5f5}
        .box{background:#fff;padding:2rem;border-radius:10px;
             box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:320px;width:90%}
        input,button{width:100%;padding:12px;font-size:16px;margin-top:10px;
                     border-radius:5px;border:2px solid #ddd;box-sizing:border-box}
        button{background:#25d366;color:#fff;border:none}
      </style></head><body>
      <div class="box">
        <h2>🔐 Enter 6-digit password</h2>
        ${p ? '<p style="color:#d33">Incorrect code, try again.</p>' : ''}
        <form>
          <input type="text" name="p" maxlength="6" pattern="[0-9]{6}" required autofocus>
          <button type="submit">Download CSV</button>
        </form>
        <p style="font-size:13px;color:#666;margin-top:10px">
          The password was sent to you in WhatsApp.<br>
          Link auto-expires in 2 hours.
        </p>
      </div></body></html>`);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition',
    `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

/* ---------- start-up ------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp CSV Converter listening on ${PORT} (${MODE_LIVE ? 'live' : 'sandbox'})`);
});