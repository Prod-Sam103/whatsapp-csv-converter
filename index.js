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
    const maxRequests = 100; // 100 requests per window
    
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
    '+2349065729552', // New authorized number
    '+2348132474537'  // New authorized number
];

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

// Check if number is authorized for testing
function isAuthorizedNumber(phoneNumber) {
    const cleanNumber = phoneNumber.replace('whatsapp:', '');
    return AUTHORIZED_NUMBERS.includes(cleanNumber);
}

// SECURITY: Input validation and sanitization function
function validateAndSanitizeTextInput(input) {
    if (!input || typeof input !== 'string') {
        return null;
    }
    
    // Length limits to prevent DoS
    const MAX_TEXT_LENGTH = 10000; // 10KB max text message
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

// Plain Text Contact Template with Action Buttons
async function sendPlainTextContactTemplate(to, contactCount, contacts, totalCount) {
    const TEMPLATE_SID = process.env.PLAINTEXT_TEMPLATE_SID || 'HX...'; // Set this in Vercel env
    
    if (!TEMPLATE_SID || TEMPLATE_SID === 'HX...') {
        throw new Error('Plain text template SID not configured');
    }
    
    // Initialize Twilio client
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Build contact preview (up to 3 contacts)
    let contactPreview = '';
    contacts.slice(0, 3).forEach((contact, index) => {
        contactPreview += `${index + 1}. *${contact.name || 'Contact'}*\n`;
        if (contact.mobile) contactPreview += `   📱 ${contact.mobile}\n`;
        if (contact.email) contactPreview += `   📧 ${contact.email}\n`;
        contactPreview += `\n`;
    });
    
    if (contacts.length > 3) {
        contactPreview += `... and ${contacts.length - 3} more\n`;
    }
    
    const fromNumber = process.env.TWILIO_PHONE_NUMBER?.replace('whatsapp:', '') || '';
    
    console.log(`🚀 Sending plain text template - Count: ${contactCount}, Total: ${totalCount}`);
    console.log(`🚀 Attempting Plain Text Contact Template with Action Buttons...`);
    
    await client.messages.create({
        from: `whatsapp:${fromNumber}`,
        to: to,
        messagingServiceSid: undefined,
        contentSid: TEMPLATE_SID,
        contentVariables: JSON.stringify({
            "1": contactCount.toString(),
            "2": contactPreview.trim(),
            "3": totalCount.toString()
        })
    });
    
    console.log('✅ Plain text contact template with action buttons sent successfully!');
}

// Template 1: Status Message with Export Button
async function sendStatusTemplateWithExportButton(to, batch) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = '+16466030424';
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
    const fromNumber = '+16466030424';
    
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
        
        // Handle Add More button - encourage sending more contacts
        if (ButtonPayload === 'add_more_contacts' || 
            ButtonText === 'Add More') {
            
            console.log(`🌟 ADD MORE BRANCH TRIGGERED for ${From}`);
            const cleanPhone = From.replace('whatsapp:', '');
            const contacts = await store.get(`contacts:${cleanPhone}`) || [];
            
            const contactCount = contacts.length;
            const contactWord = contactCount === 1 ? 'contact' : 'contacts';
            
            twiml.message(`📝 **Great! You have ${contactCount} ${contactWord} ready for export.**

**Keep adding more contacts:**
• Send contact files (VCF, CSV, Excel, PDF, DOCX)
• Send plain text with contact details
• Mix and match - system auto-batches everything!

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
            
            // Use session store to get and clear contacts
            const cleanPhone = From.replace('whatsapp:', '');
            const contacts = await store.popContacts(cleanPhone);
            
            if (!contacts || contacts.length === 0) {
                twiml.message(`❌ No contacts to export.\n\nSend some contact files first!`);
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
            
            // Create secure file with clean UUID
            const fileId = uuidv4();
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
💡 _Tap the link above to download your file_`);
            }
            
            // Batch is already cleared by popContacts()
            
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
            twiml.message(`🎖️ **WhatsApp CSV Converter**

📋 **HOW TO USE:**
1. Send your contact files OR plain text
2. Keep sending more if needed
3. Tap "Export" button when done

📂 **Supported Formats:**
   📇 VCF (phone contacts)
   📊 CSV
   📗 Excel
   📄 PDF
   📝 Plain Text Messages
   📘 DOCX

⚡ **FEATURES:**
✅ Auto-batching system
✅ Up to 250 contacts per batch
✅ Interactive Export & Download buttons
✅ Plain text contact extraction
✅ Works with iPhone & Android

💡 **TIPS:**
• Send multiple files at once
• WhatsApp sends 10 files max per message
• Just keep sending - system auto-batches
• Tap "Export" button to download CSV

📝 **Plain Text Examples:**
• John Doe +2348123456789 john@example.com
• Jane Smith: 08012345678
• Bob Wilson - +44 20 7946 0958 bob@company.com

🔍 **Commands:**
• "export" - Download CSV file
• "preview" - See all contacts in batch
• "help" - Show this message

_Ready for your contacts!_`);
            
        } else if (Body && Body.toLowerCase() === 'test') {
            console.log(`🌟 TEST BRANCH TRIGGERED for ${From}`);
            const fileCount = await getActiveFileCount();
            
            twiml.message(`✅ **Dual Template Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Auto-Batching: ACTIVE
🟢 Status Template with Export Button: ${STATUS_TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}
🟢 Download Template with CSV Button: ${DOWNLOAD_TEMPLATE_SID ? 'CONFIGURED' : 'NOT SET'}
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
📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text • 📘 DOCX

_Dual template system ready!_`);
            
        } else if (Body && Body.toLowerCase() === 'testtemplate') {
            console.log(`🌟 TESTTEMPLATE BRANCH TRIGGERED for ${From}`);
            // Test both templates
            try {
                const testFileId = 'test-' + Date.now();
                const testBatch = { count: 42, filesProcessed: 3, contacts: [] };
                
                console.log('🧪 Testing Status Template...');
                await sendStatusTemplateWithExportButton(From, testBatch);
                
                console.log('🧪 Testing Download Template...');
                await sendDownloadTemplateMessage(From, 42, testFileId);
                
                twiml.message('✅ Both templates tested! Check above for Export and Download buttons.');
            } catch (error) {
                twiml.message(`❌ Template test failed: ${error.message}`);
            }
            
        } else if (Body && Body.toLowerCase() === 'preview' || 
                   ButtonPayload === 'preview_contacts' ||
                   ButtonText === '👁️ Preview All') {
            // PREVIEW BATCH CONTENTS using session store
            console.log(`🌟 PREVIEW BRANCH TRIGGERED for ${From}`);
            const cleanPhone = From.replace('whatsapp:', '');
            const contacts = await store.get(`contacts:${cleanPhone}`) || [];
            
            if (contacts.length === 0) {
                twiml.message(`📝 **No contacts in your batch yet.**\n\nSend contact files or plain text messages with contact details to get started!`);
            } else {
                let previewMessage = `📋 **Batch Preview (${contacts.length} contacts):**\n\n`;
                
                // Show all contacts (limit to 20 for WhatsApp message limits)
                const contactsToShow = contacts.slice(0, 20);
                contactsToShow.forEach((contact, index) => {
                    previewMessage += `${index + 1}. **${contact.name || 'Contact'}**\n`;
                    if (contact.mobile) previewMessage += `   📱 ${contact.mobile}\n`;
                    if (contact.email) previewMessage += `   📧 ${contact.email}\n`;
                    previewMessage += `\n`;
                });
                
                if (contacts.length > 20) {
                    previewMessage += `... and ${contacts.length - 20} more contacts\n\n`;
                }
                
                previewMessage += `📤 Type "export" to download CSV\n`;
                previewMessage += `➕ Send more contacts to add them`;
                
                twiml.message(previewMessage);
            }
            
        } else if (Body && Body.trim() && (NumMedia === 0 || NumMedia === '0')) {
            // PLAIN TEXT CONTACT EXTRACTION
            console.log(`🌟 PLAIN TEXT BRANCH TRIGGERED for ${From}`);
            console.log(`🌟 Body: "${Body.substring(0, 50)}..."`);
            console.log(`🌟 NumMedia: ${NumMedia}`);
            
            // SECURITY: Validate and sanitize input
            const sanitizedBody = validateAndSanitizeTextInput(Body);
            if (!sanitizedBody) {
                twiml.message(`❌ **Invalid input detected.**\n\nPlease send valid contact information or files.`);
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            console.log(`📝 Plain text message received (${sanitizedBody.length} chars)`);
            console.log(`📝 Sanitized body preview: "${sanitizedBody.substring(0, 100)}..."`);
            
            try {
                // Use enhanced text parser to extract contacts from message
                const { parseContactFile } = require('./src/csv-excel-parser');
                console.log(`📝 About to call parseContactFile with text/plain type`);
                
                const extractedContacts = await parseContactFile(sanitizedBody, 'text/plain');
                
                console.log(`📝 parseContactFile completed successfully`);
                console.log(`📝 Extracted ${extractedContacts.length} contacts from plain text`);
                
                if (extractedContacts.length > 0) {
                    console.log(`📝 Contacts found, processing batch for ${From}`);
                    
                    // Use session store to append contacts (handles batching automatically)
                    const cleanPhone = From.replace('whatsapp:', '');
                    console.log(`📝 Adding ${extractedContacts.length} contacts to batch for ${cleanPhone}`);
                    
                    console.log(`📝 About to call store.appendContacts with phone: ${cleanPhone}`);
                    console.log(`📝 Contacts to append:`, extractedContacts);
                    
                    const totalCount = await store.appendContacts(cleanPhone, extractedContacts);
                    console.log(`📝 store.appendContacts returned: ${totalCount}`);
                    console.log(`📝 Batch now contains ${totalCount} total contacts`);
                    
                    // Verify contacts were saved
                    const verification = await store.get(`contacts:${cleanPhone}`);
                    console.log(`📝 Verification check: ${verification ? verification.length : 'null'} contacts found`);
                    
                    // Send interactive template with buttons or fallback
                    try {
                        await sendPlainTextContactTemplate(From, extractedContacts.length, extractedContacts, totalCount);
                    } catch (templateError) {
                        console.error('📝 Plain text template failed, using TwiML fallback:', templateError);
                        
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
                    
                } else {
                    // No contacts found, but be helpful
                    twiml.message(`📝 **No contacts detected in your message.**\n\n**Examples of supported formats:**\n• John Doe +2348123456789 john@example.com\n• Jane Smith: 08012345678\n• Bob Wilson - +44 20 7946 0958 bob@company.com\n\n**Or send contact files directly!**\n\nType "help" for more info.`);
                }
                
            } catch (textError) {
                console.error('📝 Plain text parsing failed:', textError);
                console.error('📝 Error stack:', textError.stack);
                console.error('📝 Error message:', textError.message);
                console.error('📝 Body that caused error:', sanitizedBody.substring(0, 200));
                
                // Fallback to welcome message
                twiml.message(`👋 **Welcome to Contact Converter!**\n\nSend your contact files or plain text with contact details!\n\n📱 Works with: iPhone contacts, Android contacts, Excel files\n⚡ Enhanced text parsing for event planners\n\n💡 Just send your contacts and tap "Export" when done!\n\nType "help" for more info.`);
            }
            
        } else {
            // Welcome message
            console.log(`🌟 WELCOME BRANCH TRIGGERED for ${From}`);
            console.log(`🌟 Body: "${Body}"`);
            console.log(`🌟 NumMedia: ${NumMedia}`);
            console.log(`🌟 Body exists: ${!!Body}`);
            console.log(`🌟 Body.trim(): "${Body?.trim()}"`);
            console.log(`🌟 NumMedia === 0: ${NumMedia === 0}`);
            
            twiml.message(`👋 **Welcome to Contact Converter!**

Send your contact files for instant CSV conversion! 

📱 Works with: iPhone contacts, Android contacts, Excel files
⚡ Dual template system with Export & Download buttons
📝 Enhanced text parsing for plain text contacts

💡 Just send your contacts and tap "Export" when done!

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
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// SECURITY: File ID validation to prevent path traversal
function validateFileId(fileId) {
    if (!fileId || typeof fileId !== 'string') {
        return false;
    }
    
    // Must be a valid UUID format (36 characters with dashes)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(fileId)) {
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
            <title>WhatsApp CSV Converter - Dual Template Edition</title>
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
                <h1>🚀 WhatsApp CSV Converter - Dual Template Edition</h1>
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
    console.log(`👥 Authorized Numbers: ${AUTHORIZED_NUMBERS.length}`);
    console.log('   - +2348121364213 (Primary)');
    console.log('   - +2347061240799 (Secondary)');
    console.log('   - +2347034988523 (Tertiary)');
    console.log('   - +2348132474537 (Quaternary)');
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
    console.log('   📁 Supported: VCF, CSV, Excel, PDF, Text, DOCX');
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

// Debug endpoints for troubleshooting
app.get('/test-store', async (req, res) => {
    const testPhone = '1234567890';
    const testContacts = [
        { name: 'Test User', mobile: '+1234567890', email: 'test@example.com' }
    ];
    
    try {
        console.log('🧪 TEST-STORE: Starting store test');
        
        // Test store operations
        const count = await store.appendContacts(testPhone, testContacts);
        console.log('🧪 TEST-STORE: Append result:', count);
        
        const retrieved = await store.get(`contacts:${testPhone}`);
        console.log('🧪 TEST-STORE: Retrieved:', retrieved?.length || 0);
        
        const popped = await store.popContacts(testPhone);
        console.log('🧪 TEST-STORE: Popped:', popped?.length || 0);
        
        res.json({
            success: true,
            appendResult: count,
            retrievedCount: retrieved?.length || 0,
            poppedCount: popped?.length || 0,
            storageType: store.redis ? 'Redis' : 'Memory',
            redisConnected: !!store.redis
        });
    } catch (error) {
        console.log('🧪 TEST-STORE: Error:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Debug endpoint to show current storage state
app.get('/debug-storage/:phone', async (req, res) => {
    const phone = req.params.phone.replace('whatsapp:', '');
    try {
        const contacts = await store.get(`contacts:${phone}`);
        res.json({
            phone: phone,
            contactCount: contacts?.length || 0,
            contacts: contacts || [],
            storageType: store.redis ? 'Redis' : 'Memory'
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});