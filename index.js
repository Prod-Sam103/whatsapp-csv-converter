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

// Send template message with download button - ENHANCED DEBUG VERSION
async function sendTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    console.log('🔍 COMPREHENSIVE Template Debug:');
    console.log('Template SID:', TEMPLATE_SID);
    console.log('Contact Count:', contactCount);
    console.log('File ID:', fileId);
    console.log('Account SID:', process.env.TWILIO_ACCOUNT_SID?.substring(0, 10) + '...');
    console.log('Auth Token set:', !!process.env.TWILIO_AUTH_TOKEN);
    console.log('WhatsApp Number:', process.env.TWILIO_WHATSAPP_NUMBER);
    console.log('From (to):', to);
    
    const contentVariables = {
        "1": contactCount.toString(),
        "2": fileId
    };
    
    console.log('Content Variables JSON:', JSON.stringify(contentVariables));
    
    try {
        console.log('🚀 Attempting to send template message...');
        
        const message = await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: to,
            contentSid: TEMPLATE_SID,
            contentVariables: JSON.stringify(contentVariables)
        });
        
        console.log(`📤 Template message sent successfully!`);
        console.log('Message SID:', message.sid);
        console.log('Message Status:', message.status);
        return message;
    } catch (error) {
        console.error('❌ DETAILED Template Error:');
        console.error('Error Message:', error.message);
        console.error('Error Code:', error.code);
        console.error('Error Status:', error.status);
        console.error('More Info:', error.moreInfo);
        console.error('Full Error:', error);
        throw error;
    }
}

// Test template with different approaches
async function testTemplate(to) {
    console.log('🧪 TESTING TEMPLATE WITH MULTIPLE APPROACHES');
    
    // Test 1: Simple variables
    try {
        console.log('Test 1: Simple variables');
        await sendTemplateMessage(to, 1, 'test123');
        return 'Test 1 successful';
    } catch (error) {
        console.log('Test 1 failed:', error.message);
    }
    
    // Test 2: Different variable format
    try {
        console.log('Test 2: Different URL format');
        await sendTemplateMessage(to, 5, 'abc123?p=456789');
        return 'Test 2 successful';
    } catch (error) {
        console.log('Test 2 failed:', error.message);
    }
    
    // Test 3: Check if template exists
    try {
        console.log('Test 3: Template existence check');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const template = await client.content.v1.contents(TEMPLATE_SID).fetch();
        console.log('Template found:', template.friendlyName, template.language);
        return 'Test 3 successful - template exists';
    } catch (error) {
        console.log('Test 3 failed - template not found:', error.message);
        return 'Template does not exist or access denied';
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
        
        // TEMPLATE TESTING COMMANDS
        if (Body.toLowerCase() === 'testtemplate') {
            console.log('🧪 Template test requested');
            if (TEMPLATE_SID) {
                try {
                    const result = await testTemplate(From);
                    twiml.message(`✅ Template test result: ${result}`);
                } catch (error) {
                    twiml.message(`❌ Template test failed: ${error.message}`);
                }
            } else {
                twiml.message('❌ No template SID configured');
            }
            
        } else if (Body.toLowerCase() === 'simpletemplate') {
            // Test with the simplest possible template call
            if (TEMPLATE_SID) {
                try {
                    await sendTemplateMessage(From, 1, 'test');
                    twiml.message('✅ Simple template test sent');
                } catch (error) {
                    twiml.message(`❌ Simple template failed: ${error.message}`);
                }
            } else {
                twiml.message('❌ No template SID configured');
            }
            
        } else if (Body.toLowerCase() === 'templateinfo') {
            // Show template configuration info
            twiml.message(`📋 Template Info:
SID: ${TEMPLATE_SID || 'Not set'}
Account: ${process.env.TWILIO_ACCOUNT_SID?.substring(0, 15)}...
WhatsApp #: ${process.env.TWILIO_WHATSAPP_NUMBER}`);
            
        // CONTACT PACKAGE DETECTED
        } else if (NumMedia > 0 && MediaUrl0) {
            console.log('📎 Contact package detected:', MediaUrl0);
            
            // Get existing batch or create new one
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0 };
            
            // Download and parse new VCF file
            const vcfContent = await downloadMedia(MediaUrl0, req);
            console.log('🔍 VCF Content Preview:', vcfContent.substring(0, 500));
            console.log('🔍 VCF Content Length:', vcfContent.length);
            console.log('🔍 Number of BEGIN:VCARD occurrences:', (vcfContent.match(/BEGIN:VCARD/gi) || []).length);
            
            const newContacts = parseVCF(vcfContent);
            console.log('🔍 Parsed contacts count:', newContacts.length);
            console.log('🔍 Parsed contacts:', newContacts.map(c => c.name).join(', '));
            
            if (newContacts.length === 0) {
                twiml.message(`❌ No contacts found in the file.\n\nPlease ensure you're sharing a valid contact file.`);
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
            
        } else if (Body === '1️⃣' || Body === '1') {
            // Export current batch
            const batch = await storage.get(`batch:${From}`);
            
            if (!batch || batch.contacts.length === 0) {
                twiml.message(`❌ No contacts to export.\n\nSend some contacts first!`);
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
                filename: `contacts_${Date.now()}.csv`,
                from: From,
                created: Date.now(),
                contactCount: batch.contacts.length
            });
            
            const downloadUrl = `${BASE_URL}/download/${fileId}`;
            
            // TRY TEMPLATE FIRST, THEN FALLBACK
            try {
                console.log('🚀 Attempting template message for CSV download...');
                await sendTemplateMessage(From, batch.contacts.length, fileId);
                console.log('✅ Template message sent successfully!');
            } catch (templateError) {
                console.error('❌ Template failed, using fallback:', templateError);
                // Enhanced fallback message
                twiml.message(`✅ *CSV Ready!*\n\n📊 Processed: ${batch.contacts.length} contacts\n📎 Download: ${downloadUrl}\n⏰ Expires: 2 hours\n\n💡 _Tap the link to download your CSV file_`);
            }
            
            // Clear batch after export
            await storage.del(`batch:${From}`);
            
        } else if (Body === '2️⃣' || Body === '2') {
            // Continue adding - just acknowledge
            twiml.message(`📨 Drop your contact cards—let's bulk-load them! 🚀`);
            
        } else if (Body.toLowerCase() === 'help') {
            twiml.message(`🎖️ **WhatsApp CSV Converter - Template Testing**\n\n📋 **COMMANDS:**\n• testtemplate - Test template functionality\n• simpletemplate - Simple template test\n• templateinfo - Show template config\n• help - This help\n• status - System status\n\n📎 **Normal usage:** Send contacts to test batching\n\n🧪 **Testing Mode Active**`);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**\n\n🟢 Bot: OPERATIONAL\n🟢 Parser: ARMED\n🟢 CSV Generator: READY\n🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}\n🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}\n🟢 Template: ${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}\n\n_Ready to receive contact packages!_`);
            
        } else if (Body.toLowerCase() === 'status') {
            const fileCount = await getActiveFileCount();
            twiml.message(`✅ *Systems Check Complete*

🟢 Bot: OPERATIONAL
🟢 Parser: ARMED
🟢 CSV Generator: READY
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}
🟢 Template: ${TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}

🧪 **Template Testing Mode**
Type 'testtemplate' to debug templates

Ready to receive contact packages!`);
            
        } else {
            // Any other message - prompt for contacts
            twiml.message(`📨 Drop your contact cards—let's bulk-load them! 🚀

🧪 **Template Testing Active**
Commands: testtemplate, simpletemplate, templateinfo`);
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
                    <p>Send your contacts again to get a new download link.</p>
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
            <title>WhatsApp CSV Converter - Template Testing</title>
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
                .testing {
                    background: #fff3cd;
                    border: 1px solid #ffeaa7;
                    padding: 1rem;
                    border-radius: 5px;
                    margin: 1rem 0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎖️ WhatsApp CSV Converter</h1>
                <h2>Status: ✅ OPERATIONAL (Template Testing Mode)</h2>
                
                <div class="testing">
                    <h3>🧪 Template Testing Mode Active</h3>
                    <p>This branch includes enhanced template debugging and testing commands.</p>
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
                        <span>Testing Mode:</span>
                        <strong>Template debugging enabled</strong>
                    </div>
                    <div class="metric">
                        <span>Uptime:</span>
                        <strong>${Math.floor(process.uptime() / 60)} minutes</strong>
                    </div>
                </div>
                
                <h3>Template Testing Commands</h3>
                <ul>
                    <li><code>testtemplate</code> - Comprehensive template testing</li>
                    <li><code>simpletemplate</code> - Simple template test</li>
                    <li><code>templateinfo</code> - Show template configuration</li>
                    <li><code>status</code> - System status with template info</li>
                </ul>
                
                <h3>How to Use</h3>
                <ol>
                    <li>Send a WhatsApp message to +16466030424</li>
                    <li>Use template testing commands to debug</li>
                    <li>Share contacts to test normal flow</li>
                    <li>Verify template integration works</li>
                </ol>
                
                <p style="margin-top: 2rem; color: #666; text-align: center;">
                    Built with ❤️ for easy contact management - Template Testing Branch
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
    console.log('🚀 OPERATION: TEMPLATE TESTING - SYSTEMS ONLINE');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`📋 Template SID: ${TEMPLATE_SID || 'NOT CONFIGURED'}`);
    console.log(`🧪 Template Testing Mode: ACTIVE`);
    console.log(`🚫 Testing Mode: Only authorized numbers can access`);
    console.log(`✅ Authorized Numbers: ${AUTHORIZED_NUMBERS.join(', ')}`);
    console.log('\n📋 Webhook ready at: POST /webhook');
    console.log('\n🧪 Template testing commands available:');
    console.log('   - testtemplate');
    console.log('   - simpletemplate');
    console.log('   - templateinfo');
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