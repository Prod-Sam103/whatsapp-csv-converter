// src/csv-excel-parser.js - Universal Contact File Parser with PDF & Text Support
const XLSX = require('xlsx');
const Papa = require('papaparse');
const pdf = require('pdf-parse');

// Column name variations for auto-detection
const COLUMN_MAPPINGS = {
    name: [
        'name', 'full name', 'fullname', 'contact name', 'contact', 'person',
        'first name', 'firstname', 'last name', 'lastname', 'display name',
        'customer name', 'client name', 'title', 'contact_name', 'full_name',
        'nome', 'nom', 'name_full', 'display_name', 'person_name', 'client',
        'customer', 'lead', 'prospect', 'member', 'attendee', 'participant'
    ],
    email: [
        'email', 'email address', 'e-mail', 'mail', 'electronic mail',
        'email_address', 'e_mail', 'contact email', 'primary email',
        'work email', 'business email', 'personal email', 'correo',
        'email_1', 'email1', 'primary_email', 'contact_email', 'gmail',
        'yahoo', 'outlook', 'hotmail', 'mail_address'
    ],
    phone: [
        'phone', 'mobile', 'cell', 'telephone', 'phone number', 'mobile number',
        'cell phone', 'cellular', 'contact number', 'tel', 'telefone', 'telefono',
        'phone_number', 'mobile_number', 'cell_phone', 'primary_phone',
        'work phone', 'business phone', 'personal phone', 'phone1', 'mobile1',
        'contact_phone', 'phone_1', 'mobile_1', 'whatsapp', 'whatsapp number',
        'tel_number', 'tel_mobile', 'number', 'contact_mobile'
    ]
};

// Common contact patterns for text extraction
const CONTACT_PATTERNS = {
    // Email patterns
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    
    // Phone patterns (international and Nigerian)
    phone: /(?:\+?234|0)?[789]\d{9}|\+?\d{10,15}/g,
    
    // Name patterns (before email or phone)
    nameBeforeEmail: /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*[-:,]?\s*[A-Za-z0-9._%+-]+@/gm,
    nameBeforePhone: /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*[-:,]?\s*(?:\+?234|0)?[789]\d{9}/gm,
    
    // Structured contact blocks
    contactBlock: /^(.+?)(?:\n|\r\n|$)(?:.*?(?:email|mail|@).*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}))?(?:.*?(?:phone|mobile|tel|call).*?((?:\+?234|0)?[789]\d{9}|\+?\d{10,15}))?/gim
};

// Detect file type and parse accordingly
function parseContactFile(fileBuffer, filename) {
    console.log('🔍 Parsing contact file:', filename);
    console.log('🔍 File size:', fileBuffer.length, 'bytes');
    
    const fileExtension = filename.toLowerCase().split('.').pop();
    console.log('🔍 File extension:', fileExtension);
    
    let rawData = [];
    
    try {
        if (fileExtension === 'csv') {
            rawData = parseCSV(fileBuffer);
        } else if (['xlsx', 'xls'].includes(fileExtension)) {
            rawData = parseExcel(fileBuffer);
        } else if (fileExtension === 'pdf') {
            rawData = parsePDF(fileBuffer);
        } else if (['txt', 'text'].includes(fileExtension)) {
            rawData = parseText(fileBuffer);
        } else {
            // Try to parse as text if unknown format
            console.log('❓ Unknown extension, trying text parsing...');
            rawData = parseText(fileBuffer);
        }
        
        console.log('🔍 Raw data rows:', rawData.length);
        
        if (rawData.length === 0) {
            throw new Error('No contact data found in file');
        }
        
        // Map to Sugar format
        const contacts = mapToSugarFormat(rawData);
        console.log('🎯 Mapped to Sugar format:', contacts.length, 'contacts');
        
        return contacts;
        
    } catch (error) {
        console.error('❌ File parsing error:', error);
        throw new Error(`Failed to parse ${fileExtension.toUpperCase()} file: ${error.message}`);
    }
}

// Parse CSV files
function parseCSV(fileBuffer) {
    console.log('📊 Parsing CSV file...');
    
    const csvText = fileBuffer.toString('utf8');
    console.log('📊 CSV preview:', csvText.substring(0, 200));
    
    const result = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        delimitersToGuess: [',', '\t', '|', ';']
    });
    
    if (result.errors.length > 0) {
        console.warn('⚠️ CSV parsing warnings:', result.errors);
    }
    
    console.log('📊 CSV headers detected:', result.meta.fields);
    return result.data;
}

// Parse Excel files
function parseExcel(fileBuffer) {
    console.log('📗 Parsing Excel file...');
    
    const workbook = XLSX.read(fileBuffer, {
        type: 'buffer',
        cellDates: true,
        cellNF: false,
        cellText: false
    });
    
    console.log('📗 Excel sheets:', workbook.SheetNames);
    
    // Use first sheet
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    console.log('📗 Using sheet:', firstSheetName);
    
    // Convert to JSON with headers
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        blankrows: false
    });
    
    if (jsonData.length < 2) {
        throw new Error('Excel file must have at least a header row and one data row');
    }
    
    // Convert array format to object format
    const headers = jsonData[0].map(h => String(h).trim().toLowerCase());
    console.log('📗 Excel headers:', headers);
    
    const dataRows = jsonData.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index] || '';
        });
        return obj;
    });
    
    return dataRows;
}

// Parse PDF files
async function parsePDF(fileBuffer) {
    console.log('📄 Parsing PDF file...');
    
    try {
        const pdfData = await pdf(fileBuffer);
        const textContent = pdfData.text;
        
        console.log('📄 PDF text length:', textContent.length);
        console.log('📄 PDF preview:', textContent.substring(0, 300));
        
        // Extract contacts from PDF text
        return extractContactsFromText(textContent);
        
    } catch (error) {
        console.error('❌ PDF parsing error:', error);
        throw new Error('Could not extract text from PDF. File may be image-based or corrupted.');
    }
}

// Parse plain text files
function parseText(fileBuffer) {
    console.log('📝 Parsing text file...');
    
    const textContent = fileBuffer.toString('utf8');
    console.log('📝 Text length:', textContent.length);
    console.log('📝 Text preview:', textContent.substring(0, 300));
    
    return extractContactsFromText(textContent);
}

// Extract contacts from text content using pattern matching
function extractContactsFromText(textContent) {
    console.log('🔍 Extracting contacts from text...');
    
    const contacts = [];
    const lines = textContent.split(/\n|\r\n/).map(line => line.trim()).filter(line => line);
    
    // Method 1: Try to parse as CSV-like content first
    if (textContent.includes(',') || textContent.includes('\t') || textContent.includes('|')) {
        try {
            const csvResult = Papa.parse(textContent, {
                header: true,
                skipEmptyLines: true,
                dynamicTyping: true,
                delimitersToGuess: [',', '\t', '|', ';']
            });
            
            if (csvResult.data && csvResult.data.length > 0) {
                console.log('🔍 Text parsed as CSV-like structure');
                return csvResult.data;
            }
        } catch (csvError) {
            console.log('🔍 CSV parsing failed, trying pattern extraction...');
        }
    }
    
    // Method 2: Pattern-based extraction
    const emailMatches = [...textContent.matchAll(CONTACT_PATTERNS.email)];
    const phoneMatches = [...textContent.matchAll(CONTACT_PATTERNS.phone)];
    
    console.log('🔍 Found emails:', emailMatches.length);
    console.log('🔍 Found phones:', phoneMatches.length);
    
    // Extract structured contact blocks
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip empty lines or headers
        if (!line || line.toLowerCase().includes('name') && line.toLowerCase().includes('email')) {
            continue;
        }
        
        const contact = {
            name: '',
            email: '',
            phone: ''
        };
        
        // Try to extract from current line and next few lines
        const contextLines = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
        
        // Extract email from context
        const emailMatch = contextLines.match(CONTACT_PATTERNS.email);
        if (emailMatch) {
            contact.email = emailMatch[0];
        }
        
        // Extract phone from context
        const phoneMatch = contextLines.match(CONTACT_PATTERNS.phone);
        if (phoneMatch) {
            contact.phone = phoneMatch[0];
        }
        
        // Extract name (try multiple strategies)
        if (contact.email || contact.phone) {
            // Strategy 1: Current line might be the name
            if (!line.includes('@') && !line.match(/\d{7,}/)) {
                contact.name = line.replace(/[^\w\s]/g, '').trim();
            }
            
            // Strategy 2: Look for name pattern before email/phone
            if (!contact.name) {
                const nameMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
                if (nameMatch) {
                    contact.name = nameMatch[1];
                }
            }
            
            // Strategy 3: Use line before email/phone as name
            if (!contact.name && i > 0) {
                const prevLine = lines[i - 1];
                if (prevLine && !prevLine.includes('@') && !prevLine.match(/\d{7,}/)) {
                    contact.name = prevLine.replace(/[^\w\s]/g, '').trim();
                }
            }
        }
        
        // Add contact if we have meaningful data
        if (contact.name || contact.email || contact.phone) {
            contacts.push({
                name: contact.name,
                email: contact.email,
                mobile: contact.phone,
                passes: 1
            });
        }
    }
    
    // Method 3: If structured approach fails, try bulk extraction
    if (contacts.length === 0) {
        console.log('🔍 Trying bulk pattern extraction...');
        
        // Bulk extract all emails and phones
        const allEmails = [...textContent.matchAll(CONTACT_PATTERNS.email)].map(m => m[0]);
        const allPhones = [...textContent.matchAll(CONTACT_PATTERNS.phone)].map(m => m[0]);
        
        // Create contacts from bulk data
        const maxLength = Math.max(allEmails.length, allPhones.length);
        for (let i = 0; i < maxLength; i++) {
            const contact = {
                name: `Contact ${i + 1}`,
                email: allEmails[i] || '',
                mobile: allPhones[i] || '',
                passes: 1
            };
            
            if (contact.email || contact.mobile) {
                contacts.push(contact);
            }
        }
    }
    
    console.log('🔍 Extracted contacts from text:', contacts.length);
    return contacts;
}

// Map raw data to Sugar format
function mapToSugarFormat(rawData) {
    console.log('🗺️ Mapping to Sugar format...');
    
    if (rawData.length === 0) {
        return [];
    }
    
    // Check if data is already in the right format (from text extraction)
    if (rawData[0] && rawData[0].hasOwnProperty('mobile')) {
        console.log('🗺️ Data already in Sugar format');
        return rawData.filter(contact => contact.name || contact.mobile);
    }
    
    // Get headers from first row
    const headers = Object.keys(rawData[0]).map(h => h.toLowerCase().trim());
    console.log('🗺️ Available headers:', headers);
    
    // Auto-detect column mappings
    const columnMap = autoDetectColumns(headers);
    console.log('🗺️ Column mapping:', columnMap);
    
    const contacts = [];
    
    rawData.forEach((row, index) => {
        try {
            const contact = {
                name: '',
                mobile: '',
                email: '',
                passes: 1
            };
            
            // Extract name
            if (columnMap.name) {
                contact.name = cleanText(row[columnMap.name]);
            }
            
            // Extract email
            if (columnMap.email) {
                contact.email = cleanEmail(row[columnMap.email]);
            }
            
            // Extract phone
            if (columnMap.phone) {
                contact.mobile = cleanPhone(row[columnMap.phone]);
            }
            
            // Only add if we have at least name or phone
            if (contact.name || contact.mobile) {
                contacts.push(contact);
                console.log(`🗺️ Row ${index + 1}: ${contact.name} - ${contact.mobile}`);
            } else {
                console.log(`⚠️ Skipping row ${index + 1}: insufficient data`);
            }
            
        } catch (error) {
            console.warn(`⚠️ Error processing row ${index + 1}:`, error.message);
        }
    });
    
    return contacts;
}

// Auto-detect column mappings
function autoDetectColumns(headers) {
    const mapping = {};
    
    // Find name column
    for (const header of headers) {
        if (COLUMN_MAPPINGS.name.includes(header)) {
            mapping.name = header;
            break;
        }
    }
    
    // Find email column
    for (const header of headers) {
        if (COLUMN_MAPPINGS.email.includes(header)) {
            mapping.email = header;
            break;
        }
    }
    
    // Find phone column
    for (const header of headers) {
        if (COLUMN_MAPPINGS.phone.includes(header)) {
            mapping.phone = header;
            break;
        }
    }
    
    console.log('🎯 Auto-detected columns:', mapping);
    
    return mapping;
}

// Clean text data
function cleanText(text) {
    if (!text) return '';
    return String(text).trim().replace(/\s+/g, ' ');
}

// Clean email data
function cleanEmail(email) {
    if (!email) return '';
    const cleaned = String(email).trim().toLowerCase();
    // Basic email validation
    if (cleaned.includes('@') && cleaned.includes('.')) {
        return cleaned;
    }
    return '';
}

// Clean phone data
function cleanPhone(phone) {
    if (!phone) return '';
    
    // Convert to string and clean
    let cleaned = String(phone).replace(/[^\d+\-\(\)\s]/g, '').trim();
    
    // Remove common formatting
    cleaned = cleaned.replace(/[\-\(\)\s]/g, '');
    
    // Nigerian number formatting (same as VCF parser)
    if (cleaned.match(/^0[789]\d{9}$/)) {
        return '+234' + cleaned.substring(1);
    }
    
    // Add + if missing for international numbers
    if (cleaned.match(/^\d{10,}$/) && !cleaned.startsWith('+')) {
        if (cleaned.startsWith('234')) {
            return '+' + cleaned;
        } else if (cleaned.startsWith('1') && cleaned.length === 11) {
            return '+' + cleaned;
        } else if (cleaned.startsWith('44')) {
            return '+' + cleaned;
        }
    }
    
    return cleaned;
}

// Get supported file info
function getSupportedFormats() {
    return {
        supported: ['.vcf', '.csv', '.xlsx', '.xls', '.pdf', '.txt'],
        description: 'VCF, CSV, Excel, PDF, and text files with contact data',
        requiredColumns: 'At least Name or Phone number',
        optionalColumns: 'Email address',
        textPatterns: 'Automatically extracts emails and phone numbers from unstructured text'
    };
}

module.exports = {
    parseContactFile,
    getSupportedFormats,
    COLUMN_MAPPINGS,
    CONTACT_PATTERNS
};