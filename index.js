// index.js

const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import parsing modules
const { parseVCF } = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const { parseContactFile, getSupportedFormats } = require('./src/csv-excel-parser');

const app = express();
app.use(express.urlencoded({ extended: false }));

// Production config
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

// Restrict access to only your number for now
const AUTHORIZED_NUMBERS = ['+2348121364213', '+16466030424']; // Add yours here

// Template SID for Twilio template
const TEMPLATE_SID = process.env.TEMPLATE_SID;

// Storage (in-memory for dev, redis for prod)
let fileStorage = {};
let redisClient;
if (IS_PRODUCTION && process.env.REDIS_URL) {
    const redis = require('redis');
    redisClient = redis.createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Error', err));
    redisClient.connect().then(() => console.log('Redis Connected'));
}

// Storage ops
const storage = {
    async set(key, value, expirySeconds = 7200) {
        if (redisClient) {
            await redisClient.set(key, JSON.stringify(value), { EX: expirySeconds });
        } else {
            fileStorage[key] = {
                data: value,
                expires: Date.now() + (expirySeconds * 1000)
            };
        }
    },
    async get(key) {
        if (redisClient) {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } else {
            const item = fileStorage[key];
            if (!item) return null;
            if (Date.now() > item.expires) {
                delete fileStorage[key];
                return null;
            }
            return item.data;
        }
    },
    async del(key) {
        if (redisClient) {
            await redisClient.del(key);
        } else {
            delete fileStorage[key];
        }
    }
};

// Restrict to authorised numbers only
function isAuthorizedNumber(phoneNumber) {
    const cleanNumber = phoneNumber.replace('whatsapp:', '');
    return AUTHORIZED_NUMBERS.includes(cleanNumber);
}

// ----------- CONTACT MEDIA PARSER ----------- //
async function parseContactMedia(mediaUrl, req) {
    // Download the file
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    const response = await axios.get(mediaUrl, {
        auth: { username: accountSid, password: authToken },
        responseType: 'arraybuffer'
    });

    const fileBuffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';

    // Handle each format
    if (contentType.includes('text/x-vcard') || contentType.includes('text/vcard')) {
        // VCF
        const vcfContent = fileBuffer.toString('utf8');
        return parseVCF(vcfContent);
    } else if (contentType.includes('text/csv') || contentType.includes('application/csv')) {
        // CSV
        return parseContactFile(fileBuffer, 'contacts.csv');
    } else if (contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
        // Excel xlsx
        return parseContactFile(fileBuffer, 'contacts.xlsx');
    } else if (contentType.includes('application/vnd.ms-excel')) {
        // Excel xls
        return parseContactFile(fileBuffer, 'contacts.xls');
    } else if (contentType.includes('application/pdf')) {
        // PDF
        return parseContactFile(fileBuffer, 'contacts.pdf');
    } else if (contentType.includes('text/plain')) {
        // Text file
        return parseContactFile(fileBuffer, 'contacts.txt');
    } else {
        // Fallback: Try VCF first, then text
        const vcfContent = fileBuffer.toString('utf8');
        if (vcfContent.includes('BEGIN:VCARD')) {
            return parseVCF(vcfContent);
        }
        // Fallback to text parser
        return parseContactFile(fileBuffer, 'contacts.txt');
    }
}

// ----------- TWILIO BOT LOGIC ----------- //
app.post('/webhook', async (req, res) => {
    const { Body, From, MediaUrl0, NumMedia } = req.body;
    const twiml = new twilio.twiml.MessagingResponse();

    try {
        // Authorisation
        if (!isAuthorizedNumber(From)) {
            return res.type('text/xml').send(twiml.toString());
        }

        // FILE RECEIVED
        if (NumMedia > 0 && MediaUrl0) {
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0 };
            try {
                const newContacts = await parseContactMedia(MediaUrl0, req);
                if (!newContacts.length) {
                    twiml.message("❌ Couldn’t find any contacts in that file. Make sure it’s in VCF, CSV, Excel, PDF or Text format, and includes at least a name or phone number.");
                } else {
                    batch.contacts.push(...newContacts);
                    batch.count = batch.contacts.length;
                    batch.lastUpdated = Date.now();
                    await storage.set(`batch:${From}`, batch, 600);
                    twiml.message(`💾 ${batch.count} contacts saved so far.  \n\nTap 1️⃣ to export • 2️⃣ to add more files\n\n_Supported: VCF, CSV, Excel, PDF, Text_`);
                }
            } catch (err) {
                twiml.message("❌ Sorry, I couldn’t process that file. Please check the format and try again (VCF, CSV, Excel, PDF or Text supported).");
            }
            return res.type('text/xml').send(twiml.toString());
        }

        // EXPORT BATCH
        if (Body === '1' || Body === '1️⃣') {
            const batch = await storage.get(`batch:${From}`);
            if (!batch || !batch.contacts.length) {
                twiml.message("❌ No contacts to export yet. Please upload your contact files first!");
                return res.type('text/xml').send(twiml.toString());
            }
            const csv = generateCSV(batch.contacts);
            const fileId = uuidv4();
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                from: From,
                created: Date.now(),
                contactCount: batch.contacts.length
            });
            const downloadUrl = `${BASE_URL}/download/${fileId}`;
            twiml.message(`✅ Your CSV file with ${batch.contacts.length} contacts is ready!  \n\n[Download CSV](${downloadUrl})  \n\nLink expires in 2 hours.`);
            await storage.del(`batch:${From}`);
            return res.type('text/xml').send(twiml.toString());
        }

        // ADD MORE
        if (Body === '2' || Body === '2️⃣') {
            twiml.message("📥 Ready for more! Just upload the next contact file.\n\n_Supported formats: VCF, CSV, Excel, PDF, Text_");
            return res.type('text/xml').send(twiml.toString());
        }

        // HELP/INFO
        if (Body.toLowerCase() === 'help') {
            twiml.message(
                "📋 *How to use this bot:*\n" +
                "1. Upload a contact file (VCF, CSV, Excel, PDF, or Text)\n" +
                "2. I’ll parse all the contacts—repeat to add more files\n" +
                "3. Tap 1️⃣ to export to CSV, or 2️⃣ to keep adding\n\n" +
                "_Supported: VCF, CSV, Excel, PDF, Text_"
            );
            return res.type('text/xml').send(twiml.toString());
        }

        // Unknown text – prompt to upload
        twiml.message("👋 Upload a contact file to get started!  \n_Supported: VCF, CSV, Excel, PDF, Text_  \n\nType 'help' for instructions.");
        return res.type('text/xml').send(twiml.toString());
    } catch (err) {
        console.error('❌ BOT ERROR:', err);
        twiml.message("❌ Something went wrong. Please try again in a moment!");
        return res.type('text/xml').send(twiml.toString());
    }
});

// ----------- DOWNLOAD ENDPOINT ----------- //
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const fileData = await storage.get(`file:${fileId}`);
    if (!fileData) {
        return res.status(404).send("⏰ This download link has expired. Please upload your contacts again.");
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
    res.send(fileData.content);
});

// ----------- SERVER START ----------- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Universal WhatsApp Contact Parser is running on port ${PORT}`);
});

