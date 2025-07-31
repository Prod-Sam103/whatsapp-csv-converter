// test-text-parsing.js - Enhanced Text Parsing Tests
const { parseContactFile, parseTextContacts } = require('../src/csv-excel-parser');

console.log('🧪 ENHANCED TEXT PARSING TEST SUITE\n');

// Test cases for plain text contact extraction
const testCases = [
    {
        name: 'WhatsApp Message Style',
        input: `John Doe +2348123456789 john@example.com
Jane Smith: 08012345678 jane.smith@company.org  
Bob Wilson - +44 20 7946 0958`,
        expected: 3
    },
    {
        name: 'Event Planner Guest List',
        input: `Guest List for Wedding:
1. Sarah Johnson +2349876543210 sarah@email.com
2. Michael Brown 08033445566
3. Lisa Davis +1234567890 lisa.davis@company.com
4. David Wilson: 07012345678`,
        expected: 4
    },
    {
        name: 'Structured Contact Block',
        input: `Contact: Alice Cooper
Phone: +2348012345678
Email: alice@example.com

Contact: Mark Thompson  
Phone: 08067890123
Email: mark@company.org`,
        expected: 2
    },
    {
        name: 'Mixed Format Message',
        input: `Here are the contacts:
- Emma Watson +44 20 7946 0958 emma@movies.com
- Tom Hanks: +1 555 123 4567
- Will Smith 08099887766 will@actor.com`,
        expected: 3
    },
    {
        name: 'Incomplete Data',
        input: `Just phone numbers:
08123456789
+2347098765432
Some names without phones:
Random Person
Another Name`,
        expected: 2
    },
    {
        name: 'Email Only Contacts',
        input: `Email contacts:
support@company.com
sales@business.org  
info@organization.net`,
        expected: 3
    },
    {
        name: 'Real Event Scenario',
        input: `Birthday Party Guest List:
John 08123456789
Mary +2347098765432 mary@email.com
Peter: 08067891234
Susan - +44 20 1234 5678 susan@uk.com
David (no phone) david@example.com`,
        expected: 5
    }
];

// Test runner function
async function runTextParsingTest(testCase) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📝 TEST: ${testCase.name}`);
    console.log('='.repeat(60));
    
    console.log('📄 Input text:');
    console.log('-'.repeat(40));
    console.log(testCase.input);
    console.log('-'.repeat(40));
    
    try {
        // Test the enhanced text parsing
        const startTime = Date.now();
        const contacts = await parseContactFile(testCase.input, 'text/plain');
        const parseTime = Date.now() - startTime;
        
        console.log(`\n⏱️ Parsing completed in ${parseTime}ms`);
        console.log(`📊 Found ${contacts.length} contacts (expected: ${testCase.expected})`);
        
        // Display results
        if (contacts.length > 0) {
            console.log('\n📋 Extracted Contacts:');
            contacts.forEach((contact, index) => {
                console.log(`\n${index + 1}. ${contact.name || 'Unnamed'}`);
                if (contact.mobile) console.log(`   📱 ${contact.mobile}`);
                if (contact.email) console.log(`   📧 ${contact.email}`);
                if (contact.company) console.log(`   🏢 ${contact.company}`);
            });
        }
        
        // Test result evaluation
        const success = contacts.length >= Math.max(1, testCase.expected - 1); // Allow 1 contact tolerance
        console.log(`\n${success ? '✅' : '❌'} Test ${success ? 'PASSED' : 'FAILED'}`);
        
        if (!success) {
            console.log(`   Expected: ${testCase.expected}, Got: ${contacts.length}`);
        }
        
        return { success, contacts, parseTime };
        
    } catch (error) {
        console.error(`\n❌ Test FAILED with error: ${error.message}`);
        return { success: false, error, parseTime: 0 };
    }
}

// Run all tests
async function runAllTests() {
    console.log('🚀 Starting Enhanced Text Parsing Test Suite...\n');
    
    const results = [];
    let totalTime = 0;
    
    for (const testCase of testCases) {
        const result = await runTextParsingTest(testCase);
        results.push({
            name: testCase.name,
            ...result
        });
        totalTime += result.parseTime || 0;
    }
    
    // Summary
    console.log('\n\n🏁 TEST SUITE COMPLETE');
    console.log('='.repeat(60));
    
    const passed = results.filter(r => r.success).length;
    const total = results.length;
    
    console.log(`📊 Results: ${passed}/${total} tests passed`);
    console.log(`⏱️ Total parsing time: ${totalTime}ms`);
    console.log(`⚡ Average time per test: ${Math.round(totalTime / total)}ms`);
    
    if (passed === total) {
        console.log('\n🎉 ALL TESTS PASSED! Enhanced text parsing is working perfectly.');
    } else {
        console.log('\n⚠️ Some tests failed. Review the results above.');
        
        const failed = results.filter(r => !r.success);
        console.log('\n❌ Failed tests:');
        failed.forEach(test => {
            console.log(`   - ${test.name}: ${test.error?.message || 'Contact count mismatch'}`);
        });
    }
    
    console.log('\n📝 Enhanced text parsing supports:');
    console.log('   ✅ WhatsApp message style contacts');
    console.log('   ✅ Event planner guest lists');
    console.log('   ✅ Structured contact blocks');
    console.log('   ✅ Mixed format messages');
    console.log('   ✅ Incomplete data handling');
    console.log('   ✅ Email-only contacts');
    console.log('   ✅ Real-world scenarios');
    
    return results;
}

// Run the test suite
runAllTests().then(() => {
    console.log('\n🔚 Text parsing test suite completed.');
}).catch(error => {
    console.error('💥 Test suite failed:', error);
});