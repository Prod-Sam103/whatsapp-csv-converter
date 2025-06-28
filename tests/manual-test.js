// manual-test.js - Interactive Testing Console
const { parseVCF } = require('./vcf-parser');
const { generateCSV } = require('./csv-generator');
const fs = require('fs');
const path = require('path');

console.log('🎮 INTERACTIVE VCF TESTER\n');

// Get command line argument
const filename = process.argv[2];

if (!filename) {
    console.log('Usage: node manual-test.js <vcf-filename>');
    console.log('\nExample: node manual-test.js test-apple.vcf');
    console.log('\nAvailable test files:');
    
    // List all VCF files in directory
    const files = fs.readdirSync('.').filter(f => f.endsWith('.vcf'));
    files.forEach(file => console.log(`  - ${file}`));
    
    process.exit(1);
}

// Check if file exists
if (!fs.existsSync(filename)) {
    console.error(`❌ File not found: ${filename}`);
    process.exit(1);
}

console.log(`📂 Loading: ${filename}\n`);

// Read file
const vcfContent = fs.readFileSync(filename, 'utf8');
console.log('📄 File Content:');
console.log('-'.repeat(40));
console.log(vcfContent.substring(0, 200) + '...');
console.log('-'.repeat(40));

// Parse
console.log('\n🔓 Parsing VCF...');
const contacts = parseVCF(vcfContent);

// Display results
console.log(`\n✅ Found ${contacts.length} contacts:\n`);
contacts.forEach((contact, i) => {
    console.log(`Contact ${i + 1}:`);
    console.log(`  Name: ${contact.name}`);
    console.log(`  Mobile: ${contact.mobile}`);
    console.log(`  Email: ${contact.email || 'N/A'}`);
    console.log('');
});

// Generate CSV
console.log('📊 Generating CSV...\n');
const csv = generateCSV(contacts);

// Save output
const outputFile = filename.replace('.vcf', '-output.csv');
fs.writeFileSync(outputFile, csv);

console.log('📄 CSV Preview:');
console.log('-'.repeat(40));
console.log(csv);
console.log('-'.repeat(40));

console.log(`\n✅ CSV saved to: ${outputFile}`);
console.log('\n🎯 TEST COMPLETE');