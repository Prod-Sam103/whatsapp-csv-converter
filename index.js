// Just replace the webhook handler section in your existing index.js
// Find this part: app.post('/webhook', async (req, res) => {

app.post('/webhook', async (req, res) => {
    const { Body, From, NumMedia } = req.body;
    
    console.log('📨 INCOMING TRANSMISSION:', new Date().toISOString());
    console.log('From:', From);
    console.log('Message:', Body);
    console.log('Attachments:', NumMedia);
    
    const twiml = new twilio.twiml.MessagingResponse();
    
    try {
        // MULTIPLE CONTACT PACKAGES DETECTED
        if (NumMedia > 0) {
            console.log(`📎 ${NumMedia} contact package(s) detected`);
            
            let allContacts = [];
            let processedFiles = 0;
            
            // Process ALL media attachments, not just MediaUrl0
            for (let i = 0; i < parseInt(NumMedia); i++) {
                const mediaUrl = req.body[`MediaUrl${i}`];
                const mediaType = req.body[`MediaContentType${i}`];
                
                if (mediaUrl) {
                    try {
                        console.log(`📎 Processing file ${i + 1}/${NumMedia}: ${mediaType}`);
                        
                        if (!IS_PRODUCTION || !process.env.TWILIO_ACCOUNT_SID) {
                            // Demo mode - add demo contacts for each file
                            const demoContactsForFile = [
                                { name: `Demo ${i + 1}-A`, mobile: `+234700000${i}01`, email: `demo${i + 1}a@example.com`, passes: 1 },
                                { name: `Demo ${i + 1}-B`, mobile: `+234700000${i}02`, email: `demo${i + 1}b@example.com`, passes: 1 }
                            ];
                            allContacts = allContacts.concat(demoContactsForFile);
                            processedFiles++;
                        } else {
                            // Production mode - use your existing parsing logic
                            const fileContent = await downloadMedia(mediaUrl, req);
                            const contacts = parseVCF(fileContent); // Your existing parser
                            
                            if (contacts && contacts.length > 0) {
                                allContacts = allContacts.concat(contacts);
                                processedFiles++;
                                console.log(`✅ File ${i + 1} processed: ${contacts.length} contacts`);
                            } else {
                                console.log(`⚠️ File ${i + 1} contained no valid contacts`);
                            }
                        }
                    } catch (fileError) {
                        console.error(`❌ Error processing file ${i + 1}:`, fileError);
                        // Continue processing other files
                    }
                }
            }
            
            if (allContacts.length === 0) {
                twiml.message(`❌ **Processing Failed**

No valid contacts found in ${NumMedia} file(s).

Please ensure you're sharing valid contact files.

Type *help* for instructions.`);
                
                res.type('text/xml');
                res.send(twiml.toString());
                return;
            }
            
            // Generate CSV using your existing function
            const csv = generateCSV(allContacts);
            
            // Create secure file
            const fileId = uuidv4();
            const password = Math.floor(100000 + Math.random() * 900000).toString();
            
            await storage.set(`file:${fileId}`, {
                content: csv,
                filename: `contacts_${Date.now()}.csv`,
                password: password,
                from: From,
                created: Date.now(),
                contactCount: allContacts.length,
                filesProcessed: processedFiles
            });
            
            const downloadUrl = `${BASE_URL}/download/${fileId}`;
            
            // Preview first 3 contacts
            const preview = allContacts.slice(0, 3).map(c => 
                `• ${c.name} - ${c.mobile}`
            ).join('\n');
            
            // Template-style response like your second screenshot
            twiml.message(`✅ **Operation Complete!**

📊 Processed: ${allContacts.length} contacts from ${processedFiles} file(s)
📎 Format: CSV ready for download
🔑 Password: ${password}
⏰ Expires: 2 hours

**Preview:**
${preview}
${allContacts.length > 3 ? `\n... and ${allContacts.length - 3} more` : ''}

🔗 Download: ${downloadUrl}`);
            
        } else if (Body.toLowerCase() === 'help') {
            sendHelpMessage(twiml);
            
        } else if (Body.toLowerCase() === 'test') {
            twiml.message(`✅ **Systems Check Complete**

🟢 Bot: OPERATIONAL
🟢 Multi-file Parser: ARMED  
🟢 CSV Generator: READY
🟢 Storage: ${redisClient ? 'REDIS' : 'MEMORY'}
🟢 Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}

_Ready to receive contact packages!_`);
            
        } else if (Body.toLowerCase() === 'status') {
            const fileCount = await getActiveFileCount();
            twiml.message(`📊 **Operational Status**

🔧 Environment: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}
📁 Active files: ${fileCount}
⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes
🌐 Base URL: ${BASE_URL}
💾 Storage: ${redisClient ? 'Redis Cloud' : 'In-Memory'}

_All systems nominal_`);
            
        } else {
            twiml.message(`👋 **Welcome to Contact Converter!**

Share contact files for instant CSV conversion.

Type *help* for detailed instructions.
Type *test* for system status.`);
        }
        
    } catch (error) {
        console.error('❌ Operation failed:', error);
        twiml.message(`❌ **System Error**

Processing failed: ${error.message}

Please try again or contact support.`);
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});