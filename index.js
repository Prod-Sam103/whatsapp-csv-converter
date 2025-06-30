/**
 * WhatsApp CSV Converter – Set C UX + health-check
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
const FILE_TTL_S = 7200;
const DUP_TIMEOUT_MS = 60_000;

app.use(express.urlencoded({ extended: false }));
const twiml = () => new twilio.twiml.MessagingResponse();

/* ---------------- webhook (same as before) ---------------- */
/* ...  unchanged webhook + helper functions here ... */

/* --- health check --- */
app.get('/', (req, res) => res.send('👍 Alive'));

/* ---------------- boot ---------------- */
app.listen(PORT, () => console.log(`🚀 CSV-bot running on ${PORT}`));
