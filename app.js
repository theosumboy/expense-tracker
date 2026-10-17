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

var APP_VERSION = 'v10';

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

/* Each type has its own vocabulary. They all land in the same CATEGORY and
   MODE columns of the sheet, so the sheet layout never changes. */
var CATS = {
  Expense: ['Food','Grocery','Transportation','Shopping','Entertainment',
            'Bills & Recharge','Health','Rent / EMI','Education','Other'],
  Income:  ['Salary','Business','Freelance','Interest','Dividend','Rental',
            'Gift','Refund','Other'],
  Savings: ['Mutual fund / SIP','Fixed deposit','Recurring deposit','PPF','NPS',
            'Stocks','Gold','Savings account','Emergency fund','Other']
};
/* Interest is stored as "Interest · Fixed deposit", so it still groups under
   Interest when filtering, and the sheet stays one column wide. */
var INTEREST = ['Savings account','Fixed deposit','Recurring deposit','Mutual funds','Bonds','Other'];
var SUB_SEP = ' · ';
var MODES = {
  Expense: ['UPI','Cash','Card','Net Banking','Other'],
  Income:  ['Bank transfer','UPI','Cash','Cheque','Other'],
  Savings: ['Auto-debit','UPI','Net Banking','Cash','Other']
};
var LABELS = {
  Expense: { cat:'Category', mode:'Paid by',      save:'Save expense' },
  Income:  { cat:'Source',   mode:'Received via', save:'Save income' },
  Savings: { cat:'Saved in', mode:'Paid from',    save:'Save savings' }
};
var TYPES = ['Expense','Income','Savings'];

// ============================ storage ============================
/* p.recur, not the old p.rec: pre-v7 builds left a different shape under
   p.rec and it must not be mistaken for a rule. p.tok is the Google access
   token, kept so that reopening the app within the hour needs no sign-in. */
var K = { acct:'p.acct', txns:'p.txns', bud:'p.bud', recur:'p.recur', shots:'p.shots',
          tok:'p.tok' };

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
var recur = load(K.recur, []);    // [{id, category, amount, mode, remarks, day, time, last:'YYYY-MM'}]
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
/** 'YYYY-MM' → Date on the 1st. Built from parts: new Date('2026-09') is UTC
    midnight, which is still August in some timezones. */
function ymDate(k){ var p = String(k).split('-'); return new Date(+p[0], +p[1]-1, 1); }
function ymShift(k, n){ var d = ymDate(k); return ym(new Date(d.getFullYear(), d.getMonth()+n, 1)); }
function daysIn(k){ var d = ymDate(k); return new Date(d.getFullYear(), d.getMonth()+1, 0).getDate(); }
function ymd(d){ d = new Date(d); return ym(d) + '-' + pad(d.getDate()); }
function ordinal(n){
  var s = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({1:'st',2:'nd',3:'rd'}[n % 10] || 'th');
  return n + s;
}
/** Top-level category: "Interest · FD" → "Interest". */
function mainCat(c){ return String(c || '').split(SUB_SEP)[0]; }
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
/* The access token is kept in localStorage for its one-hour life. Before v10
   it lived only in memory, so every reopen — every PIN unlock, every shared
   screenshot — began with no token and went straight to the Google popup.
   A longer-lived login would need a refresh token, and that needs a server
   holding a client secret: a server that could then read users' sheets. So
   one hour per token is the ceiling, and the work below is about never
   asking when we don't strictly have to. */
var savedTok = load(K.tok, null);
var gToken = savedTok && savedTok.t || null, gExpiry = savedTok && savedTok.exp || 0;
var tokenClient = null;

function haveToken(){ return !!gToken && Date.now() < gExpiry - 60000; }
function dropToken(){ gToken = null; gExpiry = 0; localStorage.removeItem(K.tok); }

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

function askGoogle() {
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
        save(K.tok, { t: gToken, exp: gExpiry });
        resolve(gToken);
      } else {
        reject(new Error(res && res.error ? res.error : 'no_token'));
      }
    };
    tokenClient.error_callback = function (err) {
      reject(new Error((err && err.type) || 'popup_failed'));
    };
    // prompt '' = show consent only if it was never given. login_hint names
    // the account, so Google skips the account chooser and the popup closes
    // by itself. ('consent' here forced the full screen on every renewal.)
    var opts = { prompt: '' };
    if (acct && acct.gEmail) opts.login_hint = acct.gEmail;
    try {
      tokenClient.requestAccessToken(opts);
    } catch (e) { reject(e); }
  });
}

/**
 * Returns a usable access token.
 *
 * interactive = false: only a token we already hold. Never opens a popup —
 * it would be blocked outside a click anyway, or worse, open with no clear
 * reason in the middle of a PIN unlock. Rejects with 'need_tap'.
 *
 * interactive = true: may open the Google popup. Call it ONLY from inside a
 * click handler, synchronously. The popup must open in the same turn as the
 * click, so when the library is loaded we call straight through — awaiting
 * anything first silently costs us the popup.
 */
function token(interactive) {
  if (haveToken()) return Promise.resolve(gToken);
  if (!interactive) return Promise.reject(new Error('need_tap'));
  if (gisReady()) return askGoogle();
  return loadGis().then(function () { return askGoogle(); });
}

function isNeedTap(e){ return /need_tap/.test(String(e && e.message)); }

/** Plain-English version of Google's error codes. */
function authReason(e) {
  var m = String((e && e.message) || '');
  if (/need_tap/.test(m))
    return 'Google needs a quick tap to reconnect.';
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
    // Expired or revoked. Asking again here would be outside any click, so
    // the popup would be blocked — drop the token and let the caller offer
    // a "tap to reconnect" instead.
    if (r.status === 401) { dropToken(); throw new Error('need_tap'); }
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
    when:     receiptDate(clean)
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

/**
 * When the payment happened, as a Date — or null. This decides which month
 * the entry counts in, so a September screenshot shared in October still
 * lands in September. The old version only knew "24 Sep 2026" and fell back
 * to today for everything else, including super.money's "September 24 at
 * 1:47 AM" and Paytm's "24/09/2026".
 *
 * Numeric dates are read day-first, as Indian apps write them. A date with
 * no year takes this year, or last year if that would put it in the future.
 */
var MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
var MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

function receiptDate(lines, now) {
  now = now || new Date();
  var dayMon = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/.]*' + MON_RE +
                          '(?:[\\s\\-\\/.,]*(\\d{4}|\\d{2})(?![:\\d]))?', 'i');
  var monDay = new RegExp('\\b' + MON_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b' +
                          '(?:,?\\s*(\\d{4})(?![:\\d]))?', 'i');
  var numeric = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/;
  var isoDate = /\b(\d{4})-(\d{2})-(\d{2})\b/;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i], m, d = null, mo = null, y = null;
    if ((m = line.match(isoDate)))       { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if ((m = line.match(dayMon)))   { d = +m[1]; mo = MON[m[2].toLowerCase()]; y = m[3] ? +m[3] : null; }
    else if ((m = line.match(monDay)))   { mo = MON[m[1].toLowerCase()]; d = +m[2]; y = m[3] ? +m[3] : null; }
    else if ((m = line.match(numeric)))  { d = +m[1]; mo = +m[2] - 1; y = +m[3]; }
    if (d === null || mo === null || d < 1 || d > 31 || mo < 0 || mo > 11) continue;

    if (y !== null && y < 100) y += 2000;
    var guessed = y === null;
    if (guessed) y = now.getFullYear();
    var out = new Date(y, mo, d, 12, 0);
    if (out.getMonth() !== mo) continue;                    // 31 Sep and the like
    if (guessed && out.getTime() > now.getTime() + 86400000) out.setFullYear(y - 1);

    // The time is usually on the same line, sometimes on the next.
    var t = timeIn(line) || (i + 1 < lines.length ? timeIn(lines[i + 1]) : null);
    if (t) out.setHours(t[0], t[1], 0, 0);
    return out;
  }
  return null;
}

function timeIn(s) {
  var m = String(s).match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\b/i);
  if (!m) return null;
  var h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  if (m[3]) {
    var pm = m[3].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  }
  return [h, mi];
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
    var em = (info && info.email) || '';
    acct = { mode:'google', email: em, gEmail: em, sheetId:'', gid:null, pinHash:'' };
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
    .then(function () {
      // Which Google account holds the sheet. Used as the login hint later,
      // so renewing the token never shows the account chooser. Email users
      // may pick a Google account different from their Paisa email.
      if (acct.gEmail) return;
      return gfetch('https://www.googleapis.com/oauth2/v3/userinfo').then(function (info) {
        if (info && info.email) { acct.gEmail = info.email; save(K.acct, acct); }
      }).catch(function(){});
    })
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

function unsyncedWarning() {
  var n = pending();
  return n ? '\n\n' + n + (n === 1 ? ' entry has' : ' entries have') +
             ' not reached your sheet yet and will be lost from this phone.' : '';
}

function logout() {
  if (!confirm('Log out? Your sheet stays in your Google Drive with all your data.' +
               unsyncedWarning())) return;
  [K.acct, K.txns, K.shots, K.tok].forEach(function (k) { localStorage.removeItem(k); });
  location.reload();
}

/** Wipes everything Paisa keeps on this phone and withdraws its Google
    access. The sheet in Drive is untouched — signing in again finds it. */
function resetAll() {
  if (!confirm('Reset Paisa on this phone?\n\nThis removes your login, PIN, budgets and ' +
               'recurring savings from this phone, and disconnects Google. Your sheet stays ' +
               'in your Google Drive, and signing in again brings your entries back.' +
               unsyncedWarning())) return;
  var t = gToken;
  Object.keys(K).forEach(function (k) { localStorage.removeItem(K[k]); });
  localStorage.removeItem('p.rec');
  var done = function () { location.reload(); };
  if (t && gisReady() && google.accounts.oauth2.revoke) {
    try { google.accounts.oauth2.revoke(t, done); } catch (e) { done(); }
    setTimeout(done, 2500);          // never hang on Google
  } else done();
}

function changePin() {
  $('#setPinLede').textContent = 'Choose a new 4-digit PIN.';
  $('#skipPin').textContent = 'Turn the PIN off';
  clearPin('#setPinBox');
  step('setpin');
  clearPin('#setPinBox');
}

// ============================ sync ============================
var syncing = false;

function pending(){ return txns.filter(function(t){ return !t._s; }).length; }

function setPill() {
  var p = $('#syncPill'), n = pending();
  if (!navigator.onLine) { p.className = 'pill sync'; p.textContent = 'Offline'; return; }
  if (syncing)           { p.className = 'pill sync'; p.textContent = 'Syncing…'; return; }
  if (!haveToken())      { p.className = 'pill sync tap';
                           p.textContent = n ? n + ' to sync · tap' : 'Tap to sync'; return; }
  if (n)                 { p.className = 'pill sync'; p.textContent = n + ' to sync'; return; }
  p.className = 'pill ok'; p.textContent = 'Synced';
}

/**
 * interactive = true only from a click (Save, Sync now, the pill): then an
 * expired token may be renewed with the popup. Every other caller — app
 * open, PIN unlock, coming back online — syncs only if a token is already
 * held, and otherwise leaves "Tap to sync" on the pill. Entries are safe in
 * the offline queue either way.
 */
function sync(interactive) {
  if (syncing || !acct || !acct.sheetId || !navigator.onLine) { setPill(); return Promise.resolve(); }
  if (!haveToken() && !interactive) { setPill(); return Promise.resolve(); }
  syncing = true; setPill();

  return token(!!interactive)                 // called synchronously: keeps the click
    .then(function () {
      return pushRows(txns.filter(function (t) { return !t._s; }));
    })
    .then(function () { return pushShots(); })
    .then(function () { return pullAll(); })
    .catch(function (e) {
      if (!interactive) return;               // background: the pill says enough
      toast(/Google API/.test(e.message)
        ? 'Could not reach your sheet. Your entries are safe on this phone.'
        : authReason(e));
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
var draft = { type:'Expense', category:'Food', sub:INTEREST[0], mode:'UPI', freq:'once', shot:'' };

function chipsHtml(list, on) {
  return list.map(function (c) {
    return '<button class="chip" type="button" data-v="' + esc(c) + '" aria-pressed="' +
           (c === on) + '">' + esc(c) + '</button>';
  }).join('');
}

/** Redraws the form for the current type: its own categories, its own
    payment words, and the extras only that type has. */
function buildChips() {
  var t = draft.type;
  $('#v-add').setAttribute('data-type', t);
  $('#catLabel').textContent = LABELS[t].cat;
  $('#modeLabel').textContent = LABELS[t].mode;
  $('#save').textContent = LABELS[t].save;
  $('#catChips').innerHTML = chipsHtml(CATS[t], draft.category);
  $('#modeChips').innerHTML = chipsHtml(MODES[t], draft.mode);

  var interest = t === 'Income' && draft.category === 'Interest';
  $('#subRow').classList.toggle('hide', !interest);
  if (interest) $('#subChips').innerHTML = chipsHtml(INTEREST, draft.sub);

  $('#freqRow').classList.toggle('hide', t !== 'Savings');
  $$('#freqSeg button').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.v === draft.freq));
  });
  freqHint();
}

function freqHint() {
  var el = $('#freqHint');
  if (draft.type !== 'Savings' || draft.freq !== 'monthly') { el.textContent = ''; return; }
  var d = $('#dt').value ? new Date($('#dt').value + 'T12:00') : new Date();
  el.textContent = 'Adds itself on the ' + ordinal(d.getDate()) + ' of every month from ' +
    d.toLocaleDateString('en-IN', { month:'long' }) + '. Stop it any time in Settings.';
}

function setType(t) {
  if (TYPES.indexOf(t) < 0) return;
  draft.type = t;
  draft.category = CATS[t][0];
  draft.mode = MODES[t][0];
  draft.freq = 'once';
  $$('#typeSeg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.v === t)); });
  buildChips();
}

function chipGroup(sel, key) {
  $(sel).addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    draft[key] = b.dataset.v;
    $$(sel + ' .chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === b)); });
    if (key === 'category') buildChips();    // Interest opens its own options
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
  // Back to one-time after every save, so a monthly rule is never made twice
  // by accident.
  draft.freq = 'once';
  buildChips();
}

function saveEntry() {
  var amt = parseFloat(String($('#amt').value).replace(/[^0-9.]/g, ''));
  if (!isFinite(amt) || amt <= 0) { toast('Enter an amount'); $('#amt').focus(); return; }

  var day = $('#dt').value || nowLocal().d, time = $('#tm').value || nowLocal().t;
  var cat = draft.category;
  if (draft.type === 'Income' && cat === 'Interest') cat = 'Interest' + SUB_SEP + draft.sub;
  var remarks = String($('#rem').value || '').trim();

  var id = uid();
  if (draft.type === 'Savings' && draft.freq === 'monthly') {
    // This entry is the first month of the rule. Its id is derived from the
    // rule and month, so the generator can tell it already exists.
    var rule = { id: uid(), category: cat, amount: amt, mode: draft.mode, remarks: remarks,
                 day: +day.slice(8, 10), time: time, last: day.slice(0, 7) };
    recur.push(rule); save(K.recur, recur);
    id = recId(rule, rule.last);
  }

  var row = {
    id: id,
    ts: day + 'T' + time + ':00',
    type: draft.type, category: cat, amount: amt,
    mode: draft.mode, remarks: remarks,
    screenshot: '', _s: 0
  };
  if (draft.shot) { shots[id] = draft.shot; save(K.shots, shots); }

  txns.unshift(row);
  txns.sort(function (a,b) { return String(b.ts).localeCompare(String(a.ts)); });
  save(K.txns, txns);

  var what = draft.type, month = ym(row.ts);
  resetForm();
  scanResult('');
  toast(what + ' ' + money(amt) + ' saved' +
        (month !== ym(new Date()) ? ' in ' + monthName(row.ts).split(' ')[0] : ''));
  renderAll();
  sync(true);                                 // a click: may reconnect if it must
}

// ============================ recurring savings ============================
/* Rebuilt on the phone (v10). The old daily server trigger could not reach a
   sheet in someone else's Drive. Instead, each time the app opens, every
   rule adds the months it has not added yet, once that month's day has
   come. rule.last records the newest month added, so deleting one month's
   entry never brings it back. Rules live on this phone, like budgets. */
function recId(rule, month) { return 'rec-' + rule.id + '-' + month; }

function runRecurring() {
  var now = new Date(), thisMonth = ym(now), added = 0;
  recur.forEach(function (rule) {
    var m = ymShift(rule.last, 1);
    while (m <= thisMonth) {
      var d = Math.min(rule.day, daysIn(m));
      if (m === thisMonth && now.getDate() < d) break;
      var id = recId(rule, m);
      if (!byId(id)) {
        txns.push({ id: id, ts: m + '-' + pad(d) + 'T' + (rule.time || '09:00') + ':00',
                    type: 'Savings', category: rule.category, amount: rule.amount,
                    mode: rule.mode, remarks: rule.remarks, screenshot: '', _s: 0 });
        added++;
      }
      rule.last = m;
      m = ymShift(m, 1);
    }
  });
  if (!added) { if (recur.length) save(K.recur, recur); return 0; }
  txns.sort(function (a,b) { return String(b.ts).localeCompare(String(a.ts)); });
  save(K.txns, txns);
  save(K.recur, recur);
  return added;
}

function stopRule(id) {
  var r = recur.filter(function (x) { return x.id === id; })[0];
  if (!r || !confirm('Stop "' + (r.remarks || r.category) + '"?\n\nEntries already added stay; ' +
                     'no new ones will be added.')) return;
  recur = recur.filter(function (x) { return x.id !== id; });
  save(K.recur, recur);
  renderSettings();
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

  shrink(file, 1100, 0.72).then(function (small) {
    draft.shot = small;
    $('#shotPrev').src = small;
    $('#shotPrev').classList.remove('hide');
    $('#shotClear').classList.remove('hide');
    $('#shotBtn').textContent = 'Replace receipt';
    return shrink(file, 1600, 0.82);
  }).then(function (big) {
    if (haveToken()) return readScan(big);
    // A shared screenshot arrives with no click behind it, so a Google popup
    // here would be blocked — or, before v10, appeared out of nowhere. Hold
    // the image and let the user's tap do the reconnecting.
    scanResult('<div><b>Screenshot attached</b><br>Tap below to read the amount and date from it.</div>' +
               '<button class="btn sm" id="scanGo" type="button" style="margin-top:10px">Read receipt</button>');
    $('#scanGo').onclick = function () {
      token(true).then(function () { readScan(big); })
        .catch(function (e) { scanResult('<div><b>Not connected</b><br>' + esc(authReason(e)) + '</div>'); });
    };
  }).catch(function () { toast('Could not read that image'); });
}

function readScan(big) {
  scanResult('');
  scanBusy(true, 'Reading your screenshot…');
  return ocr(big).then(function (text) {
    scanBusy(false);
    if (!text || text.replace(/\s/g,'').length < 4) {
      scanResult('<div><b>Could not read it</b><br>No text found in that image. ' +
                 'The receipt is attached — just type the amount.</div>');
      return;
    }
    applyScan(parseReceipt(text));
  }).catch(function (e) {
    scanBusy(false);
    scanResult('<div><b>Scan failed</b><br>' + esc(authReason(e).slice(0,140)) +
               '<br>The receipt is attached — type the amount and save as normal.</div>');
  });
}

function applyScan(r) {
  var got = [], cats = CATS[draft.type];
  if (r.amount) { $('#amt').value = r.amount; got.push('amount ' + money(r.amount)); }
  if (r.category && cats.indexOf(r.category) > -1) { draft.category = r.category; got.push('category ' + r.category); }
  if (r.mode && MODES[draft.type].indexOf(r.mode) > -1) draft.mode = r.mode;
  buildChips();
  if (r.merchant) $('#rem').value = r.merchant;

  var when = r.when, note = '';
  if (when && !isNaN(when.getTime())) {
    $('#dt').value = ymd(when);
    $('#tm').value = pad(when.getHours()) + ':' + pad(when.getMinutes());
    got.push('date ' + when.toLocaleDateString('en-IN', { day:'numeric', month:'short' }));
    if (ym(when) !== ym(new Date()))
      note = ' It will count in <b>' + esc(monthName(when)) + '</b>, the month it was paid.';
  }

  if (!got.length) {
    scanResult('<div><b>Nothing readable found</b><br>The receipt is attached. ' +
               'Fill the amount in yourself and save.</div>');
    return;
  }
  scanResult('<div><b>Read ' + esc(got.join(', ')) + '</b><br>' +
             'Check it below and fix anything wrong, then tap Save.' + note + '</div>');
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

// ============================ the month being looked at ============================
/* Stats and History both show one month at a time, and share it: step back
   to September on Stats and History is on September too. An entry belongs
   to the month of its own date — never the month it was typed in. */
var viewMonth = ym(new Date());
var selDay = '';                  // 'YYYY-MM-DD' picked on the calendar, or ''

function inMonth(k) { return txns.filter(function (t) { return ym(t.ts) === k; }); }

function renderMonthNav() {
  var label = monthName(ymDate(viewMonth));
  $$('.monthnav b').forEach(function (b) { b.textContent = label; });
  $$('.monthnav .today').forEach(function (b) {
    b.classList.toggle('hide', viewMonth === ym(new Date()));
  });
}

function stepMonth(n) {
  viewMonth = n === 0 ? ym(new Date()) : ymShift(viewMonth, n);
  selDay = '';
  renderAll();
}

// ============================ stats ============================
function sum(list, type) {
  return list.reduce(function (a,t) { return a + (t.type === type ? Number(t.amount)||0 : 0); }, 0);
}

function byCategory(list, type) {
  var out = {};
  list.forEach(function (t) {
    if (t.type !== type) return;
    out[t.category] = (out[t.category] || 0) + (Number(t.amount)||0);
  });
  return out;
}

function barsHtml(map, color, emptyText) {
  var rows = Object.keys(map).map(function (c) { return {c:c, v:map[c]}; })
                   .sort(function (a,b) { return b.v - a.v; });
  if (!rows.length) return '<div class="empty">' + esc(emptyText) + '</div>';
  var max = rows[0].v || 1;
  return rows.map(function (r) {
    return '<div class="bar-row"><div class="nm">' + esc(r.c) + '</div>' +
           '<div class="tr"><i style="width:' + Math.max(2,(r.v/max)*100) + '%;background:var(--' +
           color + ')"></i></div><div class="vl">' + moneyShort(r.v) + '</div></div>';
  }).join('');
}

function renderStats() {
  renderMonthNav();
  var key = viewMonth, isNow = key === ym(new Date());
  var mName = monthName(ymDate(key)).split(' ')[0];
  var list = inMonth(key);
  var exp = sum(list,'Expense'), inc = sum(list,'Income'), sav = sum(list,'Savings');

  $('#sSpent').textContent = money(exp);
  $('#sMonth').textContent = 'spent in ' + monthName(ymDate(key));
  $('#kInc').textContent = moneyShort(inc);
  $('#kExp').textContent = moneyShort(exp);
  $('#kSav').textContent = moneyShort(sav);
  var left = inc - exp - sav;
  $('#sNet').innerHTML = inc
    ? 'Left over after spending and saving: <b style="color:var(--' + (left < 0 ? 'expense' : 'income') +
      ')">' + (left < 0 ? '−' : '') + money(Math.abs(left)) + '</b>' +
      (sav > 0 ? ' · saved ' + Math.round(sav / inc * 100) + '% of income' : '')
    : 'Add your income to see what is left over.';

  var limit = Number(bud.TOTAL) || 0, meter = $('#sMeter'), alerts = [];
  var byCat = byCategory(list, 'Expense');
  if (limit > 0) {
    var pct = exp / limit;
    meter.style.width = Math.min(100, pct*100) + '%';
    meter.className = pct >= 1 ? 'crit' : (pct >= 0.8 ? 'warn' : '');
    $('#sLeft').textContent = money(Math.max(0, limit - exp));
    if (pct >= 1) alerts.push(['crit','Over budget',
      'You spent ' + money(exp) + ' of your ' + money(limit) + ' limit — ' +
      money(exp - limit) + ' over.']);
    else if (pct >= 0.8 && isNow) alerts.push(['warn', Math.round(pct*100) + '% of budget used',
      money(limit - exp) + ' left for the rest of ' + mName + '.']);
  } else {
    meter.style.width = '0'; meter.className = '';
    $('#sLeft').textContent = '—';
  }
  Object.keys(bud).forEach(function (c) {
    if (c === 'TOTAL' || !bud[c]) return;
    var spent = byCat[c] || 0;
    if (spent >= bud[c]) alerts.push(['crit', c + ' over limit',
      money(spent) + ' spent against a ' + money(bud[c]) + ' limit.']);
    else if (spent >= bud[c]*0.8 && isNow) alerts.push(['warn', c + ' nearly used up',
      money(bud[c]-spent) + ' left of ' + money(bud[c]) + '.']);
  });
  $('#alerts').innerHTML = alerts.slice(0,3).map(function (a) {
    return '<div class="alert ' + a[0] + '"><span>' + (a[0]==='crit'?'⚠':'!') +
           '</span><div><b>' + esc(a[1]) + '</b><br>' + esc(a[2]) + '</div></div>';
  }).join('');

  // Pace: a running month projects forward; a finished one just averages.
  var days = daysIn(key), today = new Date().getDate();
  var avg = exp / (isNow ? today : days);
  $('#pAvg').textContent = money(avg);
  $('#pProj').textContent = money(isNow ? avg * days : exp);
  $('#pProjL').textContent = isNow ? 'projected this month' : 'total for ' + mName;

  $('#catTitle').textContent = 'Where it went — ' + mName;
  $('#catBars').innerHTML = barsHtml(byCat, 'expense', 'No spending logged in ' + mName + '.');
  $('#incBars').innerHTML = barsHtml(byCategory(list, 'Income'), 'income', 'No income logged in ' + mName + '.');
  $('#savBars').innerHTML = barsHtml(byCategory(list, 'Savings'), 'savings', 'Nothing saved in ' + mName + ' yet.');

  // Six months ending at the month in view, all three types side by side.
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var k = ymShift(key, -i), l = inMonth(k);
    months.push({ k: k, label: ymDate(k).toLocaleDateString('en-IN',{month:'short'}),
                  e: sum(l,'Expense'), n: sum(l,'Income'), s: sum(l,'Savings') });
  }
  var tmax = Math.max.apply(null, months.map(function (x) { return Math.max(x.e, x.n, x.s); }).concat([1]));
  var h = function (v) { return Math.max(v ? 3 : 0, (v/tmax)*100); };
  $('#trend').innerHTML = months.map(function (x, i) {
    return '<button class="col' + (i===5?' cur':'') + '" type="button" data-m="' + x.k + '" title="' +
           esc(x.label) + ': income ' + money(x.n) + ', spent ' + money(x.e) + ', saved ' + money(x.s) + '">' +
           '<div class="stack"><i class="n" style="height:' + h(x.n) + '%"></i>' +
           '<i class="e" style="height:' + h(x.e) + '%"></i>' +
           '<i class="s" style="height:' + h(x.s) + '%"></i></div>' +
           '<span>' + esc(x.label) + '</span></button>';
  }).join('');
}

// ============================ lists ============================
function txHtml(t) {
  var d = new Date(t.ts);
  var when = isNaN(d.getTime()) ? '' :
    d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' · ' +
    d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  var sign = t.type === 'Income' ? '+' : (t.type === 'Savings' ? '' : '−');
  return '<div class="tx" data-id="' + esc(t.id) + '">' +
    '<div class="ic ' + esc(t.type) + '">' + esc(String(t.category||'?').slice(0,1).toUpperCase()) + '</div>' +
    '<div class="mid"><div class="t1">' + esc(t.remarks || t.category) + '</div>' +
    '<div class="t2">' + esc(t.category) + ' · ' + esc(t.mode||'') + ' · ' + when +
    (String(t.id).indexOf('rec-') === 0 ? ' · ↻' : '') +
    ((t.screenshot || shots[t.id]) ? ' · 📎' : '') + '</div></div>' +
    (!t._s ? '<div class="dot" title="not synced"></div>' : '') +
    '<div class="amt ' + esc(t.type) + '">' + sign + money(t.amount).slice(1) + '</div></div>';
}

function renderRecent() {
  var r = txns.slice(0,6);
  $('#recentList').innerHTML = r.length ? r.map(txHtml).join('')
    : '<div class="empty">Nothing logged yet. Your first entry goes above.</div>';
}

var filter = { type:'', cat:'' };

function matchesFilter(t) {
  if (filter.type && t.type !== filter.type) return false;
  if (filter.cat && mainCat(t.category) !== filter.cat) return false;
  return true;
}

/** Month grid, Monday first. Each day shows what was spent, and a dot each
    for income and savings. Tap a day to list just that day. */
function renderCal() {
  var first = ymDate(viewMonth), n = daysIn(viewMonth);
  var lead = (first.getDay() + 6) % 7;
  var per = {};
  inMonth(viewMonth).forEach(function (t) {
    if (!matchesFilter(t)) return;
    var k = ymd(t.ts);
    var p = per[k] || (per[k] = { e:0, n:0, s:0 });
    if (t.type === 'Expense') p.e += Number(t.amount)||0;
    else if (t.type === 'Income') p.n += Number(t.amount)||0;
    else p.s += Number(t.amount)||0;
  });
  var todayK = ymd(new Date());
  var html = ['M','T','W','T','F','S','S'].map(function (w) { return '<div class="wd">' + w + '</div>'; }).join('');
  for (var i = 0; i < lead; i++) html += '<div></div>';
  for (var d = 1; d <= n; d++) {
    var k = viewMonth + '-' + pad(d), p = per[k];
    html += '<button type="button" class="day' + (k === todayK ? ' today' : '') + (k === selDay ? ' sel' : '') +
            (p ? ' has' : '') + '" data-d="' + k + '" aria-pressed="' + (k === selDay) + '">' +
            '<span class="dn">' + d + '</span>' +
            (p && p.e ? '<span class="de">' + moneyShort(p.e).slice(1) + '</span>' : '') +
            '<span class="dots">' + (p && p.n ? '<i class="n"></i>' : '') + (p && p.s ? '<i class="s"></i>' : '') +
            '</span></button>';
  }
  $('#cal').innerHTML = html;
}

function renderHist() {
  renderMonthNav();
  renderCal();
  var q = String($('#q').value || '').toLowerCase().trim();
  // A search looks across every month — you are hunting for something.
  // Otherwise the list is the month (or day) on the calendar.
  var list = txns.filter(function (t) {
    if (!matchesFilter(t)) return false;
    if (!q) return selDay ? ymd(t.ts) === selDay : ym(t.ts) === viewMonth;
    return String(t.remarks||'').toLowerCase().indexOf(q) > -1 ||
           String(t.category||'').toLowerCase().indexOf(q) > -1 ||
           String(t.mode||'').toLowerCase().indexOf(q) > -1 ||
           String(t.amount).indexOf(q) > -1;
  });

  var head;
  if (q) head = 'All months · ' + list.length + ' found';
  else if (selDay) head = new Date(selDay + 'T12:00').toLocaleDateString('en-IN',
         { weekday:'short', day:'numeric', month:'short' }) + ' · ' + list.length +
         (list.length === 1 ? ' entry' : ' entries') + ' <button class="link inline" id="clearDay" type="button">Show whole month</button>';
  else head = monthName(ymDate(viewMonth)) + ' · ' + list.length + (list.length === 1 ? ' entry' : ' entries');
  var tot = '';
  if (list.length) {
    var e = sum(list,'Expense'), n = sum(list,'Income'), s = sum(list,'Savings');
    tot = '<div class="totline">' +
      (n ? '<span style="color:var(--income)">+' + moneyShort(n).slice(1) + ' in</span>' : '') +
      (e ? '<span style="color:var(--expense)">−' + moneyShort(e).slice(1) + ' out</span>' : '') +
      (s ? '<span style="color:var(--savings)">' + moneyShort(s).slice(1) + ' saved</span>' : '') + '</div>';
  }
  $('#histHead').innerHTML = head + tot;
  $('#histList').innerHTML = list.length ? list.slice(0,300).map(txHtml).join('')
    : '<div class="empty">' + (q ? 'No entries match.' : 'Nothing logged ' +
        (selDay ? 'on this day.' : 'in ' + monthName(ymDate(viewMonth)).split(' ')[0] + '.')) + '</div>';
}

function buildFilters() {
  // Category chips follow the type picked, so the row stays short and every
  // chip means something for that type.
  var opts = [['','All']].concat(TYPES.map(function (t) { return ['t:'+t, t]; }));
  if (filter.type) opts = opts.concat(CATS[filter.type].map(function (c) { return ['c:'+c, c]; }));
  $('#filterChips').innerHTML = opts.map(function (o) {
    var on = (o[0] === '' && !filter.type && !filter.cat) ||
             (o[0] === 't:'+filter.type && !filter.cat) ||
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
    (isNaN(d.getTime()) ? '' : esc(d.toLocaleString('en-IN'))) +
    (String(t.id).indexOf('rec-') === 0 ? '<br>Added by a monthly saving' : '') + '</p>' +
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
  $('#bCats').innerHTML = CATS.Expense.map(function (c) {
    return '<label class="f"><span>' + esc(c) + '</span>' +
      '<input class="in bcat" data-c="' + esc(c) + '" type="number" inputmode="numeric" ' +
      'placeholder="no limit" value="' + (bud[c] || '') + '"></label>';
  }).join('');

  $('#recList').innerHTML = recur.length ? recur.map(function (r) {
    return '<div class="tx"><div class="ic Savings">↻</div>' +
      '<div class="mid"><div class="t1">' + esc(r.remarks || r.category) + '</div>' +
      '<div class="t2">' + esc(r.category) + ' · ' + money(r.amount) + ' on the ' + ordinal(r.day) +
      ' of every month</div></div>' +
      '<button class="btn ghost sm stopRule" type="button" data-id="' + esc(r.id) +
      '" style="width:auto;padding:7px 12px">Stop</button></div>';
  }).join('') : '<div class="empty" style="padding:14px 0">No monthly savings yet. Add a saving and ' +
                'choose “Every month” — an SIP or RD, say.</div>';

  $('#acct').textContent = acct
    ? (acct.email || 'Signed in') + ' · ' + (acct.mode === 'google' ? 'Google' : 'Email') +
      (acct.gEmail && acct.gEmail !== acct.email ? ' · Drive: ' + acct.gEmail : '') +
      ' · ' + txns.length + ' entries · app ' + APP_VERSION
    : '';
  $('#pinBtn').textContent = acct && acct.pinHash ? 'Change PIN' : 'Set a PIN';
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
  runRecurring();
  renderAll();
  sync();                      // no popup: only if a token is still held
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
  chipGroup('#subChips','sub');
  $('#typeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (b) setType(b.dataset.v);
  });
  $('#freqSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    draft.freq = b.dataset.v;
    buildChips();
  });
  $('#dt').addEventListener('change', freqHint);

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
  document.addEventListener('click', function (e) {
    var m = e.target.closest('.monthnav button');
    if (m) { stepMonth(+m.dataset.step); return; }
    var c = e.target.closest('#trend .col');
    if (c) { viewMonth = c.dataset.m; selDay = ''; renderAll(); return; }
    var d = e.target.closest('#cal .day');
    if (d) { selDay = selDay === d.dataset.d ? '' : d.dataset.d; renderHist(); return; }
    if (e.target.closest('#clearDay')) { selDay = ''; renderHist(); return; }
    var s = e.target.closest('.stopRule');
    if (s) stopRule(s.dataset.id);
  });
  $('#filterChips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    var v = b.dataset.v;
    filter = { type:'', cat:'' };
    if (v.indexOf('t:') === 0) filter.type = v.slice(2);
    if (v.indexOf('c:') === 0) filter.cat = v.slice(2);
    buildFilters(); renderHist();
  });

  $('#bSave').addEventListener('click', saveBudgets);
  $('#recAdd').addEventListener('click', function () {
    go('add'); setType('Savings'); draft.freq = 'monthly'; buildChips(); $('#amt').focus();
  });
  $('#syncNow').addEventListener('click', function () {
    sync(true).then(function(){ if (haveToken() && !pending()) toast('Synced'); });
  });
  $('#syncPill').addEventListener('click', function () { if (!syncing) sync(true); });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#pinBtn').addEventListener('click', changePin);
  $('#resetAll').addEventListener('click', resetAll);
  $('#logout').addEventListener('click', logout);

  window.addEventListener('online', function () { setPill(); sync(); });
  window.addEventListener('offline', setPill);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !acct || !acct.sheetId) return;
    if (runRecurring()) renderAll();   // a new month may have begun
    sync();
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

// Tests set window.__PAISA_TEST__ before loading this file to reach the
// parser directly. Nothing in the app reads it.
if (window.__PAISA_TEST__) window.__PAISA_TEST__ = { parseReceipt: parseReceipt, receiptDate: receiptDate };

document.addEventListener('DOMContentLoaded', init);
})();
