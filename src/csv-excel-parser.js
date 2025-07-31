// src/csv-excel-parser.js - Universal Contact File Parser V2
// Enhanced with multi-format support and improved text parsing

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

// Main parsing function - routes to appropriate parser based on content type
async function parseContactFile(fileContent, mediaType = '') {
    try {
        log(`🔍 Processing file type: ${mediaType}`);
        log(`📏 File size: ${Buffer.isBuffer(fileContent) ? fileContent.length : fileContent.length} bytes`);
        
        // Convert buffer to string for text-based formats
        let content = fileContent;
        if (Buffer.isBuffer(fileContent)) {
            content = fileContent.toString('utf8');
        }
        
        // VCF files - highest priority detection
        if (mediaType.includes('vcard') || mediaType.includes('text/x-vcard') || 
            content.includes('BEGIN:VCARD')) {
            log('📇 Parsing as VCF format');
            const { parseVCF } = require('./vcf-parser');
            return parseVCF(content);
        }
        
        // CSV files
        if (mediaType.includes('csv') || mediaType.includes('application/csv') ||
            (content.includes(',') && (content.toLowerCase().includes('name') || 
             content.toLowerCase().includes('phone') || content.toLowerCase().includes('email')))) {
            log('📊 Parsing as CSV format');
            return parseCSV(content);
        }
        
        // Excel files
        if (mediaType.includes('excel') || mediaType.includes('spreadsheet') || 
            mediaType.includes('vnd.ms-excel') || mediaType.includes('officedocument.spreadsheetml')) {
            log('📗 Parsing as Excel format');
            return parseExcel(fileContent); // Pass original buffer for Excel
        }
        
        // PDF files
        if (mediaType.includes('pdf')) {
            log('📄 Parsing as PDF format');
            return await parsePDF(fileContent); // Pass original buffer for PDF
        }
        
        // Text files - ENHANCED VERSION
        if (mediaType.includes('text/plain') || mediaType.includes('text/') || 
            (!mediaType && typeof content === 'string')) {
            log('📝 Parsing as Text format');
            return parseTextContacts(content);
        }
        
        // Auto-detection for unknown formats
        log('🔄 Unknown format, attempting intelligent detection...');
        
        // Check for VCF patterns
        if (content.includes('BEGIN:VCARD') || content.includes('VCARD')) {
            log('🔍 Auto-detected VCF content');
            const { parseVCF } = require('./vcf-parser');
            return parseVCF(content);
        }
        
        // Check for CSV patterns
        if (content.includes(',') && (content.includes('@') || content.match(/\d{3,}/))) {
            log('🔍 Auto-detected CSV content');
            return parseCSV(content);
        }
        
        // Fallback to text parsing for everything else
        log('🔍 Fallback to enhanced text parsing');
        return parseTextContacts(content);
        
    } catch (error) {
        logError('❌ Parse error:', error);
        
        // Final fallback to text parsing
        try {
            const textContent = Buffer.isBuffer(fileContent) ? fileContent.toString('utf8') : fileContent;
            log('🆘 Emergency text parsing fallback...');
            return parseTextContacts(textContent);
        } catch (finalError) {
            logError('💥 All parsing methods failed:', finalError);
            return [];
        }
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
        
        // Method 2: Line-by-line analysis if no blocks found
        if (contacts.length === 0) {
            log('📝 Method 2: Line-by-line analysis...');
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
            log(`📝 Method 2 found: ${contacts.length} contacts`);
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

// CSV parsing function
function parseCSV(csvContent) {
    const contacts = [];
    
    try {
        log('📊 Starting CSV parsing...');
        const lines = csvContent.split('\n').filter(line => line.trim());
        
        if (lines.length < 2) {
            log('📊 CSV too short, no data rows found');
            return contacts;
        }
        
        // Parse headers intelligently
        const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/"/g, ''));
        log('📊 CSV headers detected:', headers);
        
        // Find column indices intelligently
        const nameIndex = headers.findIndex(h => 
            h.includes('name') || h.includes('contact') || h.includes('person') || h.includes('full')
        );
        const phoneIndex = headers.findIndex(h => 
            h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('tel') || h.includes('cell')
        );
        const emailIndex = headers.findIndex(h => 
            h.includes('email') || h.includes('mail') || h.includes('@')
        );
        
        log(`📊 Column mapping: name=${nameIndex}, phone=${phoneIndex}, email=${emailIndex}`);
        
        // Parse data rows
        for (let i = 1; i < lines.length; i++) {
            try {
                const values = parseCSVLine(lines[i]);
                
                const contact = {
                    name: nameIndex >= 0 && values[nameIndex] ? values[nameIndex].trim() : '',
                    mobile: phoneIndex >= 0 && values[phoneIndex] ? cleanPhoneNumber(values[phoneIndex].trim()) : '',
                    email: emailIndex >= 0 && values[emailIndex] ? values[emailIndex].trim() : '',
                    passes: 1
                };
                
                // Only add if we have meaningful data
                if (contact.name || contact.mobile) {
                    contacts.push(contact);
                }
            } catch (rowError) {
                logError(`📊 Error parsing CSV row ${i}:`, rowError);
                continue;
            }
        }
        
        log(`📊 CSV parsed successfully: ${contacts.length} contacts extracted`);
        return contacts;
        
    } catch (error) {
        logError('📊 CSV parsing failed:', error);
        return [];
    }
}

// Helper to properly parse CSV lines with quotes and commas
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                // Escaped quote
                current += '"';
                i++; // Skip next quote
            } else {
                // Toggle quote state
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // End of field
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    // Add final field
    values.push(current);
    
    return values.map(v => v.trim());
}

// Excel parsing function (requires xlsx package)
function parseExcel(excelBuffer) {
    try {
        log('📗 Starting Excel parsing...');
        
        // SECURITY: Input validation and size limits
        if (!Buffer.isBuffer(excelBuffer)) {
            throw new Error('Invalid Excel buffer provided');
        }
        
        const bufferSize = excelBuffer.length;
        const MAX_EXCEL_SIZE = 20 * 1024 * 1024; // 20MB limit
        
        if (bufferSize > MAX_EXCEL_SIZE) {
            throw new Error(`Excel file too large: ${Math.round(bufferSize / 1024 / 1024)}MB (max: 20MB)`);
        }
        
        log(`📗 Excel buffer size: ${Math.round(bufferSize / 1024)}KB`);
        
        const XLSX = require('xlsx');
        
        // SECURITY: Safe reading with limited options to prevent prototype pollution
        const workbook = XLSX.read(excelBuffer, { 
            type: 'buffer',
            cellText: false,      // Disable cell text processing to reduce attack surface
            cellFormula: false,   // Disable formula processing for security
            cellHTML: false,      // Disable HTML processing
            sheetRows: 1000,      // Limit rows to prevent DoS
            bookSheets: true,     // Only process actual sheets
            bookProps: false,     // Disable book properties to reduce attack surface
            cellDates: false      // Disable date processing
        });
        
        // SECURITY: Validate workbook structure
        if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('Invalid or empty Excel workbook');
        }
        
        // SECURITY: Limit number of sheets to process (prevent DoS)
        const MAX_SHEETS = 5;
        if (workbook.SheetNames.length > MAX_SHEETS) {
            log(`📗 Limiting to first ${MAX_SHEETS} sheets (found ${workbook.SheetNames.length})`);
            workbook.SheetNames = workbook.SheetNames.slice(0, MAX_SHEETS);
        }
        
        // Get first worksheet
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // SECURITY: Validate worksheet
        if (!worksheet) {
            throw new Error(`Worksheet '${sheetName}' not found or invalid`);
        }
        
        log(`📗 Reading sheet: ${sheetName}`);
        
        // SECURITY: Convert to JSON with safe options
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
            header: 1,
            raw: false,           // Convert all values to strings for safety
            defval: '',           // Default value for empty cells
            range: undefined      // Use default range (prevents range manipulation attacks)
        });
        
        if (jsonData.length < 2) {
            log('📗 Excel sheet too short, no data rows found');
            return [];
        }
        
        // Parse headers (first row)
        const headers = jsonData[0].map(h => (h || '').toString().toLowerCase().trim());
        log('📗 Excel headers detected:', headers);
        
        // Find column indices
        const nameIndex = headers.findIndex(h => 
            h.includes('name') || h.includes('contact') || h.includes('person') || h.includes('full')
        );
        const phoneIndex = headers.findIndex(h => 
            h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('tel') || h.includes('cell')
        );
        const emailIndex = headers.findIndex(h => 
            h.includes('email') || h.includes('mail') || h.includes('@')
        );
        
        log(`📗 Column mapping: name=${nameIndex}, phone=${phoneIndex}, email=${emailIndex}`);
        
        const contacts = [];
        
        // Parse data rows
        for (let i = 1; i < jsonData.length; i++) {
            const row = jsonData[i];
            
            if (!row || row.length === 0) continue;
            
            try {
                const contact = {
                    name: nameIndex >= 0 && row[nameIndex] ? row[nameIndex].toString().trim() : '',
                    mobile: phoneIndex >= 0 && row[phoneIndex] ? cleanPhoneNumber(row[phoneIndex].toString().trim()) : '',
                    email: emailIndex >= 0 && row[emailIndex] ? row[emailIndex].toString().trim() : '',
                    passes: 1
                };
                
                // Only add if we have meaningful data
                if (contact.name || contact.mobile) {
                    contacts.push(contact);
                }
            } catch (rowError) {
                logError(`📗 Error parsing Excel row ${i}:`, rowError);
                continue;
            }
        }
        
        log(`📗 Excel parsed successfully: ${contacts.length} contacts extracted`);
        return contacts;
        
    } catch (error) {
        logError('📗 Excel parsing failed:', error);
        
        // Try to extract as CSV if Excel parsing fails
        try {
            log('📗 Attempting CSV fallback...');
            return parseCSV(excelBuffer.toString());
        } catch (csvError) {
            logError('📗 CSV fallback also failed:', csvError);
            return [];
        }
    }
}

// PDF parsing function (requires pdf-parse package)
async function parsePDF(pdfBuffer) {
    try {
        log('📄 Starting PDF parsing...');
        const pdf = require('pdf-parse');
        
        // Extract text from PDF
        const data = await pdf(pdfBuffer);
        const textContent = data.text;
        
        log(`📄 PDF text extracted: ${textContent.length} characters`);
        
        if (!textContent || textContent.trim().length === 0) {
            log('📄 No text content found in PDF');
            return [];
        }
        
        // Use the enhanced text parser to extract contacts from PDF content
        const extractedContacts = parseTextContacts(textContent);
        
        log(`📄 PDF parsed successfully: ${extractedContacts.length} contacts extracted`);
        return extractedContacts;
        
    } catch (error) {
        logError('📄 PDF parsing failed:', error);
        
        // Fallback: try to parse as text if it's actually a text file
        try {
            log('📄 Attempting text fallback...');
            return parseTextContacts(pdfBuffer.toString());
        } catch (textError) {
            logError('📄 Text fallback failed:', textError);
            return [];
        }
    }
}

// Get supported formats for help messages
function getSupportedFormats() {
    return {
        formats: [
            { name: 'VCF', description: 'Contact cards from phones', extensions: ['.vcf'] },
            { name: 'CSV', description: 'Comma-separated values', extensions: ['.csv'] },
            { name: 'Excel', description: 'Spreadsheet formats', extensions: ['.xlsx', '.xls'] },
            { name: 'PDF', description: 'Text extraction from documents', extensions: ['.pdf'] },
            { name: 'Text', description: 'Pattern matching for contact data', extensions: ['.txt'] }
        ],
        mimeTypes: [
            'text/vcard',
            'text/x-vcard',
            'text/csv',
            'application/csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/pdf',
            'text/plain'
        ]
    };
}

// Export all functions
module.exports = {
    parseContactFile,
    parseTextContacts,
    parseCSV,
    parseExcel,
    parsePDF,
    getSupportedFormats,
    cleanPhoneNumber,
    cleanText
};