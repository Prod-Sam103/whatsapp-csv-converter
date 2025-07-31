// vcf-parser.js - Enhanced Multi-Contact Parser with Better Debugging

// Production-aware logging
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const log = (...args) => {
    if (!IS_PRODUCTION) {
        log(...args);
    }
};
const logError = (...args) => {
    if (!IS_PRODUCTION) {
        logError(...args);
    } else {
        logError('VCF parser error occurred');
    }
};
function parseVCF(vcfContent) {
    const contacts = [];
    
    log('🔍 === VCF PARSER START ===');
    log('🔍 Raw content type:', typeof vcfContent);
    log('🔍 Raw content length:', vcfContent?.length || 0);
    
    // Handle buffer input
    let content = vcfContent;
    if (Buffer.isBuffer(vcfContent)) {
        content = vcfContent.toString('utf8');
        log('🔍 Converted buffer to string, length:', content.length);
    }
    
    if (!content || typeof content !== 'string') {
        log('❌ Invalid VCF content provided');
        return contacts;
    }
    
    // Fix line endings and split into cards
    const normalizedContent = content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
    
    log('🔍 Normalized content length:', normalizedContent.length);
    log('🔍 First 500 chars:');
    log(normalizedContent.substring(0, 500));
    log('🔍 Last 200 chars:');
    log(normalizedContent.substring(Math.max(0, normalizedContent.length - 200)));
    
    // Count total BEGIN/END blocks for validation
    const beginCount = (normalizedContent.match(/BEGIN:VCARD/gi) || []).length;
    const endCount = (normalizedContent.match(/END:VCARD/gi) || []).length;
    log(`🔍 Found ${beginCount} BEGIN:VCARD and ${endCount} END:VCARD blocks`);
    
    // Split by BEGIN:VCARD - more robust approach
    const vcardBlocks = normalizedContent.split(/(?=BEGIN:VCARD)/i).filter(block => 
        block.trim() && block.toUpperCase().includes('BEGIN:VCARD')
    );
    
    log('🔍 Found VCard blocks after split:', vcardBlocks.length);
    
    // If no proper blocks found, try alternative splitting
    if (vcardBlocks.length === 0 && normalizedContent.includes('BEGIN:VCARD')) {
        log('🔍 Trying alternative block splitting...');
        const altBlocks = normalizedContent.split('BEGIN:VCARD');
        altBlocks.forEach((block, index) => {
            if (index > 0) { // Skip first empty part
                vcardBlocks.push('BEGIN:VCARD' + block);
            }
        });
        log('🔍 Alternative splitting found:', vcardBlocks.length, 'blocks');
    }
    
    vcardBlocks.forEach((vcard, index) => {
        log(`\n🔍 === Processing VCard ${index + 1}/${vcardBlocks.length} ===`);
        log('🔍 Block length:', vcard.length);
        log('🔍 First 150 chars:', vcard.substring(0, 150));
        
        // Check for proper VCard structure
        const hasBegin = vcard.toUpperCase().includes('BEGIN:VCARD');
        const hasEnd = vcard.toUpperCase().includes('END:VCARD');
        
        log(`🔍 Has BEGIN: ${hasBegin}, Has END: ${hasEnd}`);
        
        if (!hasBegin || !hasEnd) {
            log('⚠️ Malformed VCard, missing BEGIN or END, skipping');
            return;
        }
        
        const contact = {
            name: '',
            mobile: '',
            email: '',
            company: '',
            passes: 1
        };
        
        // Extract lines and clean them
        const lines = vcard.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.match(/^BEGIN:VCARD$/i) && !l.match(/^END:VCARD$/i));
        
        log(`🔍 Extracted ${lines.length} data lines`);
        lines.forEach((line, i) => {
            if (i < 5) { // Show first 5 lines for debugging
                log(`   Line ${i + 1}: ${line}`);
            }
        });
        
        // Extract name with multiple strategies
        let extractedName = '';
        
        // Strategy 1: N field (structured name)
        const nLine = lines.find(line => line.match(/^N[:;]/i));
        if (nLine) {
            log('🔍 Found N line:', nLine);
            const nValue = nLine.replace(/^N[:;]/i, '').trim();
            const nameParts = nValue.split(';').map(p => p.trim()).filter(p => p);
            
            if (nameParts.length >= 2) {
                const lastName = nameParts[0] || '';
                const firstName = nameParts[1] || '';
                extractedName = `${firstName} ${lastName}`.trim();
                log('🔍 Extracted from N field:', extractedName);
            } else if (nameParts.length === 1) {
                extractedName = nameParts[0];
                log('🔍 Extracted single name from N field:', extractedName);
            }
        }
        
        // Strategy 2: FN field (formatted name) as fallback
        if (!extractedName) {
            const fnLine = lines.find(line => line.match(/^FN[:;]/i));
            if (fnLine) {
                log('🔍 Found FN line:', fnLine);
                extractedName = fnLine.replace(/^FN[:;]/i, '').trim();
                log('🔍 Extracted from FN field:', extractedName);
            }
        }
        
        contact.name = extractedName;
        
        // Extract phone numbers - handle multiple formats
        const telLines = lines.filter(line => 
            line.match(/^TEL/i) || 
            line.match(/^item\d*\.TEL/i) ||  // Apple format
            line.match(/^TEL;/i) ||
            line.match(/^TEL:/i)
        );
        
        log(`🔍 Found ${telLines.length} TEL lines:`, telLines);
        
        let selectedPhone = '';
        let cellPhone = '';
        let workPhone = '';
        let homePhone = '';
        
        telLines.forEach((telLine, telIndex) => {
            log(`🔍 Processing TEL line ${telIndex + 1}:`, telLine);
            
            let phone = '';
            
            // Extract phone number after colon
            if (telLine.includes(':')) {
                phone = telLine.split(':').slice(1).join(':').trim();
            } else if (telLine.includes(';')) {
                // Handle cases where format is TEL;TYPE=CELL;555-1234
                const parts = telLine.split(';');
                phone = parts[parts.length - 1].trim();
            }
            
            log(`🔍 Raw phone extracted:`, phone);
            
            // Clean phone number but preserve international format
            const cleanPhone = phone.replace(/[^\d+\s\-\(\)]/g, '').trim();
            log(`🔍 Cleaned phone:`, cleanPhone);
            
            // Categorize phone by type
            if (telLine.match(/CELL|MOBILE/i)) {
                cellPhone = cleanPhone;
                log(`🔍 Identified as CELL phone:`, cellPhone);
            } else if (telLine.match(/WORK|BUSINESS/i)) {
                workPhone = cleanPhone;
                log(`🔍 Identified as WORK phone:`, workPhone);
            } else if (telLine.match(/HOME/i)) {
                homePhone = cleanPhone;
                log(`🔍 Identified as HOME phone:`, homePhone);
            }
            
            // Store first valid phone found as fallback
            if (!selectedPhone && cleanPhone) {
                selectedPhone = cleanPhone;
                log(`🔍 Set as primary phone:`, selectedPhone);
            }
        });
        
        // Prefer cell phone, then work, then home, then any phone
        let finalPhone = cellPhone || workPhone || homePhone || selectedPhone;
        log(`🔍 Final phone selection:`, finalPhone);
        
        // Format Nigerian numbers and other international formats
        if (finalPhone) {
            let formattedPhone = finalPhone;
            
            // Remove all non-digit characters except +
            formattedPhone = formattedPhone.replace(/[^\d+]/g, '');
            
            // Nigerian local format (0XX) to international
            if (formattedPhone.match(/^0[789]\d{9}$/)) {
                formattedPhone = '+234' + formattedPhone.substring(1);
                log(`🔍 Formatted Nigerian number:`, formattedPhone);
            }
            // Nigerian without 0 prefix
            else if (formattedPhone.match(/^[789]\d{9}$/)) {
                formattedPhone = '+234' + formattedPhone;
                log(`🔍 Formatted Nigerian number (no 0):`, formattedPhone);
            }
            // Add + if missing for international numbers
            else if (formattedPhone.match(/^\d{10,}$/) && !formattedPhone.startsWith('+')) {
                if (formattedPhone.startsWith('234')) {
                    formattedPhone = '+' + formattedPhone;
                } else if (formattedPhone.startsWith('1') && formattedPhone.length === 11) {
                    formattedPhone = '+' + formattedPhone;
                } else if (formattedPhone.startsWith('44')) {
                    formattedPhone = '+' + formattedPhone;
                } else {
                    // Keep as is for other international formats
                    formattedPhone = '+' + formattedPhone;
                }
                log(`🔍 Added + prefix:`, formattedPhone);
            }
            
            finalPhone = formattedPhone;
        }
        
        contact.mobile = finalPhone;
        
        // Extract email with multiple strategies
        const emailLine = lines.find(line => 
            line.match(/^EMAIL/i) || 
            line.match(/^item\d*\.EMAIL/i) ||
            line.match(/^EMAIL[:;]/i)
        );
        
        if (emailLine) {
            log('🔍 Found EMAIL line:', emailLine);
            let email = '';
            if (emailLine.includes(':')) {
                email = emailLine.split(':').slice(1).join(':').trim();
            }
            contact.email = email;
            log('🔍 Extracted email:', email);
        }
        
        // Extract organization/company
        const orgLine = lines.find(line => line.match(/^ORG[:;]/i));
        if (orgLine) {
            log('🔍 Found ORG line:', orgLine);
            const org = orgLine.replace(/^ORG[:;]/i, '').trim();
            contact.company = org;
            log('🔍 Extracted company:', org);
        }
        
        log(`🔍 Final parsed contact ${index + 1}:`);
        log(`   Name: "${contact.name}"`);
        log(`   Mobile: "${contact.mobile}"`);
        log(`   Email: "${contact.email}"`);
        log(`   Company: "${contact.company}"`);
        
        // Enhanced validation - accept if we have name OR phone OR email
        const hasName = contact.name && contact.name.trim();
        const hasPhone = contact.mobile && contact.mobile.trim();
        const hasEmail = contact.email && contact.email.trim();
        
        if (hasName || hasPhone || hasEmail) {
            contacts.push(contact);
            log(`✅ Contact ${index + 1} ACCEPTED`);
        } else {
            log(`❌ Contact ${index + 1} REJECTED - no valid data`);
        }
    });
    
    log(`\n🎯 === VCF PARSER COMPLETE ===`);
    log(`🎯 Successfully extracted ${contacts.length} contacts from ${vcardBlocks.length} VCard blocks`);
    
    // Final summary
    contacts.forEach((contact, index) => {
        log(`Final Contact ${index + 1}: ${contact.name || 'NO_NAME'} | ${contact.mobile || 'NO_PHONE'} | ${contact.email || 'NO_EMAIL'}`);
    });
    
    return contacts;
}

module.exports = { parseVCF };