/**
 * EXPENSE TRACKER — Google Apps Script backend (multi-user)
 * ===========================================================================
 * One deployment serves every user. Each user gets their OWN spreadsheet,
 * created automatically the first time they sign up.
 *
 * Also serves the 3-tap phone shortcut (MacroDroid / Apple Shortcuts) so you
 * can log an expense without opening the app at all.
 *
 * ---------------------------------------------------------------------------
 * SETUP (10 minutes, once)
 *   1. Go to https://script.google.com  ->  New project
 *   2. Delete everything in Code.gs and paste this whole file
 *   3. Change SECRET below to a random string only you know
 *   4. Save, then Run -> setup()  (approve the permissions it asks for)
 *   5. Deploy -> New deployment -> Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   6. Copy the /exec URL — that is your API_URL for the app and the phone
 *   7. (optional) Run installRecurringTrigger() once, for auto rent/EMI rows
 *
 *   8. FOR SCREENSHOT SCANNING — turn on the Drive service:
 *        In the left sidebar, next to "Services", click +
 *        Find "Drive API", click Add   (leave the identifier as "Drive")
 *      Without this, everything still works except scanning.
 * ===========================================================================
 */

// ==== CONFIG ===============================================================

/** Random private string. Signs login tokens. Never share it. */
var SECRET = 'CHANGE_THIS_TO_SOMETHING_RANDOM_9f3k2';

/** Name of the master registry spreadsheet (holds the user list only). */
var REGISTRY_NAME = 'Expense Tracker — Registry';

/** Drive folder that holds uploaded receipt screenshots. */
var SCREENSHOT_FOLDER = 'Expense Tracker Screenshots';

var CATEGORIES = [
  'Food', 'Grocery', 'Transportation', 'Shopping', 'Entertainment',
  'Bills & Recharge', 'Health', 'Rent / EMI', 'Education', 'Other'
];
var MODES = ['UPI', 'Cash', 'Card', 'Net Banking', 'Other'];
var TYPES = ['Expense', 'Income', 'Savings'];

var TXN_HEADERS = ['DATE', 'TIME', 'TYPE', 'CATEGORY', 'AMOUNT', 'MODE',
                   'REMARKS', 'SCREENSHOT', 'ID'];
var BUDGET_HEADERS = ['CATEGORY', 'MONTHLY_LIMIT'];
var RECUR_HEADERS  = ['NAME', 'TYPE', 'CATEGORY', 'AMOUNT', 'MODE',
                      'DAY_OF_MONTH', 'ACTIVE', 'LAST_RUN'];
var REG_HEADERS    = ['PHONE', 'PIN_HASH', 'SHEET_ID', 'SHEET_URL',
                      'CREATED', 'LAST_SEEN'];

// ==== ROUTING ==============================================================

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // --- 3-tap phone shortcut: ?key=...&phone=...&amount=...&category=... ---
    if (p.amount != null && p.phone) {
      var u = findUser(p.phone);
      if (!u) return text('No account for that number. Sign up in the app first.');
      if (sha(p.pin || '') !== u.pinHash) return text('Wrong PIN');
      addRows(u, [{
        id: p.id || newId(),
        ts: p.ts || '',
        type: p.type || 'Expense',
        category: p.category || 'Other',
        amount: p.amount,
        mode: p.mode || 'UPI',
        remarks: p.remarks || ''
      }]);
      return text('Saved ' + p.amount + ' · ' + (p.category || 'Other'));
    }

    // --- auto-capture: MacroDroid forwards a payment notification or bank SMS ---
    //     ?action=auto&phone=...&pin=...&text=<the whole notification>
    if (p.action === 'auto') {
      var au = findUser(p.phone);
      if (!au) return text('No account for that number');
      if (sha(p.pin || '') !== au.pinHash) return text('Wrong PIN');
      return text(autoCapture(au, p.text || '', p.src || ''));
    }

    // --- evening summary: MacroDroid shows the reply as a notification ---
    if (p.action === 'summary') {
      var su = findUser(p.phone);
      if (!su) return text('No account for that number');
      if (sha(p.pin || '') !== su.pinHash) return text('Wrong PIN');
      return text(daySummary(su));
    }

    if (p.action === 'ping') {
      return json({ ok: true, categories: CATEGORIES, modes: MODES, types: TYPES });
    }

    // --- app pull ---
    var user = auth(p.token);
    if (!user) return json({ ok: false, error: 'auth' });

    if (p.action === 'pull') {
      return json({
        ok: true,
        items: readTxns(user),
        budgets: readBudgets(user),
        recurring: readRecurring(user),
        sheetUrl: user.sheetUrl
      });
    }
    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var a = b.action;

    if (a === 'signup') return json(signup(b.phone, b.pin));
    if (a === 'login')  return json(login(b.phone, b.pin));

    // --- v7: email accounts. Stores an email and a password HASH only.
    //     No expense data ever reaches this script; that lives in the user's
    //     own Google Drive. ---
    if (a === 'eregister') return json(eregister(b.email, b.passHash));
    if (a === 'elogin')    return json(elogin(b.email, b.passHash));

    var user = auth(b.token);
    if (!user) return json({ ok: false, error: 'auth' });

    if (a === 'push') {
      var res = addRows(user, b.items || []);
      return json({ ok: true, added: res.added, skipped: res.skipped, ids: res.ids });
    }
    if (a === 'update')     return json(updateRow(user, b.item));
    if (a === 'delete')     return json(deleteRow(user, b.id));
    if (a === 'budgets')    return json(writeBudgets(user, b.budgets || []));
    if (a === 'recurring')  return json(writeRecurring(user, b.recurring || []));
    if (a === 'screenshot') return json(saveScreenshot(user, b.id, b.dataUrl));
    if (a === 'scan')       return json(scanReceipt(b.dataUrl));

    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ==== AUTH =================================================================

function signup(phone, pin) {
  phone = normPhone(phone);
  if (phone.length < 10) return { ok: false, error: 'Enter a valid 10-digit number' };
  if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, error: 'PIN must be 4 digits' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findUser(phone)) return { ok: false, error: 'exists' };

    var ss = SpreadsheetApp.create('Expense Tracker — ' + mask(phone));
    initUserSheet(ss);

    var reg = registry();
    reg.appendRow([phone, sha(pin), ss.getId(), ss.getUrl(), new Date(), new Date()]);

    return {
      ok: true, token: mkToken(phone), sheetUrl: ss.getUrl(),
      categories: CATEGORIES, modes: MODES, types: TYPES
    };
  } finally {
    lock.releaseLock();
  }
}

function login(phone, pin) {
  phone = normPhone(phone);
  var u = findUser(phone);
  if (!u) return { ok: false, error: 'nouser' };
  if (sha(pin) !== u.pinHash) return { ok: false, error: 'Wrong PIN' };
  touch(u);
  return {
    ok: true, token: mkToken(phone), sheetUrl: u.sheetUrl,
    categories: CATEGORIES, modes: MODES, types: TYPES
  };
}

/** Stateless signed token: "<phone>.<hmac>". No session storage needed. */
function mkToken(phone) {
  return phone + '.' + sign(phone);
}

function auth(token) {
  if (!token) return null;
  var i = String(token).lastIndexOf('.');
  if (i < 0) return null;
  var phone = token.slice(0, i), sig = token.slice(i + 1);
  if (sign(phone) !== sig) return null;
  return findUser(phone);
}

function sign(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(String(s), SECRET));
}

function sha(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s) + SECRET));
}

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function mask(p) { return 'xxxxx' + String(p).slice(-5); }

// ==== EMAIL ACCOUNTS (v7) ==================================================
/* The ONLY thing stored here is an email address and a hash of the password.
   The password itself is already hashed on the user's phone before it is sent,
   then hashed again here with SECRET — so even this sheet cannot reveal it.
   Expense data is NOT stored here; it lives in each user's own Drive. */

var ACC_HEADERS = ['EMAIL', 'PASS_HASH', 'CREATED', 'LAST_SEEN'];

function accSheet() {
  var ss = registry().getParent();
  var sh = ss.getSheetByName('Accounts');
  if (!sh) {
    sh = ss.insertSheet('Accounts');
    sh.getRange(1, 1, 1, ACC_HEADERS.length).setValues([ACC_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findAccount(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  var sh = accSheet();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var v = sh.getRange(2, 1, last - 1, ACC_HEADERS.length).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim().toLowerCase() === email) {
      return { row: i + 2, email: email, hash: String(v[i][1]) };
    }
  }
  return null;
}

function eregister(email, passHash) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email' };
  if (!passHash || String(passHash).length < 32) return { ok: false, error: 'Bad password' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findAccount(email)) return { ok: false, error: 'exists' };
    accSheet().appendRow([email, sha(passHash), new Date(), new Date()]);
    return { ok: true, email: email };
  } finally {
    lock.releaseLock();
  }
}

function elogin(email, passHash) {
  var a = findAccount(email);
  if (!a) return { ok: false, error: 'nouser' };
  if (sha(passHash) !== a.hash) return { ok: false, error: 'Wrong password' };
  try { accSheet().getRange(a.row, 4).setValue(new Date()); } catch (e) {}
  return { ok: true, email: a.email };
}

// ==== REGISTRY =============================================================

function registry() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('REGISTRY_ID');
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(REGISTRY_NAME);
    props.setProperty('REGISTRY_ID', ss.getId());
  }
  var sh = ss.getSheetByName('Users') || ss.insertSheet('Users');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, REG_HEADERS.length).setValues([REG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findUser(phone) {
  phone = normPhone(phone);
  var sh = registry();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var v = sh.getRange(2, 1, last - 1, REG_HEADERS.length).getValues();
  for (var i = 0; i < v.length; i++) {
    if (normPhone(v[i][0]) === phone) {
      return {
        row: i + 2, phone: phone, pinHash: String(v[i][1]),
        sheetId: String(v[i][2]), sheetUrl: String(v[i][3])
      };
    }
  }
  return null;
}

function touch(u) {
  try { registry().getRange(u.row, 6).setValue(new Date()); } catch (e) {}
}

// ==== PER-USER SHEET =======================================================

function initUserSheet(ss) {
  var t = ss.getSheets()[0].setName('Transactions');
  t.getRange(1, 1, 1, TXN_HEADERS.length).setValues([TXN_HEADERS])
   .setFontWeight('bold').setBackground('#b7e1cd');
  t.setFrozenRows(1);
  t.setColumnWidth(7, 220);
  t.hideColumns(9);

  var b = ss.insertSheet('Budgets');
  b.getRange(1, 1, 1, BUDGET_HEADERS.length).setValues([BUDGET_HEADERS])
   .setFontWeight('bold').setBackground('#fce8b2');
  b.setFrozenRows(1);
  b.appendRow(['TOTAL', '']);
  for (var i = 0; i < CATEGORIES.length; i++) b.appendRow([CATEGORIES[i], '']);

  var r = ss.insertSheet('Recurring');
  r.getRange(1, 1, 1, RECUR_HEADERS.length).setValues([RECUR_HEADERS])
   .setFontWeight('bold').setBackground('#c9daf8');
  r.setFrozenRows(1);

  var s = ss.insertSheet('Summary');
  s.getRange('A1').setValue('This month').setFontWeight('bold').setFontSize(14);
  s.getRange('A3').setValue('Spent');
  s.getRange('B3').setFormula(
    '=SUMIFS(Transactions!E:E,Transactions!C:C,"Expense",Transactions!A:A,">="&EOMONTH(TODAY(),-1)+1)');
  s.getRange('A4').setValue('Income');
  s.getRange('B4').setFormula(
    '=SUMIFS(Transactions!E:E,Transactions!C:C,"Income",Transactions!A:A,">="&EOMONTH(TODAY(),-1)+1)');
  s.getRange('A5').setValue('Saved');
  s.getRange('B5').setFormula(
    '=SUMIFS(Transactions!E:E,Transactions!C:C,"Savings",Transactions!A:A,">="&EOMONTH(TODAY(),-1)+1)');
  s.getRange('A6').setValue('Net left').setFontWeight('bold');
  s.getRange('B6').setFormula('=B4-B3-B5').setFontWeight('bold');
  s.getRange('B3:B6').setNumberFormat('#,##0.00');
  return ss;
}

function userSS(u) { return SpreadsheetApp.openById(u.sheetId); }

function tab(u, name, headers) {
  var ss = userSS(u);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ==== TRANSACTIONS =========================================================

function addRows(u, items) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = tab(u, 'Transactions', TXN_HEADERS);
    var seen = idMap(sh, 9);
    var rows = [], ids = [], skipped = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var id = String(it.id || newId());
      if (seen[id]) { skipped++; continue; }

      var amt = Number(String(it.amount == null ? '' : it.amount).replace(/[^0-9.]/g, ''));
      if (!isFinite(amt) || amt <= 0) { skipped++; continue; }

      var d = parseTs(it.ts);
      rows.push([
        Utilities.formatDate(d, tz(), 'dd/MM/yyyy'),
        Utilities.formatDate(d, tz(), 'HH:mm'),
        pick(it.type, TYPES, 'Expense'),
        String(it.category || 'Other'),
        amt,
        pick(it.mode, MODES, 'UPI'),
        String(it.remarks || ''),
        String(it.screenshot || ''),
        id
      ]);
      ids.push(id);
      seen[id] = true;
    }
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, TXN_HEADERS.length).setValues(rows);
    }
    touch(u);
    return { added: rows.length, skipped: skipped, ids: ids };
  } finally {
    lock.releaseLock();
  }
}

function readTxns(u) {
  var sh = tab(u, 'Transactions', TXN_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, TXN_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (!v[i][4] && v[i][4] !== 0) continue;
    out.push({
      ts: toIso(v[i][0], v[i][1]),
      type: String(v[i][2] || 'Expense'),
      category: String(v[i][3] || 'Other'),
      amount: Number(v[i][4]) || 0,
      mode: String(v[i][5] || ''),
      remarks: String(v[i][6] || ''),
      screenshot: String(v[i][7] || ''),
      id: String(v[i][8] || ('r' + (i + 2)))
    });
  }
  return out;
}

function findRow(sh, id, col) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var v = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === String(id)) return i + 2;
  return 0;
}

function updateRow(u, it) {
  if (!it || !it.id) return { ok: false, error: 'no id' };
  var sh = tab(u, 'Transactions', TXN_HEADERS);
  var r = findRow(sh, it.id, 9);
  if (!r) return addRows(u, [it]).added ? { ok: true, created: true } : { ok: false, error: 'not found' };
  var d = parseTs(it.ts);
  sh.getRange(r, 1, 1, TXN_HEADERS.length).setValues([[
    Utilities.formatDate(d, tz(), 'dd/MM/yyyy'),
    Utilities.formatDate(d, tz(), 'HH:mm'),
    pick(it.type, TYPES, 'Expense'),
    String(it.category || 'Other'),
    Number(it.amount) || 0,
    pick(it.mode, MODES, 'UPI'),
    String(it.remarks || ''),
    String(it.screenshot || ''),
    String(it.id)
  ]]);
  return { ok: true };
}

function deleteRow(u, id) {
  var sh = tab(u, 'Transactions', TXN_HEADERS);
  var r = findRow(sh, id, 9);
  if (r) sh.deleteRow(r);
  return { ok: true, deleted: !!r };
}

// ==== BUDGETS ==============================================================

function readBudgets(u) {
  var sh = tab(u, 'Budgets', BUDGET_HEADERS);
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var v = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < v.length; i++) {
    var k = String(v[i][0] || '').trim();
    if (!k) continue;
    var n = Number(v[i][1]);
    if (isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

function writeBudgets(u, list) {
  var sh = tab(u, 'Budgets', BUDGET_HEADERS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  var rows = [['TOTAL', numOrBlank(pluck(list, 'TOTAL'))]];
  for (var i = 0; i < CATEGORIES.length; i++) {
    rows.push([CATEGORIES[i], numOrBlank(pluck(list, CATEGORIES[i]))]);
  }
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  return { ok: true };
}

function pluck(list, key) {
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].category === key) return list[i].limit;
  return '';
}
function numOrBlank(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : ''; }

// ==== RECURRING ============================================================

function readRecurring(u) {
  var sh = tab(u, 'Recurring', RECUR_HEADERS);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, RECUR_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (!String(v[i][0] || '').trim()) continue;
    out.push({
      name: String(v[i][0]), type: String(v[i][1] || 'Expense'),
      category: String(v[i][2] || 'Other'), amount: Number(v[i][3]) || 0,
      mode: String(v[i][4] || 'UPI'), day: Number(v[i][5]) || 1,
      active: String(v[i][6]).toUpperCase() !== 'NO',
      lastRun: v[i][7] ? String(v[i][7]) : ''
    });
  }
  return out;
}

function writeRecurring(u, list) {
  var sh = tab(u, 'Recurring', RECUR_HEADERS);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, RECUR_HEADERS.length).clearContent();
  }
  if (!list.length) return { ok: true };
  var rows = list.map(function (r) {
    return [r.name || '', r.type || 'Expense', r.category || 'Other',
            Number(r.amount) || 0, r.mode || 'UPI', Number(r.day) || 1,
            r.active === false ? 'NO' : 'YES', r.lastRun || ''];
  });
  sh.getRange(2, 1, rows.length, RECUR_HEADERS.length).setValues(rows);
  return { ok: true };
}

/** Daily trigger: posts any recurring item whose day-of-month is today. */
function runRecurring() {
  var sh = registry();
  var last = sh.getLastRow();
  if (last < 2) return;
  var users = sh.getRange(2, 1, last - 1, REG_HEADERS.length).getValues();
  var today = new Date();
  var dom = today.getDate();
  var stamp = Utilities.formatDate(today, tz(), 'yyyy-MM');

  for (var i = 0; i < users.length; i++) {
    var u = { row: i + 2, phone: users[i][0], sheetId: String(users[i][2]) };
    if (!u.sheetId) continue;
    try {
      var list = readRecurring(u), due = [], changed = false;
      for (var j = 0; j < list.length; j++) {
        var r = list[j];
        if (!r.active || r.day !== dom || r.lastRun === stamp) continue;
        due.push({
          id: newId(), ts: today.toISOString(), type: r.type, category: r.category,
          amount: r.amount, mode: r.mode, remarks: r.name + ' (auto)'
        });
        r.lastRun = stamp;
        changed = true;
      }
      if (due.length) { addRows(u, due); }
      if (changed) writeRecurring(u, list);
    } catch (e) { Logger.log('recurring failed for row ' + u.row + ': ' + e); }
  }
}

function installRecurringTrigger() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'runRecurring') ScriptApp.deleteTrigger(all[i]);
  }
  ScriptApp.newTrigger('runRecurring').timeBased().atHour(6).everyDays(1).create();
  return 'Daily 6am trigger installed';
}

// ==== SCREENSHOTS ==========================================================

function saveScreenshot(u, id, dataUrl) {
  if (!dataUrl) return { ok: false, error: 'no image' };
  var m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { ok: false, error: 'bad data url' };

  var root = folder(SCREENSHOT_FOLDER);
  var mine = subfolder(root, mask(u.phone));
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1],
    id + '.' + (m[1].indexOf('png') > -1 ? 'png' : 'jpg'));
  var f = mine.createFile(blob);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.google.com/uc?id=' + f.getId();

  var sh = tab(u, 'Transactions', TXN_HEADERS);
  var r = findRow(sh, id, 9);
  if (r) sh.getRange(r, 8).setValue(url);
  return { ok: true, url: url };
}

function folder(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function subfolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ==== SCREENSHOT SCANNING ==================================================
/* Reads a UPI payment screenshot (GPay / PhonePe / Paytm / bank app) and
   pulls out the amount, who it went to, and a likely category.
   OCR is done by Google Drive — free, no extra API key.
   Requires the Drive advanced service (see SETUP note 8 at the top). */

/** merchant keyword -> category. Match is case-insensitive substring. */
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

function scanReceipt(dataUrl) {
  if (!dataUrl) return { ok: false, error: 'No image received' };
  var m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { ok: false, error: 'That file is not an image' };

  var text;
  try {
    text = ocrImage(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'scan'));
  } catch (err) {
    return { ok: false, error: 'ocr_unavailable', detail: String(err) };
  }
  if (!text || text.replace(/\s/g, '').length < 4) {
    return { ok: false, error: 'Could not read any text in that image' };
  }

  var p = parseReceipt(text);
  p.ok = true;
  p.text = text.slice(0, 1200);
  return p;
}

/** Google Drive converts an image to a Doc and OCRs it on the way. Free. */
function ocrImage(blob) {
  var id = null;
  try {
    var res;
    if (Drive.Files.create) {                       // Drive API v3
      res = Drive.Files.create(
        { name: 'ocr-tmp', mimeType: 'application/vnd.google-apps.document' },
        blob, { ocrLanguage: 'en' });
    } else {                                        // Drive API v2
      res = Drive.Files.insert(
        { title: 'ocr-tmp', mimeType: 'application/vnd.google-apps.document' },
        blob, { ocr: true, ocrLanguage: 'en' });
    }
    id = res.id;

    // Read the text back out of the converted doc.
    try {
      return DocumentApp.openById(id).getBody().getText();
    } catch (docErr) {
      // Fallback if the Docs permission isn't granted: ask Drive to export
      // the same document as plain text, using the Drive permission we have.
      var url = 'https://www.googleapis.com/drive/v3/files/' +
                encodeURIComponent(id) + '/export?mimeType=text/plain';
      var resp = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) throw docErr;
      return resp.getContentText();
    }
  } finally {
    if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} }
  }
}

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
    ref:      findRef(clean),
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

function findRef(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/(?:upi transaction id|utr|txn id|transaction id|ref(?:erence)? no)[:\s#]*([A-Za-z0-9]{6,})(?![\w.]*@)/i);
    if (m && /\d/.test(m[1])) return m[1];
  }
  return '';
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
var NOT_A_TXN = [
  'otp', 'one time password', 'do not share', 'never share', 'verification code',
  'will be debited', 'is requested', 'has requested', 'requesting', 'collect request',
  'payment request', 'failed', 'declined', 'unsuccessful', 'could not be',
  'reversed', 'cancelled', 'e-mandate', 'mandate will', 'due on', 'bill is due',
  'payment due', 'statement is', 'minimum due', 'reminder', 'overdue',
  'apply now', 'pre-approved', 'congratulations', 'you have won', 'limited offer',
  'click here', 'download now', 'low balance'
];

function autoCapture(u, raw, src) {
  var r = parseAlert(raw);
  if (!r.ok) return 'skipped (' + r.reason + ')';

  var sh = tab(u, 'Transactions', TXN_HEADERS);
  if (recentDuplicate(sh, r.amount, r.type, 4)) return 'duplicate, ignored';

  addRows(u, [{
    id: newId(),
    type: r.type,
    category: r.category,
    amount: r.amount,
    mode: r.mode,
    remarks: (r.merchant ? r.merchant : 'Auto') + ' · auto' + (src ? ' (' + src + ')' : '')
  }]);

  return (r.type === 'Income' ? '+' : '-') + 'Rs ' + r.amount +
         ' · ' + r.category + (r.merchant ? ' · ' + r.merchant : '');
}

function parseAlert(raw) {
  var t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reason: 'empty' };
  var low = t.toLowerCase();

  for (var i = 0; i < NOT_A_TXN.length; i++) {
    if (low.indexOf(NOT_A_TXN[i]) > -1) return { ok: false, reason: 'not a payment' };
  }

  // Amount: prefer one marked with a currency, else a bare 2-decimal figure.
  var m = t.match(/(?:₹|₨|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i) ||
          t.match(/\b([0-9][0-9,]*\.[0-9]{2})\b/);
  if (!m) return { ok: false, reason: 'no amount' };
  var amount = Number(String(m[1]).replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return { ok: false, reason: 'no amount' };

  var credit = /\b(credited|received from|refund|refunded|cashback of|deposited|added to your)\b/.test(low);
  var debit  = /\b(debited|paid|spent|withdrawn|sent to|purchase|deducted|txn of|transferred to)\b/.test(low);
  if (!credit && !debit) return { ok: false, reason: 'unclear direction' };
  var type = (credit && !debit) ? 'Income' : 'Expense';

  var merchant = alertMerchant(t);
  var category = type === 'Income' ? 'Other'
                                   : findCategory(low + ' ' + merchant.toLowerCase(), merchant);

  return {
    ok: true, amount: amount, type: type, merchant: merchant,
    category: category, mode: findMode(low)
  };
}

/** Pulls the payee out of "... to ZOMATO MEDIA on ..." / "... at MYNTRA ..." */
function alertMerchant(t) {
  var pats = [
    /\b(?:paid to|sent to|transferred to|credited to|to VPA|to)\s+([A-Za-z][A-Za-z0-9&.'\- ]{2,42})/i,
    /\b(?:at|towards|for)\s+([A-Za-z][A-Za-z0-9&.'\- ]{2,42})/i
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = t.match(pats[i]);
    if (!m) continue;
    var s = m[1]
      .replace(/\b(on|ref|refno|upi|utr|txn|transaction|info|avl|bal|a\/c|ac|dated|via|using|from|successfully|success|is|was|has|not)\b.*$/i, '')
      .replace(/^(your|the|my)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.,;:\-]+$/, '');
    if (s.length >= 3 && /[A-Za-z]{3}/.test(s) && !/^\d+$/.test(s)) return s;
  }
  // Fall back to the name part of a UPI id, e.g. zomato1paytm@hdfcbank
  var v = t.match(/\b([a-z][a-z0-9._-]{2,30})@[a-z]{2,}\b/i);
  if (v) return titleCase(v[1].replace(/[._-]+/g, ' ').replace(/\d+$/, '').trim());
  return '';
}

/** Same amount, same direction, within a few minutes = the same payment. */
function recentDuplicate(sh, amount, type, minutes) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var n = Math.min(15, last - 1);
  var v = sh.getRange(last - n + 1, 1, n, TXN_HEADERS.length).getValues();
  var now = new Date().getTime();

  for (var i = 0; i < v.length; i++) {
    if (String(v[i][2]) !== String(type)) continue;
    if (Math.abs(Number(v[i][4]) - Number(amount)) > 0.009) continue;
    var d = new Date(toIso(v[i][0], v[i][1]));
    if (isNaN(d.getTime())) continue;
    if (Math.abs(now - d.getTime()) <= minutes * 60000) return true;
  }
  return false;
}

/** One line for the evening notification. */
function daySummary(u) {
  var rows = readTxns(u);
  var today = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  var month = Utilities.formatDate(new Date(), tz(), 'yyyy-MM');

  var dSpent = 0, dCount = 0, mSpent = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'Expense') continue;
    if (String(r.ts).slice(0, 7) === month) mSpent += r.amount;
    if (String(r.ts).slice(0, 10) === today) { dSpent += r.amount; dCount++; }
  }

  var budget = Number(readBudgets(u).TOTAL) || 0;
  var s = dCount
    ? 'Today: Rs ' + Math.round(dSpent) + ' across ' + dCount +
      (dCount === 1 ? ' spend' : ' spends')
    : 'Nothing logged today — did anything get missed?';
  s += ' · This month: Rs ' + Math.round(mSpent);
  if (budget) s += ' of ' + Math.round(budget);
  return s;
}

// ==== HELPERS ==============================================================

function tz() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }

function parseTs(s) {
  if (!s) return new Date();
  var d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

function toIso(dateCell, timeCell) {
  var d;
  if (dateCell instanceof Date) d = new Date(dateCell);
  else {
    var m = String(dateCell).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    d = m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date(dateCell);
  }
  if (isNaN(d.getTime())) d = new Date();
  var t = timeCell instanceof Date
    ? Utilities.formatDate(timeCell, tz(), 'HH:mm')
    : String(timeCell || '');
  var hm = t.match(/(\d{1,2}):(\d{2})/);
  if (hm) { d.setHours(+hm[1]); d.setMinutes(+hm[2]); }
  return Utilities.formatDate(d, tz(), "yyyy-MM-dd'T'HH:mm:ss");
}

function idMap(sh, col) {
  var last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  var v = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < v.length; i++) { var s = String(v[i][0] || ''); if (s) map[s] = true; }
  return map;
}

function pick(v, allowed, dflt) {
  v = String(v || '');
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i].toLowerCase() === v.toLowerCase()) return allowed[i];
  }
  return dflt;
}

function newId() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function text(s) {
  return ContentService.createTextOutput(String(s))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ==== RUN ONCE FROM THE EDITOR ============================================

/** Run this first. Creates the registry and grants permissions. */
function setup() {
  registry();
  folder(SCREENSHOT_FOLDER);
  Logger.log('Registry ready. Now deploy as a Web app.');
}

/**
 * ===========================================================================
 * RUN THIS IF SCANNING SAYS "not switched on yet".
 * It does three things:
 *   1. forces Google to ask for the new Drive + Docs permissions
 *   2. proves OCR actually works
 *   3. prints the REAL error if it doesn't
 * Select testOcr in the dropdown, click Run, approve, then read the log.
 * ===========================================================================
 */
function testOcr() {
  Logger.log('1/3  Checking the Drive service is added...');
  try {
    if (typeof Drive === 'undefined') throw new Error('Drive is undefined');
    Logger.log('     OK — Drive service found (' +
      (Drive.Files && Drive.Files.create ? 'v3' : 'v2') + ')');
  } catch (e) {
    Logger.log('     FAILED — add it: left sidebar, Services +, Drive API, Add.');
    Logger.log('     ' + e);
    return;
  }

  Logger.log('2/3  Running OCR on a built-in test image...');
  var text;
  try {
    var blob = Utilities.newBlob(
      Utilities.base64Decode(TEST_IMAGE_B64), 'image/png', 'ocr-selftest.png');
    text = ocrImage(blob);
  } catch (e) {
    Logger.log('     FAILED — this is the real error:');
    Logger.log('     ' + e);
    Logger.log('');
    Logger.log('     If it mentions authorization or permission: re-run this');
    Logger.log('     function and approve, then Deploy > Manage deployments >');
    Logger.log('     pencil > New version > Deploy.');
    return;
  }
  Logger.log('     OCR returned: ' + JSON.stringify(text));

  Logger.log('3/3  Parsing it...');
  var p = parseReceipt(text || '');
  Logger.log('     amount=' + p.amount + '  merchant=' + p.merchant +
             '  category=' + p.category);

  if (Number(p.amount) === 486) {
    Logger.log('');
    Logger.log('ALL GOOD. Now redeploy: Deploy > Manage deployments >');
    Logger.log('pencil > Version: New version > Deploy.');
  } else {
    Logger.log('');
    Logger.log('OCR ran but read the test image wrong. Send me this whole log.');
  }
}

/** Sanity check without deploying. */
function selfTest() {
  var r = signup('9999900000', '1234');
  Logger.log(JSON.stringify(r));
  var u = auth(r.token || mkToken('9999900000'));
  Logger.log(JSON.stringify(addRows(u, [{ amount: 250, category: 'Food', remarks: 'test' }])));
  Logger.log(JSON.stringify(readTxns(u)));
}

// ==== test image used by testOcr() (a picture of "Rs 486 / Paid to Swiggy") ====
var TEST_IMAGE_B64 = [
  'iVBORw0KGgoAAAANSUhEUgAAAjAAAADICAIAAAB5zUxlAAAmfUlEQVR42u3dZ1wUV9838F2qVAVEsWNAUAFF1EgEQQVFg6JeIkJE',
  'lFgwGmOMoGLuRC9jQb1iibGLBbCXRBHEgiJKiQUpRhFLwIb0zrIssPeLeZ5zz7Xl7LIsKPj7vvAz7pw5MzuHnf+cMme4QqGQAwAA',
  '8KGp4BQAAAACEgAAAAISAAAgIAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAISAAAAAhIAACAgAQAAICABAAACEgAAAAISAAAg',
  'IAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAISAAAAAhIAACAgAQAAICABAAACEgAAAAISAAAgIAEAACAgAQAAAhIAAAACEgAA',
  'ICABAAAgIAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAISAACAdGo4BSAiJSUlISHhyZMnjx8/fvv2bWVlZWVlJY/H09LS0tXV',
  '1dXV7datW//+/fv16+fo6Dho0CClH0BGRkZcXFxycvLz589fvXrF7L1du3Y6OjrMAejo6JiYmPTp08fc3Jz5t1u3blwuF2UH0Kpx',
  'hUJhy+zJ3Nz8xYsXjTgyLldDQ0NbW9vAwMDExMTU1NTa2nro0KEODg5aWlqfbIFt2bJl+fLl9DSLFi36/fffG5tzbm7ur7/+evbs',
  '2ZycHPm3MjU19fT0XLZsmYmJSRO/WkVFxZ49ew4fPpyZmdnYbS9fvjxu3Dj8ngFaN2FLMTMzU8oBa2lpeXl5xcfHCz89T58+lScY',
  'L1q0qFHZ1tbWrlq1SltbW+FC0dHR+fnnnwUCgWLfq76+/rfffjMwMFD4AC5fviwEgFau9fUh8Xi806dPOzk5ubu7v3///tO5dWho',
  'aJgzZw6Px1NutmVlZePGjduwYUN1dbXCmVRVVa1du3bixIkVFRUK1MycnJy+++67kpIS3CACfMpa8aCG6OhoBweH58+ffyJFtXPn',
  'zjt37ig9yHl4eNy4cUMpucXExHh6ejZqk4yMjCFDhiQkJOCnCACte5Tdy5cvXV1dq6qq2nw5vXz5ctWqVUrPdvv27fHx8UrM8OrV',
  'q3v37pUzcWZmpqur67t37/A7BABOGxj2nZOT89NPP7XtQhIKhXPnzm1Kk5pE9fX1mzZtUvrRhoSEyDNSpqysbMKECfn5+fgRAkAb',
  'CUgcDmfXrl0KdF20Inv37r1586bSs42NjaXHAy6X6+fnd/PmzaKiIoFAUFRUdP36dW9vb5m3CElJSTL3PmfOHJmjLgcPHrxu3bqE',
  'hITXr1/zeLzq6ur3798/fPgwIiJi+fLlQ4cOVVVVxW8YoE3dfbeuUXYSnTp1qq0OO8nOztbT02vU2ZBzlN2///1vej4nTpyQuKHM',
  'Rrlt27bRd33x4kV6Dr169YqKipL5FUpKSg4dOjRmzJhr165hhBIARtkpx9SpU0UGIhcXF6ekpOzYsaN///4yN4+Li2urdwzz5s0T',
  'r/+pq6s3Pefc3FzK2smTJ0urDAUEBIwYMYKyLb1bqL6+ftmyZZQE9vb29+7d+/LLL2V+hQ4dOvj7+1+9etXV1RU3lwCt3Uc6U4O6',
  'urqBgYGBgcGgQYMWLlzo5eX1xx9/KHxtFVdQUBAdHZ2Wlvb48eOXL19WVFRUVlZWV1czkxEYGBj06tXL1NTU0tJy8ODBgwYNamwd',
  'RVkOHjx47do1kQ/btWu3ZMmSpnf/lJWVUdZOnDiRsnbChAm3b99WLOfTp08/e/ZM2tru3btfvHjR2NgYP04ABKSP7xDV1Pbs2XPx',
  '4sX6+nppafLy8uTMLTY2duPGjXFxcRJzq6qqqqqqysvLY08WoKKi0r9/fxcXF1dXV2dn5xYLTm/fvg0MDBT/fN26dUZGRk3Pv0OH',
  'DpS19JBAX0t/xHX37t2UtQcOHEA0Avg0tY5BDZ07d7axsaEkkGces4qKiilTpri6usbGxlJim7iGhoZHjx7t2LFj4sSJixcvbrFv',
  'HRAQIF7V+OKLL5YuXaqU/OltoQUFBZS19DsAKysraav++ecfylNHw4YNwwxAAAhIHztDQ0PKWpk1htLSUhcXlz///LO1fN+wsLCo',
  'qCiRD7W0tI4cOaKiopxSGzt2LGUtfdzBpUuXpK1SVVUdPXq0tLWRkZGUQeEBAQH4TQIgIH3sCgsLKWutra3pm//www/37t1rLV/2',
  '/fv333//vfjn69evt7CwUNZeLCws3NzcpK29cOHCqVOnJK7atWsXpZYzbdq0bt26SVt7/fp1SjV3/Pjx+E0CfLJax+sn3r179+jR',
  'I0oCZ2dnytqUlJQjR460olL55ptvxCd2c3BwWLJkiXJ3tHPnTltbW2mP3Pr4+MTExMyaNcvW1lZPT6+8vPzhw4f79++XFqiYiuyv',
  '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',
  'AkoCKysrafXRr7/+mrIhZRDjs2fPYmJiKNviDegACEgtYcSIEfQ3I+Tn50t7JikwMHDt2rX0C6g4Srtcly5dWnvBDxkyhD5yYeHC',
  'hdJm/r5y5cry5csp2/br18/U1FTa2m+//ZYykOTUqVMS3zdfXl7u6+tL6fqys7OztrbGTxqgFftIpg6ivMKciIqKon+Xnj17Snw9',
  '0owZM5hqja+v77lz5yorK2Xu6+zZs5ShDWFhYR92gg2lTB00a9YsmdXEuXPnxsbGFhUVCQSCwsLC69evz5o1i/6oEIfDWbFiBX3X',
  'QUFBlM25XO7MmTNv3bpVUlLCTK564MABmU8Knz59GjOvAGAuuxYKSEKhUOagYYnzcjIBid3g5urqGhQUFB4e/uDBg+zs7JKSkrq6',
  'Oh6Pl52dfeHCha+++ooSjdTV1UtKStpAQMrIyGjK81jS6Ovr5+Xl0XddXl5O6aJTwMiRI/FjBmjt1FpXfW7lypXe3t6UBCEhIX5+',
  'fvTrbE1NzfXr1ykT59B5e3vTH89sLaytrRcvXrxjxw7lZvvjjz/KHH6tp6d3/PhxZ2dnPp/f9D127NgxLCwMrR0A6ENqUdOmTevT',
  'pw8lwdOnT8+fP998B9CxY0dpM4e2Rps2baI/GNRYPj4+gYGB8qQcNmxYRESEzNY/eSpk0dHR9EGDAICA1AyHq6JC707ncDgbN25s',
  'pr0bGhpGRkbKM2V1a6GpqRkdHd2UqdDZpk+fHhYWJn8zoKen5/nz57W1tRXeY79+/RISEijjIQEAAakZ+fn5devWjZIgJSWFPjhY',
  'McOGDUtISGh7T7ro6upGRUUdPnzYyMhI4Uw6d+58/PjxkydPqqk1rhHYw8MjJSVl2LBhjd0jM8PsvXv3MLIOAAHpg9HQ0Fi2bBk9',
  'zYYNG9j/3bNnT2Rk5NKlSwcOHNjYNiJVVVUnJ6fTp08nJyfLM+VoKzV79uysrKxt27Y1dq65wYMH//bbb5mZmT4+Port2tLSMikp',
  '6dSpU3JWdDQ1NefMmfPkyZNDhw7R55sAgNaFS38gv+3h8XgZGRkPHz58+vRpTk7Oq1ev8vLyKisrq6ur6+rqtLW1dXV19fX1zczM',
  '+vfvb2NjM378+LbURiePzMzMv/76KzU1NS0tLTc3t7y8vLy8vLq6WltbW19fX19fv0uXLra2tra2tvb29k1/yxTbkydPrly5kpiY',
  '+PTp0zdv3jBT6hkYGBgZGXXu3HnYsGFOTk6Ojo70eV0BAAEJAABAcSo4BQAAgIAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAI',
  'SAAAAAhIAACAgAQAAICABAAACEgAAAAISAAAgIAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAISAAAAAhIAACAgAQAAICABAAA',
  'CEgAAAAISAAAgIAEAACAgAQAAAhIAAAACEgAAICABAAAgIAEAAAISAAAAAhIAAAACEgAAICA9GHcuXOH+/9FREQ0MTdra2smK0dH',
  'x0/h7FVVVR0+fHj27Nk2NjadOnXS1NTU1tbu2rXr8OHDFyxYEBYWlp+f35bKFwBakloL7KOwsNDY2FjaWm1t7fbt2/fo0WPIkCFu',
  'bm7u7u6qqqoomI+NQCDYsGHDr7/+WlFRIbKKx+Pl5uYmJSXt27ePy+WOGDFi3rx5np6e7dq1w3kDgNZUQ6qurs7Nzb179+7u3bsn',
  'TZpkamp6/vz5T6oMYmJiyE392bNnP8IjLC4uHj58+Jo1a8SjkQihUBgfHz9z5swjR47g1wUArSwgiXjz5s3UqVNXrVqFsvlI1NXV',
  'jR8//v79++STCRMmHD9+PCsrq6Kigs/n5+TkXLlyZcmSJd27d8fpAoBWE5B69eol/G8VFRVpaWkbNmxgN+tt3Ljx6NGjKJ6Pwc6d',
  'O+/evcss6+vrX7t2LTIy0sfHp0+fPrq6uhoaGj179hw7duz27dv/+eefiIiI/v3746QBgALUPvgR6OrqDhgwYMCAAf7+/mPHjs3I',
  'yGA+Dw4O9vLy0tLSUu7uHB0dhUIhCr5RAYksHz161NXVVeofk5rajBkzpk+fvn37dj09vQ9ytChfANSQlMDExOTs2bNqav8vRubm',
  '5l67dg0l9GFlZmb+888/zLK5ufnkyZNl3+OoqQUGBs6YMQNnDwBaa0DicDgWFhbjxo0j/71586ZIgqKiotDQ0JkzZ1pZWRkYGKir',
  'qxsbG/fv39/f3//EiRMCgUDpl+OVK1fa2toaGRnp6OhYWFhMmjTp3LlzSt+Rwqqrq8PDw729vS0tLQ0MDNq1a9e9e/fhw4evXr2a',
  '1DWbIjs7myzb2dm1sb/+jIyMwMDAAQMGGBoa6ujoWFpaTp48+Y8//qirq/vguQF8ioTNr6CggOxOvA9JxNq1a0niadOmkc8TExOn',
  'Tp1K6k8SmZqaRkVF0fO/ffs2SR8eHi4tmUAgWLVqlbTd9e3bNz09XSgUWllZMZ84ODgocGaMjIzkKSMXFxeJm0dERHTr1k3aVlwu',
  'd+bMmXl5eU0pu1OnTpEMZ8yYoXA+qampJJ89e/ZIS9a1a1eSbM6cOdKSTZw4kUnTpUsXxcqXz+f/8MMPKiqSb8j69evXqPJtYm5z',
  '5swhiR88eCDP+Vy5ciXZJCYmRgjQJnx0Aem3334jiceMGfN/BypnjU9F5cCBA00MSPX19d7e3vQddejQ4fHjxx8wIAUHB8uzrbm5',
  '+cuXLxUuu6tXr5KsbG1tFc6noaGBDFrx9PSUmObJkycitxcSk9XV1bVv355J4+vrq0D5CgQCDw8P+nlr377933//LU/5Nj23Bw8e',
  'kJQBAQEyT6ZAIDAxMWHS9+7du6GhARcyaBs+umHfJSUl7Iu+yForK6s1a9bExMS8fv26qqqqpqYmJyfn1KlTY8aMYRI0NDQsWrSI',
  'fT+ugJ9//vnkyZOknjF//vykpKTS0tLy8vJ79+4tWbJETU2ttLTUy8vrQ7Xdbd26dePGjeS/EydOjImJKSgo4PF4mZmZISEhBgYG',
  'zKrnz5+7urpWVlYqtiMbGxuynJqaGhsbq1g+XC535MiRpCVW4h2GSObZ2dkvX74UT3b//v2ysjJmefTo0QoczPLlyy9evMgsq6qq',
  'Llq06K+//iorK6uoqEhJSVm+fLmGhkZZWZmc5dv03Ozs7D7//HNm+fjx41VVVfQ9Xrx48f3798zy/PnzuVwuWnoATXbNUkNyd3cn',
  'iZcuXUo+Hz16dEJCAmXD/fv3k1+mtDYuee6g09PT1dXVmQQaGhrR0dHiae7cuaOjo8M+jYrVkBiXL18m+Zw5c0Zm+sePH2tqapJN',
  'fv/9d/E0b9++tbCwIGnmzZun8OHZ29uz7/RDQ0MFAoEC+ezdu5fkk5KSIp7gX//6l8gf5/79+8WTbdiwgR20Glu+9+/fJ1OBaGlp',
  'MdFRREpKCono9PJVVm6HDx8ma+lVfKFQ6ObmxqRUV1d///49bqsBTXbNEpCePXvG7ra5cOFCo3YUFBRE7sefPn2qWEDy8fEhCXbu',
  '3CltXydOnPhQAcnPz4+k/+GHH6Qle/HiBRk0r6qqmpOTo9jhXbt2TeQe3MTEJCAg4OTJk+LxgCIrK4vksGXLFvFmUkNDQ2YtueBO',
  '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',
  'AABJRU5ErkJggg=='
].join('');
