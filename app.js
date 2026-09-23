/* Paisa — offline-first expense tracker
   Data lives in localStorage first, then syncs to the user's own Google Sheet. */
(function () {
'use strict';

// ============================ storage ============================
var K = { cfg:'et.cfg', auth:'et.auth', txns:'et.txns', bud:'et.bud',
          rec:'et.rec', shots:'et.shots', meta:'et.meta' };

function load(k, d) {
  try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
  catch (e) { return d; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { toast('Storage full — clear some receipts'); return false; }
}

var cfg   = load(K.cfg,  { api:'' });
var auth  = load(K.auth, null);
var txns  = load(K.txns, []);
var bud   = load(K.bud,  {});
var rec   = load(K.rec,  []);
var shots = load(K.shots,{});
var meta  = load(K.meta, { cats:null, modes:null, sheetUrl:'' });

var CATS  = meta.cats  || ['Food','Grocery','Transportation','Shopping','Entertainment',
                           'Bills & Recharge','Health','Rent / EMI','Education','Other'];
var MODES = meta.modes || ['UPI','Cash','Card','Net Banking','Other'];

// ============================ tiny helpers ============================
var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

function uid() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function money(n) {
  n = Math.round(Number(n) || 0);
  return '₹' + n.toLocaleString('en-IN');
}
function moneyShort(n) {
  n = Math.round(Number(n) || 0);
  if (n >= 10000000) return '₹' + (n/10000000).toFixed(1).replace(/\.0$/,'') + 'Cr';
  if (n >= 100000)   return '₹' + (n/100000).toFixed(1).replace(/\.0$/,'') + 'L';
  if (n >= 1000)     return '₹' + (n/1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/,'') + 'k';
  return '₹' + n;
}
function ym(d) { d = new Date(d); return d.getFullYear() + '-' + pad(d.getMonth()+1); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function monthName(d) {
  return new Date(d).toLocaleDateString('en-IN', { month:'long', year:'numeric' });
}
function toast(msg) {
  var t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 2300);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================ network ============================
/* Apps Script has no OPTIONS handler, so every POST uses text/plain —
   that keeps it a "simple request" and avoids a CORS preflight. */
function post(body) {
  if (!cfg.api) return Promise.reject(new Error('no server url'));
  return fetch(cfg.api, {
    method:'POST', redirect:'follow',
    headers:{ 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}
function get(params) {
  if (!cfg.api) return Promise.reject(new Error('no server url'));
  var q = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetch(cfg.api + '?' + q, { redirect:'follow' }).then(function (r) { return r.json(); });
}

// ============================ auth ============================
var authMode = 'login';

function showAuth() {
  $('#auth').classList.remove('hide');
  $('#app').classList.add('hide');
  if (!cfg.api) setTimeout(askApi, 350);
}
function showApp() {
  $('#auth').classList.add('hide');
  $('#app').classList.remove('hide');
  renderAll();
  sync();
  takeSharedImage();
}
function askApi() {
  var v = prompt('Paste your Apps Script Web App URL (ends in /exec):', cfg.api || '');
  if (v == null) return;
  cfg.api = v.trim(); save(K.cfg, cfg);
  toast(cfg.api ? 'Server saved' : 'Server cleared');
}

function pinValue() {
  return ['#p1','#p2','#p3','#p4'].map(function (s) { return $(s).value.trim(); }).join('');
}
function clearPin() {
  ['#p1','#p2','#p3','#p4'].forEach(function (s) { $(s).value = ''; });
  $('#p1').focus();
}

function setAuthMode(m) {
  authMode = m;
  $('#authTitle').textContent = m === 'login' ? 'Welcome back' : 'Create your account';
  $('#authLede').textContent  = m === 'login'
    ? 'Enter your number and PIN to continue.'
    : 'Your own private Google Sheet gets created automatically.';
  $('#pinLabel').textContent  = m === 'login' ? '4-digit PIN' : 'Choose a 4-digit PIN';
  $('#authGo').textContent    = m === 'login' ? 'Log in' : 'Create account';
  $('#authSwap').textContent  = m === 'login'
    ? 'New here? Create an account' : 'Already have an account? Log in';
  $('#authErr').textContent = '';
}

function doAuth() {
  var phone = $('#phone').value.replace(/\D/g,'').slice(-10);
  var pin = pinValue();
  var err = $('#authErr');
  err.textContent = '';

  if (phone.length !== 10) { err.textContent = 'Enter a valid 10-digit mobile number'; return; }
  if (pin.length !== 4)    { err.textContent = 'Enter all 4 PIN digits'; return; }
  if (!cfg.api)            { err.textContent = 'Set the server URL first'; askApi(); return; }

  $('#authGo').disabled = true;
  $('#authGo').textContent = 'Please wait…';

  post({ action: authMode === 'login' ? 'login' : 'signup', phone: phone, pin: pin })
    .then(function (r) {
      if (!r.ok) {
        if (r.error === 'nouser') { setAuthMode('signup'); err.textContent = 'No account yet — set a PIN to create one'; }
        else if (r.error === 'exists') { setAuthMode('login'); err.textContent = 'Account exists — log in with your PIN'; }
        else err.textContent = r.error || 'Could not sign in';
        clearPin();
        return;
      }
      auth = { token:r.token, phone:phone, sheetUrl:r.sheetUrl || '' };
      meta = { cats:r.categories || CATS, modes:r.modes || MODES, sheetUrl:r.sheetUrl || '' };
      CATS = meta.cats; MODES = meta.modes;
      save(K.auth, auth); save(K.meta, meta);
      buildChips();
      showApp();
    })
    .catch(function () { err.textContent = 'Cannot reach the server. Check the URL.'; })
    .then(function () {
      $('#authGo').disabled = false;
      $('#authGo').textContent = authMode === 'login' ? 'Log in' : 'Create account';
    });
}

// ============================ sync ============================
var syncing = false;

function pending() {
  return txns.filter(function (t) { return !t._s || t._del; }).length;
}
function setPill() {
  var p = $('#syncPill'), n = pending();
  if (!navigator.onLine) { p.className = 'pill sync'; p.textContent = 'Offline'; return; }
  if (syncing)           { p.className = 'pill sync'; p.textContent = 'Syncing…'; return; }
  if (n)                 { p.className = 'pill sync'; p.textContent = n + ' to sync'; return; }
  p.className = 'pill ok'; p.textContent = 'Synced';
}

function sync() {
  if (syncing || !auth || !cfg.api || !navigator.onLine) { setPill(); return Promise.resolve(); }
  syncing = true; setPill();

  var dels = txns.filter(function (t) { return t._del; });
  var news = txns.filter(function (t) { return !t._s && !t._del; });

  var chain = Promise.resolve();

  dels.forEach(function (t) {
    chain = chain.then(function () {
      return post({ action:'delete', token:auth.token, id:t.id }).catch(function(){});
    });
  });

  if (news.length) {
    chain = chain.then(function () {
      return post({ action:'push', token:auth.token, items: news.map(strip) })
        .then(function (r) {
          if (!r || !r.ok) return;
          // Only mark rows the server actually accepted. A row it silently
          // skipped must stay pending, or it would be lost on the next merge.
          var ok = {};
          if (r.ids && r.ids.length) {
            r.ids.forEach(function (id) { ok[id] = 1; });
            news.forEach(function (t) { if (ok[t.id]) t._s = 1; });
          } else {
            news.forEach(function (t) { t._s = 1; });
          }
        });
    });
  }

  // upload any receipt images that are still local-only
  Object.keys(shots).forEach(function (id) {
    var t = byId(id);
    if (!t || t.screenshot) return;
    chain = chain.then(function () {
      return post({ action:'screenshot', token:auth.token, id:id, dataUrl:shots[id] })
        .then(function (r) {
          if (r && r.ok) { t.screenshot = r.url; delete shots[id]; save(K.shots, shots); }
        }).catch(function(){});
    });
  });

  return chain
    .then(function () { return get({ action:'pull', token:auth.token }); })
    .then(function (r) {
      if (!r || !r.ok) return;
      merge(r.items || []);
      bud = r.budgets || {};
      rec = r.recurring || [];
      if (r.sheetUrl) { auth.sheetUrl = r.sheetUrl; save(K.auth, auth); }
      save(K.bud, bud); save(K.rec, rec);
    })
    .catch(function () {})
    .then(function () {
      txns = txns.filter(function (t) { return !t._del; });
      save(K.txns, txns);
      syncing = false; setPill(); renderAll();
    });
}

function strip(t) {
  return { id:t.id, ts:t.ts, type:t.type, category:t.category,
           amount:t.amount, mode:t.mode, remarks:t.remarks, screenshot:t.screenshot || '' };
}
function byId(id) {
  for (var i = 0; i < txns.length; i++) if (txns[i].id === id) return txns[i];
  return null;
}

/** Server is the source of truth for rows it knows. Any local row the server
    does NOT have is kept and re-queued — never silently dropped, even if we
    previously thought it was synced. Losing an entry is worse than a retry. */
function merge(remote) {
  var map = {};
  remote.forEach(function (r) { r._s = 1; map[r.id] = r; });
  txns.forEach(function (t) {
    if (!map[t.id]) { t._s = 0; map[t.id] = t; }
    else if (shots[t.id] && !map[t.id].screenshot) map[t.id].screenshot = '';
  });
  txns = Object.keys(map).map(function (k) { return map[k]; });
  txns.sort(function (a, b) { return (b.ts || '').localeCompare(a.ts || ''); });
  save(K.txns, txns);
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
    $$(sel + ' .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(c === b));
    });
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
  var amt = parseFloat(String($('#amt').value).replace(/[^0-9.]/g,''));
  if (!isFinite(amt) || amt <= 0) { toast('Enter an amount'); $('#amt').focus(); return; }

  var d = $('#dt').value || nowLocal().d;
  var t = $('#tm').value || nowLocal().t;
  var id = uid();

  var row = {
    id:id, ts: d + 'T' + t + ':00', type: draft.type, category: draft.category,
    amount: amt, mode: draft.mode, remarks: $('#rem').value.trim(),
    screenshot:'', _s:0
  };
  if (draft.shot) { shots[id] = draft.shot; save(K.shots, shots); }

  txns.unshift(row);
  txns.sort(function (a, b) { return (b.ts || '').localeCompare(a.ts || ''); });
  save(K.txns, txns);

  resetForm();
  scanResult('');
  toast(draft.type + ' ' + money(amt) + ' saved');
  renderAll();
  sync();
}

// ---- screenshot: compress hard before it ever touches storage ----
function pickShot(file) {
  if (!file) return;
  var fr = new FileReader();
  fr.onload = function () {
    var img = new Image();
    img.onload = function () {
      var max = 1100;
      var s = Math.min(1, max / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      draft.shot = c.toDataURL('image/jpeg', 0.72);
      $('#shotPrev').src = draft.shot;
      $('#shotPrev').classList.remove('hide');
      $('#shotClear').classList.remove('hide');
      $('#shotBtn').textContent = 'Replace receipt';
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

// ============================ scan a payment screenshot ============================
/* Shrinks the image, sends it to Apps Script, which OCRs it through Google
   Drive and returns amount / merchant / category. We only PRE-FILL the form —
   nothing is ever saved without the user tapping Save. */

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

function scanBusy(on, msg) {
  $('#scanBusy').classList.toggle('hide', !on);
  if (msg) $('#scanStep').textContent = msg;
  $('#scanBtn').disabled = !!on;
}

function scanResult(html) {
  var el = $('#scanResult');
  if (!html) { el.classList.add('hide'); el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.classList.remove('hide');
}

function scanReceipt(file) {
  if (!file) return;
  if (!auth || !cfg.api) { toast('Log in first'); return; }
  if (!navigator.onLine) {
    scanResult('<div><b>No internet</b><br>Scanning needs a connection. ' +
               'Type the amount in for now — it still saves offline.</div>');
    return;
  }

  go('add');
  scanResult('');
  scanBusy(true, 'Reading your screenshot…');

  // Keep the receipt image for the entry itself, and a bigger copy for OCR.
  shrink(file, 1100, 0.72).then(function (small) {
    draft.shot = small;
    $('#shotPrev').src = small;
    $('#shotPrev').classList.remove('hide');
    $('#shotClear').classList.remove('hide');
    $('#shotBtn').textContent = 'Replace receipt';
    return shrink(file, 1600, 0.82);
  }).then(function (big) {
    return post({ action: 'scan', token: auth.token, dataUrl: big });
  }).then(function (r) {
    scanBusy(false);

    if (!r || !r.ok) {
      var why = (r && r.error) === 'ocr_unavailable'
        ? 'Scanning is not switched on yet — the Drive service needs adding to your Apps Script.'
        : ((r && r.error) || 'Could not read that image.');
      scanResult('<div><b>Could not read it</b><br>' + esc(why) +
                 ' The receipt is still attached — just type the amount.</div>');
      return;
    }
    applyScan(r);
  }).catch(function () {
    scanBusy(false);
    scanResult('<div><b>Scan failed</b><br>Check your connection. ' +
               'The receipt is attached — type the amount and save as normal.</div>');
  });
}

function applyScan(r) {
  var got = [];

  if (r.amount) { $('#amt').value = r.amount; got.push('amount ' + money(r.amount)); }

  if (r.category && CATS.indexOf(r.category) > -1) {
    draft.category = r.category;
    got.push('category ' + r.category);
  }
  if (r.mode && MODES.indexOf(r.mode) > -1) draft.mode = r.mode;
  buildChips();

  if (r.merchant) $('#rem').value = r.merchant;

  var when = r.when ? new Date(r.when) : null;
  if (when && !isNaN(when.getTime())) {
    $('#dt').value = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate());
    $('#tm').value = pad(when.getHours()) + ':' + pad(when.getMinutes());
    got.push('date & time');
  }

  if (!got.length) {
    scanResult('<div><b>Nothing readable found</b><br>' +
      'The receipt is attached. Fill the amount in yourself and save.</div>');
    return;
  }

  scanResult('<div><b>Read ' + esc(got.join(', ')) + '</b><br>' +
    'Check it below and fix anything wrong, then tap Save entry.</div>');

  if (!r.amount) { $('#amt').focus(); }
}

/* Image arriving from the Android share sheet, stashed by the service worker. */
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
  }).catch(function () {});
}

// ============================ analytics ============================
function inMonth(t, key) { return ym(t.ts) === key; }
function sum(list, type) {
  return list.reduce(function (a, t) {
    return a + (t.type === type ? Number(t.amount) || 0 : 0);
  }, 0);
}

function monthStats(key) {
  var list = txns.filter(function (t) { return inMonth(t, key); });
  var exp = sum(list,'Expense'), inc = sum(list,'Income'), sav = sum(list,'Savings');
  return { list:list, exp:exp, inc:inc, sav:sav, net: inc - exp - sav };
}

function renderStats() {
  var key = ym(new Date());
  var m = monthStats(key);

  $('#sSpent').textContent = money(m.exp);
  $('#sMonth').textContent = monthName(new Date());
  $('#kInc').textContent = moneyShort(m.inc);
  $('#kExp').textContent = moneyShort(m.exp);
  $('#kSav').textContent = moneyShort(m.sav);

  // --- budget meter + alerts ---
  var limit = Number(bud.TOTAL) || 0;
  var meter = $('#sMeter'), alerts = [];
  if (limit > 0) {
    var pctN = m.exp / limit;
    meter.style.width = Math.min(100, pctN * 100) + '%';
    meter.className = pctN >= 1 ? 'crit' : (pctN >= 0.8 ? 'warn' : '');
    $('#sLeft').textContent = money(Math.max(0, limit - m.exp));
    if (pctN >= 1) {
      alerts.push(['crit','Over budget','You have spent ' + money(m.exp) + ' of your ' +
        money(limit) + ' limit — ' + money(m.exp - limit) + ' over.']);
    } else if (pctN >= 0.8) {
      alerts.push(['warn', Math.round(pctN*100) + '% of budget used',
        money(limit - m.exp) + ' left for the rest of ' + monthName(new Date()).split(' ')[0] + '.']);
    }
  } else {
    meter.style.width = '0'; meter.className = '';
    $('#sLeft').textContent = '—';
  }

  // per-category budget alerts
  var byCat = {};
  m.list.forEach(function (t) {
    if (t.type !== 'Expense') return;
    byCat[t.category] = (byCat[t.category] || 0) + (Number(t.amount) || 0);
  });
  Object.keys(bud).forEach(function (c) {
    if (c === 'TOTAL' || !bud[c]) return;
    var spent = byCat[c] || 0;
    if (spent >= bud[c]) {
      alerts.push(['crit', c + ' over limit',
        money(spent) + ' spent against a ' + money(bud[c]) + ' limit.']);
    } else if (spent >= bud[c] * 0.8) {
      alerts.push(['warn', c + ' nearly used up',
        money(bud[c] - spent) + ' left of ' + money(bud[c]) + '.']);
    }
  });

  $('#alerts').innerHTML = alerts.slice(0,3).map(function (a) {
    return '<div class="alert ' + a[0] + '"><span>' + (a[0]==='crit'?'⚠':'!') +
           '</span><div><b>' + esc(a[1]) + '</b><br>' + esc(a[2]) + '</div></div>';
  }).join('');

  // --- pace ---
  var now = new Date();
  var dayNow = now.getDate();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  var avg = m.exp / dayNow;
  $('#pAvg').textContent = money(avg);
  $('#pProj').textContent = money(avg * daysInMonth);

  // --- category bars (single-series magnitude: one hue, sorted) ---
  var rows = Object.keys(byCat).map(function (c) { return { c:c, v:byCat[c] }; })
                   .sort(function (a,b) { return b.v - a.v; });
  var max = rows.length ? rows[0].v : 1;
  $('#catBars').innerHTML = rows.length ? rows.map(function (r) {
    return '<div class="bar-row"><div class="nm">' + esc(r.c) + '</div>' +
           '<div class="tr"><i style="width:' + Math.max(2, (r.v/max)*100) + '%"></i></div>' +
           '<div class="vl">' + moneyShort(r.v) + '</div></div>';
  }).join('') : '<div class="empty">No spending logged this month yet.</div>';

  // --- 6-month trend ---
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: ym(d), label: d.toLocaleDateString('en-IN',{month:'short'}),
                  v: sum(txns.filter(function (t) { return ym(t.ts) === ym(d); }), 'Expense') });
  }
  var tmax = Math.max.apply(null, months.map(function (x) { return x.v; }).concat([1]));
  $('#trend').innerHTML = months.map(function (x, i) {
    return '<div class="col' + (i === 5 ? ' cur' : '') + '" title="' + esc(x.label) + ' ' + money(x.v) + '">' +
           '<div class="stack"><i style="height:' + Math.max(2, (x.v/tmax)*100) + '%"></i></div>' +
           '<span>' + esc(x.label) + '</span></div>';
  }).join('');
}

// ============================ lists ============================
function txHtml(t) {
  var d = new Date(t.ts);
  var when = isNaN(d) ? '' : d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) +
             ' · ' + d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  var sign = t.type === 'Income' ? '+' : '−';
  var hasShot = t.screenshot || shots[t.id];
  return '<div class="tx" data-id="' + esc(t.id) + '">' +
    '<div class="ic">' + esc((t.category || '?').slice(0,1).toUpperCase()) + '</div>' +
    '<div class="mid"><div class="t1">' + esc(t.remarks || t.category) + '</div>' +
    '<div class="t2">' + esc(t.category) + ' · ' + esc(t.mode || '') + ' · ' + when +
    (hasShot ? ' · 📎' : '') + '</div></div>' +
    (!t._s ? '<div class="dot" title="not synced"></div>' : '') +
    '<div class="amt ' + esc(t.type) + '">' + sign + money(t.amount).slice(1) + '</div></div>';
}

function renderRecent() {
  var r = txns.slice(0, 6);
  $('#recentList').innerHTML = r.length ? r.map(txHtml).join('')
    : '<div class="empty">Nothing logged yet. Your first entry goes above.</div>';
}

var filter = { type:'', cat:'' };
function renderHist() {
  var q = ($('#q').value || '').toLowerCase().trim();
  var list = txns.filter(function (t) {
    if (filter.type && t.type !== filter.type) return false;
    if (filter.cat && t.category !== filter.cat) return false;
    if (!q) return true;
    return (t.remarks || '').toLowerCase().indexOf(q) > -1 ||
           (t.category || '').toLowerCase().indexOf(q) > -1 ||
           (t.mode || '').toLowerCase().indexOf(q) > -1 ||
           String(t.amount).indexOf(q) > -1;
  });
  $('#histList').innerHTML = list.length ? list.slice(0,300).map(txHtml).join('')
    : '<div class="empty">No entries match.</div>';
}

function buildFilters() {
  var opts = [['','All']].concat(['Expense','Income','Savings'].map(function (t) { return ['t:'+t, t]; }))
    .concat(CATS.map(function (c) { return ['c:'+c, c]; }));
  $('#filterChips').innerHTML = opts.map(function (o) {
    var on = (o[0] === '' && !filter.type && !filter.cat) ||
             (o[0] === 't:' + filter.type && filter.type) ||
             (o[0] === 'c:' + filter.cat && filter.cat);
    return '<button class="chip" type="button" data-v="' + esc(o[0]) + '" aria-pressed="' +
           (!!on) + '">' + esc(o[1]) + '</button>';
  }).join('');
}

// ============================ settings ============================
function renderSettings() {
  $('#bTotal').value = bud.TOTAL || '';
  $('#bCats').innerHTML = CATS.map(function (c) {
    return '<label class="f"><span>' + esc(c) + '</span>' +
      '<input class="in bcat" data-c="' + esc(c) + '" type="number" inputmode="numeric" ' +
      'placeholder="no limit" value="' + (bud[c] || '') + '"></label>';
  }).join('');

  $('#recList').innerHTML = rec.length ? rec.map(function (r, i) {
    return '<div class="tx" data-ri="' + i + '"><div class="ic">↻</div><div class="mid">' +
      '<div class="t1">' + esc(r.name) + '</div><div class="t2">' + esc(r.category) +
      ' · day ' + esc(r.day) + ' · ' + (r.active === false ? 'paused' : 'active') + '</div></div>' +
      '<div class="amt ' + esc(r.type) + '">' + money(r.amount) + '</div>' +
      '<button class="chip recdel" data-ri="' + i + '" type="button">✕</button></div>';
  }).join('') : '<div class="empty">Nothing recurring yet. Add rent, EMI or subscriptions.</div>';

  $('#acct').textContent = auth
    ? 'Signed in as xxxxx' + String(auth.phone).slice(-5) + ' · ' + txns.length + ' entries stored'
    : '';
  $('#openSheet').href = (auth && auth.sheetUrl) || '#';
  $('#openSheet').style.display = (auth && auth.sheetUrl) ? 'block' : 'none';
}

function saveBudgets() {
  bud = {};
  var tot = Number($('#bTotal').value);
  if (tot > 0) bud.TOTAL = tot;
  $$('.bcat').forEach(function (el) {
    var n = Number(el.value); if (n > 0) bud[el.dataset.c] = n;
  });
  save(K.bud, bud);
  var list = Object.keys(bud).map(function (c) { return { category:c, limit:bud[c] }; });
  post({ action:'budgets', token:auth.token, budgets:list })
    .then(function () { toast('Budgets saved'); })
    .catch(function () { toast('Saved on phone — will sync later'); });
  renderStats();
}

function recurringSheet(existing, idx) {
  var r = existing || { name:'', type:'Expense', category:CATS[0], amount:'', mode:'UPI', day:1, active:true };
  var wrap = document.createElement('div');
  wrap.className = 'sheet';
  wrap.innerHTML =
    '<div><h3>' + (existing ? 'Edit' : 'New') + ' recurring entry</h3>' +
    '<label class="f"><span>Name</span><input class="in" id="rN" value="' + esc(r.name) + '" placeholder="House rent"></label>' +
    '<div class="row2">' +
    '<label class="f"><span>Amount (₹)</span><input class="in" id="rA" type="number" value="' + esc(r.amount) + '"></label>' +
    '<label class="f"><span>Day of month</span><input class="in" id="rD" type="number" min="1" max="28" value="' + esc(r.day) + '"></label>' +
    '</div>' +
    '<label class="f"><span>Type</span><select class="in" id="rT">' +
      ['Expense','Income','Savings'].map(function (t) {
        return '<option' + (t === r.type ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="f"><span>Category</span><select class="in" id="rC">' +
      CATS.map(function (c) {
        return '<option' + (c === r.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="f"><span>Paid by</span><select class="in" id="rM">' +
      MODES.map(function (m) {
        return '<option' + (m === r.mode ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') +
    '</select></label>' +
    '<button class="btn" id="rOk">Save</button>' +
    '<button class="btn ghost sm" id="rNo" style="margin-top:8px">Cancel</button></div>';
  document.body.appendChild(wrap);

  wrap.querySelector('#rNo').onclick = function () { wrap.remove(); };
  wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
  wrap.querySelector('#rOk').onclick = function () {
    var item = {
      name: wrap.querySelector('#rN').value.trim() || 'Recurring',
      amount: Number(wrap.querySelector('#rA').value) || 0,
      day: Math.min(28, Math.max(1, Number(wrap.querySelector('#rD').value) || 1)),
      type: wrap.querySelector('#rT').value,
      category: wrap.querySelector('#rC').value,
      mode: wrap.querySelector('#rM').value,
      active: true, lastRun: (r.lastRun || '')
    };
    if (!item.amount) { toast('Enter an amount'); return; }
    if (idx == null) rec.push(item); else rec[idx] = item;
    save(K.rec, rec);
    post({ action:'recurring', token:auth.token, recurring:rec })
      .then(function () { toast('Recurring saved'); })
      .catch(function () { toast('Saved on phone — will sync later'); });
    wrap.remove(); renderSettings();
  };
}

function exportCsv() {
  var head = ['Date','Time','Type','Category','Amount','Mode','Remarks','Screenshot'];
  var rows = txns.map(function (t) {
    var d = new Date(t.ts);
    return [ isNaN(d) ? '' : d.toLocaleDateString('en-GB'),
             isNaN(d) ? '' : d.toTimeString().slice(0,5),
             t.type, t.category, t.amount, t.mode, t.remarks, t.screenshot || '' ];
  });
  var csv = [head].concat(rows).map(function (r) {
    return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g,'""') + '"'; }).join(',');
  }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = 'expenses-' + ym(new Date()) + '.csv';
  a.click();
}

// ============================ entry detail ============================
function openTx(id) {
  var t = byId(id); if (!t) return;
  var img = t.screenshot || shots[t.id] || '';
  var d = new Date(t.ts);
  var wrap = document.createElement('div');
  wrap.className = 'sheet';
  wrap.innerHTML = '<div><h3>' + esc(t.remarks || t.category) + '</h3>' +
    '<div class="hero"><div class="big ' + esc(t.type) + '" style="color:var(--' +
      t.type.toLowerCase() + ')">' + money(t.amount) + '</div></div>' +
    '<p style="color:var(--ink-2);font-size:13.5px;margin:10px 0 16px">' +
      esc(t.type) + ' · ' + esc(t.category) + ' · ' + esc(t.mode || '—') + '<br>' +
      (isNaN(d) ? '' : esc(d.toLocaleString('en-IN'))) + '</p>' +
    (img ? '<img src="' + esc(img) + '" style="width:100%;border-radius:12px;margin-bottom:14px" alt="receipt">' : '') +
    '<button class="btn danger sm" id="txDel">Delete entry</button>' +
    '<button class="btn ghost sm" id="txNo" style="margin-top:8px">Close</button></div>';
  document.body.appendChild(wrap);
  wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
  wrap.querySelector('#txNo').onclick = function () { wrap.remove(); };
  wrap.querySelector('#txDel').onclick = function () {
    t._del = 1; delete shots[t.id];
    save(K.txns, txns); save(K.shots, shots);
    if (!t._s) txns = txns.filter(function (x) { return x.id !== t.id; });
    save(K.txns, txns);
    wrap.remove(); toast('Deleted'); renderAll(); sync();
  };
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
  window.scrollTo(0, 0);
  renderAll();
}

function renderAll() {
  setPill();
  if (view === 'add')   renderRecent();
  if (view === 'stats') renderStats();
  if (view === 'hist')  { buildFilters(); renderHist(); }
  if (view === 'set')   renderSettings();
}

// ============================ wiring ============================
function init() {
  buildChips();
  resetForm();

  chipGroup('#catChips','category');
  chipGroup('#modeChips','mode');

  $('#typeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    draft.type = b.dataset.v;
    $$('#typeSeg button').forEach(function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
  });

  $('#save').addEventListener('click', saveEntry);
  $('#scanBtn').addEventListener('click', function () { $('#scanIn').click(); });
  $('#scanIn').addEventListener('change', function (e) {
    scanReceipt(e.target.files[0]);
    e.target.value = '';
  });
  $('#shotBtn').addEventListener('click', function () { $('#shotIn').click(); });
  $('#shotIn').addEventListener('change', function (e) { pickShot(e.target.files[0]); });
  $('#shotClear').addEventListener('click', function () {
    draft.shot = '';
    $('#shotPrev').classList.add('hide'); $('#shotClear').classList.add('hide');
    $('#shotBtn').textContent = 'Attach receipt';
  });

  document.addEventListener('click', function (e) {
    var tx = e.target.closest('.tx[data-id]');
    if (tx && !e.target.closest('.recdel')) { openTx(tx.dataset.id); return; }
    var rd = e.target.closest('.recdel');
    if (rd) {
      rec.splice(Number(rd.dataset.ri), 1); save(K.rec, rec);
      post({ action:'recurring', token:auth.token, recurring:rec }).catch(function(){});
      renderSettings(); return;
    }
    var rr = e.target.closest('#recList .tx[data-ri]');
    if (rr) recurringSheet(rec[Number(rr.dataset.ri)], Number(rr.dataset.ri));
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
    if (v.indexOf('c:') === 0) filter.cat  = v.slice(2);
    buildFilters(); renderHist();
  });

  $('#bSave').addEventListener('click', saveBudgets);
  $('#recAdd').addEventListener('click', function () { recurringSheet(null, null); });
  $('#syncNow').addEventListener('click', function () { sync().then(function(){ toast('Synced'); }); });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#logout').addEventListener('click', function () {
    if (!confirm('Log out? Entries already synced stay in your Google Sheet.')) return;
    localStorage.removeItem(K.auth);
    localStorage.removeItem(K.txns);
    localStorage.removeItem(K.shots);
    location.reload();
  });

  // auth screen
  $('#authGo').addEventListener('click', doAuth);
  $('#authSwap').addEventListener('click', function () {
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });
  $('#authCfg').addEventListener('click', askApi);
  ['#p1','#p2','#p3','#p4'].forEach(function (s, i, arr) {
    $(s).addEventListener('input', function () {
      $(s).value = $(s).value.replace(/\D/g,'');
      if ($(s).value && i < 3) $(arr[i+1]).focus();
      if ($(s).value && i === 3) doAuth();
    });
    $(s).addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !$(s).value && i > 0) $(arr[i-1]).focus();
    });
  });
  $('#phone').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g,'').slice(0,10);
    if (this.value.length === 10) $('#p1').focus();
  });

  window.addEventListener('online',  function () { setPill(); sync(); });
  window.addEventListener('offline', setPill);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && auth) sync();
  });

  if (auth && auth.token) { setAuthMode('login'); showApp(); }
  else { setAuthMode(cfg.api ? 'login' : 'signup'); showAuth(); }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function(){});
  }
}

document.addEventListener('DOMContentLoaded', init);
})();
