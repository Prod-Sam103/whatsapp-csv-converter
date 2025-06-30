/* …everything above unchanged… */

/* ---------- utilities ----------------------------------------------------- */
async function dl(url) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok } = process.env;
  const r = await axios.get(url, { auth: { username: sid, password: tok }, responseType: 'text' });
  return r.data;
}

/* fixed splitDup */
function splitDup(list) {
  const map = new Map();
  list.forEach(c => {
    if (!c.mobile) return;
    if (!map.has(c.mobile)) map.set(c.mobile, []);
    map.get(c.mobile).push(c);
  });
  const uniques = [], duplicates = [];
  map.forEach(arr => (arr.length === 1 ? uniques : duplicates).push(arr.length === 1 ? arr[0] : arr));
  return { uniques, duplicates };
}

function promptDup({ From, reply }) { /* unchanged */ }

/* …rest of file unchanged… */
