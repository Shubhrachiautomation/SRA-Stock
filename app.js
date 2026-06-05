/* ================================================================
   SRA STOCK MANAGEMENT v2.1 — app.js
   Fixes: parent cats displayed + in Add Stock, delete parent cat,
          delete sale with stock reversal
   ================================================================

   DATABASE SCHEMA:
   /stock_items/{key}       itemName, serialNumber, parentType,
                            category, quantity, status, dateAdded,
                            notes, addedBy, lastUpdated
   /categories/{TYPE}       array of sub-category strings
                            TYPE = "MACHINE" | "TOOL" | "EQUIPMENT"
                            or any custom parent key (uppercased)
   /parent_categories/{key} { name, icon }   ← custom parents only
   /sales/{key}             itemId, itemName, category, parentType,
                            vendorName, quantitySold, saleDate,
                            notes, dispatchedBy, timestamp
   /activity_log/{key}      message, user, timestamp
   ================================================================ */
'use strict';

/* ── FIREBASE CONFIG ──────────────────────────────────────────── */
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY_HERE",
  authDomain:        "sra-stock-e75dc.firebaseapp.com",
  databaseURL:       "https://sra-stock-e75dc-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId:         "sra-stock-e75dc",
  storageBucket:     "sra-stock-e75dc.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
try {
  firebase.initializeApp(firebaseConfig);
  console.log('[Firebase] Initialized:', firebaseConfig.projectId);
} catch(e) {
  console.warn('[Firebase] Init warning:', e.message);
}

const db = firebase.database();
const DB = {
  STOCK:       'stock_items',
  CATS:        'categories',
  PARENT_CATS: 'parent_categories',
  ACTIVITY:    'activity_log',
  SALES:       'sales',
  USERS:       'users'
};

/* ── DB HELPERS ───────────────────────────────────────────────── */
async function fbPush(p,d)   { const r = await db.ref(p).push(d); return r.key; }
async function fbSet(p,d)    { await db.ref(p).set(d); }
async function fbUpdate(p,d) { await db.ref(p).update(d); }
async function fbDelete(p)   { await db.ref(p).remove(); }
async function fbRead(p)     { const s = await db.ref(p).once('value'); return s.val(); }
function fbListen(p,cb)      { db.ref(p).on('value', s => cb(s.val()), e => console.error('[FB]',e.message)); }
function fbOff(p)            { db.ref(p).off(); }

/* ── APP STATE ────────────────────────────────────────────────── */
const S = {
  user:       null,
  stock:      {},
  cats:       {},        // { MACHINE:[...], TOOL:[...], EQUIPMENT:[...], CUSTOM_KEY:[...] }
  parentCats: {},        // { firebaseKey: { name, icon } }  ← custom parents from Firebase
  sales:      {},
  bulkRows:   [],
  sortField:  'itemName',
  sortAsc:    true,
  pending:    null
};

/* Built-in parent types — always shown, cannot be deleted */
const BUILTIN_PARENTS = [
  { key:'MACHINE',   label:'Machines',  icon:'⚙️',  dot:'blue'  },
  { key:'TOOL',      label:'Tools',     icon:'🔧',  dot:'green' },
  { key:'EQUIPMENT', label:'Equipment', icon:'📦',  dot:'amber' }
];

const DEFAULT_CATS = {
  MACHINE:   ['CNC Machine','Lathe Machine','Milling Machine','Hydraulic Press','Conveyor System','Drilling Machine'],
  TOOL:      ['Hand Tools','Power Tools','Cutting Tools','Measuring Instruments','Welding Tools','Pneumatic Tools'],
  EQUIPMENT: ['Safety Equipment','Testing Equipment','Packaging Equipment','Lifting Equipment','Storage Equipment','Electrical Equipment']
};

/* ── INIT ─────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  const fd = document.getElementById('fm-date');
  if(fd) fd.value = today();
  const sd = document.getElementById('sell-date');
  if(sd) sd.value = today();

  updateClock();
  setInterval(updateClock, 1000);

  const zone = document.getElementById('drop-zone');
  if(zone) {
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag');
      const f = e.dataTransfer.files[0]; if(f) parseExcel(f);
    });
  }

  document.getElementById('l-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
  document.getElementById('l-user').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

  document.addEventListener('keydown', e => {
    if(e.key==='Escape')
      ['m-edit','m-cat','m-parent-cat','m-user','m-confirm','m-sell'].forEach(closeModal);
  });

  /* Restore session from localStorage (no Java backend needed) */
  const saved = localStorage.getItem('sra_session');
  if(saved) {
    try {
      S.user = JSON.parse(saved);
      bootApp();
    } catch(_) { showLogin(); }
  } else {
    /* Seed default admin on very first load */
    await seedDefaultAdmin();
    showLogin();
  }
});

function updateClock() {
  const el = document.getElementById('clock');
  if(el) el.textContent = new Date().toLocaleTimeString('en-IN',{hour12:true});
}

/* ── SIMPLE PASSWORD HASH (no backend needed) ─────────────────── */
/* Uses Web Crypto SHA-256. Returns hex string. */
async function hashPw(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* Seed the default admin account into Firebase on first boot */
async function seedDefaultAdmin() {
  try {
    const existing = await fbRead(`${DB.USERS}/shubhrachi`);
    if(!existing) {
      const pwHash = await hashPw('shubhrachi123');
      await fbSet(`${DB.USERS}/shubhrachi`, {
        username:'shubhrachi', displayName:'Shubhrachi Admin',
        role:'ADMIN', pwHash, active:true,
        createdAt: new Date().toISOString(), protected: true
      });
      console.log('[SRA] Default admin seeded in Firebase.');
    }
  } catch(e) { console.warn('[SRA] Seed skipped:', e.message); }
}

/* ── AUTH — 100% Firebase, no Java backend ────────────────────── */
async function doLogin() {
  const username = document.getElementById('l-user').value.trim().toLowerCase();
  const password = document.getElementById('l-pass').value;
  const errEl    = document.getElementById('login-err');
  const btn      = document.getElementById('login-btn');
  hideEl(errEl);
  if(!username || !password) { showEl(errEl,'Please enter username and password.'); return; }
  btn.disabled = true;
  btn.innerHTML = '⏳ Signing in…';

  try {
    /* Read user record from Firebase /users/{username} */
    const userRec = await fbRead(`${DB.USERS}/${username}`);
    if(!userRec) {
      showEl(errEl,'User not found. Check username and try again.');
      return;
    }
    if(!userRec.active) {
      showEl(errEl,'This account is inactive. Contact your admin.');
      return;
    }
    const pwHash = await hashPw(password);
    if(pwHash !== userRec.pwHash) {
      showEl(errEl,'Incorrect password. Please try again.');
      return;
    }
    /* Login success */
    S.user = {
      userId:      username,
      username:    userRec.username || username,
      displayName: userRec.displayName || username,
      role:        userRec.role || 'VIEW_ONLY'
    };
    localStorage.setItem('sra_session', JSON.stringify(S.user));
    bootApp();
  } catch(e) {
    showEl(errEl,'Login error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '→ Sign In';
  }
}

async function doLogout() {
  [DB.STOCK, DB.CATS, DB.PARENT_CATS, DB.ACTIVITY, DB.SALES, DB.USERS].forEach(fbOff);
  S.user = null; S.stock = {}; S.cats = {}; S.parentCats = {}; S.sales = {};
  localStorage.removeItem('sra_session');
  showLogin();
  toast('Logged out successfully.','success');
}

/* ── PAGE ROUTING ─────────────────────────────────────────────── */
function showLogin() {
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('app-page').classList.add('hidden');
  val('l-user',''); val('l-pass','');
  hideEl(document.getElementById('login-err'));
}

function bootApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-page').classList.remove('hidden');
  applyRoleUI();
  startListeners();
  goTo('dashboard');
}

function applyRoleUI() {
  const {role, displayName, username} = S.user;
  const isAdmin   = role === 'ADMIN';
  const isMgrPlus = role === 'ADMIN' || role === 'MANAGER';

  setText('nav-name', displayName || username);
  const av = document.getElementById('nav-avatar');
  if(av) av.textContent = (displayName || username)[0].toUpperCase();

  const rt = document.getElementById('nav-role');
  if(rt) { rt.textContent = role.replace(/_/g,' '); rt.className = 'role-tag '+role.toLowerCase(); }

  document.querySelectorAll('.role-mgrplus').forEach(el => el.style.display = isMgrPlus ? '' : 'none');
  document.querySelectorAll('.role-admin').forEach(el   => el.style.display = isAdmin   ? '' : 'none');

  const ah = document.getElementById('act-col-hdr');
  if(ah) ah.style.display = isMgrPlus ? '' : 'none';
}

const PAGE_TITLES = {
  dashboard:'Dashboard', inventory:'Inventory', 'add-stock':'Add Stock',
  sales:'Sales Ledger', categories:'Categories', users:'Users'
};

function goTo(sec) {
  const {role} = S.user;
  if((sec==='add-stock'||sec==='categories') && role==='VIEW_ONLY') { toast('Access restricted for your role.','error'); return; }
  if(sec==='users' && role!=='ADMIN') { toast('Admin access required.','error'); return; }

  closeMobileSidebar();

  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.sec === sec));
  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('sec-'+sec);
  if(target) target.classList.add('active');

  const pt = document.getElementById('page-title');
  if(pt) pt.textContent = PAGE_TITLES[sec] || sec;

  const sw = document.getElementById('search-wrap');
  if(sw) sw.style.display = (sec==='inventory') ? 'flex' : 'none';

  if(sec==='categories') renderCats();
  if(sec==='users')      loadUsers();
  if(sec==='sales')      renderSalesTable();
}

function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('mobile-open');
  document.getElementById('sidebar-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('active');
  document.body.style.overflow = '';
}

/* ── FIREBASE LISTENERS ───────────────────────────────────────── */
function startListeners() {
  fbListen(DB.STOCK, snap => {
    S.stock = snap || {};
    renderTable();
    updateStats();
    updateCategoryAnalytics();
  });

  fbListen(DB.CATS, snap => {
    if(snap) {
      S.cats = snap;
    } else {
      S.cats = JSON.parse(JSON.stringify(DEFAULT_CATS));
      fbSet(DB.CATS, S.cats);
    }
    refreshAllTypeDropdowns();
    refreshFilterCats();
    renderCats();
  });

  /* FIX 1: Listen to parent_categories and re-render everything that uses types */
  fbListen(DB.PARENT_CATS, snap => {
    S.parentCats = snap || {};
    refreshAllTypeDropdowns();   // update fm-type, e-type, c-type dropdowns
    renderCats();                // show new parent category cards
  });

  fbListen(DB.ACTIVITY, snap => renderActivity(snap));

  fbListen(DB.SALES, snap => {
    S.sales = snap || {};
    updateStats();
    updateCategoryAnalytics();
    renderSalesMini();
    if(document.getElementById('sec-sales')?.classList.contains('active')) {
      renderSalesTable();
    }
  });
}

/* ── HELPERS: get all parent types (builtin + custom) ─────────── */
function getAllParentTypes() {
  // Returns array of { key, label, icon, isCustom }
  const builtins = BUILTIN_PARENTS.map(p => ({ ...p, isCustom:false }));
  const customs  = Object.entries(S.parentCats).map(([fbKey, p]) => ({
    key:      (p.name || fbKey).toUpperCase().replace(/\s+/g,'_'),
    label:    p.name,
    icon:     p.icon || '📁',
    fbKey,                    // original Firebase key for deletion
    isCustom: true
  }));
  return [...builtins, ...customs];
}

/* FIX 2: Rebuild ALL type dropdowns whenever parent cats change */
function refreshAllTypeDropdowns() {
  const types = getAllParentTypes();

  // Add Stock form
  const fmType = document.getElementById('fm-type');
  if(fmType) {
    const prev = fmType.value;
    fmType.innerHTML = '<option value="">— Select —</option>';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === prev) o.selected = true;
      fmType.appendChild(o);
    });
  }

  // Edit modal
  const eType = document.getElementById('e-type');
  if(eType) {
    const prev = eType.value;
    eType.innerHTML = '';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === prev) o.selected = true;
      eType.appendChild(o);
    });
  }

  // Sub-category modal parent selector
  const cType = document.getElementById('c-type');
  if(cType) {
    const prev = cType.value;
    cType.innerHTML = '';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === prev) o.selected = true;
      cType.appendChild(o);
    });
  }

  // Filter bar type dropdown
  const fType = document.getElementById('f-type');
  if(fType) {
    const prev = fType.value;
    fType.innerHTML = '<option value="">All Types</option>';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === prev) o.selected = true;
      fType.appendChild(o);
    });
  }

  // Sales ledger filter
  const sfType = document.getElementById('sale-f-type');
  if(sfType) {
    const prev = sfType.value;
    sfType.innerHTML = '<option value="">All Types</option>';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === prev) o.selected = true;
      sfType.appendChild(o);
    });
  }
}

/* ── DASHBOARD ────────────────────────────────────────────────── */
function updateStats() {
  const items = Object.values(S.stock);
  const qtyByType   = {};
  const qtyByStatus = { AVAILABLE:0, IN_USE:0, UNDER_MAINTENANCE:0 };
  let totalQty = 0, lowStockCount = 0;

  /* Sum QTY (not count records) — the core bug fix */
  items.forEach(i => {
    const qty = parseInt(i.quantity) || 0;
    totalQty += qty;
    if(!qtyByType[i.parentType]) qtyByType[i.parentType] = 0;
    qtyByType[i.parentType] += qty;
    if(qtyByStatus[i.status] !== undefined) qtyByStatus[i.status] += qty;
    if(qty > 0 && qty <= 3) lowStockCount++;
  });

  const totalSold = Object.values(S.sales).reduce((s,r) => s + (parseInt(r.quantitySold)||0), 0);

  setText('st-machine',  qtyByType['MACHINE']   || 0);
  setText('st-tool',     qtyByType['TOOL']       || 0);
  setText('st-equip',    qtyByType['EQUIPMENT']  || 0);
  setText('st-total',    totalQty);
  setText('st-sold',     totalSold);
  setText('st-lowstock', lowStockCount);
  setText('lv-total',    totalQty);

  const tot = totalQty || 1;
  setWidth('bar-av', qtyByStatus.AVAILABLE/tot*100);
  setWidth('bar-iu', qtyByStatus.IN_USE/tot*100);
  setWidth('bar-mn', qtyByStatus.UNDER_MAINTENANCE/tot*100);
  setText('cnt-av', qtyByStatus.AVAILABLE);
  setText('cnt-iu', qtyByStatus.IN_USE);
  setText('cnt-mn', qtyByStatus.UNDER_MAINTENANCE);
}

function updateCategoryAnalytics() {
  const el = document.getElementById('cat-analytics'); if(!el) return;
  const catData = {};
  Object.values(S.stock).forEach(i => {
    const k = i.category || 'General';
    if(!catData[k]) catData[k] = { remaining:0, sold:0 };
    catData[k].remaining += parseInt(i.quantity)||0;
  });
  Object.values(S.sales).forEach(s => {
    const k = s.category || 'General';
    if(!catData[k]) catData[k] = { remaining:0, sold:0 };
    catData[k].sold += parseInt(s.quantitySold)||0;
  });
  const keys = Object.keys(catData);
  if(!keys.length) { el.innerHTML='<div class="empty-state-sm">No data yet</div>'; return; }
  el.innerHTML = keys.sort().map(k => `
    <div class="ca-row">
      <span class="ca-name">${esc(k)}</span>
      <div class="ca-vals">
        <span class="ca-badge rem" title="Remaining">▪ ${catData[k].remaining}</span>
        <span class="ca-badge sold" title="Sold">↓ ${catData[k].sold}</span>
      </div>
    </div>`).join('');
}

function renderActivity(snap) {
  const el = document.getElementById('act-list'); if(!el) return;
  if(!snap) { el.innerHTML='<div class="empty-state-sm">No activity yet</div>'; return; }
  el.innerHTML = Object.values(snap)
    .sort((a,b) => b.timestamp - a.timestamp).slice(0,12)
    .map(e => `
      <div class="act-item">
        <span class="act-dot"></span>
        <span class="act-msg">${esc(e.message)}</span>
        <span class="act-time">${ago(e.timestamp)}</span>
      </div>`).join('');
}

function renderSalesMini() {
  const el = document.getElementById('sales-mini-list'); if(!el) return;
  const sales = Object.values(S.sales);
  if(!sales.length) { el.innerHTML='<div class="empty-state-sm">No dispatches yet</div>'; return; }
  el.innerHTML = sales
    .sort((a,b) => b.timestamp - a.timestamp).slice(0,8)
    .map(s => `
      <div class="smini-item">
        <div>
          <div class="smini-name">${esc(s.itemName||'—')}</div>
          <div class="smini-vendor">${esc(s.vendorName||'—')}</div>
        </div>
        <span class="smini-qty">−${s.quantitySold}</span>
      </div>`).join('');
}

async function logActivity(msg) {
  try {
    await fbPush(DB.ACTIVITY, {
      message: msg, user: S.user?.displayName || 'Unknown', timestamp: Date.now()
    });
  } catch(_) {}
}

/* ── INVENTORY TABLE ──────────────────────────────────────────── */
function getFiltered() {
  const q  = ((document.getElementById('search-inp')?.value)||'').toLowerCase();
  const ft = document.getElementById('f-type')?.value   || '';
  const fc = document.getElementById('f-cat')?.value    || '';
  const fs = document.getElementById('f-status')?.value || '';
  let rows = Object.entries(S.stock);
  if(ft) rows = rows.filter(([,i]) => i.parentType === ft);
  if(fc) rows = rows.filter(([,i]) => i.category   === fc);
  if(fs) rows = rows.filter(([,i]) => i.status     === fs);
  if(q)  rows = rows.filter(([,i]) =>
    (i.itemName||'').toLowerCase().includes(q) ||
    (i.serialNumber||'').toLowerCase().includes(q) ||
    (i.category||'').toLowerCase().includes(q)
  );
  rows.sort((a,b) => {
    const va = String(a[1][S.sortField]||'').toLowerCase();
    const vb = String(b[1][S.sortField]||'').toLowerCase();
    return S.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  return rows;
}

function renderTable() {
  const tbody = document.getElementById('inv-tbody'); if(!tbody) return;
  const rows  = getFiltered();
  const count = rows.length;
  setText('row-count', count+' item'+(count!==1?'s':''));

  if(!count) {
    tbody.innerHTML='<tr><td colspan="8" class="tbl-empty">No items match the current filters.</td></tr>';
    return;
  }

  const canEdit   = S.user?.role !== 'VIEW_ONLY';
  const canDelete = S.user?.role === 'ADMIN';
  const canSell   = S.user?.role === 'ADMIN' || S.user?.role === 'MANAGER';

  tbody.innerHTML = rows.map(([id,i]) => {
    const qty     = parseInt(i.quantity)||0;
    const isLow   = qty > 0 && qty <= 3;
    const typeKey = (i.parentType||'').toLowerCase();
    return `
    <tr${isLow?' class="low-stock"':''}>
      <td>
        <strong>${esc(i.itemName||'—')}</strong>
        ${isLow?'<span style="color:#dc2626;font-size:.68rem;font-weight:700;margin-left:6px;background:#fef2f2;padding:1px 6px;border-radius:4px">LOW</span>':''}
      </td>
      <td style="font-family:var(--fmono);font-size:.77rem;color:var(--tx3)">${esc(i.serialNumber||'—')}</td>
      <td><span class="badge ${typeKey}">${esc(i.parentType||'—')}</span></td>
      <td>${esc(i.category||'—')}</td>
      <td><strong style="font-family:var(--fmono)">${qty}</strong></td>
      <td><span class="pill ${sCls(i.status)}">${sLbl(i.status)}</span></td>
      <td style="font-size:.78rem;color:var(--tx3)">${fmtDate(i.dateAdded)}</td>
      <td${canEdit?'':' style="display:none"'}>
        <div class="row-actions">
          ${canEdit ? `<button class="ibtn edit" title="Edit" onclick="openEdit('${id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          ${canSell ? `<button class="ibtn sell" title="Sell / Dispatch" onclick="openSell('${id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
          </button>` : ''}
          ${canDelete ? `<button class="ibtn del" title="Delete Item" onclick="askDelete('${id}','${esc(i.itemName||'item')}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function filterTable()  { renderTable(); refreshFilterCats(); }
function sortBy(f) {
  if(S.sortField===f) S.sortAsc=!S.sortAsc; else { S.sortField=f; S.sortAsc=true; }
  renderTable();
}

function refreshFilterCats() {
  const ft  = document.getElementById('f-type')?.value || '';
  const sel = document.getElementById('f-cat'); if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Categories</option>';
  const pool = ft ? (S.cats[ft]||[]) : [...new Set(Object.values(S.cats).flat())];
  pool.forEach(c => {
    const o = document.createElement('option');
    o.value = o.textContent = c;
    if(c===cur) o.selected = true;
    sel.appendChild(o);
  });
}

/* ── CATEGORY DROPDOWN REFRESH ────────────────────────────────── */
function refreshCatDrop(selId, typeSelId) {
  const type = document.getElementById(typeSelId)?.value || '';
  const sel  = document.getElementById(selId); if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const cats = type ? (S.cats[type]||[]) : [];
  if(!cats.length) {
    sel.innerHTML = `<option value="">${type ? 'No sub-categories yet — add one' : '— Select Type first —'}</option>`;
    return;
  }
  cats.forEach(c => {
    const o = document.createElement('option');
    o.value = o.textContent = c;
    if(c===prev) o.selected = true;
    sel.appendChild(o);
  });
}

/* ── MANUAL ENTRY ─────────────────────────────────────────────── */
async function submitManual() {
  const name   = document.getElementById('fm-name').value.trim();
  const serial = document.getElementById('fm-serial').value.trim();
  const type   = document.getElementById('fm-type').value;
  const cat    = document.getElementById('fm-cat').value;
  const qty    = parseInt(document.getElementById('fm-qty').value) || 0;
  const status = document.getElementById('fm-status').value;
  const date   = document.getElementById('fm-date').value;
  const notes  = document.getElementById('fm-notes').value.trim();
  const okEl   = document.getElementById('add-ok');
  const errEl  = document.getElementById('add-err');
  hideEl(okEl); hideEl(errEl);

  if(!name)   { showEl(errEl,'Item Name is required.'); return; }
  if(!type)   { showEl(errEl,'Parent Type is required.'); return; }
  if(!cat)    { showEl(errEl,'Category is required.'); return; }
  if(qty < 1) { showEl(errEl,'Quantity must be at least 1.'); return; }

  const item = {
    itemName:name, serialNumber:serial||genId('SRA'), parentType:type,
    category:cat, quantity:qty, status,
    dateAdded:date||today(), notes,
    addedBy:S.user?.displayName||'Unknown', lastUpdated:new Date().toISOString()
  };
  try {
    const key = await fbPush(DB.STOCK, item);
    await logActivity(`Added "${name}" (${type}) × ${qty}`);
    showEl(okEl, `✓ "${name}" added! Key: ${key.substring(0,10)}…`);
    clearManual();
  } catch(e) { showEl(errEl,'Firebase error: '+e.message); }
}

function clearManual() {
  ['fm-name','fm-serial','fm-notes'].forEach(id => val(id,''));
  val('fm-qty','1'); val('fm-type',''); val('fm-status','AVAILABLE'); val('fm-date',today());
  document.getElementById('fm-cat').innerHTML = '<option value="">— Select Type first —</option>';
}

/* ── EDIT MODAL ───────────────────────────────────────────────── */
function openEdit(id) {
  const i = S.stock[id]; if(!i) return;
  val('edit-id',id); val('e-name',i.itemName||''); val('e-serial',i.serialNumber||'');
  val('e-qty',i.quantity||1); val('e-status',i.status||'AVAILABLE'); val('e-notes',i.notes||'');
  // Rebuild e-type with all current parents then set value
  const eType = document.getElementById('e-type');
  if(eType) {
    const types = getAllParentTypes();
    eType.innerHTML = '';
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t.key; o.textContent = t.label;
      if(t.key === (i.parentType||'MACHINE')) o.selected = true;
      eType.appendChild(o);
    });
  }
  refreshCatDrop('e-cat','e-type');
  setTimeout(() => val('e-cat', i.category||''), 60);
  openModal('m-edit');
}

async function saveEdit() {
  const id     = document.getElementById('edit-id').value;
  const name   = document.getElementById('e-name').value.trim();
  const serial = document.getElementById('e-serial').value.trim();
  const type   = document.getElementById('e-type').value;
  const cat    = document.getElementById('e-cat').value;
  const qty    = parseInt(document.getElementById('e-qty').value) || 1;
  const status = document.getElementById('e-status').value;
  const notes  = document.getElementById('e-notes').value.trim();
  if(!name||!type||!cat) { toast('Name, Type and Category are required.','error'); return; }
  try {
    await fbUpdate(`${DB.STOCK}/${id}`,{
      itemName:name, serialNumber:serial, parentType:type,
      category:cat, quantity:qty, status, notes, lastUpdated:new Date().toISOString()
    });
    await logActivity(`Edited "${name}"`);
    closeModal('m-edit');
    toast(`"${name}" updated.`,'success');
  } catch(e) { toast('Update failed: '+e.message,'error'); }
}

/* ── SELL / DISPATCH ──────────────────────────────────────────── */
function openSell(id) {
  const i = S.stock[id]; if(!i) return;
  val('sell-item-id',id); val('sell-qty',''); val('sell-vendor','');
  val('sell-date',today()); val('sell-notes','');
  hideEl(document.getElementById('sell-err'));
  const info = document.getElementById('sell-item-info');
  if(info) {
    info.innerHTML = `<strong>${esc(i.itemName||'—')}</strong>
      <span style="margin:0 .5rem;color:var(--tx3)">·</span>
      <span>${esc(i.category||'—')}</span>
      <span style="margin:0 .5rem;color:var(--tx3)">·</span>
      Available Qty: <strong style="color:var(--green)">${parseInt(i.quantity)||0}</strong>`;
  }
  openModal('m-sell');
}

async function submitSell() {
  const id       = document.getElementById('sell-item-id').value;
  const qty      = parseInt(document.getElementById('sell-qty').value) || 0;
  const vendor   = document.getElementById('sell-vendor').value.trim();
  const saleDate = document.getElementById('sell-date').value;
  const notes    = document.getElementById('sell-notes').value.trim();
  const errEl    = document.getElementById('sell-err');
  hideEl(errEl);

  const item = S.stock[id];
  if(!item)           { showEl(errEl,'Item not found.'); return; }
  const currentQty = parseInt(item.quantity) || 0;
  if(!qty || qty < 1) { showEl(errEl,'Please enter a valid quantity.'); return; }
  if(!vendor)         { showEl(errEl,'Vendor/Customer name is required.'); return; }
  if(!saleDate)       { showEl(errEl,'Date of sale is required.'); return; }
  if(qty > currentQty){ showEl(errEl,`Cannot dispatch ${qty} — only ${currentQty} available.`); return; }

  try {
    await fbUpdate(`${DB.STOCK}/${id}`, {
      quantity: currentQty - qty, lastUpdated: new Date().toISOString()
    });
    await fbPush(DB.SALES, {
      itemId:item.itemName, itemName:item.itemName||'', category:item.category||'',
      parentType:item.parentType||'', vendorName:vendor, quantitySold:qty,
      saleDate, notes, dispatchedBy:S.user?.displayName||'Unknown', timestamp:Date.now(),
      stockItemId: id    // store original stock key so we can reverse it
    });
    await logActivity(`Dispatched "${item.itemName}" × ${qty} to ${vendor}`);
    closeModal('m-sell');
    toast(`${qty} unit(s) dispatched to ${vendor}.`,'success');
  } catch(e) { showEl(errEl,'Error: '+e.message); }
}

/* ── SALES TABLE ──────────────────────────────────────────────── */
function renderSalesTable() {
  const tbody = document.getElementById('sales-tbody'); if(!tbody) return;
  const ft    = document.getElementById('sale-f-type')?.value || '';
  let   rows  = Object.entries(S.sales);
  if(ft) rows = rows.filter(([,s]) => s.parentType === ft);
  rows.sort((a,b) => b[1].timestamp - a[1].timestamp);

  if(!rows.length) {
    tbody.innerHTML='<tr><td colspan="8" class="tbl-empty">No sales records found.</td></tr>';
    return;
  }

  const canDelete = S.user?.role === 'ADMIN' || S.user?.role === 'MANAGER';
  tbody.innerHTML = rows.map(([saleId,s]) => `
    <tr>
      <td><strong>${esc(s.itemName||'—')}</strong></td>
      <td>${esc(s.category||'—')}</td>
      <td><span class="badge ${(s.parentType||'').toLowerCase()}">${esc(s.parentType||'—')}</span></td>
      <td>${esc(s.vendorName||'—')}</td>
      <td><strong style="font-family:var(--fmono)">${s.quantitySold||0}</strong></td>
      <td style="font-size:.78rem;color:var(--tx3)">${fmtDate(s.saleDate)}</td>
      <td style="font-size:.78rem;color:var(--tx3)">${esc(s.dispatchedBy||'—')}</td>
      <td>
        ${canDelete ? `<button class="ibtn del" title="Reverse & Delete Sale" onclick="askDeleteSale('${saleId}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>` : '—'}
      </td>
    </tr>`).join('');
}

/* FIX 4: Delete sale + reverse stock ─────────────────────────── */
function askDeleteSale(saleId) {
  const sale = S.sales[saleId]; if(!sale) return;
  const msg = `Delete this sale record?\n\n"${sale.itemName||'Item'}" × ${sale.quantitySold} dispatched to "${sale.vendorName||'vendor'}"\n\nThis will add ${sale.quantitySold} unit(s) back to stock.`;
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-yes').textContent = 'Delete & Reverse';
  S.pending = async () => {
    try {
      const stockId  = sale.stockItemId;        // key saved at dispatch time
      const qtyBack  = parseInt(sale.quantitySold) || 0;

      // Restore stock if we have a valid stockItemId pointing to an existing item
      if(stockId && S.stock[stockId]) {
        const currentQty = parseInt(S.stock[stockId].quantity) || 0;
        await fbUpdate(`${DB.STOCK}/${stockId}`, {
          quantity:    currentQty + qtyBack,
          lastUpdated: new Date().toISOString()
        });
      }

      // Delete the sale record
      await fbDelete(`${DB.SALES}/${saleId}`);
      await logActivity(`Reversed sale: "${sale.itemName||'Item'}" × ${qtyBack} from "${sale.vendorName||'vendor'}"`);
      closeModal('m-confirm');
      // Reset button label
      document.getElementById('confirm-yes').textContent = 'Delete';
      toast(`Sale reversed. ${qtyBack} unit(s) restored to stock.`,'success');
    } catch(e) {
      closeModal('m-confirm');
      document.getElementById('confirm-yes').textContent = 'Delete';
      toast('Reversal failed: '+e.message,'error');
    }
  };
  document.getElementById('confirm-yes').onclick = () => S.pending && S.pending();
  openModal('m-confirm');
}

/* ── DELETE STOCK ITEM ────────────────────────────────────────── */
function askDelete(id, name) {
  document.getElementById('confirm-msg').textContent = `Delete "${name}"? This cannot be undone.`;
  document.getElementById('confirm-yes').textContent = 'Delete';
  S.pending = async () => {
    try {
      await fbDelete(`${DB.STOCK}/${id}`);
      await logActivity(`Deleted "${name}"`);
      closeModal('m-confirm');
      toast(`"${name}" deleted.`,'success');
    } catch(e) {
      closeModal('m-confirm');
      toast('Delete failed: '+e.message,'error');
    }
  };
  document.getElementById('confirm-yes').onclick = () => S.pending && S.pending();
  openModal('m-confirm');
}

/* ── BULK UPLOAD ──────────────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active',(i===0?'manual':'bulk')===tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
}
function handleFile(e) { const f = e.target.files[0]; if(f) parseExcel(f); }

function parseExcel(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb   = XLSX.read(new Uint8Array(e.target.result),{type:'array'});
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws,{defval:''});
      if(!rows.length) { toast('File is empty.','error'); return; }
      S.bulkRows = rows; showBulkPreview(rows);
    } catch(err) { toast('Could not parse file: '+err.message,'error'); }
  };
  reader.readAsArrayBuffer(file);
}

function showBulkPreview(rows) {
  document.getElementById('bulk-preview').classList.remove('hidden');
  setText('bulk-rows', rows.length);
  const heads = Object.keys(rows[0]);
  document.getElementById('bulk-thead').innerHTML = '<tr>'+heads.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr>';
  document.getElementById('bulk-tbody').innerHTML = rows.slice(0,8).map(r =>
    '<tr>'+heads.map(h=>`<td>${esc(String(r[h]||''))}</td>`).join('')+'</tr>'
  ).join('') + (rows.length>8 ? `<tr><td colspan="${heads.length}" style="text-align:center;color:var(--tx3)">… and ${rows.length-8} more rows</td></tr>` : '');
  hideEl(document.getElementById('bulk-err'));
  hideEl(document.getElementById('bulk-ok'));
}

async function submitBulk() {
  const rows = S.bulkRows;
  const btn  = document.getElementById('bulk-go');
  const errEl = document.getElementById('bulk-err');
  const okEl  = document.getElementById('bulk-ok');
  hideEl(errEl); hideEl(okEl);
  if(!rows.length) { showEl(errEl,'No data to upload.'); return; }
  btn.disabled = true; btn.textContent = 'Uploading…';

  const get = (row,...keys) => {
    for(const k of keys){
      const f = Object.keys(row).find(rk=>rk.toLowerCase().replace(/[\s_]/g,'')===k.toLowerCase().replace(/[\s_]/g,''));
      if(f && String(row[f]).trim()!=='') return String(row[f]).trim();
    } return '';
  };
  const VS = ['AVAILABLE','IN_USE','UNDER_MAINTENANCE'];
  const allTypeKeys = getAllParentTypes().map(t => t.key);
  let ok=0; const errs=[];

  for(let idx=0; idx<rows.length; idx++){
    const r    = rows[idx];
    const name = get(r,'name','itemname','item');
    const type = get(r,'type','parenttype').toUpperCase().replace(/[-\s]/g,'_');
    const cat  = get(r,'category','cat');
    const qty  = parseInt(get(r,'quantity','qty','count'))||1;
    let stat   = get(r,'status').toUpperCase().replace(/[-\s]/g,'_');
    if(!VS.includes(stat)) stat = 'AVAILABLE';
    if(!name)                   { errs.push(`Row ${idx+2}: Missing Name`); continue; }
    if(!allTypeKeys.includes(type)) { errs.push(`Row ${idx+2}: Invalid Type "${type}"`); continue; }
    const item = {
      itemName:name, serialNumber:get(r,'serialnumber','serial','id','serialno')||genId('BULK'),
      parentType:type, category:cat||'General', quantity:qty, status:stat,
      dateAdded:get(r,'dateadded','date')||today(),
      notes:get(r,'notes','note','remarks')||'',
      addedBy:S.user?.displayName||'Bulk Upload', lastUpdated:new Date().toISOString()
    };
    try { await fbPush(DB.STOCK,item); ok++; }
    catch(e) { errs.push(`Row ${idx+2}: ${e.message}`); }
  }
  btn.disabled=false; btn.textContent='Upload All to Firebase';
  if(ok>0){ showEl(okEl,`✓ ${ok} item${ok>1?'s':''} uploaded.`); await logActivity(`Bulk upload: ${ok} items added`); }
  if(errs.length) showEl(errEl,`${errs.length} error(s):\n• ${errs.slice(0,5).join('\n• ')}${errs.length>5?'\n… and more':''}`);
  if(ok>0 && !errs.length) clearBulk();
}

function clearBulk() {
  S.bulkRows=[];
  document.getElementById('bulk-preview').classList.add('hidden');
  document.getElementById('bulk-file').value='';
  hideEl(document.getElementById('bulk-err'));
  hideEl(document.getElementById('bulk-ok'));
}

function dlTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name','Type','Category','SerialNumber','Quantity','Status','DateAdded','Notes'],
    ['Hydraulic Press','MACHINE','Hydraulic Systems','SRA-MCH-001',2,'AVAILABLE','2025-01-15','Assembly Floor 1'],
    ['Torque Wrench Set','TOOL','Hand Tools','SRA-TL-044',5,'IN_USE','2025-02-20','Workshop A'],
    ['Safety Helmet','EQUIPMENT','Safety Equipment','SRA-EQ-012',20,'AVAILABLE','2025-03-01','Store Room B'],
    ['CNC Lathe','MACHINE','Lathe Machine','SRA-MCH-002',1,'UNDER_MAINTENANCE','2025-03-15','Awaiting parts'],
    ['Vernier Caliper','TOOL','Measuring Instruments','SRA-TL-009',8,'AVAILABLE','2025-04-01','Quality Lab']
  ]);
  ws['!cols']=[{wch:28},{wch:12},{wch:24},{wch:18},{wch:10},{wch:22},{wch:14},{wch:22}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Stock Items');
  XLSX.writeFile(wb,'SRA_Stock_Upload_Template.xlsx');
  toast('Template downloaded.','success');
}

/* ── CATEGORIES ───────────────────────────────────────────────── */

/* FIX 1 + 3: Render ALL parent types including custom, with delete button */
function renderCats() {
  const grid = document.getElementById('cat-grid'); if(!grid) return;
  const canDel    = S.user?.role === 'ADMIN' || S.user?.role === 'MANAGER';
  const canDelParent = S.user?.role === 'ADMIN';   // only admin can delete parent categories

  const dotColors = { MACHINE:'blue', TOOL:'green', EQUIPMENT:'amber' };

  const allTypes = getAllParentTypes();
  grid.innerHTML = allTypes.map(type => {
    const cats   = S.cats[type.key] || [];
    const dotCls = dotColors[type.key] || 'amber';
    return `
      <div class="cat-card">
        <div class="cat-card-head">
          <span class="cat-card-title">
            <span class="sbar-dot ${dotCls}" style="width:10px;height:10px;flex-shrink:0"></span>
            <span style="margin-right:.35rem">${type.icon}</span>
            ${esc(type.label)}
            ${type.isCustom ? '<span style="font-size:.65rem;color:var(--tx3);font-weight:400;margin-left:.35rem">(custom)</span>' : ''}
          </span>
          <div style="display:flex;align-items:center;gap:.4rem">
            <span class="cat-count">${cats.length}</span>
            ${(canDelParent && type.isCustom) ? `<button class="ibtn del" style="width:22px;height:22px;flex-shrink:0" title="Delete parent category" onclick="delParentCat('${type.fbKey}','${esc(type.label)}')">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>` : ''}
          </div>
        </div>
        <div class="cat-list">
          ${cats.length
            ? cats.map(c => `
                <div class="cat-item">
                  <span class="cat-item-name">${esc(c)}</span>
                  ${canDel ? `<button class="ibtn del" style="width:24px;height:24px;flex-shrink:0;border-radius:4px" title="Remove sub-category" onclick="delCat('${type.key}','${esc(c)}')">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                  </button>` : ''}
                </div>`).join('')
            : '<div style="color:var(--tx3);font-size:.8rem;padding:.25rem">No sub-categories yet</div>'
          }
        </div>
      </div>`;
  }).join('');
}

async function saveCat() {
  const type = document.getElementById('c-type').value;
  const name = document.getElementById('c-name').value.trim();
  if(!name) { toast('Category name is required.','error'); return; }
  const existing = S.cats[type] || [];
  if(existing.includes(name)) { toast('Category already exists.','error'); return; }
  try {
    await fbUpdate(DB.CATS, {[type]: [...existing, name]});
    await logActivity(`Added sub-category "${name}" to ${type}`);
    closeModal('m-cat'); val('c-name','');
    toast(`Sub-category "${name}" added.`,'success');
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function saveParentCat() {
  const name = document.getElementById('pc-name').value.trim();
  const icon = document.getElementById('pc-icon').value.trim() || '📁';
  if(!name) { toast('Parent category name is required.','error'); return; }

  // Check no duplicate names
  const existingNames = getAllParentTypes().map(t => t.label.toLowerCase());
  if(existingNames.includes(name.toLowerCase())) {
    toast('A parent category with this name already exists.','error'); return;
  }

  try {
    /* FIX: push to parent_categories — listener will call renderCats + refreshAllTypeDropdowns */
    const fbKey = await fbPush(DB.PARENT_CATS, { name, icon });
    // Also initialise an empty sub-cat array so the key is usable in categories
    const typeKey = name.toUpperCase().replace(/\s+/g,'_');
    await fbUpdate(DB.CATS, { [typeKey]: [] });
    await logActivity(`Added parent category "${name}"`);
    closeModal('m-parent-cat'); val('pc-name',''); val('pc-icon','');
    toast(`Parent category "${name}" added.`,'success');
  } catch(e) { toast('Error: '+e.message,'error'); }
}

/* FIX 3: Delete custom parent category */
async function delParentCat(fbKey, name) {
  document.getElementById('confirm-msg').textContent =
    `Delete parent category "${name}"?\n\nThis will remove the category card. Stock items using this type will not be deleted but will show an unrecognised type.`;
  document.getElementById('confirm-yes').textContent = 'Delete Parent';
  S.pending = async () => {
    const typeKey = name.toUpperCase().replace(/\s+/g,'_');
    try {
      await fbDelete(`${DB.PARENT_CATS}/${fbKey}`);
      // Remove its sub-categories entry too
      await fbDelete(`${DB.CATS}/${typeKey}`);
      await logActivity(`Deleted parent category "${name}"`);
      closeModal('m-confirm');
      document.getElementById('confirm-yes').textContent = 'Delete';
      toast(`Parent category "${name}" deleted.`,'success');
    } catch(e) {
      closeModal('m-confirm');
      document.getElementById('confirm-yes').textContent = 'Delete';
      toast('Error: '+e.message,'error');
    }
  };
  document.getElementById('confirm-yes').onclick = () => S.pending && S.pending();
  openModal('m-confirm');
}

async function delCat(type, name) {
  document.getElementById('confirm-msg').textContent = `Remove sub-category "${name}" from ${type}?`;
  document.getElementById('confirm-yes').textContent = 'Delete';
  S.pending = async () => {
    const updated = (S.cats[type]||[]).filter(c => c !== name);
    try {
      await fbUpdate(DB.CATS, {[type]: updated});
      closeModal('m-confirm');
      toast(`Sub-category "${name}" removed.`,'success');
    } catch(e) {
      closeModal('m-confirm');
      toast('Error: '+e.message,'error');
    }
  };
  document.getElementById('confirm-yes').onclick = () => S.pending && S.pending();
  openModal('m-confirm');
}

/* ── USERS — stored in Firebase /users/{username} ─────────────── */
function loadUsers() {
  const tbody = document.getElementById('users-tbody'); if(!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="tbl-empty">Loading users…</td></tr>';
  db.ref(DB.USERS).once('value', snap => {
    const data  = snap.val() || {};
    const users = Object.values(data);
    if(!users.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="tbl-empty">No users found.</td></tr>';
      return;
    }
    tbody.innerHTML = users
      .sort((a,b) => (a.createdAt||'').localeCompare(b.createdAt||''))
      .map(u => `
        <tr>
          <td><span style="font-family:var(--fmono)">${esc(u.username||'')}</span></td>
          <td>${esc(u.displayName||'')}</td>
          <td><span class="role-pill ${u.role||''}">${(u.role||'').replace('_',' ')}</span></td>
          <td><span class="pill ${u.active?'av':'mn'}">${u.active?'Active':'Inactive'}</span></td>
          <td style="font-size:.78rem;color:var(--tx3)">${fmtDate(u.createdAt)}</td>
          <td>
            <div class="row-actions">
              <button class="ibtn edit" title="Change Password" onclick="openChangePw('${esc(u.username||'')}','${esc(u.displayName||'')}')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </button>
              ${u.protected
                ? '<span style="font-size:.72rem;color:var(--tx3)">Protected</span>'
                : `<button class="ibtn del" title="Delete user" onclick="askDeleteUser('${esc(u.username||'')}')">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                   </button>`
              }
            </div>
          </td>
        </tr>`).join('');
  }, e => {
    tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">Error loading users: ${esc(e.message)}</td></tr>`;
  });
}

async function saveUser() {
  const display  = document.getElementById('u-display').value.trim();
  const username = document.getElementById('u-username').value.trim().toLowerCase().replace(/\s+/g,'');
  const password = document.getElementById('u-password').value;
  const role     = document.getElementById('u-role').value;
  const errEl    = document.getElementById('user-err');
  hideEl(errEl);

  if(!display)            { showEl(errEl,'Display Name is required.');           return; }
  if(!username)           { showEl(errEl,'Username is required.');               return; }
  if(!password)           { showEl(errEl,'Password is required.');               return; }
  if(password.length < 6) { showEl(errEl,'Password must be at least 6 characters.'); return; }
  if(!/^[a-z0-9_]+$/.test(username)) {
    showEl(errEl,'Username may only contain letters, numbers and underscores.'); return;
  }

  try {
    /* Check username not already taken */
    const existing = await fbRead(`${DB.USERS}/${username}`);
    if(existing) { showEl(errEl,`Username "${username}" is already taken.`); return; }

    const pwHash = await hashPw(password);
    await fbSet(`${DB.USERS}/${username}`, {
      username, displayName:display, role, pwHash,
      active: true, protected: false,
      createdAt: new Date().toISOString()
    });

    await logActivity(`Created user "${username}" (${role})`);
    closeModal('m-user');
    loadUsers();
    toast(`User "${username}" created successfully.`,'success');
    ['u-display','u-username','u-password'].forEach(id => val(id,''));
    val('u-role','VIEW_ONLY');
  } catch(e) {
    showEl(errEl,'Error creating user: ' + e.message);
  }
}

function askDeleteUser(username) {
  document.getElementById('confirm-msg').textContent = `Delete user "${username}"? This cannot be undone.`;
  document.getElementById('confirm-yes').textContent = 'Delete';
  S.pending = async () => {
    try {
      await fbDelete(`${DB.USERS}/${username}`);
      await logActivity(`Deleted user "${username}"`);
      closeModal('m-confirm');
      document.getElementById('confirm-yes').textContent = 'Delete';
      loadUsers();
      toast(`User "${username}" deleted.`,'success');
    } catch(e) {
      closeModal('m-confirm');
      document.getElementById('confirm-yes').textContent = 'Delete';
      toast('Delete failed: '+e.message,'error');
    }
  };
  document.getElementById('confirm-yes').onclick = () => S.pending && S.pending();
  openModal('m-confirm');
}

/* ── CHANGE PASSWORD ──────────────────────────────────────────── */
function openChangePw(username, displayName) {
  val('cp-username', username);
  val('cp-display', displayName);
  val('cp-newpw', '');
  val('cp-confirmpw', '');
  hideEl(document.getElementById('cp-err'));
  openModal('m-change-pw');
}

async function saveChangePw() {
  const username  = document.getElementById('cp-username').value;
  const newPw     = document.getElementById('cp-newpw').value;
  const confirmPw = document.getElementById('cp-confirmpw').value;
  const errEl     = document.getElementById('cp-err');
  hideEl(errEl);

  if(!newPw)              { showEl(errEl,'New password is required.'); return; }
  if(newPw.length < 6)    { showEl(errEl,'Password must be at least 6 characters.'); return; }
  if(newPw !== confirmPw) { showEl(errEl,'Passwords do not match.'); return; }

  try {
    const pwHash = await hashPw(newPw);
    await fbUpdate(`${DB.USERS}/${username}`, { pwHash });
    await logActivity(`Password changed for user "${username}"`);
    closeModal('m-change-pw');
    toast(`Password updated for "${username}".`, 'success');
  } catch(e) {
    showEl(errEl, 'Error updating password: ' + e.message);
  }
}

/* ── MODALS ───────────────────────────────────────────────────── */
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }
function bgClose(e,id)  { if(e.target===e.currentTarget) closeModal(id); }

/* ── TOAST ────────────────────────────────────────────────────── */
let _tt;
function toast(msg, type='success') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast '+type;
  clearTimeout(_tt); _tt = setTimeout(()=>el.classList.add('hidden'), 3800);
}

/* ── HELPERS ──────────────────────────────────────────────────── */
function setText(id,v)  { const el=document.getElementById(id); if(el) el.textContent=v; }
function setWidth(id,p) { const el=document.getElementById(id); if(el) el.style.width=Math.min(100,Math.round(p))+'%'; }
function val(id,v) {
  const el=document.getElementById(id); if(!el) return '';
  if(v===undefined) return el.value; el.value=v;
}
function showEl(el,msg) { if(!el) return; el.textContent=msg; el.classList.remove('hidden'); }
function hideEl(el)     { if(!el) return; el.classList.add('hidden'); el.textContent=''; }
function sCls(s) { return {AVAILABLE:'av',IN_USE:'iu',UNDER_MAINTENANCE:'mn'}[s]||'av'; }
function sLbl(s) { return {AVAILABLE:'Available',IN_USE:'In Use',UNDER_MAINTENANCE:'Maintenance'}[s]||s||'—'; }
function fmtDate(d) {
  if(!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
  catch(_) { return d; }
}
function ago(ts) {
  const m=Math.floor((Date.now()-ts)/60000);
  if(m<1) return 'just now'; if(m<60) return `${m}m ago`;
  const h=Math.floor(m/60); if(h<24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
function today() { return new Date().toISOString().split('T')[0]; }
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function genId(p) {
  return `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2,5).toUpperCase()}`;
}

console.log('[SRA Stock v2.1] All 4 fixes applied. Parent cats live | Type dropdowns dynamic | Delete parent | Reverse sale.');
