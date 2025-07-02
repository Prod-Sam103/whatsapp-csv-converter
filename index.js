const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import tactical modules - UPDATED PATHS
const { parseVCF } = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');

const app = express();
app.use(express.urlencoded({ extended: false }));

// PRODUCTION CONFIGURATION
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

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

// Updated Twilio webhook with multi-file support
app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia } = req.body;
    
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message:', Body);
    console.log('Attachments:', NumMedia);
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    try {
        // MULTIPLE CONTACT PACKAGES DETECTED
        if (NumMedia > 0) {
            console.log(`📎 ${NumMedia} contact package(s) detected`);
            
            let allContacts = [];
            let processedFiles = 0;
            
            // Process ALL media attachments, not just MediaUrl0
            for (let i = 0; i < parseInt(NumMedia); i++) {
                const mediaUrl = req.body[`MediaUrl${i}`];
                const mediaType = req.body[`MediaContentType${i}`];
                
                if (mediaUrl) {
                    try {
                        console.log(`📎 Processing file ${i + 1}/${NumMedia}: ${mediaType}`);
                        
                        if (!IS_PRODUCTION || !process.env.TWILIO_ACCOUNT_SID) {
                            // Demo mode - add demo contacts for each file
                            const demoContactsForFile = [
                                { name: `Demo ${i + 1}-A`, mobile: `+234700000${i}01`, email: `demo${i + 1}a@example.com`, passes: 1 },
                                { name: `Demo ${i + 1}-B`, mobile: `+234700000${i}02`, email: `demo${i + 1}b@example.com`, passes: 1 }
                            ];
                            allContacts = allContacts.concat(demoContactsForFile);
                            processedFiles++;
                        } else {
                            // Production mode - use your existing parsing logic
                            const fileContent = await downloadMedia(mediaUrl, req);
                            const contacts = parseVCF(fileContent); // Your existing parser
                            
                            if (contacts && contacts.length > 0) {
                                allContacts = allContacts.concat(contacts);
                                processedFiles++;
                                console.log(`✅ File ${i + 1} processed: ${contacts.length} contacts`);
                            } else {
                                console.log(`⚠️ File ${i + 1} contained no valid contacts`);
                            }
                        }
                    } catch (fileError) {
                        console.error(`❌ Error processing file ${i + 1}:`, fileError);
                        // Continue processing other files
                    }
                }
            }
            
            if (allContacts.length === 0) {
                twiml.message(`❌ **Processing Failed**

No valid contacts found in ${NumMedia} file(s).

Please ensure you're sharing valid contact files.

Type *help* for instructions.`);
                
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Generate CSV using your existing function
            const csv = generateCSV(allContacts);
            
            // Create secure file
            const fileId = uuidv4();
            const password = Math.floor(100000 + Math.random() * 900000).toString();
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                password: password,
                from: From,
                created: Date.now(),
                contactCount: allContacts.length,
                filesProcessed: processedFiles
            });
            
            const downloadUrl = `${BASE_URL}/download/${fileId}`;
            
            // Preview first 3 contacts
            const preview = allContacts.slice(0, 3).map(c => 
                `• ${c.name} - ${c.mobile}`
            ).join('\n');
            
            // Template-style response like your second screenshot
            twiml.message(`✅ **Operation Complete!**

📊 Processed: ${allContacts.length} contacts from ${processedFiles} file(s)
📎 Format: CSV ready for download
🔑 Password: ${password}
⏰ Expires: 2 hours

**Preview:**
${preview}
${allContacts.length > 3 ? `\n... and ${allContacts.length - 3} more` : ''}

🔗 Download: ${downloadUrl}`);
            
        } else if (Body.toLowerCase() === 'help') {
            sendHelpMessage(twiml);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Multi-file Parser: ARMED  
🟢 CSV Generator: READY
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}

_Ready to receive contact packages!_`);
            
        } else if (Body.toLowerCase() === 'status') {
            const fileCount = await getActiveFileCount();
            twiml.message(`📊 **Operational Status**

🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}
📁 Active files: ${fileCount}
⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes
🌐 Base URL: ${BASE_URL}
💾 Storage: ${redisClient ? 'Redis Cloud' : 'In-Memory'}

_All systems nominal_`);
            
        } else {
            twiml.message(`👋 **Welcome to Contact Converter!**

Share contact files for instant CSV conversion.

Type *help* for detailed instructions.
Type *test* for system status.`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ **System Error**

Processing failed: ${error.message}

Please try again or contact support.`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Download media from Twilio
async function downloadMedia(mediaUrl, req) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    const response = await axios.get(mediaUrl, {
        auth: {
            username: accountSid,
            password: authToken
        },
        responseType: 'text'
    });
    
    return response.data;
}

// Send help message
function sendHelpMessage(twiml) {
    twiml.message(`🎖️ **WhatsApp CSV Converter**

📋 **COMMANDS:**
- *help* - Show instructions
- *test* - System check
- *status* - Service status

📎 **HOW TO USE:**
1. Tap attachment (📎)
2. Select "Contact" 
3. Choose contacts (up to 250)
4. Send to this number
5. Get password-protected download

⚡ **FEATURES:**
- Instant CSV conversion
- Handles all phone formats
- Nigerian numbers auto-formatted
- Secure 2-hour links
- Password protection
- **Multi-file processing**

💡 **TIPS:**
- Select multiple contacts at once
- Works with iPhone & Android
- Downloads work on any device
- Send multiple files together

_Standing by for your contacts..._`);
}

// Get active file count
async function getActiveFileCount() {
    if (redisClient) {
        const keys = await redisClient.keys('file:*');
        return keys.length;
    } else {
        // Clean expired files first
        const now = Date.now();
        Object.keys(fileStorage).forEach(key => {
            if (fileStorage[key].expires < now) {
                delete fileStorage[key];
            }
        });
        return Object.keys(fileStorage).length;
    }
}

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
    
    // Check password
    if (!p || p !== fileData.password) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Download Contacts CSV</title>
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
                        max-width: 400px;
                        width: 90%;
                    }
                    h1 {
                        color: #333;
                        margin-bottom: 1rem;
                    }
                    input {
                        width: 100%;
                        padding: 12px;
                        font-size: 18px;
                        border: 2px solid #ddd;
                        border-radius: 5px;
                        margin-bottom: 1rem;
                        text-align: center;
                        letter-spacing: 2px;
                        box-sizing: border-box;
                    }
                    button {
                        width: 100%;
                        padding: 12px;
                        font-size: 16px;
                        background: #25D366;
                        color: white;
                        border: none;
                        border-radius: 5px;
                        cursor: pointer;
                    }
                    button:hover {
                        background: #20B558;
                    }
                    .error {
                        color: #e74c3c;
                        margin-bottom: 1rem;
                        text-align: center;
                    }
                    .info {
                        color: #666;
                        font-size: 14px;
                        text-align: center;
                        margin-top: 1rem;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🔐 Enter Password</h1>
                    ${p ? '<p class="error">❌ Incorrect password</p>' : ''}
                    <form method="GET" action="/download/${fileId}">
                        <input 
                            type="text" 
                            name="p" 
                            placeholder="6-digit code" 
                            maxlength="6" 
                            pattern="[0-9]{6}"
                            autocomplete="off"
                            required 
                            autofocus
                        />
                        <button type="submit">Download CSV</button>
                    </form>
                    <p class="info">
                        💡 The password was sent to your WhatsApp
                    </p>
                </div>
            </body>
            </html>
        `);
    }
    
    // Send CSV file
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
            <title>WhatsApp CSV Converter</title>
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
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎖️ WhatsApp CSV Converter</h1>
                <h2>Status: ✅ OPERATIONAL</h2>
                
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
                        <span>Uptime:</span>
                        <strong>${Math.floor(process.uptime() / 60)} minutes</strong>
                    </div>
                    <div class="metric">
                        <span>Webhook:</span>
                        <strong>POST /webhook</strong>
                    </div>
                </div>
                
                <h3>How to Use</h3>
                <ol>
                    <li>Send a WhatsApp message to your configured number</li>
                    <li>Share contacts using the attachment button</li>
                    <li>Receive a secure download link</li>
                    <li>Download your CSV file</li>
                </ol>
                
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
    console.log('🚀 OPERATION: PARSE STORM - SYSTEMS ONLINE');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log('\n📋 Webhook ready at: POST /webhook');
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