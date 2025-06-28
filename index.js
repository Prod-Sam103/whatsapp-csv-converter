/**
 * WhatsApp CSV Converter v1-sandbox
 * Multi-file intake ▸ confirmation prompts ▸ duplicate resolver ▸ CSV generator
 * Mode controlled by WHATSAPP_MODE (sandbox | live)
 */
const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const { v4: uuid } = require('uuid');
require('dotenv').config();

const { parseVCF }     = require('./src/vcf-parser');
const { generateCSV }  = require('./src/csv-generator');
const sessionStore     = require('./src/session-store');

const app        = express();
const PORT       = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL || `http://localhost:${PORT}`;
const MODE_LIVE  = process.env.WHATSAPP_MODE === 'live';      // sandbox by default
const FILE_TTL_S = 7200;                                      // 2 h download link
const DUP_TIMEOUT_MS = 60_000;                                // 60 s reply window

app.use(express.urlencoded({ extended: false }));

/* -------------------------------------------------------- HELPERS */

function twiml() { return new twilio.twiml.MessagingResponse(); }

const OK_EMOJI = '\u2705';   // ✅
const ERR_EMOJI = '\u274C';  // ❌

/* -------------------------------------------------------- WEBHOOK */

app.post('/webhook', async (req, res) => {
  const { Body = '', From, NumMedia = 0 } = req.body;
  const mediaCount = parseInt(NumMedia, 10) || 0;

  const reply = twiml();

  try {
    /* -------- 1. DUPLICATE-RESOLUTION STATE -------------------------------- */
    const dupState = await sessionStore.getDupState(From);
    if (dupState) {
      await handleDuplicateReply({ Body, From, reply, dupState });
      return finish(res, reply);
    }

    /* -------- 2. MEDIA UPLOAD(S) ------------------------------------------ */
    if (mediaCount > 0) {
      const added = await handleMediaBatch({ req, From, mediaCount });
      reply.message(
        `Collected ${added} contacts so far.\n` +
        `1 – Convert to CSV\n2 – Add more contacts`
      );
      return finish(res, reply);
    }

    /* -------- 3. CONFIRMATION KEYS ---------------------------------------- */
    const cleanBody = Body.trim();
    if (cleanBody === '2') {
      reply.message('Sure – send the next contact file.');
      return finish(res, reply);
    }

    if (cleanBody === '1') {
      await beginConversionFlow({ From, reply });
      return finish(res, reply);
    }

    /* -------- 4. FALL-BACK / HELP ----------------------------------------- */
    if (cleanBody.toLowerCase() === 'help') {
      reply.message(
        `*WhatsApp CSV Converter*\n` +
        `• Send one or more contact cards\n` +
        `• Reply 1 to convert\n` +
        `• Reply 2 to add more\n`
      );
    } else {
      reply.message(
        `Hi! Send me WhatsApp contact cards and I'll convert them to CSV.\n` +
        `Type *help* for the full guide.`
      );
    }
  } catch (err) {
    console.error(err);
    reply.message(`${ERR_EMOJI} Unexpected error – please try again later.`);
  }

  finish(res, reply);
});

/* -------------------------------------------------------- HANDLERS */

/**
 *  Download each media attachment, parse VCF, and stash in the session store.
 *  Returns total contacts in the current session *after* this upload.
 */
async function handleMediaBatch({ req, From, mediaCount }) {
  const contacts = [];

  for (let i = 0; i < mediaCount; i += 1) {
    const mediaUrl = req.body[`MediaUrl${i}`];
    if (!mediaUrl) continue;

    const vcf = await downloadVCF(mediaUrl);
    const parsed = parseVCF(vcf);
    contacts.push(...parsed);
  }

  return sessionStore.appendContacts(From, contacts);
}

/**
 *  When user replies "1" – we de-dupe, maybe start duplicate-resolver,
 *  or else generate CSV straight away.
 */
async function beginConversionFlow({ From, reply }) {
  const staged = await sessionStore.popContacts(From);

  if (staged.length === 0) {
    reply.message('No contacts staged – send some vCards first.');
    return;
  }

  const { uniques, duplicates } = splitDuplicates(staged);

  if (duplicates.length) {
    // stash duplicate-resolver state
    await sessionStore.setDupState(From, {
      uniques,
      duplicates,
      cursor: 0,
      selected: []
    });
    promptNextDuplicate({ From, reply });
    return;
  }

  await sendCsvReply({ From, contacts: uniques, reply });
}

/**
 *  Handle a reply in the duplicate-resolver sub-flow.
 */
async function handleDuplicateReply({ Body, From, reply, dupState }) {
  const choice = Body.trim();
  if (!/^[12]$/.test(choice)) {
    reply.message('Please reply 1 or 2.');
    return;
  }

  const idx = dupState.cursor;
  const group = dupState.duplicates[idx];
  dupState.selected.push(group[parseInt(choice, 10) - 1]);
  dupState.cursor++;

  if (dupState.cursor < dupState.duplicates.length) {
    await sessionStore.setDupState(From, dupState, DUP_TIMEOUT_MS / 1000);
    promptNextDuplicate({ From, reply });
    return;
  }

  // all resolved – destroy state & generate CSV
  await sessionStore.clearDupState(From);
  const finalList = dupState.uniques.concat(dupState.selected);
  await sendCsvReply({ From, contacts: finalList, reply });
}

/* -------------------------------------------------------- UTILS */

async function downloadVCF(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const resp = await axios.get(url, {
    auth: { username: sid, password: token },
    responseType: 'text'
  });
  return resp.data;
}

/** Split contacts into uniques & duplicate groups */
function splitDuplicates(list) {
  const map = new Map();
  for (const c of list) {
    if (!c.mobile) continue;
    const key = c.mobile;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }

  const uniques = [];
  const duplicates = [];

  for (const arr of map.values()) {
    if (arr.length === 1) uniques.push(arr[0]);
    else duplicates.push(arr);
  }
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

async function sendCsvReply({ From, contacts, reply }) {
  const csv = generateCSV(contacts);
  const fileId  = uuid();
  const password = Math.floor(100_000 + Math.random() * 900_000).toString();

  await sessionStore.setTempFile(fileId, {
    content:   csv,
    filename:  `contacts_${Date.now()}.csv`,
    password,
    owner:     From
  }, FILE_TTL_S);

  const url = `${BASE_URL}/download/${fileId}`;
  reply.message(
    `${OK_EMOJI} Done – ${contacts.length} contacts converted.\n` +
    `Download: ${url}\nPassword: ${password}\n(Link valid 2 h)`
  );
}

function finish(res, twimlObj) {
  res.type('text/xml').send(twimlObj.toString());
}

/* -------------------------------------------------------- HTTP – CSV DOWNLOAD */

app.get('/download/:id', async (req, res) => {
  const file = await sessionStore.getTempFile(req.params.id);
  if (!file) return res.status(404).send('Link expired');

  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.type('text/csv').send(file.content);
});

/* -------------------------------------------------------- START-UP */

app.listen(PORT, () => {
  console.log(`🚀  WhatsApp CSV Converter listening on ${PORT} (${MODE_LIVE ? 'live' : 'sandbox'})`);
});
