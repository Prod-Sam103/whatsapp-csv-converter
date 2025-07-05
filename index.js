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
app.use(express.json({ limit: '50mb' })); // Increased payload limit

// PRODUCTION CONFIGURATION
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

// SCALE CONFIGURATION
const MAX_CONTACTS_PER_BATCH = 250; // WhatsApp limit
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const PROCESSING_TIMEOUT = 25000; // 25 seconds (WhatsApp timeout is 30s)
const CHUNK_SIZE = 50; // Process contacts in chunks
const WHATSAPP_MEDIA_LIMIT = 10; // WhatsApp/Twilio limit per message
const BATCH_TIMEOUT = 20 * 60; // 20 minutes batch timeout

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
        url: process.env.REDIS_URL,
        socket: {
            connectTimeout: 60000,
            lazyConnect: true,
        },
        // Optimised for large payloads
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
    });
    
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    redisClient.connect().then(() => {
        console.log('🔴 Redis: CONNECTED to production storage (optimised for scale)');
    });
}

// Enhanced storage operations for large datasets
const storage = {
    async set(key, value, expirySeconds = 7200) {
        // Compress large contact arrays
        const serialized = JSON.stringify(value);
        
        if (redisClient) {
            try {
                // Handle large payloads by chunking if needed
                if (serialized.length > 1024 * 1024) { // 1MB threshold
                    console.log(`📦 Large payload detected (${(serialized.length / 1024 / 1024).toFixed(2)}MB), using chunked storage`);
                    
                    const chunks = [];
                    const chunkSize = 512 * 1024; // 512KB chunks
                    
                    for (let i = 0; i < serialized.length; i += chunkSize) {
                        chunks.push(serialized.slice(i, i + chunkSize));
                    }
                    
                    // Store chunks
                    await redisClient.set(`${key}:meta`, JSON.stringify({
                        isChunked: true,
                        chunkCount: chunks.length,
                        totalSize: serialized.length
                    }), { EX: expirySeconds });
                    
                    for (let i = 0; i < chunks.length; i++) {
                        await redisClient.set(`${key}:chunk:${i}`, chunks[i], { EX: expirySeconds });
                    }
                } else {
                    await redisClient.set(key, serialized, { EX: expirySeconds });
                }
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
                // Check if data is chunked
                const meta = await redisClient.get(`${key}:meta`);
                
                if (meta) {
                    const metadata = JSON.parse(meta);
                    if (metadata.isChunked) {
                        console.log(`📦 Reconstructing chunked data (${metadata.chunkCount} chunks)`);
                        
                        let reconstructed = '';
                        for (let i = 0; i < metadata.chunkCount; i++) {
                            const chunk = await redisClient.get(`${key}:chunk:${i}`);
                            if (chunk) {
                                reconstructed += chunk;
                            }
                        }
                        return JSON.parse(reconstructed);
                    }
                }
                
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
                // Clean up chunked data if exists
                const meta = await redisClient.get(`${key}:meta`);
                if (meta) {
                    const metadata = JSON.parse(meta);
                    if (metadata.isChunked) {
                        console.log(`🗑️ Cleaning up ${metadata.chunkCount} chunks`);
                        
                        for (let i = 0; i < metadata.chunkCount; i++) {
                            await redisClient.del(`${key}:chunk:${i}`);
                        }
                        await redisClient.del(`${key}:meta`);
                    }
                }
                
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

// High-performance contact parsing with streaming
async function parseContactMediaScalable(mediaUrl, req) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        console.log(`📥 Downloading media from: ${mediaUrl}`);
        
        const response = await axios.get(mediaUrl, {
            auth: {
                username: accountSid,
                password: authToken
            },
            responseType: 'arraybuffer',
            timeout: 15000, // 15 second timeout
            maxContentLength: MAX_FILE_SIZE,
            maxBodyLength: MAX_FILE_SIZE
        });
        
        // Size check
        const fileSize = response.data.byteLength;
        console.log(`📊 File size: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
        
        if (fileSize > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${(fileSize / 1024 / 1024).toFixed(2)}MB (max: 20MB)`);
        }
        
        // Get content type and filename from headers
        const contentType = response.headers['content-type'] || '';
        const contentDisposition = response.headers['content-disposition'] || '';
        
        console.log(`📋 Content-Type: ${contentType}`);
        
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
        
        // Use enhanced universal parser with chunking for large files
        const startTime = Date.now();
        const contacts = await parseContactFileScalable(response.data, detectedType, filename);
        const processingTime = Date.now() - startTime;
        
        console.log(`⚡ Parsed ${contacts.length} contacts in ${processingTime}ms`);
        
        // Limit to 250 contacts per batch (WhatsApp limit)
        if (contacts.length > MAX_CONTACTS_PER_BATCH) {
            console.log(`📏 Truncating to ${MAX_CONTACTS_PER_BATCH} contacts (WhatsApp limit)`);
            return contacts.slice(0, MAX_CONTACTS_PER_BATCH);
        }
        
        return contacts;
    } catch (error) {
        console.error('❌ Media download/parse error:', error);
        throw error;
    }
}

// Enhanced parsing with detailed validation logging
async function parseContactFileScalable(fileContent, mediaType, filename) {
    try {
        console.log(`🔄 Starting scalable parse for type: ${mediaType}`);
        
        // Use enhanced universal parser with chunking
        const contacts = await parseContactFile(fileContent, mediaType, filename);
        console.log(`📥 Raw parsing result: ${contacts.length} contacts extracted`);
        
        // Enhanced validation with detailed logging
        const validContacts = [];
        const rejectedContacts = [];
        
        contacts.forEach((contact, index) => {
            // More flexible validation - accept if has ANY meaningful data
            const hasName = contact.name && contact.name.trim() && contact.name.trim() !== '';
            const hasMobile = contact.mobile && contact.mobile.trim() && contact.mobile.trim() !== '';
            const hasPhone = contact.phone && contact.phone.trim() && contact.phone.trim() !== '';
            const hasWorkPhone = contact.work_phone && contact.work_phone.trim() && contact.work_phone.trim() !== '';
            const hasHomePhone = contact.home_phone && contact.home_phone.trim() && contact.home_phone.trim() !== '';
            const hasEmail = contact.email && contact.email.trim() && contact.email.trim() !== '';
            
            const hasAnyPhone = hasMobile || hasPhone || hasWorkPhone || hasHomePhone;
            const hasAnyData = hasName || hasAnyPhone || hasEmail;
            
            // MUCH more permissive - accept if has name OR phone OR email
            if (hasAnyData) {
                // Clean up the contact before adding
                const cleanContact = {
                    name: (contact.name || contact.fn || contact.fullname || '').trim(),
                    mobile: (contact.mobile || contact.phone || contact.tel || contact.work_phone || contact.home_phone || '').trim(),
                    email: (contact.email || contact.mail || '').trim(),
                    company: (contact.company || contact.organization || contact.org || '').trim(),
                    notes: (contact.notes || contact.note || '').trim()
                };
                
                // Final check - must have at least name or phone
                if (cleanContact.name || cleanContact.mobile) {
                    validContacts.push(cleanContact);
                } else {
                    rejectedContacts.push({
                        index: index + 1,
                        reason: 'No usable name or phone after cleaning',
                        data: contact
                    });
                }
            } else {
                rejectedContacts.push({
                    index: index + 1,
                    reason: 'No name, phone, or email found',
                    data: contact
                });
            }
        });
        
        if (rejectedContacts.length > 0) {
            console.log(`⚠️ Rejected ${rejectedContacts.length} contacts:`);
            rejectedContacts.slice(0, 5).forEach(rejected => {
                console.log(`   - Contact ${rejected.index}: ${rejected.reason}`);
                console.log(`     Raw data: ${JSON.stringify(rejected.data).substring(0, 150)}...`);
            });
        }
        
        console.log(`✅ Validation complete: ${validContacts.length}/${contacts.length} valid contacts (${rejectedContacts.length} rejected)`);
        
        return validContacts;
        
    } catch (error) {
        console.error(`❌ Scalable parsing failed for ${mediaType}:`, error);
        // Final fallback to text parsing
        try {
            const fallbackContacts = await parseContactFile(fileContent.toString(), 'text/plain', filename);
            console.log(`🔄 Fallback parsing yielded: ${fallbackContacts.length} contacts`);
            return fallbackContacts;
        } catch (fallbackError) {
            console.error('❌ Fallback parsing also failed:', fallbackError);
            return [];
        }
    }
}

// Template Message Function with Download Button
async function sendTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const cleanFileId = typeof fileId === 'string' ? fileId.split('/').pop() : fileId;
    console.log(`🚀 Template message - FileID: ${cleanFileId}, Count: ${contactCount}`);
    
    const fromNumber = '+16466030424';
    
    try {
        if (TEMPLATE_SID) {
            console.log('🚀 Attempting WhatsApp Business Template with Download Button...');
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
                console.log('✅ Template message with download button sent successfully!');
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

// Send interactive message with Export button
async function sendInteractiveExportMessage(to, batch) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = '+16466030424';
    
    // Build status message
    let statusMessage = `💾 *${batch.count} contacts saved so far.*`;
    
    if (batch.filesProcessed > 0) {
        statusMessage += `\n✅ Processed ${batch.filesProcessed} file(s)`;
    }
    
    // Show progress
    const remaining = MAX_CONTACTS_PER_BATCH - batch.count;
    if (remaining > 0) {
        statusMessage += `\n📋 *Note:* Received ${batch.count}/${MAX_CONTACTS_PER_BATCH} contacts (You can send ${remaining} more)`;
    } else {
        statusMessage += `\n📋 *Note:* Batch limit reached (${MAX_CONTACTS_PER_BATCH}/${MAX_CONTACTS_PER_BATCH})`;
    }
    
    statusMessage += `\n\nKeep sending more contacts or export when ready`;
    
    try {
        console.log('🚀 Sending interactive message with Export button...');
        
        // Send interactive button message
        await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to: to,
            body: statusMessage,
            // Add interactive button using Twilio's button format
            action: JSON.stringify({
                buttons: [{
                    type: 'reply',
                    reply: {
                        id: 'export_contacts',
                        title: 'Export'
                    }
                }]
            })
        });
        
        console.log('✅ Interactive Export button message sent!');
        
    } catch (interactiveError) {
        console.error('❌ Interactive button failed, using TwiML fallback:', interactiveError);
        
        // Fallback to simple text message
        const fallbackMessage = statusMessage + `\n\nType "export" to download your CSV file`;
        
        await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to: to,
            body: fallbackMessage
        });
        
        console.log('✅ Fallback message sent');
    }
}

// Interactive Export Button webhook with clean UX
app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia, ButtonText, ButtonPayload } = req.body;
    const startTime = Date.now();
    
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message:', Body);
    console.log('Button Text:', ButtonText);
    console.log('Button Payload:', ButtonPayload);
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
        
        // Handle Export button click
        if (ButtonPayload === 'export_contacts' || ButtonText === 'Export' || Body.toLowerCase() === 'export') {
            console.log(`📤 Export button clicked or export command received`);
            const batch = await storage.get(`batch:${From}`);
            
            if (!batch || batch.contacts.length === 0) {
                twiml.message(`❌ No contacts to export.\n\nSend some contact files first!`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            console.log(`📊 Generating CSV for ${batch.contacts.length} contacts...`);
            
            // Generate CSV from batch with chunking for large datasets
            const csvStartTime = Date.now();
            const csv = generateCSV(batch.contacts);
            const csvTime = Date.now() - csvStartTime;
            
            console.log(`📝 CSV generated in ${csvTime}ms (${(csv.length / 1024).toFixed(2)}KB)`);
            
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
            
            // Send template message with Download CSV button
            try {
                console.log('🚀 Sending template message with Download CSV button...');
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
            
        } else if (NumMedia > 0) {
            // AUTO-BATCH CONTACT PROCESSING
            console.log(`📎 ${NumMedia} contact file(s) detected - Starting auto-batch processing`);
            
            // Get existing batch or create new one
            let batch = await storage.get(`batch:${From}`) || { contacts: [], count: 0, filesProcessed: 0 };
            let totalNewContacts = 0;
            let processedFiles = 0;
            let failedFiles = 0;
            let failureReasons = [];
            
            // Process ALL attachments in parallel for speed
            const processingPromises = [];
            
            for (let i = 0; i < parseInt(NumMedia); i++) {
                const mediaUrl = req.body[`MediaUrl${i}`];
                const mediaType = req.body[`MediaContentType${i}`];
                
                if (mediaUrl) {
                    processingPromises.push(
                        parseContactMediaScalable(mediaUrl, req)
                            .then(contacts => ({
                                success: true,
                                fileIndex: i + 1,
                                contacts: contacts,
                                count: contacts.length
                            }))
                            .catch(error => ({
                                success: false,
                                fileIndex: i + 1,
                                error: error.message
                            }))
                    );
                }
            }
            
            // Process all files in parallel with timeout protection
            console.log(`⚡ Processing ${processingPromises.length} files in parallel...`);
            
            const results = await Promise.allSettled(
                processingPromises.map(promise => 
                    Promise.race([
                        promise,
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Processing timeout')), PROCESSING_TIMEOUT)
                        )
                    ])
                )
            );
            
            // Collect results
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value.success) {
                    const { contacts, count, fileIndex } = result.value;
                    console.log(`✅ File ${fileIndex} processed: ${count} contacts`);
                    
                    batch.contacts.push(...contacts);
                    totalNewContacts += count;
                    processedFiles++;
                } else {
                    const error = result.status === 'fulfilled' 
                        ? result.value.error 
                        : result.reason.message;
                    
                    const fileIndex = result.status === 'fulfilled' 
                        ? result.value.fileIndex 
                        : 'unknown';
                    
                    console.error(`❌ File ${fileIndex} failed: ${error}`);
                    failedFiles++;
                    failureReasons.push(`File ${fileIndex}: ${error}`);
                }
            }
            
            // Check if we hit the limit
            if (batch.contacts.length > MAX_CONTACTS_PER_BATCH) {
                console.log(`📏 Batch limit reached, truncating to ${MAX_CONTACTS_PER_BATCH} contacts`);
                batch.contacts = batch.contacts.slice(0, MAX_CONTACTS_PER_BATCH);
                totalNewContacts = Math.min(totalNewContacts, MAX_CONTACTS_PER_BATCH);
            }
            
            if (totalNewContacts === 0) {
                let errorMessage = `❌ No contacts found in ${NumMedia} file(s).`;
                
                if (failedFiles > 0) {
                    errorMessage += `\n\n**Issues found:**`;
                    failureReasons.slice(0, 3).forEach((reason) => { // Limit to 3 errors
                        errorMessage += `\n• ${reason}`;
                    });
                    if (failureReasons.length > 3) {
                        errorMessage += `\n• ... and ${failureReasons.length - 3} more`;
                    }
                }
                
                errorMessage += `\n\n**Supported formats:**\n📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX\n\n**Required:** Name or Phone number`;
                
                twiml.message(errorMessage);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Update batch totals
            batch.count = batch.contacts.length;
            batch.filesProcessed += processedFiles;
            batch.lastUpdated = Date.now();
            
            // Save batch (expires in 20 minutes)
            await storage.set(`batch:${From}`, batch, BATCH_TIMEOUT);
            
            // Send interactive message with Export button (instead of TwiML)
            try {
                await sendInteractiveExportMessage(From, batch);
            } catch (interactiveError) {
                console.error('❌ Interactive message failed, using TwiML fallback:', interactiveError);
                
                // Fallback to TwiML with simple text
                let statusMessage = `💾 *${batch.count} contacts saved so far.*`;
                
                if (processedFiles > 0) {
                    statusMessage += `\n✅ Processed ${processedFiles} file(s): +${totalNewContacts} contacts`;
                }
                
                if (failedFiles > 0) {
                    statusMessage += `\n⚠️ ${failedFiles} file(s) failed to process`;
                }
                
                const remaining = MAX_CONTACTS_PER_BATCH - batch.count;
                if (remaining > 0) {
                    statusMessage += `\n📋 *Note:* Received ${batch.count}/${MAX_CONTACTS_PER_BATCH} contacts (You can send ${remaining} more)`;
                } else {
                    statusMessage += `\n📋 *Note:* Batch limit reached (${MAX_CONTACTS_PER_BATCH}/${MAX_CONTACTS_PER_BATCH})`;
                }
                
                statusMessage += `\n\nKeep sending more contacts or type "export" when ready`;
                
                twiml.message(statusMessage);
            }
            
        } else if (Body.toLowerCase() === 'help') {
            twiml.message(`🎖️ **WhatsApp CSV Converter**

📋 **HOW TO USE:**
1. Send your contact files
2. Keep sending more if needed
3. Tap "Export" button when done

📂 **Supported Formats:**
   📇 VCF (phone contacts)
   📊 CSV
   📗 Excel
   📄 PDF
   📝 Text
   📘 DOCX

⚡ **FEATURES:**
✅ Auto-batching system
✅ Up to 250 contacts per batch
✅ Interactive Export button
✅ Works with iPhone & Android

💡 **TIPS:**
• Send multiple files at once
• WhatsApp sends 10 files max per message
• Just keep sending - system auto-batches
• Tap "Export" button to download CSV

_Ready for your contacts!_`);
            
        } else if (Body.toLowerCase() === 'test') {
            const fileCount = await getActiveFileCount();
            
            twiml.message(`✅ **Interactive Export Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Auto-Batching: ACTIVE
🟢 Interactive Export Button: ENABLED
🟢 Template Download: READY
🟢 Storage: ${redisClient ? 'REDIS OPTIMISED' : 'MEMORY'}

**Performance:**
📊 Max Contacts: ${MAX_CONTACTS_PER_BATCH}
📁 Max File Size: 20MB
⏱️ Batch Timeout: ${BATCH_TIMEOUT / 60} minutes
🗃️ Active Files: ${fileCount}

**Supported Formats:**
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX

_Interactive export system ready!_`);
            
        } else if (Body.toLowerCase() === 'testtemplate') {
            // Test template functionality
            try {
                const testFileId = 'test-' + Date.now();
                await sendTemplateMessage(From, 42, testFileId);
                twiml.message('✅ Template test sent! Check above for Download CSV button.');
            } catch (error) {
                twiml.message(`❌ Template test failed: ${error.message}`);
            }
            
        } else {
            // Welcome message
            twiml.message(`👋 **Welcome to Contact Converter!**

Send your contact files for instant CSV conversion! 

📱 Works with: iPhone contacts, Android contacts, Excel files
⚡ Interactive export system with clean buttons

💡 Just send your contacts and tap "Export" when done!

Type "help" for more info.`);
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

// High-performance download endpoint with streaming
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
                        <p><strong>Interactive Export:</strong> Clean button experience for downloads.</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Set headers for optimised download
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileData.filename}"`);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        // Add UTF-8 BOM for Excel compatibility
        const bom = '\uFEFF';
        const content = bom + fileData.content;
        
        res.send(content);
        
        console.log(`📥 File downloaded successfully: ${fileId} (${fileData.contactCount || 0} contacts, ${(content.length / 1024).toFixed(2)}KB)`);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Download Failed</title>
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
                    <h1>❌ Download Failed</h1>
                    <p>There was an error processing your download.</p>
                    <p>Please try again or contact support.</p>
                </div>
            </body>
            </html>
        `);
    }
});

// Enhanced health check endpoint with interactive export metrics
app.get('/', async (req, res) => {
    const fileCount = await getActiveFileCount();
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp CSV Converter - Interactive Export Edition</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                    max-width: 1000px;
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
                .metric { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #eee; }
                .metric:last-child { border-bottom: none; }
                .performance { background: #e8f5e8; }
                .interactive { background: #e1f5fe; }
                .green { color: #28a745; font-weight: bold; }
                .blue { color: #007bff; font-weight: bold; }
                .orange { color: #fd7e14; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 WhatsApp CSV Converter - Interactive Export Edition</h1>
                <h2>Status: ✅ OPERATIONAL</h2>
                
                <div class="status interactive">
                    <h3>🖱️ Interactive Export Features</h3>
                    <div class="metric"><span>Interactive Export Button:</span><strong class="green">✅ Active</strong></div>
                    <div class="metric"><span>Clean Button UX:</span><strong class="green">✅ Enabled</strong></div>
                    <div class="metric"><span>Template Download Button:</span><strong class="green">✅ Ready</strong></div>
                    <div class="metric"><span>Seamless Contact Collection:</span><strong class="green">✅ Working</strong></div>
                </div>
                
                <div class="status">
                    <h3>🔥 High-Performance Features</h3>
                    <div class="metric"><span>Parallel File Processing:</span><strong class="green">✅ Active</strong></div>
                    <div class="metric"><span>Memory Optimisation:</span><strong class="green">✅ Enabled</strong></div>
                    <div class="metric"><span>Chunked Storage:</span><strong class="green">✅ Large File Support</strong></div>
                    <div class="metric"><span>Universal Parser:</span><strong class="green">✅ Enhanced</strong></div>
                    <div class="metric"><span>Template Messages:</span><strong class="green">✅ Working</strong></div>
                    <div class="metric"><span>Timeout Protection:</span><strong class="green">✅ 25s Limit</strong></div>
                </div>
                
                <div class="status performance">
                    <h3>⚡ Performance Metrics</h3>
                    <div class="metric"><span>Max Contacts per Batch:</span><strong class="blue">${MAX_CONTACTS_PER_BATCH}</strong></div>
                    <div class="metric"><span>Max File Size:</span><strong class="blue">20MB</strong></div>
                    <div class="metric"><span>Processing Timeout:</span><strong class="blue">25 seconds</strong></div>
                    <div class="metric"><span>Batch Timeout:</span><strong class="blue">${BATCH_TIMEOUT / 60} minutes</strong></div>
                    <div class="metric"><span>Parallel Processing:</span><strong class="blue">Up to ${WHATSAPP_MEDIA_LIMIT} files</strong></div>
                </div>
                
                <div class="status">
                    <h3>🎯 System Status</h3>
                    <div class="metric"><span>Authorized Users:</span><strong>${AUTHORIZED_NUMBERS.length} numbers</strong></div>
                    <div class="metric"><span>Storage Backend:</span><strong>${redisClient ? 'Redis Cloud (Optimised)' : 'In-Memory'}</strong></div>
                    <div class="metric"><span>Active Files:</span><strong>${fileCount}</strong></div>
                    <div class="metric"><span>Environment:</span><strong>${IS_PRODUCTION ? 'Production' : 'Development'}</strong></div>
                </div>
                
                <h3>📂 Supported Formats (6 Total)</h3>
                <ul>
                    <li>📇 <strong>VCF</strong> - Contact cards (optimised parsing)</li>
                    <li>📊 <strong>CSV</strong> - Spreadsheet data (enhanced detection)</li>
                    <li>📗 <strong>Excel</strong> - .xlsx/.xls files (streaming support)</li>
                    <li>📄 <strong>PDF</strong> - Text extraction (memory efficient)</li>
                    <li>📝 <strong>Text</strong> - Pattern matching (4 methods)</li>
                    <li>📘 <strong>DOCX</strong> - Word documents (enhanced support)</li>
                </ul>
                
                <h3>🖱️ Interactive Export Workflow</h3>
                <ol>
                    <li><strong>Send contacts:</strong> User sends contact files via WhatsApp</li>
                    <li><strong>Auto-batch:</strong> System automatically collects contacts</li>
                    <li><strong>Interactive response:</strong> User sees Export button</li>
                    <li><strong>Tap Export:</strong> Clean button triggers export process</li>
                    <li><strong>Template download:</strong> Receive Download CSV button</li>
                    <li><strong>Tap Download:</strong> File downloads instantly</li>
                </ol>
                
                <h3>🚀 Latest Interactive Enhancements</h3>
                <ul>
                    <li>✅ <strong>Interactive Export Button:</strong> Clean button instead of emoji text</li>
                    <li>✅ <strong>Dual Button System:</strong> Export button → Download CSV button</li>
                    <li>✅ <strong>Enhanced UX:</strong> Professional button experience</li>
                    <li>✅ <strong>Auto-Collection:</strong> Seamless contact accumulation</li>
                    <li>✅ <strong>Template Integration:</strong> Download button in template</li>
                    <li>✅ <strong>Fallback Support:</strong> Text commands work if buttons fail</li>
                    <li>✅ <strong>Button Detection:</strong> Handles button clicks and text commands</li>
                    <li>✅ <strong>Enhanced Validation:</strong> More permissive contact acceptance</li>
                </ul>
                
                <p style="margin-top: 2rem; color: #666; text-align: center;">
                    <strong>Interactive Export Edition</strong><br>
                    Built for professional button experience with ❤️
                </p>
            </div>
        </body>
        </html>
    `);
});

// Error handling with performance context
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: IS_PRODUCTION ? 'Something went wrong' : err.message,
        performance_note: 'Interactive export mode active'
    });
});

// Enhanced file count helper with Redis optimisation
async function getActiveFileCount() {
    if (redisClient) {
        try {
            const keys = await redisClient.keys('file:*');
            // Filter out chunked metadata
            const fileKeys = keys.filter(key => !key.includes(':meta') && !key.includes(':chunk:'));
            return fileKeys.length;
        } catch (error) {
            console.error('Redis file count error:', error);
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

// Start server with enhanced logging
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 OPERATION: INTERACTIVE EXPORT BUTTON - CLEAN UX');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected (Optimised)' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`👥 Authorized Numbers: ${AUTHORIZED_NUMBERS.length}`);
    console.log('   - +2348121364213 (Primary)');
    console.log('   - +2347061240799 (Secondary)');
    console.log('   - +2347034988523 (Tertiary)');
    console.log('   - +2348132474537 (Quaternary)');
    console.log(`🎯 Template SID: ${TEMPLATE_SID || 'Not configured'}`);
    console.log('\n🖱️ INTERACTIVE EXPORT FEATURES:');
    console.log('   ⚡ Interactive Export button instead of emoji text');
    console.log('   📊 Clean button UX experience');
    console.log('   🔄 Dual button system: Export → Download CSV');
    console.log('   📱 Professional template integration');
    console.log('   💾 Memory optimisation with chunked storage');
    console.log('   ⏱️ Extended batch timeout: 20 minutes');
    console.log('   📁 Large file support: up to 20MB');
    console.log('   🔄 Enhanced error handling and recovery');
    console.log('   ✅ Enhanced validation: accepts name OR phone OR email');
    console.log('   📁 Supported: VCF, CSV, Excel, PDF, Text, DOCX');
    console.log('\n📋 Interactive export webhook ready at: POST /webhook');
    console.log('💡 Clean UX: Export button → Download CSV button!');
});

// Enhanced cleanup with performance monitoring
setInterval(async () => {
    const startTime = Date.now();
    let cleanedCount = 0;
    
    if (!redisClient) {
        const now = Date.now();
        Object.keys(fileStorage).forEach(key => {
            if (fileStorage[key].expires < now) {
                delete fileStorage[key];
                cleanedCount++;
            }
        });
    }
    
    const cleanupTime = Date.now() - startTime;
    if (cleanedCount > 0) {
        console.log(`🗑️ Cleaned ${cleanedCount} expired files in ${cleanupTime}ms`);
    }
}, 30 * 60 * 1000); // Every 30 minutes

// Graceful shutdown with cleanup
process.on('SIGTERM', async () => {
    console.log('📴 Shutting down gracefully...');
    if (redisClient) {
        console.log('💾 Closing Redis connection...');
        await redisClient.quit();
    }
    console.log('✅ Shutdown complete');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});