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

// TESTING RESTRICTION - Authorized numbers
const AUTHORIZED_NUMBERS = [
    '+2348121364213', // Your personal number
    '+2347061240799',  // New authorized number
    '+2347034988523', // New authorized number
    '+2348132474537'  // New authorized number
];

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
            try {
                await redisClient.set(key, JSON.stringify(value), {
                    EX: expirySeconds
                });
            } catch (redisError) {
                console.error('Redis set failed:', redisError);
                fileStorage[key] = {
                    data: value,
                    expires: Date.now() + (expirySeconds * 1000)
                };
            }
        } else {
            fileStorage[key] = {
                data: value,
                expires: Date.now() + (expirySeconds * 1000)
            };
        }
    },
    
    async get(key) {
        if (redisClient) {
            try {
                const data = await redisClient.get(key);
                return data ? JSON.parse(data) : null;
            } catch (redisError) {
                console.error('Redis get failed:', redisError);
            }
        }
        
        const item = fileStorage[key];
        if (!item) return null;
        if (Date.now() > item.expires) {
            delete fileStorage[key];
            return null;
        }
        return item.data;
    },
    
    async del(key) {
        if (redisClient) {
            try {
                await redisClient.del(key);
            } catch (redisError) {
                console.error('Redis delete failed:', redisError);
                delete fileStorage[key];
            }
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

// ENHANCED: Parse contact media with better TXT detection and DOCX support
async function parseContactMedia(mediaUrl, req) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        console.log(`📥 Downloading media from: ${mediaUrl}`);
        
        const response = await axios.get(mediaUrl, {
            auth: {
                username: accountSid,
                password: authToken
            },
            responseType: 'arraybuffer'
        });
        
        // Get content type and filename from headers
        const contentType = response.headers['content-type'] || '';
        const contentDisposition = response.headers['content-disposition'] || '';
        
        console.log(`📋 Content-Type: ${contentType}`);
        console.log(`📋 Content-Disposition: ${contentDisposition}`);
        
        // Extract filename from content-disposition if available
        let filename = '';
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch) {
            filename = filenameMatch[1].replace(/['"]/g, '').toLowerCase();
            console.log(`📄 Detected filename: ${filename}`);
        }
        
        // Enhanced file type detection
        let detectedType = contentType;
        
        // Override content type based on filename extension for better accuracy
        if (filename) {
            if (filename.endsWith('.txt')) {
                detectedType = 'text/plain';
                console.log('🔍 Filename override: Detected as text/plain');
            } else if (filename.endsWith('.vcf')) {
                detectedType = 'text/vcard';
                console.log('🔍 Filename override: Detected as text/vcard');
            } else if (filename.endsWith('.csv')) {
                detectedType = 'text/csv';
                console.log('🔍 Filename override: Detected as text/csv');
            } else if (filename.endsWith('.xlsx')) {
                detectedType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                console.log('🔍 Filename override: Detected as Excel');
            } else if (filename.endsWith('.xls')) {
                detectedType = 'application/vnd.ms-excel';
                console.log('🔍 Filename override: Detected as Excel (legacy)');
            } else if (filename.endsWith('.docx')) {
                detectedType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                console.log('🔍 Filename override: Detected as DOCX');
            } else if (filename.endsWith('.doc')) {
                detectedType = 'application/msword';
                console.log('🔍 Filename override: Detected as DOC');
            } else if (filename.endsWith('.pdf')) {
                detectedType = 'application/pdf';
                console.log('🔍 Filename override: Detected as PDF');
            }
        }
        
        // Fallback: If WhatsApp sends generic content type, try to detect from content
        if (contentType === 'application/octet-stream' || contentType === 'text/plain' || !contentType) {
            const buffer = Buffer.from(response.data);
            const textContent = buffer.toString('utf8', 0, Math.min(1000, buffer.length));
            
            if (textContent.includes('BEGIN:VCARD')) {
                detectedType = 'text/vcard';
                console.log('🔍 Content analysis: Detected VCF content');
            } else if (textContent.includes('PK') && textContent.includes('[Content_Types]')) {
                if (filename.includes('docx') || !filename.includes('xlsx')) {
                    detectedType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                    console.log('🔍 Content analysis: Detected DOCX content');
                } else {
                    detectedType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                    console.log('🔍 Content analysis: Detected XLSX content');
                }
            } else if (textContent.includes('%PDF')) {
                detectedType = 'application/pdf';
                console.log('🔍 Content analysis: Detected PDF content');
            } else if (textContent.includes(',') && (textContent.includes('name') || textContent.includes('phone') || textContent.includes('email'))) {
                detectedType = 'text/csv';
                console.log('🔍 Content analysis: Detected CSV content');
            } else {
                // Default to text if we can't determine
                detectedType = 'text/plain';
                console.log('🔍 Content analysis: Defaulting to text/plain');
            }
        }
        
        console.log(`🎯 Final detected type: ${detectedType}`);
        
        // Use enhanced universal parser
        return await parseContactFile(response.data, detectedType, filename);
    } catch (error) {
        console.error('❌ Media download/parse error:', error);
        throw error;
    }
}

// Template Message Function
async function sendTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const cleanFileId = typeof fileId === 'string' ? fileId.split('/').pop() : fileId;
    console.log(`🚀 Template message - FileID: ${cleanFileId}`);
    
    const fromNumber = '+16466030424';
    
    try {
        if (TEMPLATE_SID) {
            console.log('🚀 Attempting WhatsApp Business Template...');
            try {
                await client.messages.create({
                    from: `whatsapp:${fromNumber}`,
                    to: to,
                    contentSid: TEMPLATE_SID,
                    contentVariables: JSON.stringify({
                        "1": contactCount.toString(),
                        "2": cleanFileId
                    })
                });
                console.log('✅ Template message sent successfully!');
                return;
            } catch (templateError) {
                console.error('❌ Business template failed:', templateError.message);
            }
        }
        
        const downloadUrl = `${BASE_URL}/get/${cleanFileId}`;
        console.log('🚀 Attempting structured WhatsApp message...');
        await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to: to,
            body: `✅ *Your CSV file with ${contactCount} contacts is ready for download!*

📎 *Download CSV*
${downloadUrl}

⏰ _Link expires in 2 hours_
💡 _Tap the link above to download your file_`
        });
        console.log('✅ Structured WhatsApp message sent!');
        
    } catch (finalError) {
        console.error('❌ All template methods failed:', finalError.message);
        throw finalError;
    }
}

// Enhanced Twilio webhook with better file detection
app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia } = req.body;
    
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message:', Body);
    console.log('Attachments:', NumMedia);
    
    // Log all media info for debugging
    if (NumMedia > 0) {
        for (let i = 0; i < parseInt(NumMedia); i++) {
            console.log(`📎 Media ${i}: ${req.body[`MediaContentType${i}`]} - ${req.body[`MediaUrl${i}`]}`);
        }
    }
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    try {
        // TESTING RESTRICTION CHECK
        if (!isAuthorizedNumber(From)) {
            console.log(`🚫 Unauthorized number: ${From}`);
            res.type('text/xml');
            res.send(twiml.toString());
            return;
        }
        
        // MULTIPLE CONTACT FILES DETECTED
        if (NumMedia > 0) {
            console.log(`📎 ${NumMedia} contact file(s) detected`);
            
            // Get existing batch or create new one
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0 };
            let totalNewContacts = 0;
            let processedFiles = 0;
            let failedFiles = 0;
            let failureReasons = [];
            
            // Process ALL attachments with enhanced detection
            for (let i = 0; i < parseInt(NumMedia); i++) {
                const mediaUrl = req.body[`MediaUrl${i}`];
                const mediaType = req.body[`MediaContentType${i}`];
                
                if (mediaUrl) {
                    try {
                        console.log(`📎 Processing file ${i + 1}/${NumMedia}: ${mediaType}`);
                        console.log(`🔗 Media URL: ${mediaUrl}`);
                        
                        // Parse using enhanced universal parser
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
                            failureReasons.push(`File ${i + 1}: No contacts found`);
                        }
                        
                    } catch (parseError) {
                        console.error(`❌ Error processing file ${i + 1}:`, parseError);
                        failedFiles++;
                        failureReasons.push(`File ${i + 1}: ${parseError.message}`);
                    }
                }
            }
            
            if (totalNewContacts === 0) {
                let errorMessage = `❌ No contacts found in ${NumMedia} file(s).`;
                
                if (failedFiles > 0) {
                    errorMessage += `\n\n**Issues found:**`;
                    failureReasons.forEach((reason, i) => {
                        errorMessage += `\n• ${reason}`;
                    });
                }
                
                errorMessage += `\n\n**Supported formats:**\n📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX\n\n**Required:** Name or Phone number`;
                
                twiml.message(errorMessage);
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
            let statusMessage = `💾 **${batch.count} contacts saved so far.**`;
            
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
            
            // Create secure file with clean UUID
            const fileId = uuidv4();
            console.log(`📝 Creating file with clean ID: ${fileId}`);
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                from: From,
                created: Date.now(),
                contactCount: batch.contacts.length
            });
            
            // Try enhanced template message first
            try {
                console.log('🚀 Sending enhanced template message...');
                await sendTemplateMessage(From, batch.contacts.length, fileId);
                console.log('✅ Template message sent successfully!');
            } catch (templateError) {
                console.error('❌ Template failed, using TwiML fallback:', templateError);
                
                const downloadUrl = `${BASE_URL}/get/${fileId}`;
                twiml.message(`✅ **Your CSV file with ${batch.contacts.length} contacts is ready!**

📎 *Download CSV*
${downloadUrl}

⏰ _Link expires in 2 hours_
💡 _Tap the link above to download your file_`);
            }
            
            // Clear batch after export
            await storage.del(`batch:${From}`);
            
        } else if (Body === '2️⃣' || Body === '2') {
            twiml.message(`📨 **Ready for more files!**

Drop your contact files—let's bulk-load them! 🚀

📂 **Supported formats:**
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX

💡 _Send multiple files at once for faster processing_`);
            
        } else if (Body.toLowerCase() === 'help') {
            twiml.message(`🎖️ **WhatsApp CSV Converter**

📋 **HOW TO USE:**
1. Send contact files (up to 5 at once)
2. Tap 1️⃣ to export or 2️⃣ to add more
3. Download your CSV file

📂 **Supported Formats:**
   📇 VCF (phone contacts)
   📊 CSV
   📗 Excel
   📄 PDF
   📝 Text
   📘 DOCX

⚡ **FEATURES:**
✅ Multi-file processing
✅ Enhanced file detection
✅ Universal format support
✅ Smart text extraction
✅ Template download buttons

💡 **TIPS:**
• Send multiple files together
• Works with iPhone & Android exports
• PDF contact lists supported
• Word documents with contact data
• Text files with contact patterns

_Standing by for your contact packages..._`);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Multi-file Parser: ARMED
🟢 Universal Parser: ENHANCED
🟢 Text Detection: IMPROVED
🟢 DOCX Support: ADDED
🟢 Template Messages: ACTIVE
🟢 Download URLs: WORKING
🟢 Batch System: ACTIVE
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}

**Authorized Numbers:** 2 users
**Supported Formats:**
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX

_Ready to receive contact packages!_`);
            
        } else if (Body.toLowerCase() === 'testtemplate') {
            // Test template functionality
            try {
                const testFileId = 'test-' + Date.now();
                await sendTemplateMessage(From, 5, testFileId);
                twiml.message('✅ Template test sent! Check above for template message.');
            } catch (error) {
                twiml.message(`❌ Template test failed: ${error.message}`);
            }
            
        } else {
            // Your updated welcome message
            twiml.message(`👋 *Welcome to Contact Converter!*

Drop your contact files here for lightning-fast bulk processing! 🚀

📂 Supported Formats:
   📇 VCF (phone contacts)
   📊 CSV
   📗 Excel
   📄 PDF
   📝 Text
   📘 DOCX

⚡️ Pro-Tip:
Send multiple contacts at once for extra speed! 💨

❓ Need Help?
Type help.`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ **System Error**

Processing failed: ${error.message}

Please try again or contact support.

**Debug info:** ${error.stack?.split('\n')[0] || 'Unknown error'}`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// WhatsApp-safe redirect endpoint
app.get('/get/:fileId', async (req, res) => {
    const { fileId } = req.params;
    console.log(`🔗 WhatsApp redirect request for file: ${fileId}`);
    res.redirect(301, `/download/${fileId}`);
});

// Download endpoint
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    
    try {
        console.log(`📥 Download request for file: ${fileId}`);
        const fileData = await storage.get(`file:${fileId}`);
        
        if (!fileData) {
            console.log(`❌ File not found: ${fileId}`);
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
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
        res.send(fileData.content);
        
        console.log(`📥 File downloaded successfully: ${fileId} (${fileData.contactCount || 0} contacts)`);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send('Download failed');
    }
});

// Health check endpoint
app.get('/', async (req, res) => {
    const fileCount = Object.keys(fileStorage).length;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp CSV Converter - Enhanced</title>
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
                .status { background: #f8f9fa; padding: 1rem; border-radius: 5px; margin: 1rem 0; }
                .metric { display: flex; justify-content: space-between; padding: 0.5rem 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎖️ WhatsApp CSV Converter</h1>
                <h2>Status: ✅ OPERATIONAL</h2>
                
                <div class="status">
                    <h3>Enhanced Features</h3>
                    <div class="metric"><span>Multi-file Processing:</span><strong>✅ Active</strong></div>
                    <div class="metric"><span>File Detection:</span><strong>✅ Enhanced TXT & DOCX</strong></div>
                    <div class="metric"><span>Universal Parser:</span><strong>✅ 6 Formats</strong></div>
                    <div class="metric"><span>Template Messages:</span><strong>✅ Working</strong></div>
                    <div class="metric"><span>Authorized Users:</span><strong>2 numbers</strong></div>
                    <div class="metric"><span>Storage:</span><strong>${redisClient ? 'Redis Cloud' : 'In-Memory'}</strong></div>
                    <div class="metric"><span>Active Files:</span><strong>${fileCount}</strong></div>
                </div>
                
                <h3>Supported Formats (6 Total)</h3>
                <ul>
                    <li>📇 VCF - Contact cards</li>
                    <li>📊 CSV - Spreadsheet data</li>
                    <li>📗 Excel - .xlsx/.xls files</li>
                    <li>📄 PDF - Text extraction</li>
                    <li>📝 Text - Pattern matching</li>
                    <li>📘 DOCX - Word documents</li>
                </ul>
                
                <h3>Latest Enhancements</h3>
                <ul>
                    <li>✅ Fixed TXT file detection and processing</li>
                    <li>✅ Added DOCX support for Word documents</li>
                    <li>✅ Enhanced file type detection from filenames</li>
                    <li>✅ Better content analysis for unknown types</li>
                    <li>✅ Updated user interface messaging</li>
                </ul>
                
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

// Get active file count helper
async function getActiveFileCount() {
    if (redisClient) {
        try {
            const keys = await redisClient.keys('file:*');
            return keys.length;
        } catch (error) {
            return 0;
        }
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 OPERATION: PARSE STORM - TXT FIXED & DOCX SUPPORT ADDED');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`👥 Authorized Numbers: ${AUTHORIZED_NUMBERS.length}`);
    console.log('   - +2348121364213 (Primary)');
    console.log('   - +2347061240799 (Secondary)');
    console.log(`🎯 Template SID: ${TEMPLATE_SID || 'Not configured'}`);
    console.log('\n📋 Enhanced Features:');
    console.log('   ✅ Fixed TXT file detection and processing');
    console.log('   ✅ Added DOCX support for Word documents');
    console.log('   ✅ Enhanced content type detection');
    console.log('   ✅ Updated user interface messaging');
    console.log('   📁 Supported: VCF, CSV, Excel, PDF, Text, DOCX');
    console.log('\n📋 Enhanced webhook ready at: POST /webhook');
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
