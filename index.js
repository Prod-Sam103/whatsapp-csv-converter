const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import tactical modules
const { parseVCF } = require('./src/vcf-parser');
const { generateCSV } = require('./src/csv-generator');
const { parseContactFile, getSupportedFormats } = require('./src/csv-excel-parser');
const store = require('./src/session-store');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' })); // Increased payload limit

// SECURITY: Rate limiting protection
const rateLimitStore = new Map();
function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress || 
               'unknown';
    
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxRequests = 20; // Reduced from 100 to 20 for public access security
    
    // Clean old entries
    for (const [key, data] of rateLimitStore.entries()) {
        if (now - data.resetTime > windowMs) {
            rateLimitStore.delete(key);
        }
    }
    
    const key = `${ip}:${req.path}`;
    const current = rateLimitStore.get(key) || { count: 0, resetTime: now };
    
    if (now - current.resetTime > windowMs) {
        current.count = 0;
        current.resetTime = now;
    }
    
    current.count++;
    rateLimitStore.set(key, current);
    
    if (current.count > maxRequests) {
        console.log(`🚨 Rate limit exceeded for ${ip}: ${current.count} requests`);
        return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please try again later.',
            resetTime: current.resetTime + windowMs
        });
    }
    
    // Add rate limit headers
    res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': Math.max(0, maxRequests - current.count),
        'X-RateLimit-Reset': new Date(current.resetTime + windowMs).toISOString()
    });
    
    next();
}

// Apply rate limiting to all routes
app.use(rateLimit);

// PRODUCTION CONFIGURATION
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const FILE_EXPIRY = 2 * 60 * 60 * 1000; // 2 hours

// SCALE CONFIGURATION
const MAX_CONTACTS_PER_BATCH = 500; // Increased for bulk processing
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB per file
const PROCESSING_TIMEOUT = 45000; // 45 seconds (increased for large text processing)
const CHUNK_SIZE = 50; // Process contacts in chunks
const WHATSAPP_MEDIA_LIMIT = 10; // WhatsApp/Twilio limit per message
const BATCH_TIMEOUT = 20 * 60; // 20 minutes batch timeout

// OPEN ACCESS - No phone number restrictions (removed for public access)
// Previously restricted to specific numbers, now open to all users
const AUTHORIZED_NUMBERS = []; // Empty array - no restrictions

// Template Configuration - TWO TEMPLATES
const STATUS_TEMPLATE_SID = process.env.STATUS_TEMPLATE_SID; // New: Status with Export button
const DOWNLOAD_TEMPLATE_SID = process.env.DOWNLOAD_TEMPLATE_SID; // Existing: Download CSV button

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

// Public access - all numbers are now authorized
function isAuthorizedNumber(phoneNumber) {
    // Always return true for public access (no restrictions)
    return true;
}

// SECURITY: Input validation and sanitization function
function validateAndSanitizeTextInput(input) {
    if (!input || typeof input !== 'string') {
        return null;
    }
    
    // Length limits to prevent DoS
    const MAX_TEXT_LENGTH = 50000; // 50KB max text message (increased for bulk contacts)
    if (input.length > MAX_TEXT_LENGTH) {
        console.log(`🚨 Text input too long: ${input.length} chars (max: ${MAX_TEXT_LENGTH})`);
        return null;
    }
    
    // Remove potential XSS and injection attempts
    let sanitized = input
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove <script> tags
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/javascript:/gi, '') // Remove javascript: protocol
        .replace(/data:/gi, '') // Remove data: protocol
        .replace(/vbscript:/gi, '') // Remove vbscript: protocol
        .trim();
    
    // Basic length check after sanitization
    if (sanitized.length < 3) {
        return null;
    }
    
    // Check for suspicious patterns that might indicate injection attempts
    const suspiciousPatterns = [
        /\$\{.*\}/, // Template literal injection
        /<%.*%>/, // Template injection
        /\{\{.*\}\}/, // Template injection
        /eval\s*\(/, // Code execution
        /function\s*\(/, // Function definition
        /setTimeout|setInterval/i, // Timer functions
        /document\.|window\./i, // DOM access
        /XMLHttpRequest|fetch\(/i, // Network requests
    ];
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(sanitized)) {
            console.log(`🚨 Suspicious pattern detected in input: ${pattern}`);
            return null;
        }
    }
    
    return sanitized;
}

// SECURITY: Media URL validation to prevent SSRF attacks
function validateMediaUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }
    
    try {
        const parsedUrl = new URL(url);
        
        // Only allow HTTPS URLs from Twilio
        if (parsedUrl.protocol !== 'https:') {
            console.log(`🚨 Invalid protocol in media URL: ${parsedUrl.protocol}`);
            return false;
        }
        
        // Only allow Twilio media domains
        const allowedDomains = [
            'api.twilio.com',
            'media.twiliocdn.com',
            /^[a-z0-9-]+\.twilio\.com$/,
            /^[a-z0-9-]+\.twiliocdn\.com$/
        ];
        
        const hostname = parsedUrl.hostname.toLowerCase();
        const isAllowed = allowedDomains.some(domain => {
            if (typeof domain === 'string') {
                return hostname === domain;
            } else {
                return domain.test(hostname);
            }
        });
        
        if (!isAllowed) {
            console.log(`🚨 Unauthorized domain in media URL: ${hostname}`);
            return false;
        }
        
        // Prevent accessing internal network addresses
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (ipRegex.test(hostname)) {
            const parts = hostname.split('.').map(Number);
            // Block private IP ranges
            if (
                parts[0] === 10 || // 10.0.0.0/8
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 172.16.0.0/12
                (parts[0] === 192 && parts[1] === 168) || // 192.168.0.0/16
                parts[0] === 127 || // 127.0.0.0/8 (localhost)
                parts[0] === 0     // 0.0.0.0/8
            ) {
                console.log(`🚨 Private IP address blocked: ${hostname}`);
                return false;
            }
        }
        
        return true;
        
    } catch (error) {
        console.log(`🚨 Invalid URL format: ${error.message}`);
        return false;
    }
}

// High-performance contact parsing with streaming
async function parseContactMediaScalable(mediaUrl, req) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        // SECURITY: Validate media URL to prevent SSRF attacks
        if (!validateMediaUrl(mediaUrl)) {
            throw new Error('Invalid or unsafe media URL provided');
        }
        
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
        
        // Simplified file type detection - VCF and text only
        let detectedType = contentType;
        
        // Override content type based on filename extension
        if (filename) {
            if (filename.endsWith('.txt')) {
                detectedType = 'text/plain';
                console.log('🔍 Filename override: Detected as text/plain');
            } else if (filename.endsWith('.vcf')) {
                detectedType = 'text/vcard';
                console.log('🔍 Filename override: Detected as text/vcard');
            } else if (filename.endsWith('.csv') || filename.endsWith('.xlsx') || 
                       filename.endsWith('.xls') || filename.endsWith('.docx') || 
                       filename.endsWith('.doc') || filename.endsWith('.pdf')) {
                throw new Error('Unsupported file format. Please send VCF files or paste contact text.');
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
                throw new Error('Excel/Word files not supported. Please send VCF files or paste contact text.');
            } else if (textContent.includes('%PDF')) {
                throw new Error('PDF files not supported. Please send VCF files or paste contact text.');
            } else if (textContent.includes(',') && (textContent.includes('name') || textContent.includes('phone') || textContent.includes('email'))) {
                throw new Error('CSV files not supported. Please send VCF files or paste contact text.');
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

// Plain Text Contact Template with Action Buttons
async function sendPlainTextContactTemplate(to, contactCount, contacts, totalCount) {
    const TEMPLATE_SID = process.env.PLAINTEXT_TEMPLATE_SID || 'HX...'; // Set this in Vercel env
    
    console.log(`🔍 TEMPLATE DEBUG: PLAINTEXT_TEMPLATE_SID = "${TEMPLATE_SID}"`);
    console.log(`🔍 TEMPLATE DEBUG: Environment check = ${!!process.env.PLAINTEXT_TEMPLATE_SID}`);
    
    if (!TEMPLATE_SID || TEMPLATE_SID === 'HX...') {
        console.log('❌ TEMPLATE DEBUG: Template SID not configured, throwing error');
        throw new Error('Plain text template SID not configured');
    }
    
    // Initialize Twilio client
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || '+16467578772';
    
    // Build contact preview for {{2}} variable
    const firstContact = contacts[0];
    const contactPreview = `${firstContact.name || 'Contact'} - ${firstContact.mobile || firstContact.phone || 'No phone'}`;
    
    console.log(`🚀 Sending plain text template - Count: ${contactCount}, Total: ${totalCount}`);
    console.log(`🚀 Template SID: ${TEMPLATE_SID}`);
    console.log(`🚀 From: whatsapp:${fromNumber}`);
    console.log(`🚀 To: ${to}`);
    console.log(`🚀 Contact preview: ${contactPreview}`);
    
    // Template variables for new 3-variable structure
    const var1 = contactCount.toString();     // {{1}} - contacts found in message
    const var2 = contactPreview;              // {{2}} - contact preview  
    const var3 = totalCount.toString();       // {{3}} - total in batch
    
    console.log(`🚀 Template variables: {{1}}="${var1}", {{2}}="${var2}", {{3}}="${var3}"`);
    console.log(`🚀 Attempting Plain Text Contact Template with Action Buttons...`);
    
    const templateMessage = await client.messages.create({
        from: `whatsapp:${fromNumber}`,
        to: to,
        contentSid: TEMPLATE_SID,
        contentVariables: JSON.stringify({
            "1": var1,
            "2": var2,
            "3": var3
        })
    });
    
    console.log('✅ Plain text contact template with action buttons sent successfully!');
    console.log(`📋 Message SID: ${templateMessage.sid}`);
    console.log(`📋 Template used: ${TEMPLATE_SID}`);
}

// Template 1: Status Message with Export Button
async function sendStatusTemplateWithExportButton(to, batch) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || '+16467578772';
    const remaining = MAX_CONTACTS_PER_BATCH - batch.count;
    
    console.log(`🚀 Sending status template with Export button - Count: ${batch.count}, Files: ${batch.filesProcessed}, Remaining: ${remaining}`);
    
    try {
        if (STATUS_TEMPLATE_SID) {
            console.log('🚀 Attempting Status Template with Export Button...');
            
            await client.messages.create({
                from: `whatsapp:${fromNumber}`,
                to: to,
                contentSid: STATUS_TEMPLATE_SID,
                contentVariables: JSON.stringify({
                    "1": batch.count.toString(),           // Contact count
                    "2": batch.filesProcessed.toString(),  // Files processed  
                    "3": remaining.toString()              // Remaining slots
                })
            });
            
            console.log('✅ Status template with Export button sent successfully!');
            return;
            
        } else {
            console.log('⚠️ STATUS_TEMPLATE_SID not configured, using fallback');
            throw new Error('Status template not configured');
        }
        
    } catch (templateError) {
        console.error('❌ Status template failed:', templateError.message);
        
        // Fallback to regular text message
        console.log('🚀 Using fallback text message...');
        
        let statusMessage = `💾 *${batch.count} contacts saved so far.*`;
        
        if (batch.filesProcessed > 0) {
            statusMessage += `\n✅ Processed ${batch.filesProcessed} file(s)`;
        }
        
        if (remaining > 0) {
            statusMessage += `\n📋 *Note:* Received ${batch.count}/${MAX_CONTACTS_PER_BATCH} contacts`;
        } else {
            statusMessage += `\n📋 *Note:* Batch limit reached (${MAX_CONTACTS_PER_BATCH}/${MAX_CONTACTS_PER_BATCH})`;
        }
        
        statusMessage += `\n\nKeep sending more contacts or type "export" when ready`;
        
        await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to: to,
            body: statusMessage
        });
        
        console.log('✅ Fallback status message sent');
    }
}

// Template 2: Download CSV Button
async function sendDownloadTemplateMessage(to, contactCount, fileId) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || '+16467578772';
    
    const cleanFileId = typeof fileId === 'string' ? fileId.split('/').pop() : fileId;
    console.log(`🚀 Sending download template - FileID: ${cleanFileId}, Count: ${contactCount}`);
    
    try {
        if (DOWNLOAD_TEMPLATE_SID) {
            console.log('🚀 Attempting Download Template with CSV Button...');
            
            await client.messages.create({
                from: `whatsapp:${fromNumber}`,
                to: to,
                contentSid: DOWNLOAD_TEMPLATE_SID,
                contentVariables: JSON.stringify({
                    "1": contactCount.toString(),
                    "2": cleanFileId
                })
            });
            
            console.log('✅ Download template with CSV button sent successfully!');
            return;
            
        } else {
            console.log('⚠️ DOWNLOAD_TEMPLATE_SID not configured, using fallback');
            throw new Error('Download template not configured');
        }
        
    } catch (templateError) {
        console.error('❌ Download template failed:', templateError.message);
        
        // Fallback to regular text message
        const downloadUrl = `${BASE_URL}/get/${cleanFileId}`;
        console.log('🚀 Using fallback download message...');
        
        await client.messages.create({
            from: `whatsapp:${fromNumber}`,
            to: to,
            body: `✅ *Your CSV file with ${contactCount} contacts is ready for download!*

📎 *Download CSV*
${downloadUrl}

⏰ _Link expires in 2 hours_
💡 _Tap the link above to download your file_`
        });
        
        console.log('✅ Fallback download message sent');
    }
}

// Dual Template Export Button webhook
app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia, ButtonText, ButtonPayload } = req.body;
    const startTime = Date.now();
    
    console.log('🔥🔥🔥 WEBHOOK HIT! 🔥🔥🔥', new Date().toISOString());
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message Body Length:', Body ? Body.length : 'NULL');
    console.log('Message Preview:', Body ? Body.substring(0, 100) + '...' : 'NO BODY');
    console.log('Button Text:', ButtonText);
    console.log('Button Payload:', ButtonPayload);
    console.log('Attachments:', NumMedia);
    console.log('Full Request Body Keys:', Object.keys(req.body));
    console.log('Request Headers:', JSON.stringify(req.headers, null, 2));
    
    // Log all media info for debugging
    if (NumMedia > 0) {
        for (let i = 0; i < parseInt(NumMedia); i++) {
            console.log(`📎 Media ${i}: ${req.body[`MediaContentType${i}`]} - ${req.body[`MediaUrl${i}`]}`);
        }
    }
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    try {
        // PUBLIC ACCESS - All users now welcome (authorization removed for public use)
        // Previous authorization check removed - service now available to everyone
        
        // Handle Add More button - encourage sending more contacts
        if (ButtonPayload === 'add_more_contacts' || 
            ButtonText === 'Add More') {
            
            console.log(`🌟 ADD MORE BRANCH TRIGGERED for ${From}`);
            const cleanPhone = From.replace('whatsapp:', '');
            const contacts = await store.get(`contacts:${cleanPhone}`) || [];
            
            const contactCount = contacts.length;
            const contactWord = contactCount === 1 ? 'contact' : 'contacts';
            
            twiml.message(`📝 **Great! You have ${contactCount} ${contactWord} ready for CSV export.**

**Keep adding more contacts:**
• Send VCF contact files
• Send plain text with contact details
• System auto-batches everything!

**Examples:**
• John Doe +2348123456789 john@example.com
• Jane Smith: 08012345678

When you're ready, type "export" to download your CSV! 📤`);

        // Handle Export button click or export command  
        } else if (ButtonPayload === 'export_contacts' || 
            ButtonText === 'Export' || 
            ButtonText === 'Export CSV' ||
            Body.toLowerCase() === 'export' ||
            Body === '1️⃣' || Body === '1') {
            
            console.log(`🌟 EXPORT BRANCH TRIGGERED for ${From}`);
            console.log(`📤 Export triggered via: ${ButtonText || ButtonPayload || Body}`);
            
            // Use session store to get contacts (non-destructive first)
            const cleanPhone = From.replace('whatsapp:', '');
            const contacts = await store.get(`contacts:${cleanPhone}`);
            
            if (!contacts || contacts.length === 0) {
                twiml.message(`❌ No contacts to export.\n\nSend some VCF files or contact information first!`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            console.log(`📊 Generating CSV for ${contacts.length} contacts...`);
            
            // Generate CSV from contacts
            const csvStartTime = Date.now();
            const csv = generateCSV(contacts);
            const csvTime = Date.now() - csvStartTime;
            
            console.log(`📝 CSV generated in ${csvTime}ms (${(csv.length / 1024).toFixed(2)}KB)`);
            
            // Create secure file with shorter ID for WhatsApp template compatibility
            const fileId = uuidv4().replace(/-/g, '').substring(0, 16); // 16 char hex string
            console.log(`📝 Creating file with clean ID: ${fileId}`);
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                from: From,
                created: Date.now(),
                contactCount: contacts.length
            });
            
            // Send Download Template with CSV Button
            try {
                await sendDownloadTemplateMessage(From, contacts.length, fileId);
            } catch (downloadError) {
                console.error('❌ Download template failed, using TwiML fallback:', downloadError);
                
                const downloadUrl = `${BASE_URL}/get/${fileId}`;
                twiml.message(`✅ **Your CSV file with ${contacts.length} contacts is ready!**

📎 *Download CSV*
${downloadUrl}

⏰ _Link expires in 2 hours_
💡 _Ready for import!_`);
            }
            
            // Clear contacts only after successful export
            await store.del(`contacts:${cleanPhone}`);
            console.log(`🗑️ Cleared contact batch for ${cleanPhone} after successful export`);
            
        } else if (NumMedia > 0) {
            // AUTO-BATCH CONTACT PROCESSING
            console.log(`📎 ${NumMedia} contact file(s) detected - Starting auto-batch processing`);
            
            // Get existing contacts using session store (consistent with export)
            const cleanPhone = From.replace('whatsapp:', '');
            const existingContacts = await store.get(`contacts:${cleanPhone}`) || [];
            let batch = { contacts: existingContacts, count: existingContacts.length, filesProcessed: 0 };
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
                
                errorMessage += `\n\n**Supported formats:**\n📇 VCF files • 📝 Plain Text\n\n**Required:** Name or Phone number`;
                
                twiml.message(errorMessage);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Update batch totals
            batch.count = batch.contacts.length;
            batch.filesProcessed += processedFiles;
            batch.lastUpdated = Date.now();
            
            // Save contacts using session store (consistent with export)
            await store.set(`contacts:${cleanPhone}`, batch.contacts, 7200); // 2 hours
            
            // Send Status Template with Export Button (instead of TwiML)
            try {
                await sendStatusTemplateWithExportButton(From, batch);
            } catch (statusError) {
                console.error('❌ Status template failed, using TwiML fallback:', statusError);
                
                // Fallback to TwiML
                let statusMessage = `💾 *${batch.count} contacts saved so far.*`;
                
                if (processedFiles > 0) {
                    statusMessage += `\n✅ Processed ${processedFiles} file(s): +${totalNewContacts} contacts`;
                }
                
                if (failedFiles > 0) {
                    statusMessage += `\n⚠️ ${failedFiles} file(s) failed to process`;
                }
                
                const remaining = MAX_CONTACTS_PER_BATCH - batch.count;
                if (remaining > 0) {
                    statusMessage += `\n📋 *Note:* Received ${batch.count}/${MAX_CONTACTS_PER_BATCH} contacts`;
                } else {
                    statusMessage += `\n📋 *Note:* Batch limit reached (${MAX_CONTACTS_PER_BATCH}/${MAX_CONTACTS_PER_BATCH})`;
                }
                
                statusMessage += `\n\nKeep sending more contacts or type "export" when ready`;
                
                twiml.message(statusMessage);
            }
            
        } else if (Body && Body.toLowerCase() === 'help') {
            console.log(`🌟 HELP BRANCH TRIGGERED for ${From}`);
            twiml.message(`📱 **Contact Processor**

📋 **HOW TO USE:**
1. Send VCF files OR paste contact text
2. Keep sending more if needed
3. Tap "Export" button when done

📂 **Supported Formats:**
   📇 VCF files (phone contact exports)
   📝 Plain text contact information

📝 **Text Examples:**
• John Doe +2348123456789 john@example.com
• Jane Smith: 08012345678
• Bob Wilson - +44 20 7946 0958 bob@company.com

🔍 **Commands:**
• "export" - Download CSV file
• "help" - Show this message

_Ready for your contacts!_`);
            
        } else if (Body && isGreeting(Body)) {
            // Greeting detection - trigger welcome message
            console.log(`👋 GREETING DETECTED: "${Body}" from ${From}`);
            twiml.message(`✨ **Contact Processor**

I help you organize contacts into CSV files!

📱 **I work with:**
📇 VCF files (phone contact exports)
📝 Plain text contact information

Send me your contacts → Get CSV file

Type "help" for more info.`);
            
        } else if (Body && Body.toLowerCase() === 'test') {
            console.log(`🌟 TEST BRANCH TRIGGERED for ${From}`);
            const fileCount = await getActiveFileCount();
            
            twiml.message(`✅ **Contact Processor System Check Complete**

🟢 Bot: OPERATIONAL
🟢 Auto-Batching: ACTIVE
🟢 Status Template with Export Button: ${STATUS_TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}
🟢 Download Template with CSV: ${DOWNLOAD_TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}
🟢 Storage: ${redisClient ? 'REDIS OPTIMISED' : 'MEMORY'}

**Template Configuration:**
📋 Status Template SID: ${STATUS_TEMPLATE_SID || 'Not configured'}
📥 Download Template SID: ${DOWNLOAD_TEMPLATE_SID || 'Not configured'}

**Performance:**
📊 Max Contacts: ${MAX_CONTACTS_PER_BATCH}
📁 Max File Size: 20MB
⏱️ Batch Timeout: ${BATCH_TIMEOUT / 60} minutes
🗃️ Active Files: ${fileCount}

**Supported Formats:**
📇 VCF • 📝 Plain Text

_Ready for contact processing!_`);
            
        // testtemplate command removed - feature deprecated
            
        // preview command removed - feature deprecated
            
        } else if (Body && Body.trim() && (NumMedia === 0 || NumMedia === '0')) {
            // SMART BATCH CONTACT EXTRACTION WITH AUTO-SPLITTING
            console.log(`🌟 PLAIN TEXT BRANCH TRIGGERED for ${From}`);
            console.log(`🌟 Body length: ${Body.length} chars`);
            console.log(`🌟 Body preview: "${Body.substring(0, 50)}..."`);
            console.log(`🌟 NumMedia: ${NumMedia}`);
            
            // SECURITY: Validate and sanitize input
            const sanitizedBody = validateAndSanitizeTextInput(Body);
            if (!sanitizedBody) {
                twiml.message(`❌ **Invalid contact information detected.**\n\nPlease send valid contact information or VCF files.`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            console.log(`📝 Plain text message received (${sanitizedBody.length} chars)`);
            console.log(`📝 Sanitized body preview: "${sanitizedBody.substring(0, 100)}..."`);
            
            // SMART BATCH HANDLING: Check if message is too large
            const { splitContactList, isLikelyContinuation, generateSplitInstructions, generateBatchStatus, EFFECTIVE_LIMIT } = require('./src/contact-splitter');
            
            // Get existing contacts to check for continuation
            const cleanPhone = From.replace('whatsapp:', '');
            const existingContacts = await store.get(`contacts:${cleanPhone}`) || [];
            const isPartOfBatch = isLikelyContinuation(sanitizedBody, existingContacts);
            
            console.log(`📝 Message length: ${sanitizedBody.length}, Limit: ${EFFECTIVE_LIMIT}`);
            console.log(`📝 Existing contacts: ${existingContacts.length}`);
            console.log(`📝 Likely continuation: ${isPartOfBatch}`);
            
            // Handle oversized messages with smart splitting - detect WhatsApp/Twilio truncation
            // WhatsApp truncates messages at ~1600 chars, so messages close to this are likely truncated
            const LIKELY_TRUNCATED_THRESHOLD = 1200; // Conservative threshold for detection
            const contactCount = (sanitizedBody.match(/\+234\d{10}/g) || []).length;

            // Check if message appears to be truncated
            const isLikelyTruncated = sanitizedBody.length > LIKELY_TRUNCATED_THRESHOLD &&
                                    contactCount >= 10 && // Has many contacts (suggests large list)
                                    sanitizedBody.includes('+234'); // Contains Nigerian contacts

            console.log(`📝 Truncation Analysis - Length: ${sanitizedBody.length}, Contacts: ${contactCount}, Likely truncated: ${isLikelyTruncated}`);
            console.log(`📝 Message ends with: "${sanitizedBody.slice(-50)}"`);
            console.log(`📝 Threshold: ${LIKELY_TRUNCATED_THRESHOLD}, isPartOfBatch: ${isPartOfBatch}`);

            if (isLikelyTruncated && !isPartOfBatch) {
                console.log(`📦 Message too large (${sanitizedBody.length} chars), offering smart split`);
                
                const chunks = splitContactList(sanitizedBody);
                const estimatedContacts = (sanitizedBody.match(/\+234\d{10}/g) || []).length;
                
                // Store split info for user session
                await store.set(`split:${cleanPhone}`, {
                    chunks: chunks,
                    currentPart: 0,
                    totalParts: chunks.length,
                    estimatedTotal: estimatedContacts,
                    created: Date.now()
                }, 3600); // 1 hour expiry
                
                const instructions = generateSplitInstructions(chunks, estimatedContacts);
                twiml.message(instructions);
                
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            try {
                // Use enhanced text parser to extract contacts from message
                const { parseContactFile } = require('./src/csv-excel-parser');
                console.log(`📝 About to call parseContactFile with text/plain type`);
                console.log(`📝 Text input length: ${sanitizedBody.length} characters`);
                console.log(`📝 Text preview (first 200 chars): ${sanitizedBody.substring(0, 200)}`);
                
                // Add timeout protection for large text processing
                const parsePromise = parseContactFile(sanitizedBody, 'text/plain');
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Text parsing timeout after 30 seconds')), 30000)
                );
                
                const extractedContacts = await Promise.race([parsePromise, timeoutPromise]);
                
                console.log(`📝 parseContactFile completed successfully`);
                console.log(`📝 Extracted ${extractedContacts.length} contacts from plain text`);
                
                if (extractedContacts.length > 0) {
                    console.log(`📝 Contacts found, processing batch for ${From}`);
                    
                    // Append contacts to batch
                    const totalCount = await store.appendContacts(cleanPhone, extractedContacts);
                    console.log(`📝 Batch now contains ${totalCount} total contacts`);
                    
                    // Check if this is part of a guided split process
                    const splitInfo = await store.get(`split:${cleanPhone}`);
                    
                    if (splitInfo) {
                        // Update split progress
                        splitInfo.currentPart++;
                        await store.set(`split:${cleanPhone}`, splitInfo, 3600);
                        
                        console.log(`📦 Split progress: ${splitInfo.currentPart}/${splitInfo.totalParts}`);
                        
                        // Generate batch status message
                        const statusMessage = generateBatchStatus(
                            splitInfo.currentPart, 
                            splitInfo.totalParts, 
                            extractedContacts.length, 
                            totalCount
                        );
                        
                        // If not complete, provide next chunk
                        if (splitInfo.currentPart < splitInfo.totalParts) {
                            const nextChunk = splitInfo.chunks[splitInfo.currentPart];
                            const finalMessage = `${statusMessage}\n\n**Part ${splitInfo.currentPart + 1} of ${splitInfo.totalParts}:**\n${nextChunk}`;
                            twiml.message(finalMessage);
                        } else {
                            // All parts complete, clean up split session
                            await store.del(`split:${cleanPhone}`);
                            twiml.message(statusMessage);
                        }
                        
                    } else {
                        // Regular processing (not part of split)

                        // 🚨 PROACTIVE TRUNCATION CHECK - Ask if user has more contacts for large batches
                        const suspiciouslyLargeText = sanitizedBody.length > 1000;
                        const substantialContactBatch = extractedContacts.length >= 10;
                        const shouldAskForMore = suspiciouslyLargeText && substantialContactBatch;

                        console.log(`🔍 Proactive Check - TextLength: ${sanitizedBody.length}, Contacts: ${extractedContacts.length}, ShouldAsk: ${shouldAskForMore}`);

                        if (shouldAskForMore) {
                            // Send truncation warning instead of normal template
                            const truncationMessage = `⚠️ **Potential WhatsApp Truncation Detected!**

**Found:** ${extractedContacts.length} contacts from your message
**Suspicion:** Your message was ${sanitizedBody.length} characters - likely truncated by WhatsApp's 1600 char limit

**🤔 Question: Do you have MORE contacts that got cut off?**

**Options:**
✅ **Export current batch** (${totalCount} contacts total)
➕ **Add more contacts** in smaller chunks (10-15 per message)
📱 **Upload VCF file** instead for large lists

Type "export" or use buttons below!`;

                            twiml.message(truncationMessage);
                            res.type('text/xml');
                            res.send(twiml.toString());
                            return;
                        }

                        try {
                            console.log('📝 About to call sendPlainTextContactTemplate...');
                            await sendPlainTextContactTemplate(From, extractedContacts.length, extractedContacts, totalCount);
                            console.log('📝 sendPlainTextContactTemplate completed successfully');
                        } catch (templateError) {
                            console.error('📝 Plain text template failed, using TwiML fallback:', templateError);
                            console.error('📝 Template error stack:', templateError.stack);
                            
                            // Fallback to TwiML message
                            let previewMessage = `📝 **Found ${extractedContacts.length} contact(s) in your message!**\n\n`;
                            
                            // Show up to 3 contacts in preview
                            extractedContacts.slice(0, 3).forEach((contact, index) => {
                                previewMessage += `${index + 1}. **${contact.name || 'Contact'}**\n`;
                                if (contact.mobile) previewMessage += `   📱 ${contact.mobile}\n`;
                                if (contact.email) previewMessage += `   📧 ${contact.email}\n`;
                                previewMessage += `\n`;
                            });
                            
                            if (extractedContacts.length > 3) {
                                previewMessage += `... and ${extractedContacts.length - 3} more\n\n`;
                            }
                            
                            previewMessage += `💾 **Total in batch: ${totalCount} contacts**\n\n`;
                            previewMessage += `**Options:**\n`;
                            previewMessage += `📤 Type "export" to download CSV\n`;
                            previewMessage += `➕ Send more contacts to add them\n`;
                            previewMessage += `👁️ Type "preview" to see all contacts`;
                            
                            twiml.message(previewMessage);
                        }
                    }
                    
                } else {
                    // No contacts found, provide specific help for the user's format
                    console.log(`📝 No contacts parsed from ${sanitizedBody.length} character message`);
                    console.log(`📝 First 300 chars of failed message: ${sanitizedBody.substring(0, 300)}`);
                    
                    twiml.message(`📝 **I couldn't find any contacts in your ${sanitizedBody.length} character message.**\n\n**Your format looks like:** Name +234... Name +234...\n\n**I'm optimized for:**\n• Mr John Doe +2348123456789\n• Mrs Jane Smith +2347098765432\n• Contact Name +234XXXXXXXXXX\n\n**Try:**\n1. Add spaces between names and phones\n2. Use proper +234 format\n3. Send smaller batches (50-100 contacts)\n\nType "help" for more examples.`);
                }
                
            } catch (textError) {
                console.error('📝 Plain text parsing failed:', textError);
                console.error('📝 Error stack:', textError.stack);
                console.error('📝 Error message:', textError.message);
                console.error('📝 Body that caused error:', sanitizedBody.substring(0, 200));
                
                // Fallback to welcome message
                twiml.message(`✨ **Contact Processor**\n\nI help you organize contacts into CSV files!\n\n📱 **I work with:**\n📇 VCF files (phone contact exports)\n📝 Plain text contact information\n\nSend me your contacts → Get CSV file\n\nType "help" for more info.`);
            }
            
        } else {
            // Welcome message
            console.log(`🌟 WELCOME BRANCH TRIGGERED for ${From}`);
            console.log(`🌟 Body: "${Body}"`);
            console.log(`🌟 NumMedia: ${NumMedia}`);
            console.log(`🌟 Body exists: ${!!Body}`);
            console.log(`🌟 Body.trim(): "${Body?.trim()}"`);
            console.log(`🌟 NumMedia === 0: ${NumMedia === 0}`);
            
            twiml.message(`✨ **Contact Processor**

I help you organize contacts into CSV files!

📱 **I work with:**
📇 VCF files (phone contact exports)
📝 Plain text contact information

Send me your contacts → Get CSV file

Type "help" for more info.`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        
        // SECURITY: Don't expose sensitive error details to users
        const safeErrorMessage = IS_PRODUCTION 
            ? 'Processing failed. Please try again or contact support.'
            : `Processing failed: ${error.message}`;
        
        twiml.message(`❌ **System Error**

${safeErrorMessage}

Please try again or contact support.

Type "help" for assistance.`);
    }
    
    console.log('📤 About to send TwiML response...');
    console.log('📤 TwiML content:', twiml.toString());
    res.type('text/xml');
    res.send(twiml.toString());
});

// Greeting detection function
function isGreeting(message) {
    if (!message || typeof message !== 'string') {
        return false;
    }
    
    const greetings = [
        'hello', 'hi', 'hey', 'hiya', 'helo', 'hallo',
        'welcome', 'welcome message', 'welcome message?',
        'start', 'begin', 'get started', 'getting started',
        'good morning', 'good afternoon', 'good evening',
        'greetings', 'salutations', 'howdy',
        'yo', 'sup', 'whats up', "what's up",
        'morning', 'afternoon', 'evening',
        'hii', 'hiiii', 'helloooo', 'heyyyy'
    ];
    
    const cleanMessage = message.toLowerCase().trim();
    
    // Check for exact matches
    if (greetings.includes(cleanMessage)) {
        return true;
    }
    
    // Check for greetings with punctuation
    const withoutPunctuation = cleanMessage.replace(/[^\w\s]/g, '').trim();
    if (greetings.includes(withoutPunctuation)) {
        return true;
    }
    
    // Check if message starts with a greeting (for messages like "hi there" or "hello bot")
    return greetings.some(greeting => cleanMessage.startsWith(greeting + ' ') || cleanMessage.startsWith(greeting));
}

// SECURITY: File ID validation to prevent path traversal
function validateFileId(fileId) {
    if (!fileId || typeof fileId !== 'string') {
        return false;
    }
    
    // Must be a valid file ID format (16-character hex string or full UUID)
    const shortIdRegex = /^[0-9a-f]{16}$/i; // 16-char hex string
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // Full UUID
    
    if (!shortIdRegex.test(fileId) && !uuidRegex.test(fileId)) {
        console.log(`🚨 Invalid file ID format: ${fileId}`);
        return false;
    }
    
    // Additional safety checks
    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
        console.log(`🚨 Path traversal attempt detected: ${fileId}`);
        return false;
    }
    
    return true;
}

// WhatsApp-safe redirect endpoint
app.get('/get/:fileId', async (req, res) => {
    const { fileId } = req.params;
    
    // SECURITY: Validate file ID
    if (!validateFileId(fileId)) {
        return res.status(400).send('Invalid file ID');
    }
    
    console.log(`🔗 WhatsApp redirect request for file: ${fileId}`);
    res.redirect(301, `/download/${fileId}`);
});

// High-performance download endpoint with streaming
app.get('/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    
    // SECURITY: Validate file ID
    if (!validateFileId(fileId)) {
        return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Invalid Request</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                    h1 { color: #e74c3c; }
                </style>
            </head>
            <body>
                <h1>❌ Invalid File ID</h1>
                <p>The file ID provided is not valid.</p>
            </body>
            </html>
        `);
    }
    
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
                        <p><strong>Dual Template System:</strong> Export button → Download CSV button experience.</p>
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

// Enhanced health check endpoint with dual template metrics
app.get('/', async (req, res) => {
    const fileCount = await getActiveFileCount();
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Contact Processor - VCF & Text Edition</title>
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
                .templates { background: #fff3e0; }
                .green { color: #28a745; font-weight: bold; }
                .blue { color: #007bff; font-weight: bold; }
                .orange { color: #fd7e14; font-weight: bold; }
                .red { color: #dc3545; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📱 WhatsApp Contact Processor - VCF & Text Edition</h1>
                <h2>Status: ✅ OPERATIONAL</h2>
                
                <div class="status templates">
                    <h3>📋 Dual Template System</h3>
                    <div class="metric"><span>Status Template (Export Button):</span><strong class="${STATUS_TEMPLATE_SID ? 'green' : 'red'}">${STATUS_TEMPLATE_SID ? '✅ Configured' : '❌ Missing'}</strong></div>
                    <div class="metric"><span>Download Template (CSV Button):</span><strong class="${DOWNLOAD_TEMPLATE_SID ? 'green' : 'red'}">${DOWNLOAD_TEMPLATE_SID ? '✅ Configured' : '❌ Missing'}</strong></div>
                    <div class="metric"><span>Template Fallbacks:</span><strong class="green">✅ Active</strong></div>
                    <div class="metric"><span>Button Detection:</span><strong class="green">✅ Multi-format</strong></div>
                </div>
                
                <div class="status">
                    <h3>🔥 High-Performance Features</h3>
                    <div class="metric"><span>Parallel File Processing:</span><strong class="green">✅ Active</strong></div>
                    <div class="metric"><span>Memory Optimisation:</span><strong class="green">✅ Enabled</strong></div>
                    <div class="metric"><span>Chunked Storage:</span><strong class="green">✅ Large File Support</strong></div>
                    <div class="metric"><span>Universal Parser:</span><strong class="green">✅ Enhanced</strong></div>
                    <div class="metric"><span>Auto-Batching:</span><strong class="green">✅ Seamless</strong></div>
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
                    <div class="metric"><span>Access Policy:</span><strong class="green">✅ Public Access (All Users Welcome)</strong></div>
                    <div class="metric"><span>Storage Backend:</span><strong>${redisClient ? 'Redis Cloud (Optimised)' : 'In-Memory'}</strong></div>
                    <div class="metric"><span>Active Files:</span><strong>${fileCount}</strong></div>
                    <div class="metric"><span>Environment:</span><strong>${IS_PRODUCTION ? 'Production' : 'Development'}</strong></div>
                </div>
                
                <h3>📂 Supported Formats (2 Total)</h3>
                <ul>
                    <li>📇 <strong>VCF</strong> - Contact cards (optimized parsing)</li>
                    <li>📝 <strong>Plain Text</strong> - Contact information parsing (4 methods)</li>
                </ul>
                
                <h3>📋 Dual Template Configuration</h3>
                <div style="background: #f8f9fa; padding: 1rem; border-radius: 5px; font-family: monospace; margin: 1rem 0;">
                    <strong>Environment Variables Required:</strong><br>
                    STATUS_TEMPLATE_SID=${STATUS_TEMPLATE_SID || 'HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}<br>
                    DOWNLOAD_TEMPLATE_SID=${DOWNLOAD_TEMPLATE_SID || 'HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}
                </div>
                
                <h3>🖱️ Dual Template Workflow</h3>
                <ol>
                    <li><strong>Send contacts:</strong> User sends contact files via WhatsApp</li>
                    <li><strong>Status template:</strong> System sends template with Export button</li>
                    <li><strong>Tap Export:</strong> User taps Export button in template</li>
                    <li><strong>Download template:</strong> System sends template with Download CSV button</li>
                    <li><strong>Tap Download:</strong> User downloads CSV file instantly</li>
                </ol>
                
                <h3>🚀 Template Creation Guide</h3>
                <div style="background: #e8f5e8; padding: 1rem; border-radius: 5px; margin: 1rem 0;">
                    <strong>Template 1: Status with Export Button</strong><br>
                    Name: contact_status_export<br>
                    Body: 💾 *{{1}} contacts saved so far.*<br>
                    ✅ Processed {{2}} file(s)<br>
                    📋 *Note:* Received {{1}}/250 contacts <br><br>
                    Keep sending more contacts or export when ready<br>
                    Button: [Quick Reply] Export (ID: export_contacts)
                </div>
                
                <div style="background: #e1f5fe; padding: 1rem; border-radius: 5px; margin: 1rem 0;">
                    <strong>Template 2: Download CSV Button</strong><br>
                    Name: csv_export_download<br>
                    Body: ✅ Your CSV file with {{1}} contacts is ready for download!<br>
                    Button: [Visit Website] Download CSV → https://your-app.railway.app/get/{{2}}
                </div>
                
                <h3>🚀 Latest Dual Template Enhancements</h3>
                <ul>
                    <li>✅ <strong>Dual Template System:</strong> Status template → Download template</li>
                    <li>✅ <strong>Professional Button UX:</strong> Real WhatsApp template buttons</li>
                    <li>✅ <strong>Fallback Support:</strong> Text commands work if templates fail</li>
                    <li>✅ <strong>Template Detection:</strong> Handles button clicks and text commands</li>
                    <li>✅ <strong>Environment Configuration:</strong> Easy template SID management</li>
                    <li>✅ <strong>Testing Commands:</strong> Test both templates independently</li>
                    <li>✅ <strong>Auto-Collection:</strong> Seamless contact accumulation</li>
                    <li>✅ <strong>Enhanced Validation:</strong> More permissive contact acceptance</li>
                </ul>
                
                <p style="margin-top: 2rem; color: #666; text-align: center;">
                    <strong>Dual Template Edition</strong><br>
                    Built for professional WhatsApp template experience with ❤️
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
        performance_note: 'Dual template mode active'
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
    console.log('🚀 OPERATION: DUAL TEMPLATE EXPORT SYSTEM - PROFESSIONAL BUTTONS');
    console.log(`📡 Listening on PORT: ${PORT}`);
    console.log(`🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`💾 Storage: ${redisClient ? 'Redis Connected (Optimised)' : 'In-Memory Mode'}`);
    console.log(`🌐 Base URL: ${BASE_URL}`);
    console.log(`🌍 Access Policy: PUBLIC ACCESS - All users welcome!`);
    console.log(`🔒 Security: Enhanced rate limiting (20 req/15min) for public use`);
    console.log('\n📋 TEMPLATE CONFIGURATION:');
    console.log(`   📤 Status Template SID: ${STATUS_TEMPLATE_SID || 'NOT CONFIGURED'}`);
    console.log(`   📥 Download Template SID: ${DOWNLOAD_TEMPLATE_SID || 'NOT CONFIGURED'}`);
    console.log('\n🖱️ DUAL TEMPLATE FEATURES:');
    console.log('   ⚡ Professional WhatsApp template buttons');
    console.log('   📊 Status template with Export button');
    console.log('   🔄 Download template with CSV button');
    console.log('   📱 Dual template workflow experience');
    console.log('   💾 Memory optimisation with chunked storage');
    console.log('   ⏱️ Extended batch timeout: 20 minutes');
    console.log('   📁 Large file support: up to 20MB');
    console.log('   🔄 Enhanced error handling and recovery');
    console.log('   ✅ Enhanced validation: accepts name OR phone OR email');
    console.log('   📁 Supported: VCF, Plain Text');
    console.log('\n📋 Dual template webhook ready at: POST /webhook');
    console.log('💡 Professional UX: Status template → Download template!');
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

// Debug endpoints removed - features deprecated

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});