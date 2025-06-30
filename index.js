/**
 * WhatsApp XLSX Converter — v1.6
 * • XLSX attachment with .xlsx extension in URL (required by WhatsApp)
 * • multi-file intake ▸ duplicate resolver
 */

const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const XLSX     = require('xlsx');
const { v4: uuid } = require('uuid');
require('dotenv').config();

console.log('ENV REDIS_URL =', process.env.REDIS_URL || 'undefined');
process.on('uncaughtException', e => { console.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('UNHANDLED', e); process.exit(1); });

const { parseVCF } = require('./src/vcf-parser');
const sessionStore = require('./src/session-store');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://whatsapp-csv-converter-production.up.railway.app';

const FILE_TTL = 900;               // seconds
const DUP_TIMEOUT = 60_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

app.use(express.urlencoded({ extended: false }));
const OK='✅', WARN='⚠️', THINK='🤔';
const twiml = () => new twilio.twiml.MessagingResponse();

/* ───────── webhook ───────── */
app.post('/webhook', async (req,res)=>{
  const {Body='',From,NumMedia=0}=req.body;
  const media=+NumMedia||0;
  const rsp=twiml();

  try{
    const dup=await sessionStore.getDupState(From);
    if(dup){await dupReply({Body,From,rsp,dup});return done(res,rsp);}

    if(media){
      const tot=await intake({req,From,media});
      rsp.message(`📊 I’ve stashed *${tot}* contacts so far.\n\n1️⃣ Crunch them now  |  2️⃣ Send more`);
      return done(res,rsp);
    }

    const k=Body.trim();
    if(k==='2'){rsp.message('👍 Send the next card when ready.');return done(res,rsp);}
    if(k==='1'){await convert({From,rsp});return done(res,rsp);}

    rsp.message('👋 Send contact cards and I’ll cook up a spreadsheet for you!');
  }catch(e){console.error(e);rsp.message(`${WARN} Oops – something broke. Try again.`);}
  done(res,rsp);
});

/* ───────── intake / convert ───────── */
async function intake({req,From,media}){
  const pile=[];
  for(let i=0;i<media;i++){
    const url=req.body[`MediaUrl${i}`]; if(!url)continue;
    pile.push(...parseVCF(await fetchVCF(url)));
  }
  return sessionStore.appendContacts(From,pile);
}

async function convert({From,rsp}){
  const staged=await sessionStore.popContacts(From);
  if(!staged.length){rsp.message(`${THINK} Nothing staged yet!`);return;}

  const {uniques,duplicates}=dedupe(staged);
  if(duplicates.length){
    await sessionStore.setDupState(From,{uniques,duplicates,cursor:0,chosen:[]},DUP_TIMEOUT/1000);
    return promptDup({From,rsp});
  }
  await sendXLSX({From,list:uniques,rsp});
}

async function dupReply({Body,From,rsp,dup}){
  if(!/^[12]$/.test(Body.trim())){rsp.message('Please tap 1️⃣ or 2️⃣.');return;}
  dup.chosen.push(dup.duplicates[dup.cursor][Body.trim()==='1'?0:1]);
  dup.cursor++;

  if(dup.cursor<dup.duplicates.length){
    await sessionStore.setDupState(From,dup,DUP_TIMEOUT/1000);
    promptDup({From,rsp}); return;
  }
  await sessionStore.clearDupState(From);
  await sendXLSX({From,list:dup.uniques.concat(dup.chosen),rsp});
}

/* ───────── helpers ───────── */
async function fetchVCF(url){
  const {TWILIO_ACCOUNT_SID:sid,TWILIO_AUTH_TOKEN:tok}=process.env;
  return (await axios.get(url,{auth:{username:sid,password:tok},responseType:'text'})).data;
}

function dedupe(list){
  const m=new Map();
  list.forEach(c=>{if(!c.mobile)return;if(!m.has(c.mobile))m.set(c.mobile,[]);m.get(c.mobile).push(c);});
  const u=[],d=[];m.forEach(a=>a.length===1?u.push(a[0]):d.push(a));return{uniques:u,duplicates:d};
}

function promptDup({From,rsp}){
  sessionStore.getDupState(From).then(s=>{
    const g=s.duplicates[s.cursor];
    rsp.message(`${WARN} Same number: ${g[0].mobile}\n\n1️⃣ ${g[0].name||'No Name'}\n2️⃣ ${g[1].name||'No Name'}\n\nPick 1 or 2.`);
  });
}

function buildWorkbook(list){
  const header=['Name','Phone','Email','Passes'];
  const rows=list.map(c=>[c.name,c.mobile,c.email||'',c.passes||1]);
  const ws=XLSX.utils.aoa_to_sheet([header,...rows]);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Contacts');
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}

async function sendXLSX({From,list,rsp}){
  const bin=buildWorkbook(list);
  const id=uuid();
  const b64=bin.toString('base64');
  const filename=`contacts_${Date.now()}.xlsx`;

  await sessionStore.setTempFile(id,{content:b64,filename,b64:true},FILE_TTL);

  // URL ends in .xlsx so WhatsApp accepts it
  const url=`${BASE_URL}/files/${id}.xlsx`;

  console.log(`📎 Sent XLSX with ${list.length} entries to ${From}`);
  rsp.message(`${OK} *Conversion complete!* – sending ${list.length} contacts…`).media(url);
}

function done(res,t){res.type('text/xml').send(t.toString());}

/* ───────── file endpoints (with .xlsx ext) ───────── */
app.get('/files/:id.xlsx',async(req,res)=>{
  const id=req.params.id;
  const f=await sessionStore.getTempFile(id);
  if(!f)return res.sendStatus(404);
  const buf=Buffer.from(f.content,'base64');
  res.setHeader('Content-Type',XLSX_MIME);
  res.setHeader('Content-Disposition',`attachment; filename="${f.filename}"`);
  res.send(buf);
});

app.head('/files/:id.xlsx',async(req,res)=>{
  const id=req.params.id;
  const f=await sessionStore.getTempFile(id);
  if(!f)return res.sendStatus(404);
  res.setHeader('Content-Type',XLSX_MIME);
  res.setHeader('Content-Disposition',`attachment; filename="${f.filename}"`);
  res.setHeader('Content-Length',Buffer.byteLength(Buffer.from(f.content,'base64')));
  res.sendStatus(200);
});

/* ───────── boot ───────── */
app.listen(PORT,()=>console.log(`🚀 XLSX-bot @${PORT}`));
