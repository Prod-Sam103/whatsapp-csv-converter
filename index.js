const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import tactical modules
const { parseVCF } = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');

const app = express();
app.use(express.urlencoded({ extended: false }));

// PRODUCTION CONFIGURATION
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

// TESTING RESTRICTION - Only your number
const AUTHORIZED_NUMBERS = ['+2348121364213']; // Your personal number

// Template Configuration
const TEMPLATE_SID = process.env.TEMPLATE_SID; // Will be set after template approval

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
    // Remove whatsapp: prefix if present
    const cleanNumber = phoneNumber.replace('whatsapp:', '');
    return AUTHORIZED_NUMBERS.includes(cleanNumber);
}

// Send template message with download button
async function sendTemplateMessage(to, contactCount, urlParam) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    try {
        const message = await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: to,
            contentSid: TEMPLATE_SID,
            contentVariables: JSON.stringify({
                "1": contactCount.toString(),
                "2": urlParam  // This will be fileId?p=password
            })
        });
        
        console.log(`📤 Template message sent: ${message.sid}`);
        return message;
    } catch (error) {
        console.error('❌ Template send error:', error);
        throw error;
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
            // Don't respond to unauthorized numbers during testing
            res.type('text/xml');
            res.send(twiml.toString());
            return;
        }
        
        // CONTACT PACKAGE DETECTED
        if (NumMedia > 0 && MediaUrl0) {
            console.log('📎 Contact package detected:', MediaUrl0);
            
            // Download VCF file
            const vcfContent = await downloadMedia(MediaUrl0, req);
            
            // Parse contacts
            const contacts = parseVCF(vcfContent);
            
            if (contacts.length === 0) {
                twiml.message(`❌ No contacts found in the file.\n\nPlease ensure you're sharing a valid contact file.`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Generate CSV
            const csv = generateCSV(contacts);
            
            // Create secure file
            const fileId = uuidv4();
            const password = Math.floor(100000 + Math.random() * 900000).toString();
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                password: password,
                from: From,
                created: Date.now(),
                contactCount: contacts.length
            });
            
            // Create combined URL parameter for template (fileId with password)
            const urlParam = `${fileId}?p=${password}`;
            
            // Send template message with download button
            if (TEMPLATE_SID) {
                await sendTemplateMessage(From, contacts.length, urlParam);
            } else {
                const downloadUrl = `${BASE_URL}/download/${fileId}?p=${password}`;
                // Fallback to regular message if template not configured
                // Fallback to regular message if template not configured
                twiml.message(`✅ **Operation Complete!**\n\n📊 Processed: ${contacts.length} contacts\n📎 File: contacts.csv\n🔗 Download: ${downloadUrl}\n🔑 Password: ${password}\n⏰ Expires: 2 hours`);
            }
            
        } else if (Body.toLowerCase() === 'help') {
            twiml.message(`🎖️ **WhatsApp CSV Converter**\n\n📋 **HOW TO USE:**\n1. Tap attachment (📎)\n2. Select "Contact" \n3. Choose contacts (up to 250)\n4. Send to this number\n5. Get download button\n\n⚡ **FEATURES:**\n- Instant CSV conversion\n- Nigerian numbers auto-formatted\n- Secure downloads\n- Password protection\n\n_Send contacts to get started..._`);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**\n\n🟢 Bot: OPERATIONAL\n🟢 Parser: ARMED\n🟢 CSV Generator: READY\n🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}\n🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}\n🟢 Template: ${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}\n\n_Ready to receive contact packages!_`);
            
        } else if (Body.toLowerCase() === 'status') {
            const fileCount = await getActiveFileCount();
            twiml.message(`📊 **Operational Status**\n\n🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}\n📁 Active files: ${fileCount}\n⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes\n🌐 Base URL: ${BASE_URL}\n💾 Storage: ${redisClient ? 'Redis Cloud' : 'In-Memory'}\n📋 Template: ${TEMPLATE_SID ? 'READY' : 'NOT CONFIGURED'}\n\n_All systems nominal_`);
            
        } else {
            twiml.message(`👋 **CSV Converter Active!**\n\nShare contacts with me for instant CSV conversion.\n\nType *help* for instructions.`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ Operation failed. Please try again.\n\nIf the problem persists, contact support.`);
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

// Download endpoint with password protection (unchanged)
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { p } = req.query;
    
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
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
    res.send(fileData.content);
    
    console.log(`📥 File downloaded: ${fileId} (${fileData.contactCount || 0} contacts)`);
});

// Health check endpoint (unchanged)
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
                <h2>Status: ✅ OPERATIONAL (Testing Mode)</h2>
                
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
                        <span>Testing Mode:</span>
                        <strong>Restricted to authorized numbers</strong>
                    </div>
                    <div class="metric">
                        <span>Uptime:</span>
                        <strong>${Math.floor(process.uptime() / 60)} minutes</strong>
                    </div>
                </div>
                
                <h3>How to Use</h3>
                <ol>
                    <li>Send a WhatsApp message to +16466030424</li>
                    <li>Share contacts using the attachment button</li>
                    <li>Receive a message with download button</li>
                    <li>Click button to download your CSV file</li>
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
    console.log('🚀 OPERATION: TEMPLATE STORM - SYSTEMS ONLINE');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`📋 Template SID: ${TEMPLATE_SID || 'NOT CONFIGURED'}`);
    console.log(`🚫 Testing Mode: Only authorized numbers can access`);
    console.log(`✅ Authorized Numbers: ${AUTHORIZED_NUMBERS.join(', ')}`);
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