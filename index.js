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
                    twiml.message(`❌ No contacts found in the file.\n\nSupported formats: VCF, CSV, Excel, PDF, Text\nRequired: Name or Phone number`);
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
                twiml.message(`💾 ${batch.count} saved so far.\n\nTap 1️⃣ to export • 2️⃣ to keep adding`);
                
            } catch (parseError) {
                console.error('❌ File parsing error:', parseError);
                twiml.message(`❌ Could not parse file: ${parseError.message}\n\nSupported formats:\n📇 VCF (contacts)\n📊 CSV files\n📗 Excel (.xlsx, .xls)\n📄 PDF documents\n📝 Text files\n\nRequired: Name or Phone number`);
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
            twiml.message(`📨 Drop your contact files—let's bulk-load them! 🚀\n\n📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text supported`);
            
        } else {
            // Any other message - prompt for contact files
            twiml.message(`📨 Drop your contact files—let's bulk-load them! 🚀\n\n📇 VCF • 📊 CSV • 📗 Excel • 📄 PDF • 📝 Text\n\nType 'help' for instructions`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ Operation failed. Please try again.\n\nIf the problem persists, contact support.`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
