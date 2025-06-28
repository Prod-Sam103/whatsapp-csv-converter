// test-parser.js - Weapons Testing Range
const { parseVCF } = require('./vcf-parser');
const { generateCSV } = require('./csv-generator');
const fs = require('fs');

console.log('🎯 WEAPONS TEST RANGE - OPERATIONAL\n');

// Test Case 1: Single Contact VCF
const testVCF1 = `BEGIN:VCARD
VERSION:3.0
N:Doe;John;;;
FN:John Doe
TEL;TYPE=CELL:+2341234567890
EMAIL:john.doe@example.com
END:VCARD`;

// Test Case 2: Multiple Contacts (Apple Format)
const testVCF2 = `BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iPhone OS 17.0//EN
N:Smith;Jane;;;
FN:Jane Smith
item1.TEL;type=pref:+234 987 654 3210
item1.X-ABLabel:Mobile
END:VCARD

BEGIN:VCARD
VERSION:3.0
N:Wilson;Bob;;;
FN:Bob Wilson
TEL;TYPE=WORK:08012345678
EMAIL:bob@company.com
END:VCARD

BEGIN:VCARD
VERSION:3.0
N:Johnson;Alice;;;
FN:Alice Johnson
TEL:+44 20 7946 0958
END:VCARD`;

// Test Case 3: Your actual contact (A Fatah)
const testVCF3 = `BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//iPhone OS 18.4.1//EN
N:Fatah;A;;;
FN:A Fatah
item1.TEL;type=pref:+234 705 514 8808
item1.X-ABLabel:Mobile
END:VCARD`;

// Test Case 4: Malformed/Edge Cases
const testVCF4 = `BEGIN:VCARD
VERSION:3.0
N:NoPhone;Contact;;;
FN:Contact NoPhone
EMAIL:nophone@test.com
END:VCARD

BEGIN:VCARD
VERSION:3.0
FN:Only FullName
TEL:+1234567890
END:VCARD`;

// TESTING FUNCTION
function runTest(testName, vcfData) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📋 TEST: ${testName}`);
    console.log('='.repeat(50));
    
    try {
        // Phase 1: Parse VCF
        console.log('\n🔓 PHASE 1: VCF PARSING');
        const contacts = parseVCF(vcfData);
        console.log(`✅ Parsed ${contacts.length} contacts`);
        
        // Display parsed data
        contacts.forEach((contact, index) => {
            console.log(`\n👤 Contact ${index + 1}:`);
            console.log(`   Name: ${contact.name}`);
            console.log(`   Mobile: ${contact.mobile}`);
            console.log(`   Email: ${contact.email || 'N/A'}`);
            console.log(`   Passes: ${contact.passes}`);
        });
        
        // Phase 2: Generate CSV
        console.log('\n📊 PHASE 2: CSV GENERATION');
        const csv = generateCSV(contacts);
        console.log('✅ CSV generated successfully');
        console.log('\n📄 CSV Output:');
        console.log('-'.repeat(40));
        console.log(csv);
        console.log('-'.repeat(40));
        
        // Save test output
        const filename = `test-output-${testName.replace(/\s+/g, '-').toLowerCase()}.csv`;
        fs.writeFileSync(filename, csv);
        console.log(`\n💾 Saved to: ${filename}`);
        
        return { success: true, contacts, csv };
        
    } catch (error) {
        console.error(`\n❌ TEST FAILED: ${error.message}`);
        console.error(error.stack);
        return { success: false, error };
    }
}

// RUN ALL TESTS
console.log('🚀 INITIATING WEAPONS TEST SEQUENCE...\n');

runTest('Single Contact', testVCF1);
runTest('Multiple Contacts Apple Format', testVCF2);
runTest('A Fatah Contact', testVCF3);
runTest('Edge Cases', testVCF4);

console.log('\n\n🏁 WEAPONS TEST COMPLETE\n');

// Test with actual file if exists
const testFile = 'test.vcf';
if (fs.existsSync(testFile)) {
    console.log(`\n📁 Found ${testFile} - Running live ammunition test...`);
    const fileContent = fs.readFileSync(testFile, 'utf8');
    runTest('Live File Test', fileContent);
}