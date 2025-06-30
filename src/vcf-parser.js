/**
 * VCF parser  – handles desktop/web quoted-printable & strips emoji
 */
function unqp(str){
  if(!/=/.test(str)) return str;
  return Buffer.from(str.replace(/=0D=0A|=0A/g,'')
                        .replace(/=/g,''), 'hex').toString('utf8');
}
function deEmoj(text=''){return text.replace(/\p{Extended_Pictographic}/gu,'').trim();}

function parseVCF(raw){
  const out=[];
  raw.replace(/\r\n/g,'\n').split(/BEGIN:VCARD/i).forEach(card=>{
    if(!card.includes('END:VCARD')) return;
    const c={name:'',mobile:'',email:''};
    const L=card.split('\n').map(l=>l.trim()).filter(Boolean);

    /* FN or N */
    const fn=L.find(l=>/^FN[:;]/i.test(l));
    if(fn) c.name = unqp(fn.replace(/^FN[:;]/i,''));
    if(!c.name){
      const n=L.find(l=>/^N:/i.test(l));
      if(n){
        const p=n.slice(2).split(';');
        c.name=(p[1]||'')+' '+(p[0]||''); }
    }
    c.name=deEmoj(c.name);

    /* TEL */
    const tel=L.find(l=>/^TEL.*:/i.test(l)||/^item\d+\.TEL/i.test(l));
    if(tel){
      let num=tel.split(':').pop().replace(/[^\d+]/g,'');
      if(/^0[789]\d{9}$/.test(num)) num='+234'+num.slice(1);
      if(/^\d{10,}$/.test(num)&&!num.startsWith('+')) num='+'+num;
      c.mobile=num;
    }
    if(c.name||c.mobile) out.push(c);
  });
  return out;
}

module.exports={parseVCF};
