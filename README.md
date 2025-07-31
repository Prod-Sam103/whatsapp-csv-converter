# WhatsApp CSV Converter - Enhanced Edition

A powerful WhatsApp bot that converts contact files and plain text contact lists into Excel-compatible CSV format. Perfect for event planners, business professionals, and anyone who needs to manage contact data efficiently.

## 🚀 Features

### Core Functionality
- **Multi-Format Support**: VCF, CSV, Excel, PDF, Text, DOCX (6+ formats)
- **Plain Text Parsing**: Extract contacts from WhatsApp messages and event guest lists
- **Dual Template System**: Professional WhatsApp template buttons for seamless UX
- **Auto-Batching**: Accumulate contacts from multiple sources before export
- **Excel Compatibility**: UTF-8 BOM for perfect Excel import experience

### Enhanced Capabilities
- **Parallel Processing**: Handle up to 10 files simultaneously
- **Scalable Storage**: Redis with chunking for large datasets
- **Smart Detection**: Intelligent file type recognition and fallback parsing
- **Nigerian Phone Formatting**: Automatic +234 formatting for local numbers
- **Interactive Preview**: Preview extracted contacts before export
- **Secure Downloads**: Time-limited download links with 2-hour expiry

## 📱 Supported Input Formats

### 1. Contact Files
- **📇 VCF**: iPhone/Android contact cards
- **📊 CSV**: Spreadsheet exports
- **📗 Excel**: .xlsx/.xls files
- **📄 PDF**: Text extraction from documents
- **📘 DOCX**: Word document contact lists

### 2. Plain Text Messages
Perfect for event planners and quick contact sharing:

```
John Doe +2348123456789 john@example.com
Jane Smith: 08012345678 jane.smith@company.org
Bob Wilson - +44 20 7946 0958
```

```
Guest List for Wedding:
1. Sarah Johnson +2349876543210 sarah@email.com
2. Michael Brown 08033445566
3. Lisa Davis +1234567890 lisa.davis@company.com
```

```
Contact: Alice Cooper
Phone: +2348012345678
Email: alice@example.com
```

## 🛠 Setup Instructions

### 1. Clone and Install
```bash
git clone -b csv-excel-parser-v2 https://github.com/Prod-Sam103/whatsapp-csv-converter.git
cd whatsapp-csv-converter
npm install
```

### 2. Environment Configuration
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```env
# Twilio Configuration
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=+14155238886

# WhatsApp Template SIDs (for professional buttons)
STATUS_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DOWNLOAD_TEMPLATE_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Application Configuration
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000
```

### 3. Twilio WhatsApp Setup
1. Create a [Twilio Account](https://www.twilio.com/)
2. Set up WhatsApp Sandbox or get approved WhatsApp Business API
3. Configure webhook URL: `https://your-app.vercel.app/webhook`
4. Create WhatsApp message templates (optional, for professional buttons)

### 4. Run Application
```bash
# Development
npm run dev

# Production
npm start

# Run Tests
npm test
```

## 🚀 Vercel Deployment

### Quick Deploy
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Prod-Sam103/whatsapp-csv-converter/tree/csv-excel-parser-v2)

### Manual Deployment
1. **Create Vercel Project**
   ```bash
   vercel --prod
   ```

2. **Set Environment Variables**
   ```bash
   vercel env add TWILIO_ACCOUNT_SID
   vercel env add TWILIO_AUTH_TOKEN
   vercel env add TWILIO_WHATSAPP_NUMBER
   vercel env add STATUS_TEMPLATE_SID
   vercel env add DOWNLOAD_TEMPLATE_SID
   vercel env add BASE_URL
   ```

3. **Update Webhook URL**
   - In Twilio Console, update webhook to: `https://your-app.vercel.app/webhook`

4. **Deploy**
   ```bash
   vercel --prod
   ```

## 💬 WhatsApp Template Configuration

### Template 1: Status with Export Button
```
Name: contact_status_export
Body: 💾 *{{1}} contacts saved so far.*
✅ Processed {{2}} file(s)
📋 *Note:* Received {{1}}/250 contacts

Keep sending more contacts or export when ready
Button: [Quick Reply] Export (ID: export_contacts)
```

### Template 2: Download CSV Button
```
Name: csv_export_download
Body: ✅ Your CSV file with {{1}} contacts is ready for download!
Button: [Visit Website] Download CSV → https://your-app.vercel.app/get/{{2}}
```

## 📖 User Guide

### For Event Planners
1. **Send Guest List**: Send your guest list as plain text message
2. **Multiple Formats**: Mix contact files with text messages
3. **Preview Contacts**: Type "preview" to see all collected contacts
4. **Export CSV**: Tap the Export button or type "export"
5. **Download**: Use the Download CSV button to get your file

### WhatsApp Commands
- `help` - Show detailed help message
- `export` - Download CSV file
- `preview` - See all contacts in current batch
- `test` - System status check
- `testtemplate` - Test WhatsApp templates

### Example Workflow
```
User: [Sends contact files + text message]
Bot: 💾 42 contacts saved so far... [Export Button]

User: [Taps Export Button]  
Bot: ✅ Your CSV file with 42 contacts is ready! [Download CSV Button]

User: [Taps Download CSV Button]
Bot: [File downloads automatically]
```

## 🧪 Testing

### Run All Tests
```bash
npm test                    # VCF parsing tests
node tests/test-text-parsing.js  # Text parsing tests
```

### Test Files Included
- `tests/test-parser.js` - VCF parsing validation
- `tests/test-text-parsing.js` - Plain text extraction tests
- `tests/test-*.vcf` - Sample contact files

### Test Plain Text Parsing
```javascript
const { parseContactFile } = require('./src/csv-excel-parser');

const testText = `John Doe +2348123456789 john@example.com
Jane Smith: 08012345678`;

parseContactFile(testText, 'text/plain').then(contacts => {
    console.log(`Found ${contacts.length} contacts`);
});
```

## 🔧 Architecture

### File Structure
```
├── index.js                 # Main Express server
├── src/
│   ├── csv-excel-parser.js  # Universal file parser (6+ formats)
│   ├── vcf-parser.js        # VCF contact card parser
│   ├── csv-generator.js     # Excel-compatible CSV generator
│   └── session-store.js     # Contact batch management
├── tests/
│   ├── test-parser.js       # VCF parsing tests
│   ├── test-text-parsing.js # Plain text parsing tests
│   └── *.vcf               # Sample contact files
├── vercel.json             # Vercel deployment config
└── railway.toml            # Railway deployment config (legacy)
```

### Key Components

#### Universal Parser (`csv-excel-parser.js`)
- Handles 6+ file formats with intelligent detection
- 4 different text parsing methods for maximum extraction
- Nigerian phone number formatting
- Fallback parsing for unknown formats

#### WhatsApp Bot (`index.js`)
- Dual template system with professional buttons
- Parallel file processing (up to 10 files)
- Plain text message handling
- Interactive preview and batch management
- Secure file downloads with expiry

#### Storage System
- Redis with chunking for large datasets
- In-memory fallback for development
- Automatic cleanup and expiry management

## 🔒 Security Features

- **Rate Limiting**: 5 requests per IP per 15 minutes
- **File Size Limits**: 20MB maximum per file
- **Processing Timeouts**: 25-second limit to prevent hangs
- **Secure Downloads**: Time-limited links with 2-hour expiry
- **Input Validation**: Comprehensive data sanitization
- **Authorized Numbers**: Testing mode restriction

## 📊 Performance Optimizations

- **Parallel Processing**: Handle multiple files simultaneously
- **Chunked Storage**: Support for large contact datasets
- **Memory Management**: Efficient buffer handling for large files
- **Streaming Support**: Process large Excel files without memory issues
- **Caching**: Redis optimization for high-volume usage

## 🐛 Troubleshooting

### Common Issues

**Templates not working?**
- Verify `STATUS_TEMPLATE_SID` and `DOWNLOAD_TEMPLATE_SID` are set
- Templates must be approved by WhatsApp/Twilio
- Fallback text messages work if templates unavailable

**Files not parsing?**
- Check file size (max 20MB)
- Verify file format is supported
- Try plain text extraction as fallback

**WhatsApp not responding?**
- Verify webhook URL is correct and accessible
- Check Twilio credentials and phone number
- Ensure authorized number for testing mode

### Debug Mode
Set `NODE_ENV=development` for detailed logging:
```bash
NODE_ENV=development npm start
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/new-feature`
3. Run tests: `npm test && node tests/test-text-parsing.js`
4. Commit changes: `git commit -am 'Add feature'`
5. Push branch: `git push origin feature/new-feature`
6. Create Pull Request

## 📄 License

ISC License - see LICENSE file for details.

## 🎯 Migration Notes

### From Railway to Vercel
- Created `vercel.json` configuration
- Updated environment variable management
- Optimized for serverless function limits
- Maintained Redis support for production

### New Features Added
- ✅ Plain text contact extraction
- ✅ Interactive preview system  
- ✅ Enhanced error handling
- ✅ Professional WhatsApp templates
- ✅ Comprehensive test suite
- ✅ Event planner optimizations

---

**Built with ❤️ for efficient contact management**

*WhatsApp CSV Converter - Making contact management simple and professional.*