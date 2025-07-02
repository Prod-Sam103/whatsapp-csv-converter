// vcf-parser.js - Enhanced Multi-Contact Parser
function parseVCF(vcfContent) {
    const contacts = [];
    
    // Fix line endings and split into cards
    const normalizedContent = vcfContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    
    console.log('🔍 Normalized content length:', normalizedContent.length);
    console.log('🔍 First 300 chars:', normalizedContent.substring(0, 300));
    
    // Split by BEGIN:VCARD - more robust approach
    const vcardBlocks = normalizedContent.split(/(?=BEGIN:VCARD)/i).filter(block => 
        block.trim() && block.includes('BEGIN:VCARD')
    );
    
    console.log('🔍 Found VCard blocks:', vcardBlocks.length);
    
    vcardBlocks.forEach((vcard, index) => {
        console.log(`🔍 Processing VCard ${index + 1}:`);
        console.log('First 100 chars:', vcard.substring(0, 100));
        
        if (!vcard.includes('END:VCARD')) {
            console.log('⚠️ VCard missing END:VCARD, skipping');
            return;
        }
        
        const contact = {
            name: '',
            mobile: '',
            email: '',
            passes: 1
        };
        
        // Extract lines
        const lines = vcard.split('\n').map(l => l.trim()).filter(l => l);
        console.log(`🔍 Lines in VCard ${index + 1}:`, lines.length);
        
        // Extract name (N field first, then FN as fallback)
        const nLine = lines.find(line => line.match(/^N:/i));
        if (nLine) {
            const nValue = nLine.replace(/^N:/i, '').trim();
            const nameParts = nValue.split(';').filter(p => p);
            
            if (nameParts.length >= 2) {
                const lastName = nameParts[0]?.trim() || '';
                const firstName = nameParts[1]?.trim() || '';
                contact.name = `${firstName} ${lastName}`.trim();
            } else if (nameParts.length === 1) {
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
        
        // Extract email
        const emailLine = lines.find(line => 
            line.match(/^EMAIL/i) || 
            line.match(/^item\d*\.EMAIL/i)
        );
        
        if (emailLine) {
            if (emailLine.includes(':')) {
                contact.email = emailLine.split(':').slice(1).join(':').trim();
            }
        }
        
        console.log(`🔍 Parsed contact ${index + 1}:`, contact.name, contact.mobile);
        
        // Only add contact if we have meaningful data
        if (contact.name || contact.mobile) {
            contacts.push(contact);
        } else {
            console.log(`⚠️ Skipping empty contact ${index + 1}`);
        }
    });
    
    console.log(`🎯 Successfully extracted ${contacts.length} contacts from VCF`);
    
    return contacts;
}

module.exports = { parseVCF };