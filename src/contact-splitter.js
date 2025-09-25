// Smart Contact List Splitter for WhatsApp Limits
// Handles automatic splitting of large contact lists

const WHATSAPP_CHAR_LIMIT = 1600; // WhatsApp's character limit
const SAFETY_MARGIN = 100; // Leave some margin for safety
const EFFECTIVE_LIMIT = WHATSAPP_CHAR_LIMIT - SAFETY_MARGIN;

/**
 * Detects if a message is likely a continuation of a previous large contact list
 * @param {string} message - The incoming message
 * @param {Array} existingContacts - Previously parsed contacts
 * @returns {boolean}
 */
function isLikelyContinuation(message, existingContacts) {
    // Check if message contains contact-like patterns
    const hasContactPatterns = /\+234\d{10}/.test(message) || 
                              /Mr|Mrs|Miss|Dr|Prof/i.test(message);
    
    // Check if user already has contacts in batch
    const hasExistingBatch = existingContacts && existingContacts.length > 0;
    
    // Check if message looks like it was cut off (no clear ending)
    const appearsIncomplete = !message.trim().match(/\.$/) && hasContactPatterns;
    
    return hasContactPatterns && (hasExistingBatch || appearsIncomplete);
}

/**
 * Intelligently splits a large contact list into WhatsApp-friendly chunks
 * @param {string} contactText - The full contact text
 * @returns {Array<string>} Array of text chunks under character limit
 */
function splitContactList(contactText) {
    const chunks = [];
    
    if (contactText.length <= EFFECTIVE_LIMIT) {
        return [contactText]; // No splitting needed
    }
    
    console.log(`📦 Splitting ${contactText.length} character list into chunks...`);
    
    // Try to split at natural contact boundaries
    // Look for patterns like "+234XXXXXXXXXX" followed by names
    const contactPattern = /(\+234\d{10})\s+([A-Za-z\s&\.]+?)(?=\s+\+234|\s*$)/g;
    const contacts = [];
    let match;
    
    // Extract individual contacts
    while ((match = contactPattern.exec(contactText)) !== null) {
        const contactEntry = match[0].trim();
        if (contactEntry) {
            contacts.push(contactEntry);
        }
    }
    
    // If pattern matching fails, fall back to simple splitting
    if (contacts.length === 0) {
        console.log('📦 Pattern matching failed, using fallback splitting');
        return simpleSplit(contactText);
    }
    
    console.log(`📦 Identified ${contacts.length} individual contacts`);
    
    // Group contacts into chunks
    let currentChunk = '';
    
    for (const contact of contacts) {
        const testChunk = currentChunk ? `${currentChunk} ${contact}` : contact;
        
        if (testChunk.length <= EFFECTIVE_LIMIT) {
            currentChunk = testChunk;
        } else {
            // Current chunk is full, start new one
            if (currentChunk) {
                chunks.push(currentChunk);
            }
            currentChunk = contact;
        }
    }
    
    // Add final chunk
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    
    console.log(`📦 Split into ${chunks.length} chunks:`);
    chunks.forEach((chunk, i) => {
        console.log(`   Chunk ${i + 1}: ${chunk.length} chars`);
    });
    
    return chunks;
}

/**
 * Simple character-based splitting fallback
 * @param {string} text - Text to split
 * @returns {Array<string>}
 */
function simpleSplit(text) {
    const chunks = [];
    
    for (let i = 0; i < text.length; i += EFFECTIVE_LIMIT) {
        let chunk = text.substring(i, i + EFFECTIVE_LIMIT);
        
        // Try to break at word boundaries for better readability
        if (i + EFFECTIVE_LIMIT < text.length) {
            const lastSpace = chunk.lastIndexOf(' ');
            if (lastSpace > EFFECTIVE_LIMIT * 0.8) { // Only if we're not losing too much
                chunk = chunk.substring(0, lastSpace);
                i = i + lastSpace - EFFECTIVE_LIMIT; // Adjust position
            }
        }
        
        chunks.push(chunk.trim());
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Generates helpful instructions for multi-part sending
 * @param {Array<string>} chunks - The text chunks
 * @param {number} totalEstimatedContacts - Estimated total contacts
 * @returns {string}
 */
function generateSplitInstructions(chunks, totalEstimatedContacts) {
    return `📋 **Your contact list was too large - WhatsApp truncated it!**

⚠️ **What happened:** WhatsApp has a 1600 character limit, so your message was cut off mid-way.

🔢 **From truncated portion:** Found ${totalEstimatedContacts} contacts
📝 **What to do:** Please send your contacts in smaller chunks (about 10-15 contacts per message)

**💡 Tip:** Copy and paste smaller sections of your contact list, then use "Add More" to build your batch.

✅ I'll automatically combine all your messages into one CSV file!

**Current batch:** ${totalEstimatedContacts} contacts ready for export.`;
}

/**
 * Creates a batch status message for multi-part processing
 * @param {number} currentPart - Current part number
 * @param {number} totalParts - Total expected parts
 * @param {number} contactsInPart - Contacts found in current part
 * @param {number} totalContacts - Total contacts so far
 * @returns {string}
 */
function generateBatchStatus(currentPart, totalParts, contactsInPart, totalContacts) {
    const isComplete = currentPart >= totalParts;
    
    if (isComplete) {
        return `✅ **Batch Complete!**

📊 **Final Results:**
• Total contacts: ${totalContacts}
• Parts processed: ${totalParts}/${totalParts}
• Ready for CSV export!

**Tap "Export" button or type "export" to download your CSV!** 📥`;
    } else {
        return `📝 **Part ${currentPart}/${totalParts} processed**

✅ Found ${contactsInPart} contacts in this part
📊 Total so far: ${totalContacts} contacts

**Next:** Send part ${currentPart + 1} of your contact list
I'll automatically detect and combine it! 🔄`;
    }
}

module.exports = {
    splitContactList,
    isLikelyContinuation,
    generateSplitInstructions,
    generateBatchStatus,
    WHATSAPP_CHAR_LIMIT,
    EFFECTIVE_LIMIT
};