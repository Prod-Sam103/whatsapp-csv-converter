// vcf-parser.js - Enhanced Codebreaking Division
function parseVCF(vcfContent) {
    const contacts = [];
    
    // Fix line endings and split into cards
    const normalizedContent = vcfContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    
    // Split by BEGIN:VCARD
    const vcards = normalizedContent.split(/BEGIN:VCARD/i).filter(v => v.trim());
    
    vcards.forEach(vcard => {
        if (!vcard.includes('END:VCARD')) return;
        
        const contact = {
            name: '',
            mobile: '',
            email: '',
            passes: 1
        };
        
        // Extract lines
        const lines = vcard.split('\n').map(l => l.trim()).filter(l => l);
        
        // Extract name (N field)
        const nLine = lines.find(line => line.match(/^N:/i));
        if (nLine) {
            // Handle both VERSION:3.0 (semicolons) and VERSION:2.1 (semicolons)
            const nValue = nLine.replace(/^N:/i, '').trim();
            const nameParts = nValue.split(';').filter(p => p);
            
            if (nameParts.length >= 2) {
                // Format: N:LastName;FirstName;MiddleName;Prefix;Suffix
                const lastName = nameParts[0]?.trim() || '';
                const firstName = nameParts[1]?.trim() || '';
                contact.name = `${firstName} ${lastName}`.trim();
            } else if (nameParts.length === 1) {
                // Sometimes just one name part
                contact.name = nameParts[0].trim();
            }
        }
        
        // Fallback to FN field if no N field or empty name
        if (!contact.name) {
            const fnLine = lines.find(line => line.match(/^FN:/i));
            if (fnLine) {
                contact.name = fnLine.replace(/^FN:/i, '').trim();
            }
        }
        
        // Extract phone numbers - handle multiple formats
        const telLines = lines.filter(line => 
            line.match(/^TEL/i) || 
            line.match(/^item\d*\.TEL/i)  // Apple format
        );
        
        // Find the best phone number (prefer CELL/MOBILE)
        let selectedPhone = '';
        let cellPhone = '';
        
        telLines.forEach(telLine => {
            let phone = '';
            
            // Extract phone number after colon
            if (telLine.includes(':')) {
                phone = telLine.split(':').slice(1).join(':').trim();
            }
            
            // Clean phone number
            phone = phone.replace(/[^\d+\s\-\(\)]/g, '').trim();
            
            // Check if it's a cell/mobile number
            if (telLine.match(/CELL|MOBILE/i)) {
                cellPhone = phone;
            }
            
            // Store first phone found as fallback
            if (!selectedPhone && phone) {
                selectedPhone = phone;
            }
        });
        
        // Prefer cell phone, otherwise use first phone found
        let finalPhone = cellPhone || selectedPhone;
        
        // Format Nigerian numbers
        if (finalPhone) {
            // Nigerian local format (0XX)
            if (finalPhone.match(/^0[789]\d{9}$/)) {
                finalPhone = '+234' + finalPhone.substring(1);
            }
            // Add + if missing for international numbers
            else if (finalPhone.match(/^\d{10,}$/) && !finalPhone.startsWith('+')) {
                // Likely an international number without +
                if (finalPhone.startsWith('234')) {
                    finalPhone = '+' + finalPhone;
                } else if (finalPhone.startsWith('1') && finalPhone.length === 11) {
                    finalPhone = '+' + finalPhone;
                } else if (finalPhone.startsWith('44')) {
                    finalPhone = '+' + finalPhone;
                }
            }
        }
        
        contact.mobile = finalPhone;
        
        // Extract email - handle different formats
        const emailLine = lines.find(line => 
            line.match(/^EMAIL/i) || 
            line.match(/^item\d*\.EMAIL/i)  // Apple format
        );
        
        if (emailLine) {
            // Extract email after colon
            if (emailLine.includes(':')) {
                contact.email = emailLine.split(':').slice(1).join(':').trim();
            }
        }
        
        // Only add contact if we have meaningful data
        if (contact.name || contact.mobile) {
            contacts.push(contact);
        }
    });
    
    console.log(`🎯 Extracted ${contacts.length} operatives from VCF intel`);
    
    // Log summary for debugging
    const summary = contacts.map(c => `${c.name} - ${c.mobile || 'NO PHONE'}`);
    console.log('📋 Roster:', summary.join(', '));
    
    return contacts;
}

module.exports = { parseVCF };