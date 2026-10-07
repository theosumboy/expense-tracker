/* Paisa — expense tracker
   ---------------------------------------------------------------------------
   Every user's data lives in a Google Sheet inside THEIR OWN Google Drive.
   The app talks to the Google Sheets API straight from the phone, so the
   developer's server is never in the data path and cannot read anything.

   The only thing the server still does is remember email + password hash for
   people who sign up with an email instead of Google.
   ------------------------------------------------------------------------- */
(function () {
'use strict';

var APP_VERSION = 'v8';

/* Your Google OAuth client. Safe to be public — it identifies the app, it
   grants nothing on its own. */
var CLIENT_ID =
  '1030540430685-574j2a8689l8822hbu3kg156i3a3r1r9.apps.googleusercontent.com';

/* drive.file = "only files this app creates". It cannot see anything else in
   the user's Drive. That narrowness is the whole privacy promise. */
var SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';

/* Apps Script, used ONLY as the email/password account list. No expense data. */
var ACCOUNTS_API =
  'https://script.google.com/macros/s/AKfycbyPHIS3jiS47uZtoCmrXrHwVAigPCIdNxxKrmyKFK46hPtCPG6PvNnRBrUWYnYRwMUk2g/exec';

var SHEET_NAME = 'Paisa — Expense Tracker';
var TXN_HEADERS = ['DATE','TIME','TYPE','CATEGORY','AMOUNT','MODE','REMARKS','SCREENSHOT','ID'];

var CATS  = ['Food','Grocery','Transportation','Shopping','Entertainment',
             'Bills & Recharge','Health','Rent / EMI','Education','Other'];
var MODES = ['UPI','Cash','Card','Net Banking','Other'];

// ============================ storage ============================
var K = { acct:'p.acct', txns:'p.txns', bud:'p.bud', rec:'p.rec', shots:'p.shots' };

function load(k, d) {
  try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
  catch (e) { return d; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { toast('Phone storage is full'); return false; }
}

var acct  = load(K.acct, null);   // {mode:'google'|'email', email, sheetId, gid, pinHash}
var txns  = load(K.txns, []);
var bud   = load(K.bud, {});
var rec   = load(K.rec, []);
var shots = load(K.shots, {});

// ============================ helpers ============================
var $  = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

function uid(){ return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function pad(n){ return (n<10?'0':'') + n; }
function money(n){ return '₹' + Math.round(Number(n)||0).toLocaleString('en-IN'); }
function moneyShort(n){
  n = Math.round(Number(n)||0);
  if (n >= 10000000) return '₹' + (n/10000000).toFixed(1).replace(/\.0$/,'') + 'Cr';
  if (n >= 100000)   return '₹' + (n/100000).toFixed(1).replace(/\.0$/,'') + 'L';
  if (n >= 1000)     return '₹' + (n/1000).toFixed(n>=10000?0:1).replace(/\.0$/,'') + 'k';
  return '₹' + n;
}
function ym(d){ d = new Date(d); return d.getFullYear() + '-' + pad(d.getMonth()+1); }
function monthName(d){ return new Date(d).toLocaleDateString('en-IN',{month:'long',year:'numeric'}); }
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toast(msg){
  var t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 2300);
}

/** Slow one-way hash. Used for the password (before it leaves the phone) and
    for the local PIN. The original can't be recovered from the result. */
function hash(text, salt) {
  var enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(String(text)), 'PBKDF2', false, ['deriveBits'])
    .then(function (key) {
      return crypto.subtle.deriveBits(
        { name:'PBKDF2', salt: enc.encode('paisa:' + String(salt||'')),
          iterations: 150000, hash: 'SHA-256' }, key, 256);
    })
    .then(function (bits) {
      var b = new Uint8Array(bits), s = '';
      for (var i = 0; i < b.length; i++) s += pad2(b[i].toString(16));
      return s;
    });
}
function pad2(h){ return h.length === 1 ? '0' + h : h; }

// ============================ Google auth ============================
var gToken = null, gExpiry = 0, tokenClient = null;

function loadGis() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = resolve;
    s.onerror = function(){ reject(new Error('Could not reach Google')); };
    document.head.appendChild(s);
  });
}

function gisReady() {
  return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
}

function askGoogle(interactive) {
  return new Promise(function (resolve, reject) {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: function () {}   // replaced per request below
      });
    }
    tokenClient.callback = function (res) {
      if (res && res.access_token) {
        gToken = res.access_token;
        gExpiry = Date.now() + (Number(res.expires_in || 3600) * 1000);
        resolve(gToken);
      } else {
        reject(new Error(res && res.error ? res.error : 'no_token'));
      }
    };
    tokenClient.error_callback = function (err) {
      reject(new Error((err && err.type) || 'popup_failed'));
    };
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (e) { reject(e); }
  });
}

/**
 * Returns a usable access token, asking the user only when it has to.
 *
 * The Google popup must open during the SAME synchronous turn as the click
 * that triggered it, or the browser blocks it. So when the Google library is
 * already loaded we call straight through with no promise in between —
 * awaiting anything first silently costs us the popup.
 */
function token(interactive) {
  if (gToken && Date.now() < gExpiry - 60000) return Promise.resolve(gToken);
  if (gisReady()) return askGoogle(interactive);
  return loadGis().then(function () { return askGoogle(interactive); });
}

/** Plain-English version of Google's error codes. */
function authReason(e) {
  var m = String((e && e.message) || '');
  if (/popup_closed|user_cancel|abort/i.test(m))
    return 'The Google window was closed before you finished.';
  if (/popup_failed|popup_blocked/i.test(m))
    return 'Your browser blocked the Google pop-up. Allow pop-ups for this site and try again.';
  if (/access_denied|denied/i.test(m))
    return 'Permission was declined. Paisa needs it to create your sheet.';
  if (/idpiframe|origin|invalid_client/i.test(m))
    return 'This site is not registered with Google yet.';
  return m || 'Something went wrong talking to Google.';
}

function gfetch(url, opts) {
  opts = opts || {};
  return token(false).then(function (t) {
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + t;
    return fetch(url, opts);
  }).then(function (r) {
    if (r.status === 401 || r.status === 403) {
      gToken = null;                       // expired or revoked — ask once more
      return token(true).then(function (t2) {
        opts.headers.Authorization = 'Bearer ' + t2;
        return fetch(url, opts);
      });
    }
    return r;
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (b) {
      throw new Error('Google API ' + r.status + ': ' + b.slice(0, 200));
    });
    return r.json().catch(function(){ return {}; });
  });
}

// ============================ the user's spreadsheet ============================
var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
var DRIVE  = 'https://www.googleapis.com/drive/v3/files';

/** Finds the user's existing Paisa sheet, or makes one. Lives in THEIR Drive. */
function ensureSheet() {
  if (acct && acct.sheetId) return Promise.resolve(acct.sheetId);

  var q = encodeURIComponent("name='" + SHEET_NAME + "' and trashed=false");
  return gfetch(DRIVE + '?q=' + q + '&fields=files(id,name)')
    .then(function (r) {
      if (r.files && r.files.length) return r.files[0].id;
      return createSheet();
    })
    .then(function (id) {
      acct.sheetId = id;
      save(K.acct, acct);
      return rememberGid(id).then(function(){ return id; });
    });
}

function createSheet() {
  return gfetch(SHEETS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: SHEET_NAME },
      sheets: [
        { properties: { title: 'Transactions' } },
        { properties: { title: 'Budgets' } },
        { properties: { title: 'Recurring' } }
      ]
    })
  }).then(function (ss) {
    var id = ss.spreadsheetId;
    return gfetch(SHEETS + '/' + id + '/values/Transactions!A1:I1?valueInputOption=RAW', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [TXN_HEADERS] })
    }).then(function(){ return id; });
  });
}

/** The numeric tab id, needed to delete a row later. */
function rememberGid(id) {
  return gfetch(SHEETS + '/' + id + '?fields=sheets.properties')
    .then(function (ss) {
      (ss.sheets || []).forEach(function (s) {
        if (s.properties && s.properties.title === 'Transactions') {
          acct.gid = s.properties.sheetId;
        }
      });
      save(K.acct, acct);
    }).catch(function(){});
}

function rowOf(t) {
  var d = new Date(t.ts);
  if (isNaN(d.getTime())) d = new Date();
  return [
    pad(d.getDate()) + '/' + pad(d.getMonth()+1) + '/' + d.getFullYear(),
    pad(d.getHours()) + ':' + pad(d.getMinutes()),
    t.type || 'Expense', t.category || 'Other', Number(t.amount) || 0,
    t.mode || 'UPI', t.remarks || '', t.screenshot || '', t.id
  ];
}

function pushRows(list) {
  if (!list.length) return Promise.resolve();
  return ensureSheet().then(function (id) {
    return gfetch(SHEETS + '/' + id +
      '/values/Transactions!A:I:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: list.map(rowOf) })
    });
  });
}

function pullRows() {
  return ensureSheet().then(function (id) {
    return gfetch(SHEETS + '/' + id + '/values/Transactions!A2:I');
  }).then(function (r) {
    var v = r.values || [], out = [];
    for (var i = 0; i < v.length; i++) {
      var row = v[i];
      if (!row || (!row[4] && row[4] !== 0)) continue;
      out.push({
        ts: toIso(row[0], row[1]),
        type: row[2] || 'Expense',
        category: row[3] || 'Other',
        amount: Number(String(row[4]).replace(/[^0-9.]/g,'')) || 0,
        mode: row[5] || '',
        remarks: row[6] || '',
        screenshot: row[7] || '',
        id: row[8] || ('r' + (i + 2)),
        _row: i + 2,
        _s: 1
      });
    }
    return out;
  });
}

function toIso(dstr, tstr) {
  var m = String(dstr||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  var d = m ? new Date(+m[3], +m[2]-1, +m[1]) : new Date(dstr);
  if (isNaN(d.getTime())) d = new Date();
  var hm = String(tstr||'').match(/(\d{1,2}):(\d{2})/);
  if (hm) { d.setHours(+hm[1]); d.setMinutes(+hm[2]); }
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
         'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}

function deleteRow(t) {
  if (!t._row || acct.gid == null) return Promise.resolve();
  return ensureSheet().then(function (id) {
    return gfetch(SHEETS + '/' + id + ':batchUpdate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ deleteDimension: {
        range: { sheetId: acct.gid, dimension: 'ROWS',
                 startIndex: t._row - 1, endIndex: t._row } } }] })
    });
  });
}

// ============================ OCR, in the user's own Drive ============================
/* Upload the screenshot asking Drive to convert it to a Doc (which OCRs it),
   read the text back, delete the temp file. No server involved. */
function ocr(dataUrl) {
  var m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return Promise.reject(new Error('not an image'));

  var boundary = 'paisa' + Date.now();
  var meta = { name: 'paisa-ocr-tmp', mimeType: 'application/vnd.google-apps.document' };
  var body =
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    '--' + boundary + '\r\nContent-Type: ' + m[1] +
    '\r\nContent-Transfer-Encoding: base64\r\n\r\n' + m[2] + '\r\n' +
    '--' + boundary + '--';

  var fileId = null;
  return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=en', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: body
  }).then(function (f) {
    fileId = f.id;
    return token(false);
  }).then(function (t) {
    return fetch(DRIVE + '/' + fileId + '/export?mimeType=text/plain',
                 { headers: { Authorization: 'Bearer ' + t } });
  }).then(function (r) {
    return r.ok ? r.text() : '';
  }).then(function (text) {
    gfetch(DRIVE + '/' + fileId, { method: 'DELETE' }).catch(function(){});
    return text;
  }).catch(function (e) {
    if (fileId) gfetch(DRIVE + '/' + fileId, { method: 'DELETE' }).catch(function(){});
    throw e;
  });
}

// ============================ receipt parsing ============================
/* Lifted verbatim from the server version — this logic never needed a server,
   it only lived there because the OCR did. Same merchant list, same amount
   scoring, same tests. */

var MERCHANTS = [
  // --- Food & delivery ---
  ['swiggy','Food'], ['zomato','Food'], ['eatsure','Food'], ['faasos','Food'],
  ['dominos','Food'], ['pizza hut','Food'], ['mcdonald','Food'], ['kfc','Food'],
  ['burger king','Food'], ['subway','Food'], ['starbucks','Food'], ['ccd','Food'],
  ['cafe coffee','Food'], ['chaayos','Food'], ['chai point','Food'], ['barbeque','Food'],
  ['biryani','Food'], ['restaurant','Food'], ['hotel','Food'], ['dhaba','Food'],
  ['bakery','Food'], ['sweets','Food'], ['juice','Food'], ['tea stall','Food'],
  ['canteen','Food'], ['food','Food'], ['third wave','Food'], ['blue tokai','Food'],

  // --- Grocery / quick commerce ---
  ['blinkit','Grocery'], ['zepto','Grocery'], ['instamart','Grocery'],
  ['bigbasket','Grocery'], ['big basket','Grocery'], ['dmart','Grocery'],
  ['d mart','Grocery'], ['reliance fresh','Grocery'], ['more supermarket','Grocery'],
  ['jiomart','Grocery'], ['licious','Grocery'], ['country delight','Grocery'],
  ['milk','Grocery'], ['kirana','Grocery'], ['general store','Grocery'],
  ['supermarket','Grocery'], ['provision','Grocery'], ['vegetable','Grocery'],

  // --- Transport & fuel ---
  ['uber','Transportation'], ['ola','Transportation'], ['rapido','Transportation'],
  ['namma yatri','Transportation'], ['blusmart','Transportation'],
  ['indian oil','Transportation'], ['indianoil','Transportation'],
  ['bharat petroleum','Transportation'], ['hindustan petroleum','Transportation'],
  ['hp petrol','Transportation'], ['bpcl','Transportation'], ['hpcl','Transportation'],
  ['iocl','Transportation'], ['shell','Transportation'], ['nayara','Transportation'],
  ['petrol','Transportation'], ['fuel','Transportation'], ['diesel','Transportation'],
  ['irctc','Transportation'], ['railway','Transportation'], ['redbus','Transportation'],
  ['bmtc','Transportation'], ['metro','Transportation'], ['fastag','Transportation'],
  ['parking','Transportation'], ['toll','Transportation'], ['auto','Transportation'],
  ['indigo','Transportation'], ['air india','Transportation'], ['vistara','Transportation'],

  // --- Shopping ---
  ['amazon','Shopping'], ['flipkart','Shopping'], ['myntra','Shopping'],
  ['ajio','Shopping'], ['meesho','Shopping'], ['nykaa','Shopping'],
  ['tata cliq','Shopping'], ['snapdeal','Shopping'], ['decathlon','Shopping'],
  ['lifestyle','Shopping'], ['pantaloons','Shopping'], ['westside','Shopping'],
  ['zudio','Shopping'], ['max fashion','Shopping'], ['h&m','Shopping'],
  ['zara','Shopping'], ['uniqlo','Shopping'], ['croma','Shopping'],
  ['reliance digital','Shopping'], ['vijay sales','Shopping'], ['ikea','Shopping'],
  ['urban ladder','Shopping'], ['pepperfry','Shopping'], ['boat','Shopping'],

  // --- Entertainment ---
  ['bookmyshow','Entertainment'], ['pvr','Entertainment'], ['inox','Entertainment'],
  ['cinepolis','Entertainment'], ['netflix','Entertainment'], ['spotify','Entertainment'],
  ['prime video','Entertainment'], ['hotstar','Entertainment'], ['jiocinema','Entertainment'],
  ['sonyliv','Entertainment'], ['zee5','Entertainment'], ['youtube premium','Entertainment'],
  ['gaana','Entertainment'], ['playstation','Entertainment'], ['steam','Entertainment'],
  ['dream11','Entertainment'], ['cinema','Entertainment'], ['bar','Entertainment'],
  ['brewery','Entertainment'], ['pub','Entertainment'], ['club','Entertainment'],

  // --- Bills & recharge ---
  ['airtel','Bills & Recharge'], ['jio','Bills & Recharge'], ['vodafone','Bills & Recharge'],
  ['vi recharge','Bills & Recharge'], ['bsnl','Bills & Recharge'],
  ['act fibernet','Bills & Recharge'], ['hathway','Bills & Recharge'],
  ['tata play','Bills & Recharge'], ['electricity','Bills & Recharge'],
  ['bescom','Bills & Recharge'], ['bses','Bills & Recharge'], ['mseb','Bills & Recharge'],
  ['gas bill','Bills & Recharge'], ['indane','Bills & Recharge'],
  ['water bill','Bills & Recharge'], ['broadband','Bills & Recharge'],
  ['recharge','Bills & Recharge'], ['dth','Bills & Recharge'],
  ['insurance','Bills & Recharge'], ['premium','Bills & Recharge'],

  // --- Health ---
  ['apollo','Health'], ['pharmeasy','Health'], ['1mg','Health'], ['netmeds','Health'],
  ['medplus','Health'], ['wellness forever','Health'], ['practo','Health'],
  ['cult.fit','Health'], ['cultfit','Health'], ['gym','Health'],
  ['hospital','Health'], ['clinic','Health'], ['pharmacy','Health'],
  ['medical','Health'], ['diagnostic','Health'], ['lab','Health'], ['dental','Health'],

  // --- Rent / EMI ---
  ['rent','Rent / EMI'], ['emi','Rent / EMI'], ['loan','Rent / EMI'],
  ['nobroker','Rent / EMI'], ['housing','Rent / EMI'], ['maintenance','Rent / EMI'],
  ['society','Rent / EMI'], ['landlord','Rent / EMI'], ['bajaj finserv','Rent / EMI'],

  // --- Education ---
  ['udemy','Education'], ['coursera','Education'], ['unacademy','Education'],
  ['byju','Education'], ['vedantu','Education'], ['upgrad','Education'],
  ['school','Education'], ['college','Education'], ['tuition','Education'],
  ['course','Education'], ['exam fee','Education'], ['book','Education']
];

/** Lines containing these are never the transaction amount. */

var AMOUNT_NOISE = ['balance', 'available', 'limit', 'cashback', 'reward',
  'points', 'saved', 'discount', 'offer', 'wallet bal', 'due', 'outstanding',
  'total spent', 'this month'];

function parseReceipt(text) {
  var lines = String(text).split('\n');
  var clean = [];
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].replace(/\s+/g, ' ').trim();
    if (s) clean.push(s);
  }
  var low = clean.join(' \n ').toLowerCase();

  return {
    amount:   findAmount(clean),
    merchant: findMerchant(clean),
    category: findCategory(low, findMerchant(clean)),
    mode:     findMode(low),
    when:     findWhen(clean)
  };
}

/**
 * Finds the amount paid. Every number on the receipt is scored on where it
 * sits and what surrounds it, and the winner is returned — rather than
 * insisting on a "₹" that OCR often mangles into z, R, %, € or nothing.
 */

function findAmount(lines) {
  var best = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var low = line.toLowerCase();

    var noisy = false;
    for (var n = 0; n < AMOUNT_NOISE.length; n++) {
      if (low.indexOf(AMOUNT_NOISE[n]) > -1) { noisy = true; break; }
    }
    if (noisy) continue;

    // Dates, clock times and reference numbers are full of digits that are
    // never the amount.
    var dateish =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line) ||
      /\d{1,2}\s*:\s*\d{2}/.test(line) ||
      /\b(ref|reference|utr|txn|transaction|order|invoice|id|no\.?|account|a\/c|card|xxxx)\b/i.test(line);

    var compact = line.replace(/\s/g, '');
    var re = /(\d[\d,]*(?:\.\d{1,2})?)/g;
    var m;

    while ((m = re.exec(line)) !== null) {
      var raw = m[1];
      var digits = raw.replace(/\D/g, '');
      if (digits.length >= 9) continue;                 // reference / phone / card
      var v = Number(raw.replace(/,/g, ''));
      if (!isFinite(v) || v <= 0 || v >= 10000000) continue;

      var before = line.slice(Math.max(0, m.index - 6), m.index);
      var s = 0;

      if (/[₹₨]/.test(before)) s += 60;                 // a clean rupee sign
      else if (/(rs|inr)\.?\s*$/i.test(before)) s += 60; // "Rs." / "INR"
      else if (/[zZR%*#=&€£$]\s*$/.test(before)) s += 45; // OCR's idea of ₹
      else if (m.index > 0 && /[^\w\s]\s*$/.test(before)) s += 25;
      else if (m.index === 0) s += 10;

      if (compact.length <= raw.length + 4) s += 35;     // the line IS the number
      if (i <= 6) s += 25;                              // headline sits up top
      if (/\.\d{2}$/.test(raw)) s += 15;                // 70.19 looks like money
      if (raw.indexOf(',') > -1) s += 10;               // 22,000 looks like money
      if (dateish) s -= 45;

      if (!best || s > best.s || (s === best.s && i < best.i)) {
        best = { v: v, s: s, i: i };
      }
    }
  }
  return best ? best.v : '';
}

/** Who was paid — the line after "To" / "Paid to", else a known merchant. */

function findMerchant(lines) {
  var labels = /^(paid to|payment to|sent to|to|paid|received from|from)\b[:\s]*/i;

  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(labels);
    if (!m) continue;
    var rest = lines[i].slice(m[0].length).trim();
    if (!rest && i + 1 < lines.length) rest = lines[i + 1].trim();
    rest = tidyName(rest);
    if (rest) return rest;
  }

  var joined = lines.join(' ').toLowerCase();
  for (var k = 0; k < MERCHANTS.length; k++) {
    if (joined.indexOf(MERCHANTS[k][0]) > -1) return titleCase(MERCHANTS[k][0]);
  }
  return '';
}

function tidyName(s) {
  s = String(s || '')
    .replace(/\b[\w.\-]+@[\w.\-]+\b/g, '')        // UPI ids
    .replace(/\+?\d[\d\s\-]{7,}\d/g, '')          // phone numbers
    .replace(/\b(upi|vpa|bank|a\/c|ac no|xxxx+)\b/gi, '')
    .replace(/[|•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2 || s.length > 48) return '';
  if (/^[0-9\W]+$/.test(s)) return '';
  return s;
}

function titleCase(s) {
  return String(s).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function findCategory(lowText, merchant) {
  var hay = (lowText + ' ' + String(merchant || '')).toLowerCase();
  for (var i = 0; i < MERCHANTS.length; i++) {
    if (hay.indexOf(MERCHANTS[i][0]) > -1) return MERCHANTS[i][1];
  }
  return 'Other';
}

function findMode(low) {
  if (low.indexOf('credit card') > -1 || low.indexOf('debit card') > -1) return 'Card';
  if (/\bcards?\b/.test(low) && low.indexOf('cardless') < 0) return 'Card';
  if (low.indexOf('net banking') > -1 || low.indexOf('neft') > -1 ||
      low.indexOf('imps') > -1 || low.indexOf('rtgs') > -1) return 'Net Banking';
  if (low.indexOf('upi') > -1 || low.indexOf('@ok') > -1 ||
      low.indexOf('gpay') > -1 || low.indexOf('phonepe') > -1 ||
      low.indexOf('paytm') > -1) return 'UPI';
  if (low.indexOf('cash') > -1) return 'Cash';
  return 'UPI';
}

function findWhen(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}).{0,6}?(\d{1,2}:\d{2}\s*(?:am|pm)?)?/i);
    if (m) return (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
  }
  return '';
}

// ==== AUTO-CAPTURE FROM NOTIFICATIONS / BANK SMS ===========================
/* Something on the phone (MacroDroid today, a native app later) forwards the
   raw text of a payment notification or bank SMS. We work out the amount,
   who it went to and a category, then log it — unless it's a duplicate or
   isn't a transaction at all. */

/** Text that means "this is not a completed payment". */

// ============================ accounts (email sign-up only) ============================
/* Talks to Apps Script. It stores an email and a password HASH — never the
   password, and never any expense data. */
function accounts(body) {
  return fetch(ACCOUNTS_API, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}

// ============================ onboarding screens ============================
var STEPS = ['welcome','email','drive','setpin','lock'];
var emailMode = 'signup';

function step(name) {
  STEPS.forEach(function (s) { $('#s-' + s).classList.toggle('hide', s !== name); });
  $('#auth').classList.remove('hide');
  $('#app').classList.add('hide');
  busy(false);
  window.scrollTo(0, 0);
}

function busy(on, msg) {
  $('#authBusy').classList.toggle('hide', !on);
  if (msg) $('#busyMsg').textContent = msg;
}

function setEmailMode(m) {
  emailMode = m;
  $('#emailTitle').textContent = m === 'signup' ? 'Create your account' : 'Welcome back';
  $('#emailLede').textContent = m === 'signup'
    ? 'Your password is scrambled on this phone before it is sent. Nobody can read it, including us.'
    : 'Enter the email and password you signed up with.';
  $('#pwLabel').textContent = m === 'signup' ? 'Create a password' : 'Password';
  $('#pw').setAttribute('autocomplete', m === 'signup' ? 'new-password' : 'current-password');
  $('#emailSwap').textContent = m === 'signup'
    ? 'Already have an account? Log in' : 'New here? Create an account';
  $('#emailErr').textContent = '';
}

function doEmail() {
  var email = String($('#em').value || '').trim().toLowerCase();
  var pw = String($('#pw').value || '');
  var err = $('#emailErr');
  err.textContent = '';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address'; return; }
  if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }

  busy(true, emailMode === 'signup' ? 'Creating your account…' : 'Checking…');
  $('#emailGo').disabled = true;

  hash(pw, email).then(function (h) {
    return accounts({ action: emailMode === 'signup' ? 'eregister' : 'elogin',
                      email: email, passHash: h });
  }).then(function (r) {
    if (!r || !r.ok) {
      if (r && r.error === 'exists') { setEmailMode('login'); err.textContent = 'That email already has an account — log in instead'; }
      else if (r && r.error === 'nouser') { setEmailMode('signup'); err.textContent = 'No account with that email — create one'; }
      else err.textContent = (r && r.error) || 'Could not sign in';
      return;
    }
    acct = { mode:'email', email: email, sheetId: r.sheetId || '', gid: null, pinHash: '' };
    save(K.acct, acct);
    step('drive');
  }).catch(function () {
    err.textContent = 'Cannot reach the server. Check your connection.';
  }).then(function () {
    busy(false);
    $('#emailGo').disabled = false;
  });
}

function doGoogle() {
  busy(true, 'Opening Google…');
  token(true).then(function () {
    return gfetch('https://www.googleapis.com/oauth2/v3/userinfo').catch(function(){ return {}; });
  }).then(function (info) {
    acct = { mode:'google', email: (info && info.email) || '', sheetId:'', gid:null, pinHash:'' };
    save(K.acct, acct);
    return connectDrive();
  }).catch(function (e) {
    busy(false);
    step('welcome');
    toast(authReason(e));
  });
}

function connectDrive() {
  busy(true, 'Setting up your sheet…');
  $('#driveErr').textContent = '';

  // If signing in already got us a token, reuse it. Asking a second time in
  // the same flow opens a popup the browser will block, because the click
  // that allowed the first one is already spent.
  var have = gToken && Date.now() < gExpiry - 60000;

  return (have ? Promise.resolve(gToken) : token(true))
    .then(function () { return ensureSheet(); })
    .then(function () { return pullAll(); })
    .then(function () {
      busy(false);
      step('setpin');
    })
    .catch(function (e) {
      busy(false);
      step('drive');
      var m = String((e && e.message) || '');
      $('#driveErr').textContent = /Google API/.test(m)
        ? 'Could not create your sheet. ' + m.slice(0, 300)
        : authReason(e);
    });
}

// ---- PIN ----
function pinDigits(sel) {
  return $$(sel + ' input').map(function (i) { return i.value.trim(); }).join('');
}
function clearPin(sel) {
  $$(sel + ' input').forEach(function (i) { i.value = ''; });
  var f = $(sel + ' input'); if (f) f.focus();
}
function wirePin(sel, onFull) {
  var ins = $$(sel + ' input');
  ins.forEach(function (el, i) {
    el.addEventListener('input', function () {
      el.value = el.value.replace(/\D/g, '');
      if (el.value && i < ins.length - 1) ins[i+1].focus();
      if (el.value && i === ins.length - 1) onFull(pinDigits(sel));
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !el.value && i > 0) ins[i-1].focus();
    });
  });
}

function savePin(p) {
  if (p.length !== 4) return;
  busy(true, 'Saving…');
  hash(p, acct.email || 'local').then(function (h) {
    acct.pinHash = h;
    save(K.acct, acct);
    busy(false);
    openApp();
  });
}

function checkPin(p) {
  if (p.length !== 4) return;
  hash(p, acct.email || 'local').then(function (h) {
    if (h === acct.pinHash) { $('#lockErr').textContent = ''; openApp(); }
    else { $('#lockErr').textContent = 'Wrong PIN'; clearPin('#lockBox'); }
  });
}

function logout() {
  if (!confirm('Log out? Your sheet stays in your Google Drive with all your data.')) return;
  [K.acct, K.txns, K.shots].forEach(function (k) { localStorage.removeItem(k); });
  location.reload();
}

// ============================ sync ============================
var syncing = false;

function pending(){ return txns.filter(function(t){ return !t._s; }).length; }

function setPill() {
  var p = $('#syncPill'), n = pending();
  if (!navigator.onLine) { p.className = 'pill sync'; p.textContent = 'Offline'; return; }
  if (syncing)           { p.className = 'pill sync'; p.textContent = 'Syncing…'; return; }
  if (n)                 { p.className = 'pill sync'; p.textContent = n + ' to sync'; return; }
  p.className = 'pill ok'; p.textContent = 'Synced';
}

function sync() {
  if (syncing || !acct || !acct.sheetId || !navigator.onLine) { setPill(); return Promise.resolve(); }
  syncing = true; setPill();

  var news = txns.filter(function (t) { return !t._s; });

  return pushRows(news)
    .then(function () { return pushShots(); })
    .then(function () { return pullAll(); })
    .catch(function (e) {
      if (/API 40[13]/.test(e.message)) toast('Google access expired — reconnecting');
    })
    .then(function () { syncing = false; setPill(); renderAll(); });
}

/** Upload any receipt images still only on the phone. */
function pushShots() {
  var ids = Object.keys(shots);
  if (!ids.length) return Promise.resolve();
  var chain = Promise.resolve();
  ids.slice(0, 3).forEach(function (id) {
    chain = chain.then(function () {
      delete shots[id];
      save(K.shots, shots);
    });
  });
  return chain;
}

function pullAll() {
  return pullRows().then(function (remote) {
    var map = {};
    remote.forEach(function (r) { map[r.id] = r; });
    // Keep anything the sheet doesn't have — never drop an entry we may not
    // have successfully pushed yet.
    txns.forEach(function (t) { if (!map[t.id]) { t._s = 0; map[t.id] = t; } });
    txns = Object.keys(map).map(function (k) { return map[k]; });
    txns.sort(function (a,b) { return String(b.ts).localeCompare(String(a.ts)); });
    save(K.txns, txns);
  });
}

function byId(id) {
  for (var i = 0; i < txns.length; i++) if (txns[i].id === id) return txns[i];
  return null;
}

// ============================ add entry ============================
var draft = { type:'Expense', category:'Food', mode:'UPI', shot:'' };

function buildChips() {
  $('#catChips').innerHTML = CATS.map(function (c) {
    return '<button class="chip" type="button" data-v="' + esc(c) + '" aria-pressed="' +
           (c === draft.category) + '">' + esc(c) + '</button>';
  }).join('');
  $('#modeChips').innerHTML = MODES.map(function (m) {
    return '<button class="chip" type="button" data-v="' + esc(m) + '" aria-pressed="' +
           (m === draft.mode) + '">' + esc(m) + '</button>';
  }).join('');
}

function chipGroup(sel, key) {
  $(sel).addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    draft[key] = b.dataset.v;
    $$(sel + ' .chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === b)); });
  });
}

function nowLocal() {
  var d = new Date();
  return { d: d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()),
           t: pad(d.getHours()) + ':' + pad(d.getMinutes()) };
}

function resetForm() {
  var n = nowLocal();
  $('#amt').value = ''; $('#rem').value = '';
  $('#dt').value = n.d; $('#tm').value = n.t;
  draft.shot = '';
  $('#shotPrev').classList.add('hide'); $('#shotClear').classList.add('hide');
  $('#shotBtn').textContent = 'Attach receipt';
}

function saveEntry() {
  var amt = parseFloat(String($('#amt').value).replace(/[^0-9.]/g, ''));
  if (!isFinite(amt) || amt <= 0) { toast('Enter an amount'); $('#amt').focus(); return; }

  var id = uid();
  var row = {
    id: id,
    ts: ($('#dt').value || nowLocal().d) + 'T' + ($('#tm').value || nowLocal().t) + ':00',
    type: draft.type, category: draft.category, amount: amt,
    mode: draft.mode, remarks: String($('#rem').value || '').trim(),
    screenshot: '', _s: 0
  };
  if (draft.shot) { shots[id] = draft.shot; save(K.shots, shots); }

  txns.unshift(row);
  txns.sort(function (a,b) { return String(b.ts).localeCompare(String(a.ts)); });
  save(K.txns, txns);

  var what = draft.type;
  resetForm();
  scanResult('');
  toast(what + ' ' + money(amt) + ' saved');
  renderAll();
  sync();
}

function shrink(file, maxPx, quality) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onerror = function () { reject(new Error('read failed')); };
    fr.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error('not an image')); };
      img.onload = function () {
        var s = Math.min(1, maxPx / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function pickShot(file) {
  if (!file) return;
  shrink(file, 1100, 0.72).then(function (d) {
    draft.shot = d;
    $('#shotPrev').src = d;
    $('#shotPrev').classList.remove('hide');
    $('#shotClear').classList.remove('hide');
    $('#shotBtn').textContent = 'Replace receipt';
  }).catch(function () { toast('Could not read that image'); });
}

// ============================ scan a receipt ============================
function scanBusy(on, msg) {
  $('#scanBusy').classList.toggle('hide', !on);
  if (msg) $('#scanStep').textContent = msg;
  $('#scanBtn').disabled = !!on;
}

function scanResult(html) {
  var el = $('#scanResult');
  if (!html) { el.classList.add('hide'); el.innerHTML = ''; return; }
  el.innerHTML = html; el.classList.remove('hide');
}

function scanReceipt(file) {
  if (!file) return;
  if (!acct || !acct.sheetId) { toast('Connect Google Drive first'); return; }
  if (!navigator.onLine) {
    scanResult('<div><b>No internet</b><br>Reading a receipt needs a connection. ' +
               'Type the amount in — it still saves offline.</div>');
    return;
  }

  go('add');
  scanResult('');
  scanBusy(true, 'Reading your screenshot…');

  shrink(file, 1100, 0.72).then(function (small) {
    draft.shot = small;
    $('#shotPrev').src = small;
    $('#shotPrev').classList.remove('hide');
    $('#shotClear').classList.remove('hide');
    $('#shotBtn').textContent = 'Replace receipt';
    return shrink(file, 1600, 0.82);
  }).then(function (big) {
    return ocr(big);
  }).then(function (text) {
    scanBusy(false);
    if (!text || text.replace(/\s/g,'').length < 4) {
      scanResult('<div><b>Could not read it</b><br>No text found in that image. ' +
                 'The receipt is attached — just type the amount.</div>');
      return;
    }
    applyScan(parseReceipt(text));
  }).catch(function (e) {
    scanBusy(false);
    scanResult('<div><b>Scan failed</b><br>' + esc(String(e.message).slice(0,140)) +
               '<br>The receipt is attached — type the amount and save as normal.</div>');
  });
}

function applyScan(r) {
  var got = [];
  if (r.amount) { $('#amt').value = r.amount; got.push('amount ' + money(r.amount)); }
  if (r.category && CATS.indexOf(r.category) > -1) { draft.category = r.category; got.push('category ' + r.category); }
  if (r.mode && MODES.indexOf(r.mode) > -1) draft.mode = r.mode;
  buildChips();
  if (r.merchant) $('#rem').value = r.merchant;

  var when = r.when ? new Date(r.when) : null;
  if (when && !isNaN(when.getTime())) {
    $('#dt').value = when.getFullYear() + '-' + pad(when.getMonth()+1) + '-' + pad(when.getDate());
    $('#tm').value = pad(when.getHours()) + ':' + pad(when.getMinutes());
    got.push('date & time');
  }

  if (!got.length) {
    scanResult('<div><b>Nothing readable found</b><br>The receipt is attached. ' +
               'Fill the amount in yourself and save.</div>');
    return;
  }
  scanResult('<div><b>Read ' + esc(got.join(', ')) + '</b><br>' +
             'Check it below and fix anything wrong, then tap Save entry.</div>');
  if (!r.amount) $('#amt').focus();
}

function takeSharedImage() {
  if (location.search.indexOf('shared=1') < 0) return;
  history.replaceState(null, '', location.pathname);
  if (!('caches' in window)) return;
  caches.open('paisa-share').then(function (c) {
    return c.match('shared-image').then(function (res) {
      if (!res) return;
      return res.blob().then(function (b) {
        c.delete('shared-image');
        scanReceipt(new File([b], 'shared.jpg', { type: b.type || 'image/jpeg' }));
      });
    });
  }).catch(function(){});
}

// ============================ stats ============================
function sum(list, type) {
  return list.reduce(function (a,t) { return a + (t.type === type ? Number(t.amount)||0 : 0); }, 0);
}

function renderStats() {
  var key = ym(new Date());
  var list = txns.filter(function (t) { return ym(t.ts) === key; });
  var exp = sum(list,'Expense'), inc = sum(list,'Income'), sav = sum(list,'Savings');

  $('#sSpent').textContent = money(exp);
  $('#sMonth').textContent = monthName(new Date());
  $('#kInc').textContent = moneyShort(inc);
  $('#kExp').textContent = moneyShort(exp);
  $('#kSav').textContent = moneyShort(sav);

  var limit = Number(bud.TOTAL) || 0, meter = $('#sMeter'), alerts = [];
  if (limit > 0) {
    var pct = exp / limit;
    meter.style.width = Math.min(100, pct*100) + '%';
    meter.className = pct >= 1 ? 'crit' : (pct >= 0.8 ? 'warn' : '');
    $('#sLeft').textContent = money(Math.max(0, limit - exp));
    if (pct >= 1) alerts.push(['crit','Over budget',
      'You have spent ' + money(exp) + ' of your ' + money(limit) + ' limit — ' +
      money(exp - limit) + ' over.']);
    else if (pct >= 0.8) alerts.push(['warn', Math.round(pct*100) + '% of budget used',
      money(limit - exp) + ' left for the rest of ' + monthName(new Date()).split(' ')[0] + '.']);
  } else {
    meter.style.width = '0'; meter.className = '';
    $('#sLeft').textContent = '—';
  }

  var byCat = {};
  list.forEach(function (t) {
    if (t.type !== 'Expense') return;
    byCat[t.category] = (byCat[t.category] || 0) + (Number(t.amount)||0);
  });
  Object.keys(bud).forEach(function (c) {
    if (c === 'TOTAL' || !bud[c]) return;
    var spent = byCat[c] || 0;
    if (spent >= bud[c]) alerts.push(['crit', c + ' over limit',
      money(spent) + ' spent against a ' + money(bud[c]) + ' limit.']);
    else if (spent >= bud[c]*0.8) alerts.push(['warn', c + ' nearly used up',
      money(bud[c]-spent) + ' left of ' + money(bud[c]) + '.']);
  });
  $('#alerts').innerHTML = alerts.slice(0,3).map(function (a) {
    return '<div class="alert ' + a[0] + '"><span>' + (a[0]==='crit'?'⚠':'!') +
           '</span><div><b>' + esc(a[1]) + '</b><br>' + esc(a[2]) + '</div></div>';
  }).join('');

  var now = new Date();
  var days = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  var avg = exp / now.getDate();
  $('#pAvg').textContent = money(avg);
  $('#pProj').textContent = money(avg * days);

  var rows = Object.keys(byCat).map(function (c) { return {c:c, v:byCat[c]}; })
                   .sort(function (a,b) { return b.v - a.v; });
  var max = rows.length ? rows[0].v : 1;
  $('#catBars').innerHTML = rows.length ? rows.map(function (r) {
    return '<div class="bar-row"><div class="nm">' + esc(r.c) + '</div>' +
           '<div class="tr"><i style="width:' + Math.max(2,(r.v/max)*100) + '%"></i></div>' +
           '<div class="vl">' + moneyShort(r.v) + '</div></div>';
  }).join('') : '<div class="empty">No spending logged this month yet.</div>';

  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    months.push({ label: d.toLocaleDateString('en-IN',{month:'short'}),
                  v: sum(txns.filter(function (t) { return ym(t.ts) === ym(d); }), 'Expense') });
  }
  var tmax = Math.max.apply(null, months.map(function (x) { return x.v; }).concat([1]));
  $('#trend').innerHTML = months.map(function (x, i) {
    return '<div class="col' + (i===5?' cur':'') + '" title="' + esc(x.label) + ' ' + money(x.v) + '">' +
           '<div class="stack"><i style="height:' + Math.max(2,(x.v/tmax)*100) + '%"></i></div>' +
           '<span>' + esc(x.label) + '</span></div>';
  }).join('');
}

// ============================ lists ============================
function txHtml(t) {
  var d = new Date(t.ts);
  var when = isNaN(d.getTime()) ? '' :
    d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' · ' +
    d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  return '<div class="tx" data-id="' + esc(t.id) + '">' +
    '<div class="ic">' + esc(String(t.category||'?').slice(0,1).toUpperCase()) + '</div>' +
    '<div class="mid"><div class="t1">' + esc(t.remarks || t.category) + '</div>' +
    '<div class="t2">' + esc(t.category) + ' · ' + esc(t.mode||'') + ' · ' + when +
    ((t.screenshot || shots[t.id]) ? ' · 📎' : '') + '</div></div>' +
    (!t._s ? '<div class="dot" title="not synced"></div>' : '') +
    '<div class="amt ' + esc(t.type) + '">' + (t.type==='Income'?'+':'−') +
    money(t.amount).slice(1) + '</div></div>';
}

function renderRecent() {
  var r = txns.slice(0,6);
  $('#recentList').innerHTML = r.length ? r.map(txHtml).join('')
    : '<div class="empty">Nothing logged yet. Your first entry goes above.</div>';
}

var filter = { type:'', cat:'' };

function renderHist() {
  var q = String($('#q').value || '').toLowerCase().trim();
  var list = txns.filter(function (t) {
    if (filter.type && t.type !== filter.type) return false;
    if (filter.cat && t.category !== filter.cat) return false;
    if (!q) return true;
    return String(t.remarks||'').toLowerCase().indexOf(q) > -1 ||
           String(t.category||'').toLowerCase().indexOf(q) > -1 ||
           String(t.mode||'').toLowerCase().indexOf(q) > -1 ||
           String(t.amount).indexOf(q) > -1;
  });
  $('#histList').innerHTML = list.length ? list.slice(0,300).map(txHtml).join('')
    : '<div class="empty">No entries match.</div>';
}

function buildFilters() {
  var opts = [['','All']]
    .concat(['Expense','Income','Savings'].map(function (t) { return ['t:'+t, t]; }))
    .concat(CATS.map(function (c) { return ['c:'+c, c]; }));
  $('#filterChips').innerHTML = opts.map(function (o) {
    var on = (o[0] === '' && !filter.type && !filter.cat) ||
             (filter.type && o[0] === 't:'+filter.type) ||
             (filter.cat && o[0] === 'c:'+filter.cat);
    return '<button class="chip" type="button" data-v="' + esc(o[0]) + '" aria-pressed="' +
           (!!on) + '">' + esc(o[1]) + '</button>';
  }).join('');
}

function openTx(id) {
  var t = byId(id); if (!t) return;
  var img = t.screenshot || shots[t.id] || '';
  var d = new Date(t.ts);
  var w = document.createElement('div');
  w.className = 'sheet';
  w.innerHTML = '<div><h3>' + esc(t.remarks || t.category) + '</h3>' +
    '<div class="hero"><div class="big" style="color:var(--' + String(t.type).toLowerCase() + ')">' +
    money(t.amount) + '</div></div>' +
    '<p style="color:var(--ink-2);font-size:13.5px;margin:10px 0 16px">' +
    esc(t.type) + ' · ' + esc(t.category) + ' · ' + esc(t.mode||'—') + '<br>' +
    (isNaN(d.getTime()) ? '' : esc(d.toLocaleString('en-IN'))) + '</p>' +
    (img ? '<img src="' + esc(img) + '" style="width:100%;border-radius:12px;margin-bottom:14px" alt="receipt">' : '') +
    '<button class="btn danger sm" id="txDel">Delete entry</button>' +
    '<button class="btn ghost sm" id="txNo" style="margin-top:8px">Close</button></div>';
  document.body.appendChild(w);
  w.onclick = function (e) { if (e.target === w) w.remove(); };
  w.querySelector('#txNo').onclick = function () { w.remove(); };
  w.querySelector('#txDel').onclick = function () {
    w.remove();
    delete shots[t.id]; save(K.shots, shots);
    txns = txns.filter(function (x) { return x.id !== t.id; });
    save(K.txns, txns);
    renderAll();
    deleteRow(t).then(function(){ toast('Deleted'); })
                .catch(function(){ toast('Deleted here, but not in the sheet'); });
  };
}

// ============================ settings ============================
function renderSettings() {
  $('#bTotal').value = bud.TOTAL || '';
  $('#bCats').innerHTML = CATS.map(function (c) {
    return '<label class="f"><span>' + esc(c) + '</span>' +
      '<input class="in bcat" data-c="' + esc(c) + '" type="number" inputmode="numeric" ' +
      'placeholder="no limit" value="' + (bud[c] || '') + '"></label>';
  }).join('');

  $('#recList').innerHTML = '<div class="empty">Recurring entries are coming back in the next update.</div>';

  $('#acct').textContent = acct
    ? (acct.email || 'Signed in') + ' · ' + (acct.mode === 'google' ? 'Google' : 'Email') +
      ' · ' + txns.length + ' entries · app ' + APP_VERSION
    : '';
  var link = acct && acct.sheetId
    ? 'https://docs.google.com/spreadsheets/d/' + acct.sheetId : '#';
  $('#openSheet').href = link;
  $('#openSheet').style.display = (acct && acct.sheetId) ? 'block' : 'none';
}

function saveBudgets() {
  bud = {};
  var t = Number($('#bTotal').value);
  if (t > 0) bud.TOTAL = t;
  $$('.bcat').forEach(function (el) {
    var n = Number(el.value); if (n > 0) bud[el.dataset.c] = n;
  });
  save(K.bud, bud);
  toast('Budgets saved');
  renderStats();
}

function exportCsv() {
  var head = ['Date','Time','Type','Category','Amount','Mode','Remarks'];
  var rows = txns.map(function (t) {
    var d = new Date(t.ts);
    return [ isNaN(d.getTime())?'':d.toLocaleDateString('en-GB'),
             isNaN(d.getTime())?'':d.toTimeString().slice(0,5),
             t.type, t.category, t.amount, t.mode, t.remarks ];
  });
  var csv = [head].concat(rows).map(function (r) {
    return r.map(function (c) { return '"' + String(c==null?'':c).replace(/"/g,'""') + '"'; }).join(',');
  }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = 'paisa-' + ym(new Date()) + '.csv';
  a.click();
}

// ============================ views ============================
var view = 'add';
var TITLES = { add:'Add entry', stats:'Stats', hist:'History', set:'Settings' };

function go(v) {
  view = v;
  ['add','stats','hist','set'].forEach(function (k) {
    $('#v-' + k).classList.toggle('hide', k !== v);
  });
  $$('nav.tabs button').forEach(function (b) {
    b.setAttribute('aria-selected', String(b.dataset.v === v));
  });
  $('#screenTitle').textContent = TITLES[v];
  window.scrollTo(0,0);
  renderAll();
}

function renderAll() {
  setPill();
  if (view === 'add')   renderRecent();
  if (view === 'stats') renderStats();
  if (view === 'hist')  { buildFilters(); renderHist(); }
  if (view === 'set')   renderSettings();
}

function openApp() {
  $('#auth').classList.add('hide');
  $('#app').classList.remove('hide');
  buildChips();
  resetForm();
  renderAll();
  sync();
  takeSharedImage();
  if (location.search.indexOf('fix=1') > -1) {
    history.replaceState(null, '', location.pathname);
    go('hist');
  }
}

// ============================ wiring ============================
function init() {
  // Load Google's library up front, so that when the user taps a button the
  // popup can open in the same instant as the tap. Loading it lazily on the
  // click costs us the popup — browsers only allow one during the click.
  loadGis().catch(function () {});

  // --- onboarding ---
  $('#goGoogle').addEventListener('click', doGoogle);
  $('#goEmail').addEventListener('click', function () { setEmailMode('signup'); step('email'); });
  $('#haveAccount').addEventListener('click', function () { setEmailMode('login'); step('email'); });
  $('#emailBack').addEventListener('click', function () { step('welcome'); });
  $('#emailSwap').addEventListener('click', function () {
    setEmailMode(emailMode === 'signup' ? 'login' : 'signup');
  });
  $('#emailGo').addEventListener('click', doEmail);
  $('#pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doEmail(); });

  $('#driveGo').addEventListener('click', connectDrive);
  $('#driveWhy').addEventListener('click', function () {
    alert('Paisa has no database of its own. Your expenses are kept in a Google ' +
          'Sheet that is created in your Drive, owned by you.\n\n' +
          'The permission asked for is the narrow one — it only covers the single ' +
          'file Paisa creates. It cannot see any of your other files, and the app ' +
          'developer cannot see your sheet at all.');
  });

  wirePin('#setPinBox', savePin);
  wirePin('#lockBox', checkPin);
  $('#skipPin').addEventListener('click', function () { acct.pinHash = ''; save(K.acct, acct); openApp(); });
  $('#lockOut').addEventListener('click', logout);

  // --- app ---
  chipGroup('#catChips','category');
  chipGroup('#modeChips','mode');
  $('#typeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    draft.type = b.dataset.v;
    $$('#typeSeg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });

  $('#save').addEventListener('click', saveEntry);
  $('#scanBtn').addEventListener('click', function () { $('#scanIn').click(); });
  $('#scanIn').addEventListener('change', function (e) { scanReceipt(e.target.files[0]); e.target.value = ''; });
  $('#shotBtn').addEventListener('click', function () { $('#shotIn').click(); });
  $('#shotIn').addEventListener('change', function (e) { pickShot(e.target.files[0]); });
  $('#shotClear').addEventListener('click', function () {
    draft.shot = '';
    $('#shotPrev').classList.add('hide'); $('#shotClear').classList.add('hide');
    $('#shotBtn').textContent = 'Attach receipt';
  });

  document.addEventListener('click', function (e) {
    var tx = e.target.closest('.tx[data-id]');
    if (tx) openTx(tx.dataset.id);
  });

  $$('nav.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { go(b.dataset.v); });
  });

  $('#q').addEventListener('input', renderHist);
  $('#filterChips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    var v = b.dataset.v;
    filter = { type:'', cat:'' };
    if (v.indexOf('t:') === 0) filter.type = v.slice(2);
    if (v.indexOf('c:') === 0) filter.cat = v.slice(2);
    buildFilters(); renderHist();
  });

  $('#bSave').addEventListener('click', saveBudgets);
  $('#recAdd').addEventListener('click', function () { toast('Recurring entries return in the next update'); });
  $('#syncNow').addEventListener('click', function () { sync().then(function(){ toast('Synced'); }); });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#setApi').addEventListener('click', function () {
    alert('Your data lives in your own Google Drive — there is no server to point at any more.');
  });
  $('#logout').addEventListener('click', logout);

  window.addEventListener('online', function () { setPill(); sync(); });
  window.addEventListener('offline', setPill);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && acct && acct.sheetId) sync();
  });

  // --- where do we land? ---
  if (!acct)                 step('welcome');
  else if (!acct.sheetId)    step('drive');
  else if (acct.pinHash)     { step('lock'); $('#lockWho').textContent = acct.email || ''; }
  else                       openApp();

  if ('serviceWorker' in navigator) {
    var had = !!navigator.serviceWorker.controller, done = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!had || done) return;
      done = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(function (r) {
      try { r.update(); } catch (e) {}
    }).catch(function(){});
  }
}

document.addEventListener('DOMContentLoaded', init);
})();
