// src/csv-excel-parser.js - Simplified Contact Parser
// Supports VCF files and plain text contact parsing only

// Production-aware logging
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const log = (...args) => {
    if (!IS_PRODUCTION) {
        console.log(...args);
    }
};
const logError = (...args) => {
    if (!IS_PRODUCTION) {
        console.error(...args);
    } else {
        // Only log sanitized error messages in production
        console.error('Parser error occurred');
    }
};

// Main parsing function - supports VCF files and plain text only
async function parseContactFile(fileContent, mediaType = '') {
    try {
        log(`🔍 Processing file type: ${mediaType}`);
        log(`📏 File size: ${Buffer.isBuffer(fileContent) ? fileContent.length : fileContent.length} bytes`);
        
        // Convert buffer to string for text-based formats
        let content = fileContent;
        if (Buffer.isBuffer(fileContent)) {
            content = fileContent.toString('utf8');
        }
        
        // VCF files - primary format
        if (mediaType.includes('vcard') || mediaType.includes('text/x-vcard') || 
            content.includes('BEGIN:VCARD')) {
            log('📇 Parsing as VCF format');
            const { parseVCF } = require('./vcf-parser');
            return parseVCF(content);
        }
        
        // Text files - plain text contact parsing
        if (mediaType.includes('text/plain') || mediaType.includes('text/') || 
            (!mediaType && typeof content === 'string')) {
            log('📝 Parsing as plain text contacts');
            return parseTextContacts(content);
        }
        
        // Reject unsupported formats
        if (mediaType.includes('csv') || mediaType.includes('excel') || 
            mediaType.includes('pdf') || mediaType.includes('spreadsheet') ||
            mediaType.includes('vnd.ms-excel') || mediaType.includes('officedocument')) {
            throw new Error('Unsupported file format. Please send VCF files or paste contact text.');
        }
        
        // Auto-detection for unknown formats
        log('🔄 Unknown format, attempting detection...');
        
        // Check for VCF patterns
        if (content.includes('BEGIN:VCARD') || content.includes('VCARD')) {
            log('🔍 Auto-detected VCF content');
            const { parseVCF } = require('./vcf-parser');
            return parseVCF(content);
        }
        
        // Fallback to text parsing
        log('🔍 Fallback to text parsing');
        return parseTextContacts(content);
        
    } catch (error) {
        logError('❌ Parse error:', error);
        
        // Only attempt text parsing fallback for supported formats
        if (!error.message.includes('Unsupported file format')) {
            try {
                const textContent = Buffer.isBuffer(fileContent) ? fileContent.toString('utf8') : fileContent;
                log('🆘 Text parsing fallback...');
                return parseTextContacts(textContent);
            } catch (finalError) {
                logError('💥 Text parsing failed:', finalError);
                return [];
            }
        }
        
        // Re-throw unsupported format errors
        throw error;
    }
}

// ENHANCED TEXT PARSING FUNCTION - Multiple detection methods
function parseTextContacts(textContent) {
    const contacts = [];
    
    try {
        log('📝 Starting enhanced text parsing...');
        
        if (!textContent || typeof textContent !== 'string') {
            log('📝 Invalid text content');
            return contacts;
        }
        
        log(`📝 Text length: ${textContent.length} characters`);
        
        // Enhanced regex patterns
        const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;
        const phonePattern = /(?:\+?234|0)?[789]\d{9,10}|\+?\d{10,15}/g;
        const namePattern = /^[A-Z][a-zA-Z\s]{2,40}$/gm;
        
        // Method 1: Look for structured contact blocks
        log('📝 Method 1: Searching for structured contact blocks...');
        const contactBlockPattern = /(?:name|contact)[\s:]*([^\n\r]+)[\s\S]*?(?:phone|mobile|tel)[\s:]*([^\n\r]+)[\s\S]*?(?:email|mail)[\s:]*([^\n\r]+)/gi;
        
        let match;
        let blockCount = 0;
        while ((match = contactBlockPattern.exec(textContent)) !== null && blockCount < 100) {
            const contact = {
                name: cleanText(match[1]),
                mobile: cleanPhoneNumber(match[2]),
                email: cleanText(match[3]),
                passes: 1
            };
            
            if (contact.name || contact.mobile) {
                contacts.push(contact);
                blockCount++;
            }
        }
        log(`📝 Method 1 found: ${contacts.length} contacts`);
        
        // Method 2: Optimized parsing for "Name +phone" format (your exact format)
        if (contacts.length === 0) {
            log('📝 Method 2: Optimized parsing for Name +phone format...');
            
            // Split on common patterns for your format: "Name +234... Name2 +234..."
            const namePhonePattern = /([A-Za-z\s&\.]+?)\s+(\+234\d{10})/g;
            let match;
            let parseCount = 0;
            
            while ((match = namePhonePattern.exec(textContent)) !== null && parseCount < 1000) {
                const name = match[1].trim().replace(/^(Mr|Mrs|Miss|Dr|Prof)\.?\s*/i, '').trim();
                const phone = match[2];
                
                if (name && phone) {
                    const contact = {
                        name: name,
                        mobile: cleanPhoneNumber(phone),
                        email: '',
                        passes: 1
                    };
                    
                    if (contact.name && contact.mobile) {
                        contacts.push(contact);
                        parseCount++;
                    }
                }
            }
            log(`📝 Method 2 found: ${contacts.length} contacts using optimized parsing`);
            
            // Fallback to line analysis if optimized parsing fails
            if (contacts.length === 0) {
                log('📝 Method 2b: Fallback line-by-line analysis...');
                const lines = textContent.split(/[\n\r]+/).filter(line => line.trim().length > 3);
                log(`📝 Analyzing ${lines.length} lines`);
                
                for (const line of lines) {
                    const emailMatch = line.match(emailPattern);
                    const phoneMatch = line.match(phonePattern);
                    
                    if (emailMatch || phoneMatch) {
                        // Extract name from line
                        let name = line
                            .replace(emailPattern, '')
                            .replace(phonePattern, '')
                            .replace(/[^\w\s]/g, ' ')
                            .trim();
                        
                        // Clean up name
                        const nameWords = name.split(/\s+/).filter(word => 
                            word.length > 1 && 
                            /^[A-Za-z]/.test(word) && 
                            !['phone', 'email', 'contact', 'mobile', 'tel', 'call', 'mail'].includes(word.toLowerCase())
                        );
                        
                        if (nameWords.length > 0) {
                            name = nameWords.slice(0, 3).join(' '); // Max 3 words for name
                        } else {
                            name = 'Contact';
                        }
                        
                        const contact = {
                            name: name,
                            mobile: phoneMatch ? cleanPhoneNumber(phoneMatch[0]) : '',
                            email: emailMatch ? emailMatch[0] : '',
                            passes: 1
                        };
                        
                        if (contact.mobile || contact.email) {
                            contacts.push(contact);
                        }
                    }
                }
                log(`📝 Method 2b found: ${contacts.length} contacts`);
            }
        }
        
        // Method 3: Extract all patterns and try to match them intelligently
        if (contacts.length === 0) {
            log('📝 Method 3: Pattern extraction and matching...');
            const emails = [...textContent.matchAll(emailPattern)].map(m => m[0]);
            const phones = [...textContent.matchAll(phonePattern)].map(m => m[0]);
            const names = [...textContent.matchAll(namePattern)].map(m => m[0]);
            
            log(`📝 Found patterns: ${emails.length} emails, ${phones.length} phones, ${names.length} names`);
            
            const cleanPhones = phones.map(phone => cleanPhoneNumber(phone)).filter(p => p);
            const maxItems = Math.max(emails.length, cleanPhones.length, names.length);
            
            for (let i = 0; i < maxItems; i++) {
                const contact = {
                    name: names[i] || `Contact ${i + 1}`,
                    mobile: cleanPhones[i] || '',
                    email: emails[i] || '',
                    passes: 1
                };
                
                if (contact.mobile || contact.email) {
                    contacts.push(contact);
                }
            }
            log(`📝 Method 3 found: ${contacts.length} contacts`);
        }
        
        // Method 4: Advanced pattern recognition for unstructured text
        if (contacts.length === 0) {
            log('📝 Method 4: Advanced pattern recognition...');
            
            // Look for common contact formats
            const advancedPatterns = [
                // Name followed by phone
                /([A-Z][a-zA-Z\s]{2,30})\s*[:\-]?\s*(\+?[\d\s\-\(\)]{8,20})/g,
                // Phone followed by name
                /(\+?[\d\s\-\(\)]{8,20})\s*[:\-]?\s*([A-Z][a-zA-Z\s]{2,30})/g,
                // Email with possible name
                /([A-Z][a-zA-Z\s]{2,30})\s*[:\-]?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
            ];
            
            for (const pattern of advancedPatterns) {
                let match;
                while ((match = pattern.exec(textContent)) !== null) {
                    const isNameFirst = /^[A-Z][a-zA-Z\s]/.test(match[1]);
                    const contact = {
                        name: isNameFirst ? match[1].trim() : match[2].trim(),
                        mobile: isNameFirst ? cleanPhoneNumber(match[2]) : cleanPhoneNumber(match[1]),
                        email: match[2].includes('@') ? match[2] : '',
                        passes: 1
                    };
                    
                    if ((contact.name && contact.name !== 'Contact') || contact.mobile || contact.email) {
                        contacts.push(contact);
                    }
                }
            }
            log(`📝 Method 4 found: ${contacts.length} contacts`);
        }
        
        // Remove duplicates based on phone or email
        const unique = [];
        const seen = new Set();
        
        for (const contact of contacts) {
            const key = contact.mobile || contact.email || contact.name;
            if (key && !seen.has(key)) {
                seen.add(key);
                unique.push(contact);
            }
        }
        
        log(`📝 Text parsing complete: ${unique.length} unique contacts extracted`);
        return unique;
        
    } catch (error) {
        logError('📝 Text parsing failed:', error);
        return [];
    }
}

// Helper functions for text parsing
function cleanText(text) {
    if (!text) return '';
    return text.trim().replace(/[^\w\s@.-]/g, '').replace(/\s+/g, ' ');
}

function cleanPhoneNumber(phone) {
    if (!phone) return '';
    
    // Remove all non-digit characters except +
    let clean = phone.replace(/[^\d+]/g, '');
    
    // Skip if too short or too long
    if (clean.length < 8 || clean.length > 15) return '';
    
    // Nigerian number formatting
    if (clean.match(/^0[789]\d{9}$/)) {
        return '+234' + clean.substring(1);
    }
    if (clean.match(/^234[789]\d{9}$/)) {
        return '+' + clean;
    }
    if (clean.match(/^[789]\d{9}$/)) {
        return '+234' + clean;
    }
    
    // International formatting
    if (!clean.startsWith('+') && clean.length >= 10) {
        return '+' + clean;
    }
    
    return clean;
}

// CSV parsing removed - only VCF and text parsing supported

// CSV parsing functions removed - only VCF and text parsing supported

// Excel parsing removed - only VCF and text parsing supported

// PDF parsing removed - only VCF and text parsing supported

// Get supported formats for help messages
function getSupportedFormats() {
    return {
        formats: [
            { name: 'VCF', description: 'Contact cards from phones', extensions: ['.vcf'] },
            { name: 'Text', description: 'Plain text with contact information', extensions: ['.txt'] }
        ],
        mimeTypes: [
            'text/vcard',
            'text/x-vcard',
            'text/plain'
        ]
    };
}

// Export functions
module.exports = {
    parseContactFile,
    parseTextContacts,
    getSupportedFormats,
    cleanPhoneNumber,
    cleanText
};