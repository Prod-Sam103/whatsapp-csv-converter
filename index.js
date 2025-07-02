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
        url: process.env.REDIS_URL
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

// Parse contact media using your existing universal parser
async function parseContactMedia(mediaUrl, req) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        const response = await axios.get(mediaUrl, {
            auth: {
                username: accountSid,
                password: authToken
            },
            responseType: 'arraybuffer'
        });
        
        // Use your existing universal parser
        return await parseContactFile(response.data);
    } catch (error) {
        console.error('Media download/parse error:', error);
        throw error;
    }
}

// Send template message function (stub - implement with your template)
async function sendTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    if (!TEMPLATE_SID) {
        throw new Error('Template not configured');
    }
    
    const downloadUrl = `${BASE_URL}/download/${fileId}`;
    
    await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: to,
        messagingServiceSid: TEMPLATE_SID,
        body: `✅ **Operation Complete!**

📊 Processed: ${contactCount} contacts
📎 Format: CSV ready for download
⏰ Expires: 2 hours

🔗 Download: ${downloadUrl}`
    });
}

// Enhanced Twilio webhook with MULTI-FILE support
app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia } = req.body;
    
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
        
        // MULTIPLE CONTACT FILES DETECTED - ENHANCED VERSION
        if (NumMedia > 0) {
            console.log(`📎 ${NumMedia} contact file(s) detected`);
            
            // Get existing batch or create new one
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0 };
            let totalNewContacts = 0;
            let processedFiles = 0;
            let failedFiles = 0;
            
            // Process ALL attachments, not just MediaUrl0
            for (let i = 0; i < parseInt(NumMedia); i++) {
                const mediaUrl = req.body[`MediaUrl${i}`];
                const mediaType = req.body[`MediaContentType${i}`];
                
                if (mediaUrl) {
                    try {
                        console.log(`📎 Processing file ${i + 1}/${NumMedia}: ${mediaType}`);
                        
                        // Parse using your universal parser
                        const newContacts = await parseContactMedia(mediaUrl, req);
                        console.log(`🔍 File ${i + 1} parsed: ${newContacts.length} contacts`);
                        
                        if (newContacts.length > 0) {
                            // Add to batch
                            batch.contacts.push(...newContacts);
                            totalNewContacts += newContacts.length;
                            processedFiles++;
                        } else {
                            console.log(`⚠️ File ${i + 1} contained no valid contacts`);
                            failedFiles++;
                        }
                        
                    } catch (parseError) {
                        console.error(`❌ Error processing file ${i + 1}:`, parseError);
                        failedFiles++;
                    }
                }
            }
            
            if (totalNewContacts === 0) {
                twiml.message(`❌ No contacts found in ${NumMedia} file(s).\n\n${failedFiles > 0 ? `${failedFiles} files failed to process.\n\n` : ''}Supported formats: VCF, CSV, Excel, PDF, Text\nRequired: Name or Phone number`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Update batch totals
            batch.count = batch.contacts.length;
            batch.lastUpdated = Date.now();
            
            // Save batch (expires in 10 minutes)
            await storage.set(`batch:${From}`, batch, 600);
            
            // Enhanced confirmation message
            let statusMessage = `💾 ${batch.count} saved so far.`;
            
            if (processedFiles > 0) {
                statusMessage += `\n\n✅ Processed ${processedFiles} file(s): +${totalNewContacts} contacts`;
            }
            
            if (failedFiles > 0) {
                statusMessage += `\n⚠️ ${failedFiles} file(s) failed to process`;
            }
            
            statusMessage += `\n\nTap 1️⃣ to export • 2️⃣ to keep adding`;
            
            twiml.message(statusMessage);
            
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
                twiml.message(`✅ **Operation Complete!**

📊 Processed: ${batch.contacts.length} contacts
📎 Format: CSV ready for download
⏰ Expires: 2 hours

🔗 Download: ${downloadUrl}

💡 _Tap the link to download your CSV file_`);
            }
            
            // Clear batch after export
            await storage.del(`batch:${From}`);
            
        } else if (Body === '2️⃣' || Body === '2') {
            // Continue adding - just acknowledge
            twiml.message(`📨 Drop your contact files—let's bulk-load them! 🚀\n\n📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text supported\n\n💡 _Send multiple files at once for faster processing_`);
            
        } else if (Body.toLowerCase() === 'help') {
            twiml.message(`🎖️ **WhatsApp CSV Converter V2**

📋 **HOW TO USE:**
1. Send contact files (up to 5 at once)
2. Tap 1️⃣ to export or 2️⃣ to add more
3. Download your CSV file

📁 **SUPPORTED FORMATS:**
📇 VCF (Contact cards)
📊 CSV (Comma-separated)
📗 Excel (.xlsx, .xls)
📄 PDF (Text extraction)
📝 Text (Pattern matching)

⚡ **NEW FEATURES:**
✅ Multi-file processing
✅ Batch collection system
✅ Universal format support
✅ Smart text extraction

💡 **TIPS:**
• Send multiple files together
• Works with iPhone & Android exports
• PDF contact lists supported
• No file size limits

_Standing by for your contact packages..._`);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Multi-file Parser: ARMED
🟢 Universal Parser: READY
🟢 Batch System: ACTIVE
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}

**Supported Formats:**
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text

_Ready to receive contact packages!_`);
            
        } else {
            // Any other message - enhanced prompt
            twiml.message(`👋 **Welcome to Contact Converter V2!**

📨 Drop your contact files—let's bulk-load them! 🚀

📁 **Supported Formats:**
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text

💡 **Send multiple files at once for faster processing**

Type 'help' for detailed instructions
Type 'test' for system status`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ Operation failed: ${error.message}\n\nPlease try again or contact support.`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Download endpoint with password protection
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { p } = req.query;
    
    // Get file data
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
                    <h1>❌ File Not Found</h1>
                    <p>This file has expired or doesn't exist.</p>
                    <p>Files are automatically deleted after 2 hours for security.</p>
                </div>
            </body>
            </html>
        `);
    }
    
    // Send CSV file directly (no password in this version)
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
    res.send(fileData.content);
    
    console.log(`📥 File downloaded: ${fileId} (${fileData.contactCount || 0} contacts)`);
});

// Health check endpoint
app.get('/', async (req, res) => {
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
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎖️ WhatsApp CSV Converter V2</h1>
                <h2>Status: ✅ OPERATIONAL</h2>
                
                <h3>New V2 Features</h3>
                <ul>
                    <li>✅ Multi-file processing</li>
                    <li>✅ Universal format support</li>
                    <li>✅ Batch collection system</li>
                    <li>✅ Smart text extraction</li>
                    <li>✅ PDF parsing</li>
                </ul>
                
                <h3>Supported Formats</h3>
                <p>📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text</p>
                
                <p style="margin-top: 2rem; color: #666; text-align: center;">
                    Built with ❤️ for easy contact management
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
    console.log('🚀 OPERATION: PARSE STORM V2 - SYSTEMS ONLINE');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log('\n📋 Multi-file webhook ready at: POST /webhook');
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
});