// csv-generator.js - Data Transformation Unit
function generateCSV(contacts) {
    // Prepare CSV headers - Operation parameters
    const headers = ['name', 'mobile', 'email', 'passes'];
    const csvRows = [headers.join(',')];
    
    // Transform each operative's data
    contacts.forEach(contact => {
        const row = [
            escapeCSV(contact.name),
            escapeCSV(contact.mobile),
            escapeCSV(contact.email || ''),
            contact.passes || 1
        ];
        csvRows.push(row.join(','));
    });
    
    const csvContent = csvRows.join('\n');
    console.log(`📊 Generated CSV with ${contacts.length} entries`);
    
    return csvContent;
}

// Defensive function - protect against CSV injection
function escapeCSV(field) {
    if (!field) return '';
    
    // If field contains special characters, wrap in quotes
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
}

module.exports = { generateCSV };