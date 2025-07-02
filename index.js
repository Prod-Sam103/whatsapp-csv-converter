const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import tactical modules
const { parseVCF } = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const { parseContactFile, getSupportedFormats } = require('./src/csv-excel-parser');

const app = express();
app.use(express.urlencoded({ extended: false }));

// PRODUCTION CONFIGURATION
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

// TESTING RESTRICTION - Only your number
const AUTHORIZED_NUMBERS = ['+2348121364213']; // Your personal number

// Template Configuration
const TEMPLATE_SID = process.env.TEMPLATE_SID;

// Storage (will be replaced with Redis in production)
let fileStorage = {};

// Import Redis if in production
let redisClient;
if (IS_PRODUCTION && process.env.REDIS_URL) {
    const redis = require('redis');
    redisClient = redis.createClient({
        </head>
        <body>
            <div class="container">
                <h1>🎖️ WhatsApp CSV Converter V2</h1>
                <h2>Status: ✅ OPERATIONAL (Universal File Parser)</h2>
                
                <div class="v2-features">
                    <h3>🚀 V2 Features</h3>
                    <ul>
                        <li>📇 VCF (Contact Cards)</li>
                        <li>📊 CSV Files</li>
                        <li>📗 Excel Files (.xlsx, .xls)</li>
                        <li>🤖 Auto-column detection</li>
                        <li>📱 Nigerian phone formatting</li>
                        <li>🎯 Sugar CRM format output</li>
                    </ul>
                </div>
                
                <div class="status">
                    <h3>System Metrics</h3>
                    <div class="metric">
                        <span>Environment:</span>
                        <strong>${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}</strong>
                    </div>
                    <div class="metric">
                        <span>Storage:</span>
                        <strong>${redisClient ? 'Redis Cloud' : 'In-Memory'}</strong>
                    </div>
                    <div class="metric">
                        <span>Active Files:</span>
                        <strong>${fileCount}</strong>
                    </div>
                    <div class="metric">
                        <span>Template:</span>
                        <strong>${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}</strong>
                    </div>
                    <div class="metric">
                        <span>Parsers:</span>
                        <strong>VCF + CSV + Excel</strong>
                    </div>
                    <div class="metric">
                        <span>Uptime:</span>
                        <strong>${Math.floor(process.uptime() / 60)} minutes</strong>
                    </div>
                </div>
                
                <h3>How to Use V2</h3>
                <ol>
                    <li>Send contact files to +16466030424</li>
                    <li>Supported: VCF, CSV, Excel (.xlsx, .xls)</li>
                    <li>Files accumulate in batches</li>
                    <li>Tap 1️⃣ to export or 2️⃣ to keep adding</li>
                    <li>Download Sugar-formatted CSV</li>
                </ol>
                
                <h3>Supported Column Names</h3>
                <ul>
                    <li><strong>Name:</strong> name, full name, contact name, person, etc.</li>
                    <li><strong>Phone:</strong> phone, mobile, cell, telephone, whatsapp, etc.</li>
                    <li><strong>Email:</strong> email, e-mail, mail, email address, etc.</li>
                </ul>
                
                <p style="margin-top: 2rem; color: #666; text-align: center;">
                    Built with ❤️ for easy contact management - V2 Universal Parser
                </p>
            </div>
        </body>
        </html>
    `);
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: IS_PRODUCTION ? 'Something went wrong' : err.message
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 OPERATION: UNIVERSAL PARSER V2 - SYSTEMS ONLINE');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`📋 Template SID: ${TEMPLATE_SID || 'NOT CONFIGURED'}`);
    console.log(`🚫 Testing Mode: Only authorized numbers can access`);
    console.log(`✅ Authorized Numbers: ${AUTHORIZED_NUMBERS.join(', ')}`);
    console.log('\n📋 Webhook ready at: POST /webhook');
    console.log('\n🚀 V2 Features:');
    console.log('   📇 VCF Parser: Enhanced multi-contact support');
    console.log('   📊 CSV Parser: Auto-column detection');
    console.log('   📗 Excel Parser: .xlsx and .xls support');
    console.log('   🤖 Smart column mapping');
    console.log('   📱 Nigerian phone formatting');
});

// Cleanup expired files every 30 minutes
setInterval(async () => {
    if (!redisClient) {
        const now = Date.now();
        Object.keys(fileStorage).forEach(key => {
            if (fileStorage[key].expires < now) {
                delete fileStorage[key];
                console.log(`🗑️ Cleaned expired file: ${key}`);
            }
        });
    }
}, 30 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('📴 Shutting down gracefully...');
    if (redisClient) {
        await redisClient.quit();
    }
    process.exit(0);
});url: process.env.REDIS_URL
    });
    
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    redisClient.connect().then(() => {
        console.log('🔴 Redis: CONNECTED to production storage');
    });
}

// Storage operations
const storage = {
    async set(key, value, expirySeconds = 7200) {
        if (redisClient) {
            await redisClient.set(key, JSON.stringify(value), {
                EX: expirySeconds
            });
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

// Check if number is authorized for testing
function isAuthorizedNumber(phoneNumber) {
    const cleanNumber = phoneNumber.replace('whatsapp:', '');
    return AUTHORIZED_NUMBERS.includes(cleanNumber);
}

// Send template message with download button
async function sendTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const contentVariables = {
        "1": contactCount.toString(),
        "2": fileId
    };
    
    try {
        const message = await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: to,
            contentSid: TEMPLATE_SID,
            contentVariables: JSON.stringify(contentVariables)
        });
        
        console.log(`📤 Template message sent successfully: ${message.sid}`);
        return message;
    } catch (error) {
        console.error('❌ Template send error:', error.message);
        throw error;
    }
}

// Universal contact file parser
async function parseContactMedia(mediaUrl, req) {
    console.log('📁 Processing contact media:', mediaUrl);
    
    // Download file as buffer
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    const response = await axios.get(mediaUrl, {
        auth: {
            username: accountSid,
            password: authToken
        },
        responseType: 'arraybuffer'
    });
    
    const fileBuffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';
    
    console.log('📁 File info:', {
        size: fileBuffer.length,
        contentType: contentType
    });
    
    // Determine file type and parse
    if (contentType.includes('text/x-vcard') || contentType.includes('text/vcard')) {
        // VCF file - use existing parser
        console.log('📇 Detected VCF file');
        const vcfContent = fileBuffer.toString('utf8');
        return parseVCF(vcfContent);
    } else if (contentType.includes('text/csv') || contentType.includes('application/csv')) {
        // CSV file - use new parser
        console.log('📊 Detected CSV file');
        return parseContactFile(fileBuffer, 'contacts.csv');
    } else if (contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') || 
               contentType.includes('application/vnd.ms-excel')) {
        // Excel file - use new parser
        console.log('📗 Detected Excel file');
        const extension = contentType.includes('openxmlformats') ? 'xlsx' : 'xls';
        return parseContactFile(fileBuffer, `contacts.${extension}`);
    } else {
        // Fallback - try as VCF first, then CSV
        console.log('❓ Unknown file type, trying VCF first...');
        try {
            const vcfContent = fileBuffer.toString('utf8');
            if (vcfContent.includes('BEGIN:VCARD')) {
                return parseVCF(vcfContent);
            }
        } catch (vcfError) {
            console.log('❓ VCF parsing failed, trying CSV...');
            try {
                return parseContactFile(fileBuffer, 'contacts.csv');
            } catch (csvError) {
                throw new Error('Unsupported file format. Please send VCF, CSV, or Excel files.');
            }
        }
    }
}

// Twilio webhook
app.post('/webhook', async (req, res) => {
    const { Body, From, MediaUrl0, NumMedia } = req.body;
    
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message:', Body);
    console.log('Attachments:', NumMedia);
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    try {
        // TESTING RESTRICTION CHECK
        if (!isAuthorizedNumber(From)) {
            console.log(`🚫 Unauthorized number: ${From}`);
            res.type('text/xml');
            res.send(twiml.toString());
            return;
        }
        
        // CONTACT FILE DETECTED (VCF, CSV, Excel)
        if (NumMedia > 0 && MediaUrl0) {
            console.log('📎 Contact file detected:', MediaUrl0);
            
            // Get existing batch or create new one
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0 };
            
            try {
                // Parse using universal parser
                const newContacts = await parseContactMedia(MediaUrl0, req);
                console.log('🔍 Parsed contacts:', newContacts.length);
                
                if (newContacts.length === 0) {
                    twiml.message(`❌ No contacts found in the file.\n\nSupported formats: VCF, CSV, Excel (.xlsx, .xls)\nRequired: Name or Phone number`);
                    res.type('text/xml');
                    res.send(twiml.toString());
                    return;
                }
                
                // Add to batch
                batch.contacts.push(...newContacts);
                batch.count = batch.contacts.length;
                batch.lastUpdated = Date.now();
                
                // Save batch (expires in 10 minutes)
                await storage.set(`batch:${From}`, batch, 600);
                
                // Send confirmation message
                twiml.message(`💾 ${batch.count} saved so far.

Tap 1️⃣ to export • 2️⃣ to keep adding`);
                
            } catch (parseError) {
                console.error('❌ File parsing error:', parseError);
                twiml.message(`❌ Could not parse file: ${parseError.message}\n\nSupported formats:\n📇 VCF (contacts)\n📊 CSV files\n📗 Excel (.xlsx, .xls)\n\nRequired columns: Name or Phone`);
            }
            
        } else if (Body === '1️⃣' || Body === '1') {
            // Export current batch
            const batch = await storage.get(`batch:${From}`);
            
            if (!batch || batch.contacts.length === 0) {
                twiml.message(`❌ No contacts to export.\n\nSend some contact files first!`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Generate CSV from batch
            const csv = generateCSV(batch.contacts);
            
            // Create secure file (no password needed)
            const fileId = uuidv4();
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `sugar_contacts_${Date.now()}.csv`,
                from: From,
                created: Date.now(),
                contactCount: batch.contacts.length
            });
            
            const downloadUrl = `${BASE_URL}/download/${fileId}`;
            
            // Try template first, then fallback
            try {
                console.log('🚀 Sending template message...');
                await sendTemplateMessage(From, batch.contacts.length, fileId);
                console.log('✅ Template message sent successfully!');
            } catch (templateError) {
                console.error('❌ Template failed, using fallback:', templateError);
                twiml.message(`✅ *CSV Ready!*\n\n📊 Processed: ${batch.contacts.length} contacts\n📎 Download: ${downloadUrl}\n⏰ Expires: 2 hours\n\n💡 _Tap the link to download your CSV file_`);
            }
            
            // Clear batch after export
            await storage.del(`batch:${From}`);
            
        } else if (Body === '2️⃣' || Body === '2') {
            // Continue adding - just acknowledge
            twiml.message(`📨 Drop your contact files—let's bulk-load them! 🚀\n\n📇 VCF • 📊 CSV • 📗 Excel supported`);
            
        } else if (Body.toLowerCase() === 'help') {
            const formats = getSupportedFormats();
            twiml.message(`🎖️ **WhatsApp CSV Converter V2**\n\n📋 **SUPPORTED FILES:**\n📇 VCF (contact cards)\n📊 CSV files\n📗 Excel (.xlsx, .xls)\n\n⚡ **HOW TO USE:**\n1. Send contact files\n2. Accumulate in batches\n3. Tap 1️⃣ to export or 2️⃣ to add more\n4. Get Sugar-formatted CSV\n\n💡 **Required:** Name or Phone number\n💡 **Optional:** Email address\n\n_Send files to get started..._`);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**\n\n🟢 Bot: OPERATIONAL\n🟢 VCF Parser: ARMED\n🟢 CSV/Excel Parser: READY\n🟢 CSV Generator: READY\n🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}\n🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}\n🟢 Template: ${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}\n\n_Ready to receive contact files!_`);
            
        } else if (Body.toLowerCase() === 'status') {
            const fileCount = await getActiveFileCount();
            twiml.message(`✅ *Systems Check Complete*

🟢 Bot: OPERATIONAL
🟢 VCF Parser: ARMED
🟢 CSV/Excel Parser: READY
🟢 CSV Generator: READY
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}
🟢 Template: ${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}

📋 **V2 Features:**
📇 VCF contacts
📊 CSV files
📗 Excel (.xlsx, .xls)

Ready to receive contact files!`);
            
        } else if (Body.toLowerCase() === 'formats') {
            const formats = getSupportedFormats();
            twiml.message(`📋 **Supported File Formats**\n\n✅ ${formats.supported.join(' • ')}\n\n📝 **Required Columns:**\n${formats.requiredColumns}\n\n📧 **Optional Columns:**\n${formats.optionalColumns}\n\n💡 **Auto-detection** for various column names\n💡 **Nigerian phone formatting** included`);
            
        } else {
            // Any other message - prompt for contact files
            twiml.message(`📨 Drop your contact files—let's bulk-load them! 🚀\n\n📇 VCF • 📊 CSV • 📗 Excel supported\n\nType 'help' for instructions`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ Operation failed. Please try again.\n\nIf the problem persists, contact support.`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Get active file count
async function getActiveFileCount() {
    if (redisClient) {
        const keys = await redisClient.keys('file:*');
        return keys.length;
    } else {
        const now = Date.now();
        Object.keys(fileStorage).forEach(key => {
            if (fileStorage[key].expires < now) {
                delete fileStorage[key];
            }
        });
        return Object.keys(fileStorage).length;
    }
}

// Download endpoint with time-based expiry only
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    
    const fileData = await storage.get(`file:${fileId}`);
    
    if (!fileData) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>File Not Found</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background: #f5f5f5;
                    }
                    .container {
                        background: white;
                        padding: 2rem;
                        border-radius: 10px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        text-align: center;
                        max-width: 400px;
                    }
                    h1 { color: #e74c3c; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>⏰ Link Expired</h1>
                    <p>This download link has expired for security.</p>
                    <p>Links automatically expire after 2 hours.</p>
                    <p>Send your contact files again to get a new download link.</p>
                </div>
            </body>
            </html>
        `);
    }
    
    // Direct download - no password needed
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
    res.send(fileData.content);
    
    console.log(`📥 File downloaded: ${fileId} (${fileData.contactCount || 0} contacts)`);
});

// Health check endpoint
app.get('/', async (req, res) => {
    const fileCount = await getActiveFileCount();
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp CSV Converter V2</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                    max-width: 800px;
                    margin: 0 auto;
                    padding: 2rem;
                    background: #f5f5f5;
                }
                .container {
                    background: white;
                    padding: 2rem;
                    border-radius: 10px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #25D366; }
                .status { 
                    background: #f0f0f0; 
                    padding: 1rem; 
                    border-radius: 5px;
                    margin: 1rem 0;
                }
                .metric {
                    display: flex;
                    justify-content: space-between;
                    padding: 0.5rem 0;
                    border-bottom: 1px solid #eee;
                }
                .metric:last-child { border-bottom: none; }
                .v2-features {
                    background: #e8f5e8;
                    border: 1px solid #4caf50;
                    padding: 1rem;
                    border-radius: 5px;
                    margin: 1rem 0;
                }
            </style>
        