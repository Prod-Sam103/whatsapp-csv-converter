// src/csv-excel-parser.js - Universal Contact File Parser
const XLSX = require('xlsx');
const Papa = require('papaparse');

// Column name variations for auto-detection
const COLUMN_MAPPINGS = {
    name: [
        'name', 'full name', 'fullname', 'contact name', 'contact', 'person',
        'first name', 'firstname', 'last name', 'lastname', 'display name',
        'customer name', 'client name', 'title', 'contact_name', 'full_name'
    ],
    email: [
        'email', 'email address', 'e-mail', 'mail', 'electronic mail',
        'email_address', 'e_mail', 'contact email', 'primary email',
        'work email', 'business email', 'personal email'
    ],
    phone: [
        'phone', 'mobile', 'cell', 'telephone', 'phone number', 'mobile number',
        'cell phone', 'cellular', 'contact number', 'tel', 'phone_number',
        'mobile_number', 'cell_phone', 'primary_phone', 'whatsapp'
    ]
};

// Main parsing function
function parseContactFile(fileBuffer, filename) {
    console.log('🔍 Parsing contact file:', filename);
    
    const fileExtension = filename.toLowerCase().split('.').pop();
    let rawData = [];
    
    try {
        if (fileExtension === 'csv') {
            rawData = parseCSV(fileBuffer);
        } else if (['xlsx', 'xls'].includes(fileExtension)) {
            rawData = parseExcel(fileBuffer);
        } else {
            throw new Error(`Unsupported file type: ${fileExtension}`);
        }
        
        if (rawData.length === 0) {
            throw new Error('No data found in file');
        }
        
        return mapToSugarFormat(rawData);
        
    } catch (error) {
        console.error('❌ File parsing error:', error);
        throw new Error(`Failed to parse ${fileExtension.toUpperCase()} file: ${error.message}`);
    }
}

// Parse CSV files
function parseCSV(fileBuffer) {
    const csvText = fileBuffer.toString('utf8');
    const result = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        delimitersToGuess: [',', '\t', '|', ';']
    });
    
    return result.data;
}

// Parse Excel files
function parseExcel(fileBuffer) {
    const workbook = XLSX.read(fileBuffer, {
        type: 'buffer',
        cellDates: true
    });
    
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        blankrows: false
    });
    
    if (jsonData.length < 2) {
        throw new Error('Excel file must have headers and data');
    }
    
    const headers = jsonData[0].map(h => String(h).trim().toLowerCase());
    const dataRows = jsonData.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index] || '';
        });
        return obj;
    });
    
    return dataRows;
}

// Map to Sugar format
function mapToSugarFormat(rawData) {
    if (rawData.length === 0) return [];
    
    const headers = Object.keys(rawData[0]).map(h => h.toLowerCase().trim());
    const columnMap = autoDetectColumns(headers);
    const contacts = [];
    
    rawData.forEach((row, index) => {
        const contact = {
            name: '',
            mobile: '',
            email: '',
            passes: 1
        };
        
        if (columnMap.name) {
            contact.name = cleanText(row[columnMap.name]);
        }
        
        if (columnMap.email) {
            contact.email = cleanEmail(row[columnMap.email]);
        }
        
        if (columnMap.phone) {
            contact.mobile = cleanPhone(row[columnMap.phone]);
        }
        
        if (contact.name || contact.mobile) {
            contacts.push(contact);
        }
    });
    
    return contacts;
}

// Auto-detect columns
function autoDetectColumns(headers) {
    const mapping = {};
    
    for (const header of headers) {
        if (COLUMN_MAPPINGS.name.includes(header)) {
            mapping.name = header;
            break;
        }
    }
    
    for (const header of headers) {
        if (COLUMN_MAPPINGS.email.includes(header)) {
            mapping.email = header;
            break;
        }
    }
    
    for (const header of headers) {
        if (COLUMN_MAPPINGS.phone.includes(header)) {
            mapping.phone = header;
            break;
        }
    }
    
    return mapping;
}

// Utility functions
function cleanText(text) {
    if (!text) return '';
    return String(text).trim().replace(/\s+/g, ' ');
}

function cleanEmail(email) {
    if (!email) return '';
    const cleaned = String(email).trim().toLowerCase();
    if (cleaned.includes('@') && cleaned.includes('.')) {
        return cleaned;
    }
    return '';
}

function cleanPhone(phone) {
    if (!phone) return '';
    
    let cleaned = String(phone).replace(/[^\d+\-\(\)\s]/g, '').trim();
    cleaned = cleaned.replace(/[\-\(\)\s]/g, '');
    
    // Nigerian formatting
    if (cleaned.match(/^0[789]\d{9}$/)) {
        return '+234' + cleaned.substring(1);
    }
    
    if (cleaned.match(/^\d{10,}$/) && !cleaned.startsWith('+')) {
        if (cleaned.startsWith('234')) {
            return '+' + cleaned;
        }
    }
    
    return cleaned;
}

function getSupportedFormats() {
    return {
        supported: ['.csv', '.xlsx', '.xls'],
        description: 'CSV and Excel files with contact data',
        requiredColumns: 'At least Name or Phone number',
        optionalColumns: 'Email address'
    };
}

module.exports = {
    parseContactFile,
    getSupportedFormats,
    COLUMN_MAPPINGS
};