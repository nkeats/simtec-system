let configCache = {};

// ══════════════════════════════════════════════════════
// LOAN TERM CALCULATION
// ══════════════════════════════════════════════════════
// Rules (highest rule in order wins):
//   Any Mk II or Mk III product → 156 weeks
//   Any Mk I non-King-Single    → 78 weeks
//   Mk I King Single only       → 52 weeks
function calcLoanTerm(items) {
  // Filter out non-mattress items (delivery fee, protectors, bases, pillows)
  const mattresses = (items || []).filter(i => {
    const n = (i.name || '').toLowerCase();
    return n.includes('mk i') || n.includes('mk ii') || n.includes('mk iii') ||
           n.includes('mk 1') || n.includes('mk 2') || n.includes('mk 3');
  });

  if (mattresses.length === 0) return 156; // fallback

  const hasMk2or3 = mattresses.some(i => {
    const n = (i.name || '').toLowerCase();
    return n.includes('mk ii') || n.includes('mk iii') ||
           n.includes('mk 2') || n.includes('mk 3');
  });
  if (hasMk2or3) return 156;

  const hasNonKingSingle = mattresses.some(i => {
    const n = (i.name || '').toLowerCase();
    // Mk I but NOT king single
    return (n.includes('mk i') || n.includes('mk 1')) && !n.includes('king single');
  });
  if (hasNonKingSingle) return 78;

  return 52; // Mk I King Single only
}

function loanTermLabel(weeks) {
  if (weeks === 52) return '52 weeks (1 year)';
  if (weeks === 78) return '78 weeks (18 months)';
  return '156 weeks (3 years)';
}

// ══════════════════════════════════════════════════════
// AUDIO ALERT
// ══════════════════════════════════════════════════════
let audioCtx = null;
let lastKnownPendingIds = new Set();

function initAudio() {
  // Called on login button click - user interaction unlocks audio
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch(e) {
    console.log('Audio not supported');
  }
}

function playNewOrderAlert() {
  if (!audioCtx) return;
  try {
    // Two-tone pleasant chime
    const times = [[0, 880, 0.3], [0.2, 1100, 0.3], [0.4, 880, 0.2]];
    times.forEach(([when, freq, vol]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, audioCtx.currentTime + when);
      gain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + when + 0.05);
      gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + when + 0.4);
      osc.start(audioCtx.currentTime + when);
      osc.stop(audioCtx.currentTime + when + 0.5);
    });
  } catch(e) {
    console.log('Audio play error:', e);
  }
}

function checkForNewOrders(pendingOrders) {
  // Compare current pending order IDs against last known set
  const currentIds = new Set(pendingOrders.map(o => o.id));
  let hasNew = false;
  currentIds.forEach(id => {
    if (!lastKnownPendingIds.has(id)) hasNew = true;
  });
  if (hasNew) playNewOrderAlert();
  lastKnownPendingIds = currentIds;
}

// ══════════════════════════════════════════════════════
// SUPABASE INIT
// ══════════════════════════════════════════════════════
const STORAGE_KEY_URL = 'simtec_sb_url';
const STORAGE_KEY_KEY = 'simtec_sb_key';

let sbClient = null;

const CALL_CHECKLIST = [
  "Confirmed customer's full name and address",
  "Confirmed products ordered and total price",
  "Confirmed weekly repayment amount",
  "Confirmed weekly payment day",
  "Confirmed customer understands payments are via Ezidebit direct debit",
  "Confirmed customer understands delivery occurs after 10% of purchase price is paid",
  "Confirmed customer is happy to proceed",
  "Customer had the opportunity to ask questions"
];
let currentUser = null;
let currentRole = null;
let activeCallId = null;
let realtimeChannel = null;

function getSavedConfig() {
  return {
    url: localStorage.getItem(STORAGE_KEY_URL) || '',
    key: localStorage.getItem(STORAGE_KEY_KEY) || ''
  };
}

function saveConfig() {
  const url = document.getElementById('cfg-url').value.trim();
  const key = document.getElementById('cfg-key').value.trim();
  if (!url || !key) { alert('Please enter both the URL and key.'); return; }
  localStorage.setItem(STORAGE_KEY_URL, url);
  localStorage.setItem(STORAGE_KEY_KEY, key);
  initSupabase(url, key);
}

function initSupabase(url, key) {
  try {
    const { createClient } = window.supabaseJs || window.supabase;
    sbClient = createClient(url, key);
    sbClient.auth.getSession().then(({ data }) => {
      if (data.session) {
        currentUser = data.session.user;
        currentRole = currentUser.user_metadata?.role || 'caller';
        showApp();
      } else {
        showLogin();
      }
    });
  } catch (e) {
    alert('Failed to connect to Supabase. Check your URL and key.');
  }
}

// ══════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  script.onload = () => {
    window.supabaseJs = window.supabase;
    // Credentials hardcoded - no setup screen needed on new devices
    initSupabase("https://jvqjoenaungubpoegyvf.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ");
  };
  document.head.appendChild(script);
});

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  btn.textContent = 'Signing in...'; btn.disabled = true;

  try {
    const { data, error } = await sbClient.auth.signInWithPassword({ email, password: pass });
    if (error) throw error;
    currentUser = data.user;
    currentRole = currentUser.user_metadata?.role || 'caller';
    showApp();
  } catch (e) {
    errEl.textContent = e.message || 'Invalid email or password.';
    errEl.style.display = 'block';
  } finally {
    btn.textContent = 'Sign in →'; btn.disabled = false;
  }
}

async function doLogout() {
  if (realtimeChannel) sbClient.removeChannel(realtimeChannel);
  await sbClient.auth.signOut();
  currentUser = null; currentRole = null;
  consultantSignatureData = null;
  // Clear consultant form to prevent scroll-down access
  const cfc = document.getElementById('consultant-form-container');
  if (cfc) cfc.innerHTML = '';
  showLogin();
}

// ══════════════════════════════════════════════════════
// ROUTING
// ══════════════════════════════════════════════════════
function showLogin() {
  document.getElementById('config-screen').classList.remove('active');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('caller-screen').style.display = 'none';
  document.getElementById('consultant-screen').style.display = 'none';
  // Scroll back to top so login form is visible
  window.scrollTo(0, 0);
}

function showApp() {
  document.getElementById('config-screen').classList.remove('active');
  document.getElementById('login-screen').style.display = 'none';

  if (currentRole === 'caller') {
    document.getElementById('caller-screen').style.display = 'block';
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('consultant-screen').style.display = 'none';
    startCallerQueue();
  } else if (currentRole === 'consultant') {
    document.getElementById('caller-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('consultant-screen').style.display = 'block';
    buildConsultantForm();
    loadProducts();
    loadConsultants();
    loadConfig();
    startSessionTimer();
  } else if (currentRole === 'office') {
    document.getElementById('caller-screen').style.display = 'none';
    document.getElementById('consultant-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'block';
    document.getElementById('nav-user-label').textContent = currentUser?.user_metadata?.name || currentUser?.email || '';
    applyOfficeRestrictions();
    loadDashboard();
    loadProducts();
    loadConsultants();
    startRealtimeUpdates();
    startSessionTimer();
  } else {
    document.getElementById('caller-screen').style.display = 'none';
    document.getElementById('consultant-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'block';
    document.getElementById('nav-user-label').textContent = currentUser?.user_metadata?.name || currentUser?.email || '';
    loadDashboard();
    loadProducts();
    loadConsultants();
    startRealtimeUpdates();
    startSessionTimer();
  }
}

// ══════════════════════════════════════════════════════
// NAVIGATION (admin)
// ══════════════════════════════════════════════════════
function nav(id, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('s-' + id);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'dashboard') loadDashboard();
  if (id === 'delivery') loadDeliveryQueue();
  if (id === 'config') loadConfig();
  if (id === 'sales') { loadProducts(); setTimeout(initSignaturePad, 200); }
  if (id === 'manual') { if (typeof loadConfig === 'function') loadConfig(); }
  if (id === 'appointments') {
    const today = new Date().toISOString().split('T')[0];
    const dateFilter = document.getElementById('appt-filter-date');
    if (dateFilter && !dateFilter.value) dateFilter.value = today;
    loadAdminAppointments();
  }
  if (id === 'nosale') loadNoSaleContacts();
  if (id === 'customers') { document.getElementById('customer-search-input').value = ''; searchCustomers(''); }
  if (id === 'scorecard') loadScorecards();
  if (id === 'clawbacks') loadClawbacks();
  if (id === 'ezidebit') document.getElementById('ezidebit-import-result').innerHTML = '';
  if (id === 'reports') { loadConfig().then(loadReports); }
}

// ══════════════════════════════════════════════════════
// REALTIME
// ══════════════════════════════════════════════════════
function startRealtimeUpdates() {
  if (realtimeChannel) sbClient.removeChannel(realtimeChannel);
  realtimeChannel = sbClient
    .channel('orders-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
      if (document.getElementById('s-dashboard').classList.contains('active')) {
        loadDashboard();
      }
    })
    .subscribe();
}

function startCallerQueue() {
  loadCallerQueue();
  if (realtimeChannel) sbClient.removeChannel(realtimeChannel);
  realtimeChannel = sbClient
    .channel('orders-caller')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
      loadCallerQueue();
    })
    .subscribe();
}

// ══════════════════════════════════════════════════════
// SALES FORM
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// CONSULTANT FORM (stripped view)
// ══════════════════════════════════════════════════════
function buildConsultantForm() {
  const container = document.getElementById('consultant-form-container');
  if (!container) return;

  const salesScreen = document.getElementById('s-sales');
  if (!salesScreen) return;

  // Clone sales screen but exclude the signature card and order confirm panel
  // (signature card is re-added fresh below to avoid duplicate canvas ID issues)
  const clone = salesScreen.cloneNode(true);
  const sigCard = clone.querySelector('#signature-card');
  if (sigCard) sigCard.remove();
  const confirmPanel = clone.querySelector('#order-confirm');
  if (confirmPanel) confirmPanel.remove();

  container.innerHTML = clone.innerHTML;

  // Add a fresh signature card with a unique canvas ID for the consultant view
  const sigHtml = `<div class="card" id="consultant-signature-card">
    <div class="card-title">Customer 1 signature</div>
    <div class="card-sub">Have the customer sign in the box below using their finger.</div>
    <canvas id="consultant-signature-pad" style="border:2px solid var(--navy);border-radius:10px;cursor:crosshair;touch-action:none;background:#fafafa;display:block;max-width:100%"></canvas>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <button class="btn-outline btn-sm" onclick="clearConsultantSignature()">Clear & redo</button>
      <span id="consultant-sig-status" style="font-size:13px;color:var(--green);font-weight:600;align-self:center"></span>
    </div>
    <div id="consultant-sig2-wrap" style="display:none;margin-top:18px;padding-top:18px;border-top:1px solid var(--border)">
      <div class="card-title" style="font-size:14px">Customer 2 signature</div>
      <div class="card-sub">Have the second customer sign below.</div>
      <canvas id="consultant-signature-pad-2" style="border:2px solid var(--navy);border-radius:10px;cursor:crosshair;touch-action:none;background:#fafafa;display:block;max-width:100%"></canvas>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <button class="btn-outline btn-sm" onclick="clearConsultantSignature2()">Clear & redo</button>
        <span id="consultant-sig2-status" style="font-size:13px;color:var(--green);font-weight:600;align-self:center"></span>
      </div>
    </div>
  </div>`;
  // Insert signature card BEFORE the submit button
  const submitBtn = container.querySelector('.btn-gold');
  if (submitBtn) {
    submitBtn.insertAdjacentHTML('beforebegin', sigHtml);
  } else {
    container.insertAdjacentHTML('beforeend', sigHtml);
  }

  recalc();
  // Init signature pad - try multiple times to handle iOS rendering delay
  setTimeout(initConsultantSignaturePad, 300);
  setTimeout(initConsultantSignaturePad, 800);
  setTimeout(initConsultantSignaturePad, 1500);
}

let consultantSignatureData = null;

function initConsultantSignaturePad() {
  const canvas = document.getElementById('consultant-signature-pad');
  if (!canvas) return;
  if (canvas.dataset.initialized === 'true') return;

  // Force explicit dimensions - don't rely on CSS/getBoundingClientRect for iOS
  const parent = canvas.parentElement;
  const parentWidth = parent ? parent.offsetWidth - 48 : 300; // card padding
  const W = Math.max(parentWidth, 300);
  const H = 200;

  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;

  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.strokeStyle = '#1e3a6e';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  canvas.dataset.initialized = 'true';

  let drawing = false;
  let lastX = 0, lastY = 0;

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    if (e.touches) return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    const p = getPos(e);
    lastX = p.x; lastY = p.y;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
    consultantSignatureData = canvas.toDataURL();
    const status = document.getElementById('consultant-sig-status');
    if (status) status.textContent = '✓ Signature captured';
  }
  function stopDraw() { drawing = false; }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDraw);
}

function clearConsultantSignature() {
  const canvas = document.getElementById('consultant-signature-pad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  consultantSignatureData = null;
  const status = document.getElementById('consultant-sig-status');
  if (status) status.textContent = '';
}

// ══════════════════════════════════════════════════════
// DYNAMIC PRODUCTS - loaded from config table
// ══════════════════════════════════════════════════════

function categorizProduct(name) {
  const n = name.toLowerCase();
  if (n.includes('base')) return 'Bases';
  if (n.includes('protector')) return 'Accessories';
  if (n.includes('pillow')) return 'Accessories';
  if (n.includes('delivery')) return null; // handled by checkbox
  return 'Mattresses';
}

function makeTile(p) {
  const price = p.retail || 0;
  const formatted = price.toLocaleString('en-AU');
  return `<div class="ptile" data-price="${price}" data-name="${p.name}" onclick="toggleTile(this)">
    <div class="pn">${p.name}</div>
    <div class="pp">$${formatted}</div>
    <div class="qty-row">
      <button class="qty-btn" onclick="adjQty(event,this,-1)">−</button>
      <div class="qty-num">1</div>
      <button class="qty-btn" onclick="adjQty(event,this,1)">+</button>
    </div>
  </div>`;
}

async function loadProducts() {
  const container = document.getElementById('dynamic-products-container');
  if (!container) return;

  let products = [];

  if (sbClient) {
    try {
      const { data, error } = await sbClient
        .from('config')
        .select('*')
        .eq('category', 'products')
        .order('key');

      if (!error && data && data.length > 0) {
        products = data
          .map(row => row.value)
          .filter(p => p.active && p.name !== 'Delivery fee');
      }
    } catch(e) {
      // fallback to hardcoded products;
    }
  }

  // Fallback to hardcoded if config unavailable
  if (products.length === 0) {
    products = [
      {name:'Mk I King Single',retail:860},{name:'Mk I Queen',retail:1590},{name:'Mk I Super King',retail:1890},
      {name:'Mk II Queen',retail:4890},{name:'Mk II Super King',retail:5190},
      {name:'Mk III King Single',retail:3990},{name:'Mk III Queen',retail:4990},
      {name:'Mk III Super King',retail:5290},{name:'Mk III California King',retail:5590},
      {name:'King Single Bed Base',retail:650},{name:'Queen Bed Base',retail:750},
      {name:'Super King Bed Base',retail:850},{name:'California King Bed Base',retail:950},
      {name:'King Single Protector',retail:130},{name:'Queen Protector',retail:130},
      {name:'Super King Protector',retail:130},{name:'California King Protector',retail:130},
      {name:'Pillow',retail:40}
    ];
  }

  // Group by category
  const groups = {};
  for (const p of products) {
    const cat = categorizProduct(p.name);
    if (!cat) continue;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p);
  }

  const order = ['Mattresses', 'Bases', 'Accessories'];
  let html = '';
  for (const cat of order) {
    if (!groups[cat] || groups[cat].length === 0) continue;
    html += `<div class="sec-title">${cat}</div>
      <div class="prod-grid">
        ${groups[cat].map(p => makeTile(p)).join('')}
      </div>`;
  }

  container.innerHTML = html;
  recalc();
}

// Load consultants dynamically from config table
async function loadConsultants() {
  if (!sbClient) return;
  const { data, error } = await sbClient
    .from('config')
    .select('*')
    .eq('category', 'staff')
    .order('label');
  if (error || !data) return;

  const staff = data.filter(r => r.value?.active !== false);
  const selects = ['f-consultant', 'm-consultant', 'appt-consultant-name'].map(id => document.getElementById(id)).filter(Boolean);

  selects.forEach(sel => {
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">-- Select consultant --</option>';
    staff.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value.name;
      opt.dataset.phone = s.value.phone || '';
      opt.textContent = s.value.name;
      sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal;
  });
}

function consultantChange(sel) {
  const opt = sel.options[sel.selectedIndex];
  // Update phone for whichever form this is in
  const phoneField = sel.closest('form, .card, .screen')?.querySelector('[id$="-consultant-phone"], #f-consultant-phone, #m-consultant-phone');
  if (phoneField) phoneField.value = opt.dataset.phone || '';
  // Always update the main hidden field if it exists
  const mainPhone = document.getElementById('f-consultant-phone');
  if (mainPhone && sel.id === 'f-consultant') mainPhone.value = opt.dataset.phone || '';
  const mPhone = document.getElementById('m-consultant-phone');
  if (mPhone && sel.id === 'm-consultant') mPhone.value = opt.dataset.phone || '';
}

function toggleTile(el) {
  if (event.target.classList.contains('qty-btn')) return;
  el.classList.toggle('sel');
  if (!el.classList.contains('sel')) el.querySelector('.qty-num').textContent = '1';
  recalc();
}
function adjQty(e, btn, delta) {
  e.stopPropagation();
  const t = btn.closest('.ptile');
  const s = t.querySelector('.qty-num');
  let q = parseInt(s.textContent) + delta;
  if (q < 1) q = 1;
  s.textContent = q;
  if (!t.classList.contains('sel')) t.classList.add('sel');
  recalc();
}
function recalc() {
  const tiles = document.querySelectorAll('.ptile.sel');
  let total = 0, count = 0;
  const items = [];
  tiles.forEach(t => {
    const qty = parseInt(t.querySelector('.qty-num').textContent);
    const price = parseInt(t.dataset.price);
    total += price * qty;
    count += qty;
    items.push({ name: t.dataset.name, price, qty });
  });
  // Add delivery fee if checkbox is ticked
  const deliveryCb = document.getElementById('f-delivery');
  if (deliveryCb && deliveryCb.checked) {
    total += 170;
    count += 1;
    items.push({ name: 'Delivery fee', price: 170, qty: 1 });
  }
  document.getElementById('total-val').textContent = '$' + total.toLocaleString('en-AU', { minimumFractionDigits: 2 });
  document.getElementById('item-count').textContent = count + (count === 1 ? ' item' : ' items');
  const payTypeEl = document.getElementById('f-paytype');
  const payTypeVal = payTypeEl ? payTypeEl.value : 'dd_weekly';
  const isFortnightly = payTypeVal === 'dd_fortnightly';
  const payWeeks = calcLoanTerm(items);
  const payPeriods = isFortnightly ? Math.ceil(payWeeks / 2) : payWeeks;
  const weekly = total > 0 ? total / payPeriods : 0;
  const repLabel = document.getElementById('repayment-label');
  if (repLabel) repLabel.textContent = isFortnightly ? 'Fortnightly repayment' : 'Weekly repayment';
  document.getElementById("weekly-val").textContent = weekly > 0 ? "$" + weekly.toFixed(2) + (isFortnightly ? "/fn" : "/wk") : "-";
  const termEl = document.getElementById("loan-term-val");
  if (termEl) termEl.textContent = total > 0 ? loanTermLabel(payWeeks) : "-";
  const summary = document.getElementById('order-summary');
  document.getElementById('order-items').innerHTML = items.map(i =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px">
      <span style="color:var(--navy)">${i.qty > 1 ? i.qty + ' × ' : ''}${i.name}</span>
      <span style="color:var(--gm);font-weight:600">$${(i.price*i.qty).toLocaleString('en-AU',{minimumFractionDigits:2})}</span>
    </div>`
  ).join('');
  summary.style.display = items.length ? 'block' : 'none';
}
function deliveryChange(cb) {
  recalc();
}

function orderSourceChange(sel) {
  const root = sel.closest('#consultant-form-container, #s-sales') || document;
  const note = root.querySelector('#cooling-off-note');
  const refFields = root.querySelector('#referrer-fields');
  const coolRow = root.querySelector('#ack-coolingoff-row');
  const solicited = sel.value === 'referral';
  if (refFields) refFields.style.display = solicited ? 'block' : 'none';
  if (coolRow) coolRow.style.display = solicited ? 'none' : 'flex';
  if (note) {
    note.textContent = solicited
      ? 'This is a solicited (referral) sale — the standard 5-day cooling-off period does not apply.'
      : 'This is an unsolicited sale — the customer has a 5-day cooling-off period.';
  }
}

function payChange(sel) {
  const val = sel.value;
  const isDD = val === 'dd_weekly' || val === 'dd_fortnightly' || val === 'deposit_50';
  const payDayRow = document.getElementById('f-payday-row');
  if (payDayRow) payDayRow.style.display = isDD ? '' : 'none';
  const payNote = document.getElementById('pay-note');
  if (payNote) {
    if (val === 'dd_fortnightly') payNote.textContent = 'Fortnightly Ezidebit. 5 consecutive fortnightly payments required before delivery.';
    else if (val === 'deposit_50') payNote.textContent = '50% deposit upfront, then Ezidebit for balance. 5 consecutive payments not required for delivery.';
    else if (val === 'full' || val === 'c') payNote.textContent = 'Full payment upfront. No consecutive payment requirement for delivery.';
    else payNote.textContent = 'Weekly Ezidebit direct debit. 5 consecutive payments required before delivery.';
  }
  recalc();
}

async function submitOrder() {
  const fname = document.getElementById('f-fname').value.trim();
  const lname = document.getElementById('f-lname').value.trim();
  if (!fname || !lname) { showToast('Please enter the customer name', 'error'); return; }

  const consultantVal = document.getElementById('f-consultant').value;
  if (!consultantVal) { showToast('Please select a consultant', 'error'); return; }

  const tiles = document.querySelectorAll('.ptile.sel');
  if (!tiles.length) { showToast('Please select at least one product', 'error'); return; }

  // Joint purchase validation
  const isJoint = document.getElementById('f-joint')?.checked;
  if (isJoint) {
    const f2 = document.getElementById('f-fname2')?.value.trim();
    const l2 = document.getElementById('f-lname2')?.value.trim();
    if (!f2 || !l2) { showToast('Enter the second customer name for a joint purchase', 'error'); return; }
    const sig2 = document.getElementById('consultant-signature-pad-2') ? consultantSignatureData2 : signatureData2;
    if (!sig2) { showToast('Capture the second customer signature', 'error'); return; }
  }

  // Acknowledgement validation
  const ackDeposit = document.getElementById('f-ack-deposit')?.value.trim();
  const ackPay = document.getElementById('f-ack-payhistory')?.value.trim();
  const ackPriv = document.getElementById('f-ack-privacy')?.value.trim();
  if (!ackDeposit || !ackPay || !ackPriv) {
    showToast('Customer must initial the deposit, payment-history and privacy acknowledgements', 'error'); return;
  }
  const isUnsolicited = document.querySelector('input[name="order-source"]:checked')?.value !== 'referral';
  if (isUnsolicited) {
    if (!document.getElementById('f-ack-coolingoff')?.value.trim()) {
      showToast('Customer must initial the cooling-off acknowledgement for an unsolicited sale', 'error'); return;
    }
    if (!document.getElementById('f-coolingoff-explained')?.checked) {
      showToast('Confirm the cooling-off period has been explained to the customer', 'error'); return;
    }
  }

  const items = [];
  let total = 0;
  tiles.forEach(t => {
    const qty = parseInt(t.querySelector('.qty-num').textContent);
    const price = parseInt(t.dataset.price);
    total += price * qty;
    items.push({ name: t.dataset.name, price, qty });
  });

  const payTypeSubmit = document.getElementById('f-paytype').value;
  const isFortSubmit = payTypeSubmit === 'dd_fortnightly';
  const pwSubmit = calcLoanTerm(items);
  const ppSubmit = isFortSubmit ? Math.ceil(pwSubmit / 2) : pwSubmit;

  const order = {
    fname, lname,
    phone:            document.getElementById('f-phone').value.trim(),
    email:            document.getElementById('f-email').value.trim(),
    address:          document.getElementById('f-address').value.trim(),
    suburb:           document.getElementById('f-suburb')?.value.trim() || '',
    postcode:         document.getElementById('f-postcode')?.value.trim() || '',
    licence:          document.getElementById('f-licence')?.value.trim() || '',
    comments:         document.getElementById('f-comments')?.value.trim() || '',
    preferred_delivery_date: document.getElementById('f-delivery-date')?.value || null,
    marketing_consent: document.getElementById('f-marketing-consent')?.checked || false,
    is_referral:       document.querySelector('input[name="order-source"]:checked')?.value === 'referral',
    referrer_name:     document.getElementById('f-referrer-name')?.value.trim() || '',
    referrer_phone:    document.getElementById('f-referrer-phone')?.value.trim() || '',
    income_pension:    document.getElementById('f-income-pension')?.checked || false,
    income_fulltime:   document.getElementById('f-income-fulltime')?.checked || false,
    income_parttime:   document.getElementById('f-income-parttime')?.checked || false,
    income_weekly:      document.getElementById('f-income-weekly')?.value ? Number(document.getElementById('f-income-weekly').value) : null,
    homeowner:          document.getElementById('f-homeowner')?.value || null,
    income_notes:       document.getElementById('f-income-notes')?.value.trim() || '',
    referee1_name:    document.getElementById('f-ref1-name')?.value.trim() || '',
    referee1_rel:     document.getElementById('f-ref1-rel')?.value.trim() || '',
    referee1_phone:   document.getElementById('f-ref1-phone')?.value.trim() || '',
    referee1_email:   document.getElementById('f-ref1-email')?.value.trim() || '',
    referee2_name:    document.getElementById('f-ref2-name')?.value.trim() || '',
    referee2_rel:     document.getElementById('f-ref2-rel')?.value.trim() || '',
    referee2_phone:   document.getElementById('f-ref2-phone')?.value.trim() || '',
    referee2_email:   document.getElementById('f-ref2-email')?.value.trim() || '',
    consultant:       document.getElementById('f-consultant').value,
    consultant_phone: document.getElementById('f-consultant-phone').value.trim(),
    pay_day:          document.getElementById('f-payday').value,
    pay_type:         payTypeSubmit,
    payment_frequency: isFortSubmit ? 'fortnightly' : 'weekly',
    consecutive_payments_waived: ['full','c','deposit_50'].includes(payTypeSubmit),
    total,
    weekly_rep: +((total / ppSubmit).toFixed(2)),
    loan_term_weeks: pwSubmit,
    items,
    call_status: 'pending',
    signature_data: (document.getElementById('consultant-signature-pad') ? consultantSignatureData : signatureData) || null,
    signature_data2: (document.getElementById('consultant-signature-pad-2') ? consultantSignatureData2 : signatureData2) || null,
    customer2_fname: document.getElementById('f-fname2')?.value.trim() || '',
    customer2_lname: document.getElementById('f-lname2')?.value.trim() || '',
    customer2_phone: document.getElementById('f-phone2')?.value.trim() || '',
    employer:        document.getElementById('f-employer')?.value.trim() || '',
    occupation:      document.getElementById('f-occupation')?.value.trim() || '',
    annual_income:   document.getElementById('f-annual-income')?.value ? Number(document.getElementById('f-annual-income').value) : null,
    income_selfemployed: document.getElementById('f-income-selfemployed')?.checked || false,
    income_other:        document.getElementById('f-income-other')?.checked || false,
    other_income:    document.getElementById('f-other-income')?.value.trim() || '',
    ack_deposit_initials:    document.getElementById('f-ack-deposit')?.value.trim() || '',
    ack_payhistory_initials: document.getElementById('f-ack-payhistory')?.value.trim() || '',
    ack_privacy_initials:    document.getElementById('f-ack-privacy')?.value.trim() || '',
    ack_coolingoff_initials: document.getElementById('f-ack-coolingoff')?.value.trim() || '',
    coolingoff_explained:    document.getElementById('f-coolingoff-explained')?.checked || false
  };

  if (sbClient) {
    const { error } = await sbClient.from('orders').insert([order]);
    if (error) {
      showToast('DB error: ' + error.message, 'error');
      return;
    }
  }

  document.getElementById('order-confirm').style.display = 'block';
  document.getElementById('order-confirm').scrollIntoView({ behavior: 'smooth' });
  showToast('Order submitted - call queue updated ✓', 'success');
}

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
async function loadDashboard() {
  if (!sbClient) return renderDashboardDemo();

  try {
    const { data: orders, error } = await sbClient
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const pending = orders.filter(o => o.call_status === 'pending');
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thisWeek = orders.filter(o => new Date(o.created_at) > weekAgo);
    const callsDone = orders.filter(o => o.call_status === 'complete' && new Date(o.call_time) > weekAgo);

    checkForNewOrders(pending);
    document.getElementById('dash-queue-count').textContent = pending.length;
    document.getElementById('dash-sales-week').textContent = thisWeek.length;

    // Cancellation requests pending management review
    const cancelRequests = orders.filter(o => o.cancellation_requested && !o.cancelled_at);
    const cancelSection = document.getElementById('dash-cancel-requests');
    const cancelList = document.getElementById('dash-cancel-list');
    if (cancelSection && cancelList && isAdmin()) {
      cancelSection.style.display = cancelRequests.length > 0 ? 'block' : 'none';
      cancelList.innerHTML = cancelRequests.map(o => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-weight:600;color:var(--navy)">${o.fname} ${o.lname}</div>
            <div style="font-size:12px;color:var(--gm)">${o.phone || '-'} · Requested by: ${o.cancellation_requested_by || 'office'}</div>
            <div style="font-size:12px;color:#8a5500;margin-top:2px">Reason: ${o.cancellation_request_reason || '-'}</div>
            <div style="font-size:12px;color:var(--gm)">${o.cancellation_request_notes || ''}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-outline btn-sm" onclick="showCancellationModal('${o.id}','${o.fname} ${o.lname}')">Process cancellation</button>
            <button class="btn-green btn-sm" onclick="dismissCancelRequest('${o.id}')">Retained ✓</button>
          </div>
        </div>`).join('') || '';
    }

    // Payment follow-up
    const paymentFollowUp = orders.filter(o => o.payment_follow_up_status === 'call_needed');
    const paymentCard = document.getElementById('dash-payment-card');
    const paymentCount = document.getElementById('dash-payment-count');
    if (paymentCard && paymentCount) {
      paymentCount.textContent = paymentFollowUp.length;
      paymentCard.style.display = paymentFollowUp.length > 0 ? 'block' : 'none';
    }
    document.getElementById('dash-total-orders').textContent = orders.length;
    document.getElementById('dash-calls-done').textContent = callsDone.length;

    // Render payment follow-up list
    const paymentFollowUpOrders = orders.filter(o => o.payment_follow_up_status === 'call_needed');
    const paymentSection = document.getElementById('dash-payment-section');
    const paymentList = document.getElementById('dash-payment-list');
    if (paymentSection && paymentList) {
      paymentSection.style.display = paymentFollowUpOrders.length > 0 ? 'block' : 'none';
      paymentList.innerHTML = paymentFollowUpOrders.map(o => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600;color:var(--navy)">${o.fname} ${o.lname}</div>
            <div style="font-size:12px;color:var(--gm)">${o.phone || '-'} · ${o.email || '-'}</div>
            <div style="font-size:11px;color:var(--amber);margin-top:2px">Failed: ${o.payment_failure_reason || 'Payment dishonoured'} · Contacted ${o.payment_follow_up_sent_at ? timeAgo(o.payment_follow_up_sent_at) : '-'}</div>
          </div>
          <button class="btn-outline btn-sm" onclick="markPaymentFollowUpDone('${o.id}')">Mark resolved</button>
        </div>`).join('') || '<div style="color:var(--gm);font-size:13px;padding:12px 0">No follow-ups needed.</div>';
    }

    // Payment holidays (active) — admin only
    const onHoliday = orders.filter(o => (o.payment_holiday_weeks || 0) > 0 && !o.cancelled_at);
    const holidaySection = document.getElementById('dash-holiday-section');
    const holidayList = document.getElementById('dash-holiday-list');
    if (holidaySection && holidayList) {
      holidaySection.style.display = (onHoliday.length > 0 && isAdmin()) ? 'block' : 'none';
      holidayList.innerHTML = onHoliday.map(o => {
        const wk = o.payment_holiday_weeks || 0;
        const started = o.payment_holiday_start_date ? formatDate(o.payment_holiday_start_date) : '-';
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-weight:600;color:var(--navy)">${o.fname} ${o.lname}</div>
            <div style="font-size:12px;color:var(--gm)">${o.phone || '-'} · ${o.email || '-'}</div>
            <div style="font-size:12px;color:#8a5500;margin-top:2px">${wk} week${wk !== 1 ? 's' : ''} remaining · Started ${started}${o.payment_holiday_reason ? ' · ' + o.payment_holiday_reason : ''}</div>
          </div>
          <button class="btn-outline btn-sm" onclick="showOrderManagement('${o.id}')">Manage</button>
        </div>`;
      }).join('') || '';
    }

    const qt = document.getElementById('dash-queue-table');
    if (pending.length === 0) {
      qt.innerHTML = `<div style="text-align:center;padding:24px;color:var(--gm);font-size:13px">✅ Queue clear - no pending calls</div>`;
    } else {
      qt.innerHTML = `<table class="dtable">
        <tr><th>Customer</th><th>Consultant</th><th>Sale</th><th>Time</th><th>Status</th><th></th></tr>
        ${pending.map(o => `
          <tr class="cq-row-urgent">
            <td><b>${o.fname} ${o.lname}</b><br><span style="font-size:11px;color:var(--gm)">${o.phone || ''}</span></td>
            <td>${o.consultant || '-'}</td>
            <td>$${(o.total||0).toLocaleString('en-AU')}</td>
            <td><span class="call-timer urgent">${timeAgo(o.created_at)}</span></td>
            <td>${getAICallBadge(o)}</td>
            <td><button class="btn-green btn-sm" onclick="openCallModal('${o.id}','${o.fname} ${o.lname}','${o.consultant||''}','${o.total||0}','${o.phone||''}','${o.ai_call_status||''}','${(o.ai_call_notes||'').replace(/'/g,'')}')">Complete call</button></td>
          </tr>`).join('')}
      </table>`;
    }

    const ro = document.getElementById('dash-recent-orders');
    ro.innerHTML = `<table class="dtable">
      <tr><th>Customer</th><th>Consultant</th><th>Sale</th><th>Products</th><th>Submitted</th><th>Call</th><th>Action</th></tr>
      ${orders.slice(0, 15).map(o => {
        const daysSince = (Date.now() - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24);
        const inCoolingOff = daysSince <= 5 && !o.cancelled_at && !o.delivered_at;
        const isCancelled = !!o.cancelled_at;
        const coolingOffBtn = inCoolingOff && isAdmin()
          ? `<button class="btn-outline btn-sm" style="font-size:11px;color:#8a5500;border-color:#c9a84c" onclick="showCoolingOffModal('${o.id}','${o.fname} ${o.lname}')">5-day cancel</button>`
          : inCoolingOff && isOfficeOrAdmin()
          ? `<button class="btn-outline btn-sm" style="font-size:11px;color:var(--navy)" onclick="showCancellationRequest('${o.id}','${o.fname} ${o.lname}')">Flag cancellation</button>`
          : '';
        const cancelledBadge = isCancelled
          ? o.cooling_off_cancel
            ? '<span class="badge b-amber">Cooling off</span>'
            : '<span class="badge b-red">Cancelled</span>'
          : '';
        return `
        <tr style="${isCancelled ? 'opacity:0.5' : ''}">
          <td><b>${o.fname} ${o.lname}</b></td>
          <td>${o.consultant||'-'}</td>
          <td>$${(o.total||0).toLocaleString('en-AU')}</td>
          <td style="font-size:12px;color:var(--gm)">${(o.items||[]).map(i=>i.name).join(', ').substring(0,40)||'-'}</td>
          <td style="font-size:12px;color:var(--gm)">${formatDate(o.created_at)}</td>
          <td>${o.call_status==='complete'
            ? '<span class="badge b-green">Done ✓</span>'
            : '<span class="badge b-red">Pending</span>'}</td>
          <td>${cancelledBadge || coolingOffBtn || '-'}</td>
        </tr>`;
      }).join('')}
    </table>`;

  } catch (e) {
    renderDashboardDemo();
  }
}

function renderDashboardDemo() {
  document.getElementById('dash-queue-count').textContent = '2';
  document.getElementById('dash-sales-week').textContent = '12';
  document.getElementById('dash-total-orders').textContent = '-';
  document.getElementById('dash-calls-done').textContent = '10';
  document.getElementById('dash-queue-table').innerHTML = `
    <div style="padding:14px;background:var(--abg);border-radius:8px;font-size:13px;color:#8a5500;border:1px solid #f5c97a">
      ⚠ Not connected to database - showing demo data. Go to <b>DB Setup</b> to connect.
    </div>
    <table class="dtable" style="margin-top:12px">
      <tr><th>Customer</th><th>Consultant</th><th>Sale</th><th>Time</th><th>Status</th></tr>
      <tr class="cq-row-urgent"><td><b>Sarah Mitchell</b></td><td>James Harrington</td><td>$7,460</td><td><span class="call-timer urgent">2 min ago</span></td><td><span class="badge b-red">Call now</span></td></tr>
      <tr class="cq-row-urgent"><td>David Nguyen</td><td>Priya Nair</td><td>$4,990</td><td><span class="call-timer normal">18 min ago</span></td><td><span class="badge b-red">Call now</span></td></tr>
    </table>`;
  document.getElementById('dash-recent-orders').innerHTML = `<p style="color:var(--gm);font-size:13px;padding:12px 0">Connect the database to see live order history.</p>`;
}

// ══════════════════════════════════════════════════════
// CALLER QUEUE
// ══════════════════════════════════════════════════════
async function loadCallerQueue() {
  if (!sbClient) return;
  const { data, error } = await sbClient
    .from('orders')
    .select('*')
    .eq('call_status', 'pending')
    .order('created_at', { ascending: true });

  const container = document.getElementById('caller-queue-container');
  if (error || !data || data.length === 0) {
    container.innerHTML = `
      <div class="no-calls">
        <div class="no-calls-icon">✅</div>
        <div class="no-calls-title">Queue is clear</div>
        <div class="no-calls-sub">No confirmation calls pending right now.<br>New sales will appear here automatically.</div>
      </div>`;
    return;
  }

  checkForNewOrders(data);
  container.innerHTML = data.map(o => {
    const mins = Math.floor((Date.now() - new Date(o.created_at)) / 60000);
    const urgency = mins < 10 ? 'urgent' : '';
    const items = (o.items || []).map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}`).join(', ');
    return `
    <div class="call-card ${urgency}" id="card-${o.id}">
      <div class="call-card-top">
        <div>
          <div class="call-customer">${o.fname} ${o.lname}</div>
          <div class="call-meta">Consultant: ${o.consultant || '-'} · ${timeAgo(o.created_at)}</div>
        </div>
        ${getAICallBadge(o)}
      </div>
      <div class="call-detail-row">
        <div class="call-detail-box">
          <div class="call-detail-box-label">Phone</div>
          <div class="call-detail-box-val">${o.phone || '-'}</div>
        </div>
        <div class="call-detail-box">
          <div class="call-detail-box-label">Sale total</div>
          <div class="call-detail-box-val">$${(o.total||0).toLocaleString('en-AU')}</div>
        </div>
        <div class="call-detail-box">
          <div class="call-detail-box-label">Weekly payment</div>
          <div class="call-detail-box-val">$${(o.weekly_rep||0).toFixed(2)}/wk</div>
        </div>
        <div class="call-detail-box">
          <div class="call-detail-box-label">Payment day</div>
          <div class="call-detail-box-val">${o.pay_day || '-'}</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--gm);margin-bottom:12px;background:var(--gl);padding:8px 12px;border-radius:7px">
        <b style="color:var(--navy)">Products:</b> ${items || '-'}
      </div>
      <div class="checklist-wrap">
        <div class="checklist-title">Confirmation checklist</div>
        <div class="checklist-progress" id="prog-${o.id}">Tick each point as you confirm it with the customer - <span>0 of 8</span> completed</div>
        <ul class="checklist" id="chk-${o.id}">
          ${CALL_CHECKLIST.map((item, i) => `
            <li id="chk-${o.id}-${i}">
              <input type="checkbox" id="cb-${o.id}-${i}" onchange="tickItem('${o.id}',${i},this)">
              <label for="cb-${o.id}-${i}" style="cursor:pointer">${item}</label>
            </li>`).join('')}
        </ul>
      </div>
      <div class="call-actions">
        <textarea class="call-notes" rows="2" placeholder="Call notes..." id="notes-${o.id}"></textarea>
        <button class="btn-green" id="done-${o.id}" disabled style="opacity:.5" onclick="markCallComplete('${o.id}', '${o.fname} ${o.lname}')">✓ Call done</button>
      </div>
    </div>`;
  }).join('');
}

async function markCallComplete(id, name) {
  const callerCbs = document.querySelectorAll(`#chk-${id} input[type=checkbox]`);
  const allChecked = [...callerCbs].every(c => c.checked);
  const checklistLine = allChecked ? 'Checklist completed: all 8 confirmation points confirmed.\n' : '';
  const notes = checklistLine + (document.getElementById('notes-' + id)?.value || '');
  const card = document.getElementById('card-' + id);
  if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }

  const { error } = await sbClient
    .from('orders')
    .update({ call_status: 'complete', call_notes: notes, call_time: new Date().toISOString() })
    .eq('id', id);

  // Fire welcome email + SMS after call confirmed
  try {
    const { data: orderData } = await sbClient.from('orders').select('*').eq('id', id).single();
    if (orderData && (orderData.email || orderData.phone)) {
      fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/welcome-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ' },
        body: JSON.stringify({ order: orderData })
      });
    }
  } catch(e) { /* welcome message failed silently */ }

  if (error) {
    showToast('Error: ' + error.message, 'error');
    if (card) { card.style.opacity = '1'; card.style.pointerEvents = 'all'; }
  } else {
    showToast(`Call for ${name} marked complete ✓`, 'success');
    setTimeout(loadCallerQueue, 600);
  }
}

// ══════════════════════════════════════════════════════
// CALL COMPLETE MODAL (admin dashboard)
// ══════════════════════════════════════════════════════
function openCallModal(id, name, consultant, total, phone, aiStatus, aiNotes) {
  activeCallId = id;
  document.getElementById('call-modal-sub').textContent = `Confirming sale for ${name}`;
  document.getElementById('call-modal-details').innerHTML = `
    <div class="modal-detail-row"><span class="modal-detail-label">Customer</span><span class="modal-detail-val">${name}</span></div>
    <div class="modal-detail-row"><span class="modal-detail-label">Phone</span><span class="modal-detail-val">${phone||'-'}</span></div>
    <div class="modal-detail-row"><span class="modal-detail-label">Consultant</span><span class="modal-detail-val">${consultant||'-'}</span></div>
    <div class="modal-detail-row"><span class="modal-detail-label">Sale total</span><span class="modal-detail-val">$${Number(total).toLocaleString('en-AU')}</span></div>
    ${aiStatus ? `<div class="modal-detail-row"><span class="modal-detail-label">AI call</span><span class="modal-detail-val">${aiStatus}</span></div>` : ''}
    ${aiNotes ? `<div style="background:var(--abg);border-radius:8px;padding:10px 14px;font-size:12px;color:#8a5500;margin-top:8px">${aiNotes}</div>` : ''}
  `;
  document.getElementById('call-modal-notes').value = '';
  const chkUl = document.getElementById('modal-chk');
  chkUl.innerHTML = CALL_CHECKLIST.map((item, i) => `
    <li>
      <input type="checkbox" id="mcb-${i}" onchange="tickModalItem(${i},this)">
      <label for="mcb-${i}" style="cursor:pointer">${item}</label>
    </li>`).join('');
  const btn = document.getElementById('modal-complete-btn');
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
  const span = document.getElementById('modal-prog-count');
  if (span) span.textContent = '0 of 8';
  document.getElementById('call-modal').classList.add('open');
}

function tickItem(orderId, idx, cb) {
  const li = document.getElementById(`chk-${orderId}-${idx}`);
  if (li) li.classList.toggle('checked', cb.checked);
  const allCbs = document.querySelectorAll(`#chk-${orderId} input[type=checkbox]`);
  const checked = [...allCbs].filter(c => c.checked).length;
  const prog = document.getElementById(`prog-${orderId}`);
  if (prog) prog.querySelector('span').textContent = `${checked} of 8`;
  const btn = document.getElementById(`done-${orderId}`);
  if (btn) {
    btn.disabled = checked < 8;
    btn.style.opacity = checked < 8 ? '.5' : '1';
  }
}

function tickModalItem(idx, cb) {
  const li = cb.closest('li');
  if (li) li.classList.toggle('checked', cb.checked);
  const allCbs = document.querySelectorAll('#modal-chk input[type=checkbox]');
  const checked = [...allCbs].filter(c => c.checked).length;
  const span = document.getElementById('modal-prog-count');
  if (span) span.textContent = `${checked} of 8`;
  const btn = document.getElementById('modal-complete-btn');
  if (btn) {
    btn.disabled = checked < 8;
    btn.style.opacity = checked < 8 ? '.5' : '1';
  }
}

function closeCallModal() {
  document.getElementById('call-modal').classList.remove('open');
  activeCallId = null;
}

async function completeCall() {
  if (!activeCallId || !sbClient) return;
  const checklistSummary = 'Checklist completed: all 8 confirmation points confirmed.\n';
  const notes = checklistSummary + (document.getElementById('call-modal-notes').value || '');
  const { error } = await sbClient
    .from('orders')
    .update({ call_status: 'complete', call_notes: notes, call_time: new Date().toISOString() })
    .eq('id', activeCallId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  closeCallModal();
  showToast('Call marked complete ✓', 'success');
  loadDashboard();
}

// ══════════════════════════════════════════════════════
// CANCELLATION
// ══════════════════════════════════════════════════════
function checkCancel(input) {
  document.getElementById('cancel-confirm-btn').disabled = input.value.trim().toUpperCase() !== 'CANCEL';
}
function doCancel() {
  showToast('Order cancelled. Commission clawback recorded.', 'success');
  document.getElementById('cancel-confirm-input').value = '';
  document.getElementById('cancel-confirm-btn').disabled = true;
}

// ══════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════
function getAICallBadge(order) {
  const status = order.ai_call_status;
  const notes = order.ai_call_notes || '';
  switch(status) {
    case 'confirmed':
      return '<span class="badge b-green">AI confirmed ✓</span>';
    case 'calling':
      return '<span class="badge b-amber">AI calling...</span>';
    case 'human_requested':
      return '<span style="background:#fdecea;color:#8a2222;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600">Human requested</span>';
    case 'failed':
      return `<span style="background:#fdecea;color:#8a2222;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600" title="${notes}">AI failed - call now</span>`;
    case 'no_answer':
      return `<span style="background:#fef3e2;color:#8a5500;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600" title="${notes}">No answer - call now</span>`;
    default:
      return '<span class="badge b-red">Call now</span>';
  }
}

// ══════════════════════════════════════════════════════
// COOLING OFF CANCELLATION
// ══════════════════════════════════════════════════════

function showCoolingOffModal(orderId, customerName) {
  const existing = document.getElementById('cooling-off-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'cooling-off-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px;width:100%;max-width:500px;box-shadow:0 4px 32px rgba(30,58,110,.18)">
      <div style="font-size:18px;font-weight:700;color:#1e3a6e;margin-bottom:6px">5-Day Cooling Off Cancellation</div>
      <div style="font-size:13px;color:#7a8fad;margin-bottom:16px">
        <b>${customerName}</b> is within their 5-day cooling off period and is entitled to cancel at no cost.
      </div>

      <div style="background:#fdf6e3;border-left:4px solid #c9a84c;padding:14px 16px;border-radius:8px;margin-bottom:20px;font-size:13px;color:#554400;line-height:1.6">
        <strong>Email preview:</strong> The customer will receive a brief, friendly confirmation that their cancellation has been processed and their full refund will be returned within 3–5 business days. No questions asked - it is their legal right.
      </div>

      <div style="margin-bottom:20px">
        <label style="font-size:12px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Reason (internal note)</label>
        <select id="cooling-off-reason" style="width:100%;padding:10px 12px;border:1.5px solid #dde3f0;border-radius:8px;font-size:13px;font-family:inherit;color:#1e3a6e">
          <option value="changed_mind">Customer changed their mind</option>
          <option value="cant_afford">Financial circumstances changed</option>
          <option value="found_alternative">Found an alternative</option>
          <option value="partner_disagreed">Partner/family disagreed</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div style="display:flex;gap:10px">
        <button onclick="confirmCoolingOffCancel('${orderId}','${customerName}')"
          style="flex:1;padding:13px;background:#8a5500;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">
          Confirm cancellation & send email
        </button>
        <button onclick="document.getElementById('cooling-off-modal').remove()"
          style="padding:13px 20px;background:#f4f6fa;color:#1e3a6e;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">
          Go back
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function confirmCoolingOffCancel(orderId, customerName) {
  if (!sbClient) return;
  const reason = document.getElementById('cooling-off-reason')?.value || 'other';

  const { data: orders } = await sbClient.from('orders').select('*').eq('id', orderId).limit(1);
  const order = orders?.[0];

  // Cancel with cooling_off flag
  const { error } = await sbClient.from('orders').update({
    cancelled_at: new Date().toISOString(),
    cooling_off_cancel: true,
    clawback_status: 'pending',
    call_notes: (order?.call_notes || '') + ' | Cooling-off cancellation. Reason: ' + reason + '.'
  }).eq('id', orderId);

  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  // Send cooling-off email
  if (order?.email) {
    try {
      await fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/cooling-off-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ'
        },
        body: JSON.stringify({ order })
      });
    } catch(e) { /* email send failed silently */ }
  }

  document.getElementById('cooling-off-modal')?.remove();
  showToast(`Cooling-off cancellation confirmed - email sent to ${customerName}`, 'success');
  loadDashboard();
}

async function dismissCancelRequest(orderId) {
  if (!sbClient) return;
  await sbClient.from('orders').update({
    cancellation_requested: false,
    cancellation_request_notes: null,
    cancellation_request_reason: null
  }).eq('id', orderId);
  showToast('Marked as retained ✓', 'success');
  loadDashboard();
}

async function markPaymentFollowUpDone(orderId) {
  if (!sbClient) return;
  await sbClient.from('orders').update({
    payment_follow_up_status: 'resolved',
    updated_at: new Date().toISOString()
  }).eq('id', orderId);
  showToast('Marked as resolved ✓', 'success');
  loadDashboard();
}

// ── MORE MENU ──
function toggleMoreMenu() {
  const menu = document.getElementById('more-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
// Close more menu when clicking outside
document.addEventListener('click', function(e) {
  const menu = document.getElementById('more-menu');
  const btn = document.getElementById('more-menu-btn');
  if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// ── SESSION TIMEOUT (30 min for consultant, 2 hours for admin) ──
let lastActivity = Date.now();
let sessionTimer = null;

function resetActivityTimer() {
  lastActivity = Date.now();
}

// ══════════════════════════════════════════════════════
// OFFICE ROLE PERMISSIONS
// ══════════════════════════════════════════════════════

function isAdmin() { return currentRole === 'admin'; }
function isOfficeOrAdmin() { return currentRole === 'admin' || currentRole === 'office'; }

function applyOfficeRestrictions() {
  // Hide Config tab from office role
  const configNavBtn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.textContent.includes('Config'));
  if (configNavBtn) configNavBtn.style.display = 'none';

  // Hide commission amounts from nav - office can see structure but not amounts
  // This is handled in the commissions screen render

  // Show a role indicator in the topbar
  const userLabel = document.getElementById('nav-user-label');
  if (userLabel) userLabel.title = 'Office access';
}

// ── CANCELLATION REQUEST (office role) ──
// Office staff cannot cancel — they flag it for management approval
function showCancellationRequest(orderId, customerName) {
  const existing = document.getElementById('cancel-request-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'cancel-request-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px;width:100%;max-width:480px;box-shadow:0 4px 32px rgba(30,58,110,.18)">
      <div style="font-size:18px;font-weight:700;color:var(--navy);margin-bottom:6px">Customer cancellation request</div>
      <div style="font-size:13px;color:var(--gm);margin-bottom:20px">
        Record the details of <strong>${customerName}</strong>'s cancellation request. This will be flagged for management approval — you do not have authority to action the cancellation directly.
      </div>
      <div style="margin-bottom:14px">
        <label class="flabel">Reason given by customer</label>
        <select class="finput" id="cancel-req-reason">
          <option value="cant_afford">Cannot afford to continue</option>
          <option value="changed_mind">Changed their mind</option>
          <option value="found_alternative">Found an alternative</option>
          <option value="dissatisfied">Dissatisfied with product/service</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div style="margin-bottom:20px">
        <label class="flabel">Notes (what did the customer say?)</label>
        <textarea class="finput" id="cancel-req-notes" rows="3" placeholder="Record the customer's exact words where possible..."></textarea>
      </div>
      <div style="background:var(--abg);border:1px solid #f5d080;border-radius:8px;padding:12px 14px;font-size:13px;color:#8a5500;margin-bottom:20px">
        ⚠ This request will be flagged on the dashboard for Nigel or Matt to review. They will contact the customer to attempt to retain the sale before any cancellation is processed.
      </div>
      <div style="display:flex;gap:10px">
        <button onclick="submitCancellationRequest('${orderId}','${customerName}')"
          style="flex:1;padding:13px;background:var(--navy);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">
          Flag for management
        </button>
        <button onclick="document.getElementById('cancel-request-modal').remove()"
          style="padding:13px 20px;background:#f4f6fa;color:var(--navy);border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">
          Cancel
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function submitCancellationRequest(orderId, customerName) {
  if (!sbClient) return;
  const reason = document.getElementById('cancel-req-reason').value;
  const notes = document.getElementById('cancel-req-notes').value.trim();
  if (!notes) { showToast('Please add notes about what the customer said', 'error'); return; }

  // Flag the order as having a pending cancellation request
  await sbClient.from('orders').update({
    cancellation_requested: true,
    cancellation_request_reason: reason,
    cancellation_request_notes: notes,
    cancellation_requested_at: new Date().toISOString(),
    cancellation_requested_by: currentUser?.user_metadata?.name || currentUser?.email || 'office'
  }).eq('id', orderId);

  document.getElementById('cancel-request-modal')?.remove();
  showToast('Cancellation request flagged for management review ✓', 'success');
  loadDashboard();
}

function startSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  const timeoutMs = currentRole === 'consultant' ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
  sessionTimer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      clearInterval(sessionTimer);
      showToast('Session expired — please log in again', 'error');
      setTimeout(doLogout, 2000);
    }
  }, 60000); // check every minute
}

// Track user activity
['click', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, resetActivityTimer, { passive: true });
});

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.floor(hrs/24)}d ago`;
}
function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
}

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '') + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

recalc();

// ══════════════════════════════════════════════════════
// CREDIT SCORING ENGINE
// ══════════════════════════════════════════════════════

function calculateCreditScore(payments) {
  // Start at 100
  let score = 100;
  const flags = [];
  let consecutiveOnTime = 0;
  let maxStreak = 0;
  let totalPayments = payments.length;
  let onTimeCount = 0;
  let missedUnrecovered = 0;
  let missedRecovered = 0;
  let dishonours = 0;
  let recentIssue = false; // issue in last 14 days

  const now = new Date();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Sort payments by due date ascending
  const sorted = [...payments].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const dueDate = new Date(p.due_date);
    const isRecent = dueDate > twoWeeksAgo;

    if (p.status === 'on_time') {
      onTimeCount++;
      consecutiveOnTime++;
      if (consecutiveOnTime > maxStreak) maxStreak = consecutiveOnTime;
    } else if (p.status === 'late') {
      // Late but paid - treated as recovered missed
      missedRecovered++;
      consecutiveOnTime = 0;
      score -= 5;
      if (isRecent) recentIssue = true;
    } else if (p.status === 'missed') {
      missedUnrecovered++;
      consecutiveOnTime = 0;
      score -= 15; // base deduction
      score -= 10; // additional penalty for unresolved
      if (isRecent) recentIssue = true;
    } else if (p.status === 'dishonoured') {
      dishonours++;
      consecutiveOnTime = 0;
      score -= 25;
      if (isRecent) recentIssue = true;
    }
  }

  // Bonus: perfect record
  if (dishonours === 0 && missedUnrecovered === 0 && missedRecovered === 0) {
    score += 10;
    flags.push({ type: 'positive', text: 'Perfect payment record - no missed or late payments.' });
  }

  // Bonus: recovery streak (consecutive on-time after a miss)
  if (missedUnrecovered > 0 || missedRecovered > 0 || dishonours > 0) {
    if (consecutiveOnTime >= 4) {
      const streakBonus = consecutiveOnTime * 3;
      score += streakBonus;
      flags.push({ type: 'positive', text: `Strong recovery - ${consecutiveOnTime} consecutive on-time payments since last issue (+${streakBonus} pts).` });
    }
  }

  // Recency cap - recent issue prevents auto-approval
  if (recentIssue) {
    score = Math.min(score, 60);
    flags.push({ type: 'warning', text: 'Issue detected in the last 14 days - auto-approval blocked regardless of overall history.' });
  }

  // Unrecovered missed payments cap
  if (missedUnrecovered > 0) {
    score = Math.min(score, 55);
    flags.push({ type: 'danger', text: `${missedUnrecovered} missed payment(s) not yet recovered - customer has outstanding obligations.` });
  }

  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));

  // Build assessment flags
  if (dishonours > 0) {
    flags.push({ type: 'danger', text: `${dishonours} bank dishonour(s) - funds were not available on payment day. Significant risk indicator.` });
  }
  if (missedRecovered > 0) {
    flags.push({ type: 'warning', text: `${missedRecovered} late/missed payment(s) subsequently recovered. Customer has shown willingness to pay.` });
  }
  if (totalPayments >= 10 && onTimeCount === totalPayments) {
    flags.push({ type: 'positive', text: `${totalPayments} payments made, all on time. Consistent and reliable payer.` });
  }

  // Determine band
  let band, recommendation;
  if (score >= 80) {
    band = 'approved';
    recommendation = 'Auto-approved for delivery. Payment history supports low risk.';
  } else if (score >= 50) {
    band = 'review';
    recommendation = 'Manual review recommended. Some payment concerns - weigh history before approving.';
  } else {
    band = 'cancel';
    recommendation = 'Cancellation recommended. Payment history indicates significant default risk.';
  }

  return { score, band, recommendation, flags, stats: { totalPayments, onTimeCount, missedUnrecovered, missedRecovered, dishonours, consecutiveOnTime } };
}

function renderScoreCard(order, scoreResult) {
  const { score, band, recommendation, flags, stats } = scoreResult;
  const pctPaid = order.total > 0 ? ((stats.totalPayments * (order.weekly_rep || 0)) / order.total * 100).toFixed(1) : 0;

  const bandColour = band === 'approved' ? 'var(--green)' : band === 'review' ? 'var(--amber)' : 'var(--red)';
  const bandBg = band === 'approved' ? 'var(--gbg)' : band === 'review' ? 'var(--abg)' : 'var(--rbg)';
  const bandText = band === 'approved' ? '#1a7a44' : band === 'review' ? '#8a5500' : '#8a2222';
  const bandLabel = band === 'approved' ? '✓ Auto approved' : band === 'review' ? '⚠ Manual review' : '✗ Recommend cancel';

  const flagsHtml = flags.map(f => {
    const colour = f.type === 'positive' ? '#1a7a44' : f.type === 'warning' ? '#8a5500' : '#8a2222';
    const bg = f.type === 'positive' ? 'var(--gbg)' : f.type === 'warning' ? 'var(--abg)' : 'var(--rbg)';
    const icon = f.type === 'positive' ? '✓' : f.type === 'warning' ? '⚠' : '✗';
    return `<div style="background:${bg};border-radius:6px;padding:7px 10px;font-size:12px;color:${colour};margin-bottom:5px">${icon} ${f.text}</div>`;
  }).join('');

  const actionButtons = band === 'approved'
    ? `<button class="btn-green btn-sm" onclick="approveDelivery('${order.id}', '${order.fname} ${order.lname}')">✓ Approve delivery</button>`
    : band === 'review'
    ? `<div style="display:flex;gap:8px">
        <button class="btn-green btn-sm" onclick="approveDelivery('${order.id}', '${order.fname} ${order.lname}')">✓ Approve</button>
        <button class="btn-red btn-sm" onclick="cancelFromDelivery('${order.id}', '${order.fname} ${order.lname}')">✗ Cancel</button>
       </div>`
    : `<button class="btn-red btn-sm" onclick="cancelFromDelivery('${order.id}', '${order.fname} ${order.lname}')">✗ Cancel order</button>`;

  return `
  <div class="card" style="border-left:4px solid ${bandColour}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--navy)">${order.fname} ${order.lname}</div>
        <div style="font-size:12px;color:var(--gm);margin-top:2px">${order.address || '-'} · Consultant: ${order.consultant || '-'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="text-align:center">
          <div style="font-size:32px;font-weight:700;color:${bandColour};line-height:1">${score}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;letter-spacing:.5px">Credit score</div>
        </div>
        <div style="background:${bandBg};color:${bandText};padding:6px 12px;border-radius:20px;font-size:12px;font-weight:700">${bandLabel}</div>
      </div>
    </div>

    <!-- STATS ROW -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:14px">
      <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:var(--navy)">${stats.totalPayments}</div>
        <div style="font-size:10px;color:var(--gm)">Payments made</div>
      </div>
      <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:var(--green)">${stats.onTimeCount}</div>
        <div style="font-size:10px;color:var(--gm)">On time</div>
      </div>
      <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:${stats.missedUnrecovered > 0 ? 'var(--red)' : 'var(--gm)'}">${stats.missedUnrecovered}</div>
        <div style="font-size:10px;color:var(--gm)">Missed (open)</div>
      </div>
      <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:${stats.dishonours > 0 ? 'var(--red)' : 'var(--gm)'}">${stats.dishonours}</div>
        <div style="font-size:10px;color:var(--gm)">Dishonours</div>
      </div>
      <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:var(--navy)">${pctPaid}%</div>
        <div style="font-size:10px;color:var(--gm)">Amount paid</div>
      </div>
    </div>

    <!-- RECOMMENDATION -->
    <div style="background:${bandBg};border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:${bandText};font-weight:600">
      ${recommendation}
    </div>

    <!-- FLAGS -->
    ${flagsHtml ? `<div style="margin-bottom:14px">${flagsHtml}</div>` : ''}

    <!-- PRODUCTS -->
    <div style="font-size:12px;color:var(--gm);margin-bottom:14px">
      <b style="color:var(--navy)">Products:</b> ${(order.items || []).map(i => i.name).join(', ') || '-'} · 
      <b style="color:var(--navy)">Total:</b> $${(order.total || 0).toLocaleString('en-AU')} · 
      <b style="color:var(--navy)">Weekly:</b> $${(order.weekly_rep || 0).toFixed(2)}
    </div>

    <!-- ACTIONS -->
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      ${actionButtons}
      <div style="font-size:11px;color:var(--gm)">Order ID: ${order.id.substring(0,8)}...</div>
    </div>
  </div>`;
}

async function loadDeliveryQueue() {
  const container = document.getElementById('delivery-queue-container');
  if (!container || !sbClient) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">Loading...</div>';

  // Get all orders that have reached 10% threshold (call_status complete, not yet delivered/cancelled)
  const { data: orders, error } = await sbClient
    .from('orders')
    .select('*')
    .eq('call_status', 'complete')
    .is('delivered_at', null)
    .is('cancelled_at', null)
    .order('created_at', { ascending: true });

  if (error || !orders || orders.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">No orders awaiting delivery assessment.</div>';
    return;
  }

  // For each order, get payment history and calculate score
  const cards = [];
  for (const order of orders) {
    const { data: payments } = await sbClient
      .from('payments')
      .select('*')
      .eq('order_id', order.id)
      .order('due_date', { ascending: true });

    // Only show orders that have reached 10% paid
    const totalPaid = (payments || []).filter(p => p.status === 'on_time' || p.status === 'late').length * (order.weekly_rep || 0);
    const threshold = order.total * 0.1;
    if (totalPaid < threshold) continue;

    const scoreResult = calculateCreditScore(payments || []);
    cards.push(renderScoreCard(order, scoreResult));
  }

  if (cards.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">No orders have reached the 10% payment threshold yet.</div>';
  } else {
    container.innerHTML = cards.join('');
  }
}

async function approveDelivery(orderId, customerName) {
  if (!sbClient) return;
  const { data: orderData } = await sbClient.from('orders').select('*').eq('id', orderId).single();
  const { error } = await sbClient.from('orders')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', orderId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  // Send delivery notification using template
  if (orderData) {
    try {
      fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/delivery-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ' },
        body: JSON.stringify({ order: orderData })
      });
    } catch(e) { /* delivery notification failed silently */ }
  }
  showToast(customerName + ' — delivery approved ✓ — notification sent', 'success');
  loadDeliveryQueue();
}

async function cancelFromDelivery(orderId, customerName) {
  // Office role can flag but not cancel
  if (currentRole === 'office') {
    showCancellationRequest(orderId, customerName);
    return;
  }
  // Admin only for actual cancellation
  if (currentRole !== 'admin') {
    showToast('Only administrators can cancel orders', 'error');
    return;
  }

  // Show cancellation confirmation modal
  showCancellationModal(orderId, customerName);
}

function showCancellationModal(orderId, customerName) {
  const existing = document.getElementById('cancel-delivery-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'cancel-delivery-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px;width:100%;max-width:480px;box-shadow:0 4px 32px rgba(30,58,110,.18)">
      <div style="font-size:18px;font-weight:700;color:#1e3a6e;margin-bottom:6px">Cancel order</div>
      <div style="font-size:13px;color:#7a8fad;margin-bottom:20px">This will cancel the order for <strong>${customerName}</strong> and send them a warm, supportive email. This cannot be undone.</div>

      <div style="background:#fdf6e3;border-left:4px solid #c9a84c;padding:14px 16px;border-radius:8px;margin-bottom:20px;font-size:13px;color:#554400;line-height:1.6">
        <strong>Email preview:</strong> The customer will receive a friendly message explaining that we're cancelling their order, that we're refunding all payments within 3–5 business days, that we understand financial situations change, and that they're welcome to come back to us in the future.
      </div>

      <div style="margin-bottom:16px">
        <label style="font-size:12px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Reason for cancellation (internal note)</label>
        <select id="cancel-reason-select" style="width:100%;padding:10px 12px;border:1.5px solid #dde3f0;border-radius:8px;font-size:13px;font-family:inherit;color:#1e3a6e">
          <option value="cant_afford">Customer can't afford to continue</option>
          <option value="customer_request">Customer requested cancellation</option>
          <option value="credit_score">Failed credit assessment</option>
          <option value="payment_default">Persistent payment default</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div style="display:flex;gap:10px">
        <button onclick="confirmCancellationFromDelivery('${orderId}', '${customerName}')"
          style="flex:1;padding:13px;background:#d63030;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">
          Cancel order & send email
        </button>
        <button onclick="document.getElementById('cancel-delivery-modal').remove()"
          style="padding:13px 20px;background:#f4f6fa;color:#1e3a6e;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">
          Go back
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function confirmCancellationFromDelivery(orderId, customerName) {
  if (!sbClient) return;

  const reason = document.getElementById('cancel-reason-select')?.value || 'other';

  // Get the full order details
  const { data: orders } = await sbClient.from('orders').select('*').eq('id', orderId).limit(1);
  const order = orders?.[0];

  // Cancel the order and flag for clawback
  const { error } = await sbClient.from('orders').update({
    cancelled_at: new Date().toISOString(),
    clawback_status: 'pending',
    call_notes: (order?.call_notes || '') + ' | Cancelled by admin. Reason: ' + reason + '.'
  }).eq('id', orderId);

  if (error) { showToast('Error cancelling order: ' + error.message, 'error'); return; }

  // Send cancellation email
  if (order?.email) {
    try {
      await fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/cancellation-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ' },
        body: JSON.stringify({ order })
      });
    } catch(e) { /* email failed silently */ }
  }

  document.getElementById('cancel-delivery-modal')?.remove();
  showToast('Order for ' + customerName + ' cancelled — clawback flagged for next commission run', 'success');
  loadDeliveryQueue();
  // Refresh clawback dashboard if visible
  if (document.getElementById('s-clawbacks')?.style.display !== 'none') loadClawbacks();
}

// ══════════════════════════════════════════════════════
// CONFIGURATION PANEL
// ══════════════════════════════════════════════════════

function switchConfigTab(tab, btn) {
  document.querySelectorAll('.config-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.config-tab-content').forEach(c => c.style.display = 'none');
  if (btn) btn.classList.add('active');
  document.getElementById('config-' + tab).style.display = 'block';
  if (tab === 'staff') { renderStaff(); renderStaffConfig(); }
  if (tab === 'templates') {
    const sel = document.getElementById('template-selector');
    if (sel) sel.value = '';
    const ed = document.getElementById('template-editor');
    if (ed) ed.style.display = 'none';
  }
  if (tab === 'users') loadUsers();
}

async function loadConfig() {
  if (!sbClient) return;
  const { data, error } = await sbClient.from('config').select('*').order('category').order('key');
  if (error) {
    console.error('Config load error:', error.message, error.code);
    showToast('Config error: ' + error.message, 'error');
    return;
  }
  if (!data || data.length === 0) {
    showToast('Config table appears empty — check Supabase RLS policies', 'error');
    return;
  }

  configCache = {};
  for (const row of data) {
    if (!configCache[row.category]) configCache[row.category] = {};
    configCache[row.category][row.key] = { ...row.value, _id: row.id, _label: row.label };
  }

  renderProducts();
  renderCommission();
  renderAwards();
  renderDelivery();
  renderReports();
}

async function saveConfigVal(category, key, value) {
  if (!sbClient) return;
  const { error } = await sbClient.from('config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('category', category).eq('key', key);
  if (error) { showToast('Save error: ' + error.message, 'error'); console.error('Config save error:', error); return; }
  const status = document.getElementById('config-save-status');
  if (status) {
    status.style.display = 'inline';
    status.style.fontWeight = '600';
    status.style.fontSize = '13px';
    setTimeout(() => status.style.display = 'none', 4000);
  }
  showToast('Saved ✓', 'success');
  await loadConfig();
}

async function addConfigRow(category, key, value, label) {
  if (!sbClient) return;
  const { error } = await sbClient.from('config').insert([{ category, key, value, label }]);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Added successfully ✓', 'success');
  await loadConfig();
}

async function deleteConfigRow(category, key, label) {
  if (!confirm('Delete ' + label + '? This cannot be undone.')) return;
  if (!sbClient) return;
  const { error } = await sbClient.from('config').delete().eq('category', category).eq('key', key);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Deleted ✓', 'success');
  await loadConfig();
}

function renderProducts() {
  const products = configCache['products'] || {};
  const container = document.getElementById('products-list');
  if (!container) return;

  const rows = Object.entries(products).map(([key, p]) => {
    return `<div class="config-row" data-pkey="${key}" style="flex-wrap:wrap;gap:10px">
      <div style="flex:2;min-width:160px"><div class="config-label">${p.name||key}</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Retail ($)</div>
          <input class="config-input prod-retail" type="number" data-key="${key}" value="${p.retail||0}" /></div>
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Cost ($)</div>
          <input class="config-input prod-cost" type="number" data-key="${key}" value="${p.cost||0}" /></div>
        <button class="btn-gold btn-sm" onclick="saveProduct('${key}')">Save</button>
        <button class="${p.active?'toggle-active':'toggle-inactive'}" onclick="toggleProductActive('${key}',${!p.active})">${p.active?'Active':'Inactive'}</button>
        <button class="btn-red btn-sm" onclick="deleteConfigRow('products','${key}','${(p.name||key)}')">Delete</button>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = rows || '<div style="color:var(--gm);font-size:13px;padding:12px 0">No products found.</div>';
}

async function saveProduct(key) {
  const container = document.getElementById('products-list');
  const row = container.querySelector('[data-pkey="' + key + '"]');
  const retail = parseFloat(row.querySelector('.prod-retail').value) || 0;
  const cost = parseFloat(row.querySelector('.prod-cost').value) || 0;
  const p = configCache['products'][key];
  if (p) await saveConfigVal('products', key, {name: p.name, retail, cost, active: p.active});
}

async function toggleProductActive(key, newActive) {
  const p = configCache['products'][key];
  if (p) await saveConfigVal('products', key, {name: p.name, retail: p.retail, cost: p.cost, active: newActive});
}

async function addProduct() {
  const name = document.getElementById('new-product-name').value.trim();
  const retail = parseFloat(document.getElementById('new-product-retail').value);
  const cost = parseFloat(document.getElementById('new-product-cost').value);
  if (!name || !retail) { showToast('Please enter product name and retail price', 'error'); return; }
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  await addConfigRow('products', key, { name, retail, cost: cost||0, active: true }, name);
  document.getElementById('new-product-name').value = '';
  document.getElementById('new-product-retail').value = '';
  document.getElementById('new-product-cost').value = '';
}

function renderCommission() {
  const commission = configCache['commission'] || {};
  const tiersContainer = document.getElementById('commission-tiers-list');
  if (tiersContainer) {
    const tiers = ['tier1','tier2','tier3'].map(key => {
      const t = commission[key]; if (!t) return '';
      const range = t.max_sales>=999 ? `${t.min_sales}+ sales` : `${t.min_sales}–${t.max_sales} sales`;
      return `<div class="config-row" data-tkey="${key}">
        <div style="flex:1"><div class="config-label">${range}</div></div>
        <div style="display:flex;align-items:flex-end;gap:8px">
          <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Rate ($)</div>
          <input class="config-input tier-rate" type="number" data-key="${key}" data-min="${t.min_sales}" data-max="${t.max_sales}" value="${t.rate}" /></div>
          <button class="btn-gold btn-sm" onclick="saveTier('${key}')">Save</button>
        </div>
      </div>`;
    }).join('');
    tiersContainer.innerHTML = tiers;
  }
  const bonusContainer = document.getElementById('commission-bonuses-list');
  if (bonusContainer) {
    const cb = commission['cash_bonus'] || {amount:100};
    const tl = commission['tl_override'] || {amount:60};
    bonusContainer.innerHTML = `
      <div class="config-row">
        <div style="flex:1"><div class="config-label">Cash sale bonus</div><div class="config-sub">Added on top of base commission for cash sales</div></div>
        <div style="display:flex;align-items:flex-end;gap:8px">
          <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Amount ($)</div>
          <input class="config-input" id="cash-bonus-input" type="number" value="${cb.amount}" /></div>
          <button class="btn-gold btn-sm" onclick="saveConfigVal('commission','cash_bonus',{amount:Number(document.getElementById('cash-bonus-input').value)})">Save</button>
        </div>
      </div>
      <div class="config-row">
        <div style="flex:1"><div class="config-label">Team leader override per sale</div><div class="config-sub">Paid to TL on every commissionable sale across their team including their own</div></div>
        <div style="display:flex;align-items:flex-end;gap:8px">
          <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Amount ($)</div>
          <input class="config-input" id="tl-override-input" type="number" value="${tl.amount}" /></div>
          <button class="btn-gold btn-sm" onclick="saveConfigVal('commission','tl_override',{amount:Number(document.getElementById('tl-override-input').value)})">Save</button>
        </div>
      </div>`;
  }
  const zeroContainer = document.getElementById('zero-commission-list');
  if (zeroContainer) {
    const zeroProducts = commission['zero_commission_products']?.products || [];
    zeroContainer.innerHTML = `
      <div style="margin-bottom:12px">${zeroProducts.map(p=>`
        <div style="display:inline-flex;align-items:center;gap:6px;background:var(--rbg);border-radius:6px;padding:5px 10px;margin:3px;font-size:13px;color:#8a2222">
          ${p}<button onclick="removeZeroCommissionProduct('${p}')" style="background:none;border:none;cursor:pointer;color:#8a2222;font-size:14px;padding:0">×</button>
        </div>`).join('')}</div>
      <div style="display:flex;gap:8px">
        <input class="finput" id="new-zero-product" placeholder="Product name (must match exactly)" style="flex:1;margin-bottom:0" />
        <button class="btn-outline" onclick="addZeroCommissionProduct()">Add</button>
      </div>`;
  }
}

async function addZeroCommissionProduct() {
  const name = document.getElementById('new-zero-product').value.trim();
  if (!name) return;
  const current = configCache['commission']['zero_commission_products']?.products || [];
  if (current.includes(name)) { showToast('Already in list', 'error'); return; }
  await saveConfigVal('commission', 'zero_commission_products', { products: [...current, name] });
  document.getElementById('new-zero-product').value = '';
}
async function removeZeroCommissionProduct(name) {
  const current = configCache['commission']['zero_commission_products']?.products || [];
  await saveConfigVal('commission', 'zero_commission_products', { products: current.filter(p=>p!==name) });
}

function renderAwards() {
  const awards = configCache['awards'] || {};
  const container = document.getElementById('awards-config-list');
  if (!container) return;
  const order = ['initial','pearl','ruby','emerald','sapphire','grand_diamond'];
  const rows = order.map(key => {
    const a = awards[key]; if (!a) return '';
    return `<div class="config-row">
      <div style="flex:1"><div class="config-label">${a.name}</div><div class="config-sub">${a.criteria}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Sales threshold</div>
          <input class="config-input" type="number" value="${a.threshold}" onblur="updateAward('${key}','threshold',Number(this.value))" /></div>
        ${a.weeks?`<div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Weeks required</div>
          <input class="config-input" type="number" value="${a.weeks}" onblur="updateAward('${key}','weeks',Number(this.value))" /></div>`:''}
      </div>
    </div>`;
  }).join('');
  container.innerHTML = rows;
}

async function updateAward(key, field, value) {
  const a = configCache['awards'][key];
  if (!a) return;
  await saveConfigVal('awards', key, {...a, [field]: value});
}

async function saveTier(key) {
  const input = document.querySelector('.tier-rate[data-key="' + key + '"]');
  const t = configCache['commission'][key];
  if (input && t) await saveConfigVal('commission', key, {min_sales: t.min_sales, max_sales: t.max_sales, rate: Number(input.value)});
}

async function saveAward(key) {
  const a = configCache['awards'][key];
  if (!a) return;
  const thresholdInput = document.querySelector('.award-threshold[data-key="' + key + '"]');
  const weeksInput = document.querySelector('.award-weeks[data-key="' + key + '"]');
  const updated = {...a, threshold: Number(thresholdInput?.value || a.threshold)};
  if (weeksInput) updated.weeks = Number(weeksInput.value);
  await saveConfigVal('awards', key, updated);
}

async function saveDeliverySettings() {
  const fee = Number(document.getElementById('delivery-fee-input')?.value || 170);
  const threshold_pct = Number(document.getElementById('delivery-threshold-input')?.value || 10);
  const payment_weeks = Number(document.getElementById('delivery-weeks-input')?.value || 156);
  const consecutive_payments = Number(document.getElementById('delivery-consecutive-input')?.value || 5);
  await saveConfigVal('delivery', 'settings', {fee, threshold_pct, payment_weeks, consecutive_payments});
}

async function saveCreditBands() {
  const auto_approve = Number(document.getElementById('credit-approve-input')?.value || 80);
  const manual_review = Number(document.getElementById('credit-review-input')?.value || 50);
  await saveConfigVal('delivery', 'credit_bands', {auto_approve, manual_review});
}

function renderDelivery() {
  const delivery = configCache['delivery'] || {};
  const s = delivery['settings'] || {fee:170,threshold_pct:10,payment_weeks:156};
  const b = delivery['credit_bands'] || {auto_approve:80,manual_review:50};
  const sc = document.getElementById('delivery-settings-form');
  if (sc) sc.innerHTML = `
    <div class="config-row">
      <div style="flex:1"><div class="config-label">Delivery fee</div><div class="config-sub">Charged on all delivered orders</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Amount ($)</div>
        <input class="config-input" id="delivery-fee-input" type="number" value="${s.fee}" /></div>
        <button class="btn-gold btn-sm" onclick="saveDeliverySettings()">Save</button>
      </div>
    </div>
    <div class="config-row">
      <div style="flex:1"><div class="config-label">Deposit threshold</div><div class="config-sub">% of purchase price that must be paid before delivery is approved</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Percentage (%)</div>
        <input class="config-input" id="delivery-threshold-input" type="number" value="${s.threshold_pct}" /></div>
        <button class="btn-gold btn-sm" onclick="saveDeliverySettings()">Save</button>
      </div>
    </div>
    <div class="config-row">
      <div style="flex:1"><div class="config-label">Consecutive payments required</div><div class="config-sub">Customer must have made this many consecutive on-time payments before delivery is approved</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Payments</div>
        <input class="config-input" id="delivery-consecutive-input" type="number" value="${s.consecutive_payments || 5}" /></div>
        <button class="btn-gold btn-sm" onclick="saveDeliverySettings()">Save</button>
      </div>
    </div>
    <div class="config-row">
      <div style="flex:1"><div class="config-label">Payment plan weeks</div><div class="config-sub">Total number of weekly payments</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <div><div style="font-size:10px;color:var(--gm);margin-bottom:3px">Weeks</div>
        <input class="config-input" id="delivery-weeks-input" type="number" value="${s.payment_weeks}" /></div>
        <button class="btn-gold btn-sm" onclick="saveDeliverySettings()">Save</button>
      </div>
    </div>`;
  const bc = document.getElementById('credit-bands-form');
  if (bc) bc.innerHTML = `
    <div class="config-row">
      <div style="flex:1"><div class="config-label" style="color:var(--green)">Auto approve - minimum score</div><div class="config-sub">Scores at or above this are approved automatically</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <input class="config-input" id="credit-approve-input" type="number" value="${b.auto_approve}" />
        <button class="btn-gold btn-sm" onclick="saveCreditBands()">Save</button>
      </div>
    </div>
    <div class="config-row">
      <div style="flex:1"><div class="config-label" style="color:var(--amber)">Manual review - minimum score</div><div class="config-sub">Scores below this are recommended for cancellation</div></div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <input class="config-input" id="credit-review-input" type="number" value="${b.manual_review}" />
        <button class="btn-gold btn-sm" onclick="saveCreditBands()">Save</button>
      </div>
    </div>`;
}

function renderReports() {
  const reports = configCache['reports'] || {};
  const recipients = reports['recipients'] || {daily_sales:[],weekly_commission:[]};
  const container = document.getElementById('reports-config-form');
  if (!container) return;
  const dailyList = (recipients.daily_sales||[]).map(e=>`
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--gl);border-radius:6px;padding:5px 10px;margin:3px;font-size:13px;color:var(--navy)">
      ${e}<button onclick="removeReportRecipient('daily_sales','${e}')" style="background:none;border:none;cursor:pointer;color:var(--gm);font-size:14px;padding:0">×</button>
    </div>`).join('');
  const commissionList = (recipients.weekly_commission||[]).map(e=>`
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--gl);border-radius:6px;padding:5px 10px;margin:3px;font-size:13px;color:var(--navy)">
      ${e}<button onclick="removeReportRecipient('weekly_commission','${e}')" style="background:none;border:none;cursor:pointer;color:var(--gm);font-size:14px;padding:0">×</button>
    </div>`).join('');
  container.innerHTML = `
    <div class="config-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <div class="config-label">Daily sales report recipients</div>
      <div>${dailyList||'<span style="color:var(--gm);font-size:13px">No recipients</span>'}</div>
      <div style="display:flex;gap:8px;width:100%">
        <input class="finput" id="new-daily-email" type="email" placeholder="email@example.com" style="flex:1;margin-bottom:0" />
        <button class="btn-outline" onclick="addReportRecipient('daily_sales')">Add</button>
      </div>
    </div>
    <div class="config-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <div class="config-label">Weekly commission report recipients</div>
      <div>${commissionList||'<span style="color:var(--gm);font-size:13px">No recipients</span>'}</div>
      <div style="display:flex;gap:8px;width:100%">
        <input class="finput" id="new-commission-email" type="email" placeholder="email@example.com" style="flex:1;margin-bottom:0" />
        <button class="btn-outline" onclick="addReportRecipient('weekly_commission')">Add</button>
      </div>
    </div>`;
}

async function addReportRecipient(type) {
  const inputId = type==='daily_sales'?'new-daily-email':'new-commission-email';
  const email = document.getElementById(inputId).value.trim();
  if (!email) return;
  const recipients = configCache['reports']['recipients']||{daily_sales:[],weekly_commission:[]};
  const list = recipients[type]||[];
  if (list.includes(email)) { showToast('Already in list','error'); return; }
  const updated = {...recipients,[type]:[...list,email]};
  await saveConfigVal('reports','recipients',updated);
  document.getElementById(inputId).value='';
}

async function removeReportRecipient(type,email) {
  const recipients = configCache['reports']['recipients']||{daily_sales:[],weekly_commission:[]};
  const updated = {...recipients,[type]:(recipients[type]||[]).filter(e=>e!==email)};
  await saveConfigVal('reports','recipients',updated);
}

async function addStaff() {
  const name = document.getElementById('new-staff-name').value.trim();
  const phone = document.getElementById('new-staff-phone').value.trim();
  const email = document.getElementById('new-staff-email').value.trim();
  const role = document.getElementById('new-staff-role').value;
  if (!name || !phone) { showToast('Please enter name and phone number', 'error'); return; }

  // Save to config table as staff record
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  await addConfigRow('staff', key, { name, phone, email, role, active: true }, name);

  // Reload consultant dropdowns immediately
  await loadConsultants();

  showToast(`${name} added ✓ - also create their Supabase login and add to Airtable`, 'success');
  document.getElementById('new-staff-name').value = '';
  document.getElementById('new-staff-phone').value = '';
  document.getElementById('new-staff-email').value = '';
}

// Render staff list in config panel
async function renderStaff() {
  await renderStaffConfig();
}

async function renderStaffConfig() {
  const container = document.getElementById('staff-list');
  if (!container || !sbClient) return;

  const { data, error } = await sbClient.from('config').select('*').eq('category', 'staff').order('label');
  if (error || !data || data.length === 0) {
    container.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:12px 0">No staff records found.</div>';
    return;
  }

  // Populate TL dropdown for new staff form
  const tlSelect = document.getElementById('new-staff-tl');
  if (tlSelect) {
    tlSelect.innerHTML = '<option value="">— None —</option>';
    data.filter(s => s.value.role === 'Team Leader' && s.value.active !== false).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value.name; opt.textContent = s.value.name;
      tlSelect.appendChild(opt);
    });
  }

  const roleColour = { 'Team Leader': '#1a7a44', 'Sleep Consultant': 'var(--navy)', 'Trainee': '#8a5500', 'Admin': '#8a2222', 'Driver': 'var(--gm)' };
  const awardIcons = { 'Initial': '🎖', 'Pearl': '🦪', 'Ruby': '❤️', 'Emerald': '💚', 'Sapphire': '💙', 'Grand Diamond': '💎' };

  const rows = data.map(s => {
    const v = s.value;
    const rc = roleColour[v.role] || 'var(--gm)';
    const awardIcon = awardIcons[v.award_level] || '';
    const tlText = v.team_leader ? ' · TL: ' + v.team_leader : '';
    const isActive = v.active !== false;
    return `<div class="config-row" style="flex-wrap:wrap;gap:8px">
      <div style="flex:2;min-width:160px">
        <div class="config-label">${v.name}${awardIcon ? ' ' + awardIcon : ''}</div>
        <div class="config-sub"><span style="color:${rc};font-weight:600">${v.role}</span>${tlText} · ${v.phone || 'No phone'}</div>
        ${v.award_level ? '<div style="font-size:11px;color:var(--gm);margin-top:2px">Award: ' + v.award_level + '</div>' : ''}
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn-outline btn-sm" onclick="openStaffEdit('${s.key}')">Edit</button>
        <button class="${isActive ? 'toggle-active' : 'toggle-inactive'}" onclick="toggleStaffActive('${s.key}',${!isActive})">${isActive ? 'Active' : 'Inactive'}</button>
        <button class="btn-red btn-sm" onclick="deleteConfigRow('staff','${s.key}','${v.name}')">Remove</button>
      </div>
    </div>`;
  }).join('');
  container.innerHTML = rows;
}

async function toggleStaffActive(key, newActive) {
  const existing = configCache['staff'] && configCache['staff'][key];
  if (!existing) return;
  await saveConfigVal('staff', key, { ...existing, active: newActive });
  await loadConsultants();
  renderStaffConfig();
}

// Load config when navigating to config screen - handled in existing nav function

// ══════════════════════════════════════════════════════
// SIGNATURE CAPTURE
// ══════════════════════════════════════════════════════
let signatureData = null;

function initSignaturePad() {
  const canvas = document.getElementById('signature-pad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Set canvas resolution
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.strokeStyle = '#1e3a6e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let drawing = false;
  let lastX = 0, lastY = 0;

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    if (e.touches) {
      return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    const pos = getPos(e);
    lastX = pos.x; lastY = pos.y;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x; lastY = pos.y;
    signatureData = canvas.toDataURL();
    const status = document.getElementById('sig-status');
    if (status) status.textContent = '✓ Signature captured';
  }

  function stopDraw() { drawing = false; }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDraw);
}

function clearSignature() {
  const canvas = document.getElementById('signature-pad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  signatureData = null;
  const status = document.getElementById('sig-status');
  if (status) status.textContent = '';
}

// ── Second signature + joint purchase ──────────────────────────
let signatureData2 = null;
let consultantSignatureData2 = null;

function attachSignaturePad(canvasId, statusId, onData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (canvas.dataset.initialized === 'true') return;
  const parent = canvas.parentElement;
  const parentWidth = parent ? parent.offsetWidth - 8 : 300;
  const W = Math.max(parentWidth, 280);
  const H = 180;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * window.devicePixelRatio;
  canvas.height = H * window.devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.strokeStyle = '#1e3a6e';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  canvas.dataset.initialized = 'true';
  let drawing = false, lastX = 0, lastY = 0;
  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    if (e.touches) return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function startDraw(e) { e.preventDefault(); drawing = true; const p = getPos(e); lastX = p.x; lastY = p.y; ctx.beginPath(); ctx.arc(lastX, lastY, 1, 0, Math.PI * 2); ctx.fill(); }
  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
    onData(canvas.toDataURL());
    const s = document.getElementById(statusId);
    if (s) s.textContent = '✓ Signature captured';
  }
  function stopDraw() { drawing = false; }
  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', stopDraw);
}

function clearSignature2() {
  const canvas = document.getElementById('signature-pad-2');
  if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  signatureData2 = null;
  const s = document.getElementById('sig2-status'); if (s) s.textContent = '';
}
function clearConsultantSignature2() {
  const canvas = document.getElementById('consultant-signature-pad-2');
  if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  consultantSignatureData2 = null;
  const s = document.getElementById('consultant-sig2-status'); if (s) s.textContent = '';
}

function toggleJoint(cb) {
  const root = cb.closest('#consultant-form-container, #s-sales') || document;
  const fields = root.querySelector('#second-customer-fields');
  if (fields) fields.style.display = cb.checked ? 'block' : 'none';
  const isConsultant = !!root.querySelector('#consultant-signature-pad-2');
  const wrap = root.querySelector('#consultant-sig2-wrap') || root.querySelector('#sig2-wrap');
  if (wrap) wrap.style.display = cb.checked ? 'block' : 'none';
  if (cb.checked) {
    if (isConsultant) setTimeout(() => attachSignaturePad('consultant-signature-pad-2', 'consultant-sig2-status', d => consultantSignatureData2 = d), 120);
    else setTimeout(() => attachSignaturePad('signature-pad-2', 'sig2-status', d => signatureData2 = d), 120);
  } else {
    if (isConsultant) clearConsultantSignature2(); else clearSignature2();
  }
}

// Init signature pad when sales form loads

// ══════════════════════════════════════════════════════
// MANUAL FORM OCR
// ══════════════════════════════════════════════════════
let manualFormImageBase64 = null;
let manualFormItems = [];

function handleFormDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').style.borderColor = 'var(--border)';
  const file = e.dataTransfer.files[0];
  if (file) processFormFile(file);
}

function handleFormUpload(input) {
  const file = input.files[0];
  if (file) processFormFile(file);
}

function processFormFile(file) {
  if (file.size > 10 * 1024 * 1024) {
    showToast('File too large - max 10MB', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    manualFormImageBase64 = dataUrl.split(',')[1];

    // Show preview
    const preview = document.getElementById('upload-preview');
    const img = document.getElementById('upload-preview-img');
    if (file.type.startsWith('image/')) {
      img.src = dataUrl;
      preview.style.display = 'block';
    } else {
      // PDF - just show a placeholder
      img.src = '';
      img.alt = 'PDF uploaded - ' + file.name;
      preview.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
}

async function extractFormData() {
  if (!manualFormImageBase64) { showToast('Please upload a form first', 'error'); return; }

  // Show loading
  document.getElementById('extract-loading').style.display = 'block';
  document.getElementById('upload-preview').style.display = 'none';
  const progress = document.getElementById('extract-progress');
  let pct = 0;
  const interval = setInterval(() => {
    pct = Math.min(pct + 10, 90);
    progress.style.width = pct + '%';
  }, 200);

  try {
    const response = await fetch(
      'https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/ocr-extract',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ'
        },
        body: JSON.stringify({ image: manualFormImageBase64, mimeType: 'image/jpeg' })
      }
    );

    clearInterval(interval);
    progress.style.width = '100%';

    const result = await response.json();
    document.getElementById('extract-loading').style.display = 'none';

    if (!result.success) {
      showToast('Extraction failed: ' + (result.error || 'Unknown error'), 'error');
      document.getElementById('upload-preview').style.display = 'block';
      return;
    }

    populateManualForm(result.data);

  } catch(e) {
    clearInterval(interval);
    document.getElementById('extract-loading').style.display = 'none';
    showToast('Error: ' + e.message, 'error');
    document.getElementById('upload-preview').style.display = 'block';
  }
}

function populateManualForm(data) {
  // Fill in fields
  document.getElementById('m-fname').value = data.fname || '';
  document.getElementById('m-lname').value = data.lname || '';
  document.getElementById('m-address').value = data.address || '';
  document.getElementById('m-phone').value = data.phone || '';
  document.getElementById('m-email').value = data.email || '';
  document.getElementById('m-payday').value = data.pay_day || 'Monday';
  document.getElementById('m-paytype').value = data.pay_type || 'dd';

  // Try to match consultant name
  const consultantSelect = document.getElementById('m-consultant');
  for (let i = 0; i < consultantSelect.options.length; i++) {
    if (consultantSelect.options[i].value.toLowerCase() === (data.consultant || '').toLowerCase()) {
      consultantSelect.selectedIndex = i;
      break;
    }
  }

  // Set items
  manualFormItems = data.items || [];
  renderManualProducts();

  // Check for missing fields
  const missing = ['fname','lname','address','phone'].filter(f => !data[f]);
  if (missing.length > 0 || data.items.length === 0) {
    document.getElementById('extraction-warning').style.display = 'block';
  }

  // Show review step
  document.getElementById('manual-step-upload').style.display = 'none';
  document.getElementById('manual-step-review').style.display = 'block';

  // Populate product dropdown
  populateProductDropdown();
  updateManualTotals();
}

function renderManualProducts() {
  const container = document.getElementById('m-products-list');
  if (!container) return;
  if (manualFormItems.length === 0) {
    container.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:8px 0">No products detected - add them manually below.</div>';
    return;
  }
  container.innerHTML = manualFormItems.map((item, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--gl);border-radius:8px;margin-bottom:6px;font-size:13px">
      <span style="color:var(--navy);font-weight:500">${item.qty > 1 ? item.qty + ' × ' : ''}${item.name}</span>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="color:var(--gm)">$${(item.price * item.qty).toLocaleString('en-AU', {minimumFractionDigits:2})}</span>
        <button onclick="removeManualProduct(${i})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:16px;padding:0">×</button>
      </div>
    </div>`).join('');
  updateManualTotals();
}

function removeManualProduct(i) {
  manualFormItems.splice(i, 1);
  renderManualProducts();
}

function populateProductDropdown() {
  const select = document.getElementById('m-add-product');
  if (!select) return;
  const products = configCache['products'] || {};
  select.innerHTML = '<option value="">-- Select product --</option>' +
    Object.values(products)
      .filter((p) => p.active && p.name !== 'Delivery fee')
      .map((p) => `<option value="${p.name}" data-price="${p.retail}">${p.name} - $${p.retail}</option>`)
      .join('');
}

function addManualProduct() {
  const select = document.getElementById('m-add-product');
  const opt = select.options[select.selectedIndex];
  if (!opt.value) return;
  manualFormItems.push({ name: opt.value, price: Number(opt.dataset.price), qty: 1 });
  select.selectedIndex = 0;
  renderManualProducts();
}

function updateManualTotals() {
  const total = manualFormItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  const payWks = calcLoanTerm(manualFormItems);
  const weekly = total > 0 ? (total / payWks).toFixed(2) : 0;
  const td = document.getElementById('m-total-display');
  const wd = document.getElementById('m-weekly-display');
  if (td) td.textContent = '$' + total.toLocaleString('en-AU', {minimumFractionDigits:2});
  if (wd) wd.textContent = weekly > 0 ? '$' + weekly + '/wk' : '-';
  // Inject loan term display next to weekly if container exists
  const termEl2 = document.getElementById('m-term-display');
  if (termEl2) {
    termEl2.textContent = total > 0 ? loanTermLabel(payWks) : '-';
  } else if (wd && wd.parentElement && wd.parentElement.parentElement) {
    // Create and insert term display if not already present
    const termDiv = document.createElement('div');
    termDiv.innerHTML = '<div class="sl">Loan term</div><div class="sv" id="m-term-display" style="font-size:13px;color:var(--gm)">' + (total > 0 ? loanTermLabel(payWks) : '-') + '</div>';
    wd.parentElement.parentElement.appendChild(termDiv);
  }
}

async function submitManualOrder() {
  const fname = document.getElementById('m-fname').value.trim();
  const lname = document.getElementById('m-lname').value.trim();
  if (!fname || !lname) { showToast('Please enter the customer name', 'error'); return; }
  if (manualFormItems.length === 0) { showToast('Please add at least one product', 'error'); return; }

  const total = manualFormItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  const consultantVal = document.getElementById('m-consultant').value;
  const consultantPhone = document.getElementById('m-consultant-phone')?.value || '';

  const order = {
    fname, lname,
    phone: document.getElementById('m-phone').value.trim(),
    email: document.getElementById('m-email').value.trim(),
    address: document.getElementById('m-address').value.trim(),
    consultant: consultantVal,
    consultant_phone: consultantPhone,
    pay_day: document.getElementById('m-payday').value,
    pay_type: document.getElementById('m-paytype').value,
    total,
    weekly_rep: +((total / calcLoanTerm(manualFormItems)).toFixed(2)),
    loan_term_weeks: calcLoanTerm(manualFormItems),
    items: manualFormItems,
    call_status: 'pending',
    manual_form: true
  };

  if (sbClient) {
    const { error } = await sbClient.from('orders').insert([order]);
    if (error) { showToast('DB error: ' + error.message, 'error'); return; }
  }

  showToast('Manual order submitted - confirmation call queued ✓', 'success');
  resetManualForm();
}

function resetManualForm() {
  manualFormImageBase64 = null;
  manualFormItems = [];
  document.getElementById('manual-step-upload').style.display = 'block';
  document.getElementById('manual-step-review').style.display = 'none';
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('extraction-warning').style.display = 'none';
  document.getElementById('form-file-input').value = '';
  document.getElementById('extract-progress').style.width = '0%';
}

// ══════════════════════════════════════════════════════
// CONSULTANT TAB SWITCHING & MANUAL FORM
// ══════════════════════════════════════════════════════

function consultantShowTab(tab) {
  const salesTab = document.getElementById('consultant-sales-tab');
  const manualTab = document.getElementById('consultant-manual-tab');
  const apptsTab = document.getElementById('consultant-appts-tab');
  const salesBtn = document.getElementById('consultant-tab-sales');
  const manualBtn = document.getElementById('consultant-tab-manual');
  const apptsBtn = document.getElementById('consultant-tab-appts');

  [salesTab, manualTab, apptsTab].forEach(t => { if (t) t.style.display = 'none'; });
  [salesBtn, manualBtn, apptsBtn].forEach(b => {
    if (b) { b.style.background = 'transparent'; b.style.color = 'rgba(255,255,255,0.5)'; }
  });

  if (tab === 'sales' && salesTab) {
    salesTab.style.display = 'block';
    if (salesBtn) { salesBtn.style.background = 'rgba(255,255,255,0.2)'; salesBtn.style.color = '#fff'; }
    setTimeout(initConsultantSignaturePad, 100);
  } else if (tab === 'manual' && manualTab) {
    manualTab.style.display = 'block';
    if (manualBtn) { manualBtn.style.background = 'rgba(255,255,255,0.2)'; manualBtn.style.color = '#fff'; }
  } else if (tab === 'appts' && apptsTab) {
    apptsTab.style.display = 'block';
    if (apptsBtn) { apptsBtn.style.background = 'rgba(255,255,255,0.2)'; apptsBtn.style.color = '#fff'; }
    loadConsultantAppointments();
  }
}

let consultantFormImageBase64 = null;
let consultantFormItems = [];

function handleConsultantFormUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    consultantFormImageBase64 = e.target.result.split(',')[1];
    const img = document.getElementById('c-upload-preview-img');
    img.src = e.target.result;
    document.getElementById('c-upload-preview').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

async function extractConsultantFormData() {
  if (!consultantFormImageBase64) return;
  document.getElementById('c-extract-loading').style.display = 'block';
  document.getElementById('c-upload-preview').style.display = 'none';
  const progress = document.getElementById('c-extract-progress');
  let pct = 0;
  const interval = setInterval(() => { pct = Math.min(pct + 10, 90); progress.style.width = pct + '%'; }, 200);

  try {
    const response = await fetch(
      'https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/ocr-extract',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ'
        },
        body: JSON.stringify({ image: consultantFormImageBase64, mimeType: 'image/jpeg' })
      }
    );
    clearInterval(interval);
    progress.style.width = '100%';
    const result = await response.json();
    document.getElementById('c-extract-loading').style.display = 'none';

    if (!result.success) {
      showToast('Could not read form: ' + (result.error || 'Unknown error'), 'error');
      document.getElementById('c-upload-preview').style.display = 'block';
      return;
    }
    populateConsultantManualForm(result.data);
  } catch(e) {
    clearInterval(interval);
    document.getElementById('c-extract-loading').style.display = 'none';
    showToast('Error: ' + e.message, 'error');
    document.getElementById('c-upload-preview').style.display = 'block';
  }
}

function populateConsultantManualForm(data) {
  document.getElementById('cm-fname').value = data.fname || '';
  document.getElementById('cm-lname').value = data.lname || '';
  document.getElementById('cm-address').value = data.address || '';
  document.getElementById('cm-phone').value = data.phone || '';
  document.getElementById('cm-email').value = data.email || '';
  document.getElementById('cm-payday').value = data.pay_day || 'Monday';
  document.getElementById('cm-paytype').value = data.pay_type || 'dd';
  consultantFormItems = data.items || [];
  renderConsultantProducts();
  if (!data.fname || !data.lname || data.items.length === 0) {
    document.getElementById('c-extraction-warning').style.display = 'block';
  }
  document.getElementById('c-review-card').style.display = 'block';
}

function renderConsultantProducts() {
  const container = document.getElementById('cm-products-list');
  if (!container) return;
  if (consultantFormItems.length === 0) {
    container.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:8px 0">No products detected.</div>';
  } else {
    container.innerHTML = consultantFormItems.map((item, i) => `
      <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--gl);border-radius:8px;margin-bottom:6px;font-size:13px">
        <span style="color:var(--navy)">${item.qty > 1 ? item.qty + ' × ' : ''}${item.name}</span>
        <span style="color:var(--gm)">$${(item.price * item.qty).toLocaleString('en-AU', {minimumFractionDigits:2})}</span>
      </div>`).join('');
  }
  const total = consultantFormItems.reduce((s, i) => s + i.price * i.qty, 0);
  const payWks2 = calcLoanTerm(consultantFormItems);
  const weekly = total > 0 ? (total / payWks2).toFixed(2) : 0;
  const td = document.getElementById('cm-total-display');
  const wd = document.getElementById('cm-weekly-display');
  if (td) td.textContent = '$' + total.toLocaleString('en-AU', {minimumFractionDigits:2});
  if (wd) wd.textContent = weekly > 0 ? "$" + weekly + "/wk" : "-";
  const termEl3 = document.getElementById("cm-term-display");
  if (termEl3) termEl3.textContent = total > 0 ? loanTermLabel(payWks2) : "-";
}

async function submitConsultantManualOrder() {
  const fname = document.getElementById('cm-fname').value.trim();
  const lname = document.getElementById('cm-lname').value.trim();
  if (!fname || !lname) { showToast('Please enter customer name', 'error'); return; }
  if (consultantFormItems.length === 0) { showToast('Please add at least one product', 'error'); return; }
  const total = consultantFormItems.reduce((s, i) => s + i.price * i.qty, 0);
  const order = {
    fname, lname,
    phone: document.getElementById('cm-phone').value.trim(),
    email: document.getElementById('cm-email').value.trim(),
    address: document.getElementById('cm-address').value.trim(),
    consultant: currentUser?.email || '',
    pay_day: document.getElementById('cm-payday').value,
    pay_type: document.getElementById('cm-paytype').value,
    total,
    weekly_rep: +((total / calcLoanTerm(consultantFormItems)).toFixed(2)),
    loan_term_weeks: calcLoanTerm(consultantFormItems),
    items: consultantFormItems,
    call_status: 'pending',
    manual_form: true
  };
  if (sbClient) {
    const { error } = await sbClient.from('orders').insert([order]);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
  }
  showToast('Order submitted - confirmation call queued ✓', 'success');
  resetConsultantForm();
}

function resetConsultantForm() {
  consultantFormImageBase64 = null;
  consultantFormItems = [];
  document.getElementById('c-upload-preview').style.display = 'none';
  document.getElementById('c-review-card').style.display = 'none';
  document.getElementById('c-extraction-warning').style.display = 'none';
  document.getElementById('c-form-file-input').value = '';
  document.getElementById('c-extract-progress').style.width = '0%';
}

// ══════════════════════════════════════════════════════
// APPOINTMENTS SYSTEM
// ══════════════════════════════════════════════════════

let currentApptId = null;

// ── CONSULTANT TAB: show/hide add form ──
function showAddApptForm() {
  const form = document.getElementById('add-appt-form');
  if (!form) return;
  // Default to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('appt-date').value = today;
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth' });
}

function hideAddApptForm() {
  const form = document.getElementById('add-appt-form');
  if (form) form.style.display = 'none';
}

// ── SAVE NEW APPOINTMENT ──
async function saveAppointment(editId) {
  const name = document.getElementById('appt-customer-name').value.trim();
  const date = document.getElementById('appt-date').value;
  const time = document.getElementById('appt-time').value;
  if (!name || !date || !time) { showToast('Please enter customer name, date and time', 'error'); return; }

  const appt = {
    consultant: currentUser?.user_metadata?.name || currentUser?.email || '',
    consultant_phone: '',
    customer_name: name,
    address: document.getElementById('appt-address').value.trim(),
    phone: document.getElementById('appt-phone').value.trim(),
    appt_date: date,
    appt_time: time,
    status: 'booked',
    updated_at: new Date().toISOString()
  };

  if (!sbClient) return;
  let error;
  if (editId) {
    ({ error } = await sbClient.from('appointments').update(appt).eq('id', editId));
  } else {
    ({ error } = await sbClient.from('appointments').insert([appt]));
  }

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(editId ? 'Appointment updated ✓' : 'Appointment booked ✓', 'success');
  hideAddApptForm();
  document.getElementById('appt-customer-name').value = '';
  document.getElementById('appt-address').value = '';
  document.getElementById('appt-phone').value = '';
  document.getElementById('appt-time').value = '';
  loadConsultantAppointments();
}

// ── LOAD CONSULTANT APPOINTMENTS ──
async function loadConsultantAppointments() {
  const container = document.getElementById('consultant-appt-list');
  if (!container || !sbClient) return;

  const consultantName = currentUser?.user_metadata?.name || currentUser?.email || '';

  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await sbClient
    .from('appointments')
    .select('*')
    .eq('consultant', consultantName)
    .gte('appt_date', today)
    .order('appt_date', { ascending: true })
    .order('appt_time', { ascending: true });

  if (error || !data || data.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">
      No appointments booked yet.<br>Tap <strong>+ Book appointment</strong> to add one.
    </div>`;
    return;
  }

  container.innerHTML = data.map(a => renderApptCard(a)).join('');
}

// ── RENDER APPOINTMENT CARD ──
function renderApptCard(a) {
  const statusColour = {
    booked: 'var(--navy)', presented: 'var(--amber)',
    reappointed: 'var(--gm)', cancelled: 'var(--red)'
  }[a.status] || 'var(--navy)';

  const statusLabel = {
    booked: 'Booked', presented: 'Presented',
    reappointed: 'Reappointed', cancelled: 'Cancelled'
  }[a.status] || a.status;

  const timeStr = a.appt_time ? a.appt_time.substring(0, 5) : '';
  const dateStr = a.appt_date ? new Date(a.appt_date + 'T00:00:00').toLocaleDateString('en-NZ', { weekday:'short', day:'numeric', month:'short' }) : '';

  let actionButtons = '';
  if (a.status === 'booked') {
    actionButtons = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
        <button class="btn-green btn-sm" onclick="markPresented('${a.id}')">✓ Presented</button>
        <button class="btn-outline btn-sm" onclick="markReappointed('${a.id}')">↻ Reappoint</button>
        <button class="btn-red btn-sm" onclick="markCancelled('${a.id}')">✗ Cancelled</button>
      </div>`;
  } else if (a.status === 'presented' && !a.outcome) {
    actionButtons = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
        <button class="btn-green btn-sm" onclick="markSold('${a.id}')">🏆 Sold!</button>
        <button class="btn-outline btn-sm" onclick="markNoSale('${a.id}')">No sale</button>
      </div>`;
  } else if (a.status === 'reappointed' && a.outcome === 'reappointed_call_back') {
    actionButtons = `
      <div style="margin-top:10px">
        <span style="background:var(--abg);color:#8a5500;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">📞 Call to rebook</span>
        <button class="btn-outline btn-sm" style="margin-left:8px" onclick="editReappt('${a.id}')">Update</button>
      </div>`;
  }

  let outcomeTag = '';
  if (a.outcome === 'sold') outcomeTag = '<span style="background:var(--gbg);color:#1a7a44;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">Sold ✓</span>';
  else if (a.outcome === 'no_sale') outcomeTag = `<span style="background:var(--rbg);color:#8a2222;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">No sale - ${a.no_sale_reason || ''}</span>`;
  else if (a.outcome === 'reappointed_new_time') outcomeTag = '<span style="background:var(--abg);color:#8a5500;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">Reappointed</span>';

  return `
  <div class="card" style="border-left:4px solid ${statusColour};margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--navy)">${a.customer_name}</div>
        <div style="font-size:12px;color:var(--gm);margin-top:2px">${a.address || '-'} · ${a.phone || '-'}</div>
        <div style="font-size:13px;font-weight:600;color:var(--navy);margin-top:6px">${dateStr} at ${timeStr}</div>
      </div>
      <div style="text-align:right">
        <span style="background:var(--gl);color:${statusColour};padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600">${statusLabel}</span>
        ${outcomeTag ? '<br><span style="margin-top:4px;display:inline-block">' + outcomeTag + '</span>' : ''}
      </div>
    </div>
    ${a.no_sale_notes ? `<div style="margin-top:8px;font-size:12px;color:var(--gm);background:var(--gl);padding:6px 10px;border-radius:6px">${a.no_sale_notes}</div>` : ''}
    ${actionButtons}
  </div>`;
}

// ── OUTCOME ACTIONS ──
async function markPresented(id) {
  await sbClient.from('appointments').update({ status: 'presented', updated_at: new Date().toISOString() }).eq('id', id);
  showToast('Marked as presented', 'success');
  loadConsultantAppointments();
}

async function markCancelled(id) {
  if (!confirm('Mark this appointment as cancelled?')) return;
  await sbClient.from('appointments').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  showToast('Appointment cancelled', 'success');
  loadConsultantAppointments();
}

function markSold(id) {
  // Switch to sales form with appointment pre-noted
  currentApptId = id;
  consultantShowTab('sales');
  showToast('Complete the order form - appointment will be marked sold automatically', 'success');
}

function markNoSale(id) {
  const reason = prompt("Select reason: 1=Can't afford  2=Didn't like  3=Other");
  const reasons = { '1': 'cant_afford', '2': 'didnt_like', '3': 'other' };
  const reasonKey = reasons[reason] || 'other';
  const reasonLabel = { cant_afford: "Can't afford", didnt_like: "Didn't like", other: "Other" }[reasonKey];
  const notes = reasonKey === 'other' ? prompt('Please describe the reason:') || '' : '';
  sbClient.from('appointments').update({
    outcome: 'no_sale', no_sale_reason: reasonKey,
    no_sale_notes: notes, updated_at: new Date().toISOString()
  }).eq('id', id).then(() => {
    showToast(`No sale recorded - ${reasonLabel}`, 'success');
    loadConsultantAppointments();
  });
}

let currentReapptId = null;

function markReappointed(id) {
  currentReapptId = id;
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('reappt-new-date').value = today;
  document.getElementById('reappt-new-time').value = '';
  document.getElementById('reappt-fields').style.display = 'none';
  const modal = document.getElementById('reappt-modal');
  if (modal) { modal.style.display = 'flex'; }
}

function showReapptFields() {
  document.getElementById('reappt-fields').style.display = 'block';
}

function closeReapptModal() {
  const modal = document.getElementById('reappt-modal');
  if (modal) modal.style.display = 'none';
  currentReapptId = null;
}

async function confirmNewTime() {
  const newDate = document.getElementById('reappt-new-date').value;
  const newTime = document.getElementById('reappt-new-time').value;
  if (!newDate || !newTime) { showToast('Please enter date and time', 'error'); return; }
  await sbClient.from('appointments').update({
    status: 'reappointed', outcome: 'reappointed_new_time',
    reappt_date: newDate, reappt_time: newTime,
    updated_at: new Date().toISOString()
  }).eq('id', currentReapptId);
  closeReapptModal();
  showToast('Reappointment saved ✓', 'success');
  loadConsultantAppointments();
}

async function confirmCallBack() {
  await sbClient.from('appointments').update({
    status: 'reappointed', outcome: 'reappointed_call_back',
    updated_at: new Date().toISOString()
  }).eq('id', currentReapptId);
  closeReapptModal();
  showToast('Flagged for call back', 'success');
  loadConsultantAppointments();
}

// ── ADMIN APPOINTMENTS ──
async function loadAdminAppointments() {
  if (!sbClient) return;

  const filterConsultant = document.getElementById('appt-filter-consultant')?.value || '';
  const filterDate = document.getElementById('appt-filter-date')?.value || new Date().toISOString().split('T')[0];

  let query = sbClient.from('appointments').select('*').eq('appt_date', filterDate).order('appt_time');
  if (filterConsultant) query = query.eq('consultant', filterConsultant);

  const { data, error } = await query;
  if (error) return;

  const appts = data || [];

  // Metrics
  const booked = appts.length;
  const presented = appts.filter(a => ['presented'].includes(a.status) || a.outcome).length;
  const sold = appts.filter(a => a.outcome === 'sold').length;
  const bookRate = booked > 0 ? Math.round(presented / booked * 100) + '%' : '-';
  const saleRate = presented > 0 ? Math.round(sold / presented * 100) + '%' : '-';

  const m = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  m('appt-m-booked', booked);
  m('appt-m-presented', presented);
  m('appt-m-sold', sold);
  m('appt-m-book-rate', bookRate);
  m('appt-m-sale-rate', saleRate);

  // Consultant breakdown
  const byConsultant = {};
  for (const a of appts) {
    if (!byConsultant[a.consultant]) byConsultant[a.consultant] = { booked:0, presented:0, sold:0 };
    byConsultant[a.consultant].booked++;
    if (['presented'].includes(a.status) || a.outcome) byConsultant[a.consultant].presented++;
    if (a.outcome === 'sold') byConsultant[a.consultant].sold++;
  }

  const breakdown = document.getElementById('appt-consultant-breakdown');
  if (breakdown) {
    if (Object.keys(byConsultant).length === 0) {
      breakdown.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:12px 0">No appointments for this date.</div>';
    } else {
      breakdown.innerHTML = `<table class="dtable">
        <tr><th>Consultant</th><th>Booked</th><th>Presented</th><th>Sold</th><th>Book→Present</th><th>Present→Sale</th></tr>
        ${Object.entries(byConsultant).map(([name, s]) => `
          <tr>
            <td><b>${name}</b></td>
            <td>${s.booked}</td>
            <td>${s.presented}</td>
            <td style="color:var(--green);font-weight:600">${s.sold}</td>
            <td>${s.booked > 0 ? Math.round(s.presented/s.booked*100) + '%' : '-'}</td>
            <td>${s.presented > 0 ? Math.round(s.sold/s.presented*100) + '%' : '-'}</td>
          </tr>`).join('')}
      </table>`;
    }
  }

  // Full list
  const list = document.getElementById('admin-appt-list');
  if (list) {
    if (appts.length === 0) {
      list.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:12px 0">No appointments found.</div>';
    } else {
      list.innerHTML = `<table class="dtable">
        <tr><th>Time</th><th>Consultant</th><th>Customer</th><th>Address</th><th>Phone</th><th>Status</th><th>Outcome</th></tr>
        ${appts.map(a => {
          const timeStr = a.appt_time ? a.appt_time.substring(0,5) : '-';
          const outcomeLabel = {
            sold: '🏆 Sold', no_sale: 'No sale' + (a.no_sale_reason ? ' - ' + a.no_sale_reason.replace('_',' ') : ''),
            reappointed_new_time: 'Reappointed', reappointed_call_back: 'Call to rebook'
          }[a.outcome] || '-';
          const statusBadge = {
            booked: 'b-gold', presented: 'b-amber', reappointed: 'b-amber', cancelled: 'b-red'
          }[a.status] || 'b-gold';
          return `<tr>
            <td style="font-weight:600">${timeStr}</td>
            <td>${a.consultant}</td>
            <td><b>${a.customer_name}</b></td>
            <td style="font-size:12px;color:var(--gm)">${a.address || '-'}</td>
            <td style="font-size:12px">${a.phone || '-'}</td>
            <td><span class="badge ${statusBadge}">${a.status}</span></td>
            <td style="font-size:12px">${outcomeLabel}</td>
          </tr>`;
        }).join('')}
      </table>`;
    }
  }

  // Populate consultant filter from all appointments (not just today)
  const filterEl = document.getElementById('appt-filter-consultant');
  if (filterEl) {
    const { data: allAppts } = await sbClient.from('appointments').select('consultant').order('consultant');
    const consultants = [...new Set((allAppts || []).map(a => a.consultant).filter(Boolean))];
    const currentVal = filterEl.value;
    filterEl.innerHTML = '<option value="">All consultants</option>';
    consultants.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      filterEl.appendChild(opt);
    });
    filterEl.value = currentVal;
  }
}

// Load admin appointments when navigating to appointments screen

// ══════════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ══════════════════════════════════════════════════════

const DEFAULT_TEMPLATES = {
  welcome_email: { label:"Welcome email", type:"email",
    subject:"Welcome to the Simtec Therapeutic family, {{fname}}!",
    body:"<p>Hi {{fname}},</p><p>Welcome to Simtec Therapeutic! We are delighted to have you as a customer.</p><p><strong>Weekly payment:</strong> ${{weekly}}/week via direct debit<br><strong>Consultant:</strong> {{consultant}}<br><strong>Delivery address:</strong> {{address}}</p><p>Remember you have a 5-day cooling-off period. Call 09 886 9897 anytime.</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong></p>" },
  welcome_sms: { label:"Welcome SMS", type:"sms",
    body:"Hi {{fname}}, welcome to Simtec Therapeutic! Order confirmed at ${{weekly}}/week. We will be in touch about delivery. Call 09 886 9897 if you need us." },
  delivery_email: { label:"Delivery notification email", type:"email",
    subject:"Your Simtec mattress delivery is confirmed, {{fname}}!",
    body:"<p>Hi {{fname}},</p><p>Great news - your Simtec Therapeutic mattress is confirmed for delivery!</p><p><strong>Delivery address:</strong> {{address}}</p><p>Please ensure someone is home. Sweet dreams!</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong><br>09 886 9897 - simtecnz.com</p>" },
  delivery_sms: { label:"Delivery notification SMS", type:"sms",
    body:"Hi {{fname}}, great news! Your Simtec mattress delivery is confirmed. Please ensure someone is home at {{address}}. Call 09 886 9897 if you need us." },
  payment_failed_email: { label:"Payment failure email", type:"email",
    subject:"We noticed your payment did not go through - we are here to help",
    body:"<p>Hi {{fname}},</p><p>We noticed your payment did not go through this week - no worries! Give us a call on <strong>09 886 9897</strong> or reply to this email and we will sort it out.</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong></p>" },
  payment_failed_sms: { label:"Payment failure SMS", type:"sms",
    body:"Hi {{fname}}, this is Simtec Therapeutic. Your payment did not go through this week - no worries! Call 09 886 9897 or reply and we will sort it out." },
  cancellation_email: { label:"Cancellation email", type:"email",
    subject:"Regarding your Simtec Therapeutic order",
    body:"<p>Hi {{fname}},</p><p>We have cancelled your order and we want you to know we completely understand. Financial circumstances can change for any of us.</p><p><strong>Your refund</strong> will be returned in full within 3-5 business days.</p><p>Our door is always open when things look brighter.</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong><br>09 886 9897</p>" },
  cooling_off_email: { label:"Cooling-off cancellation email", type:"email",
    subject:"Your Simtec Therapeutic cancellation is confirmed",
    body:"<p>Hi {{fname}},</p><p>Your cancellation under the 5-day cooling-off period has been processed - no problem at all. This is your right and we respect it completely.</p><p><strong>Your refund</strong> will be returned in full within 3-5 business days.</p><p>We hope to welcome you back in future.</p><p>Take care,<br><strong>The Simtec Therapeutic Team</strong><br>09 886 9897</p>" },
  end_of_loan_email: { label:"End of loan congratulations email", type:"email",
    subject:"Congratulations {{fname}} - your mattress is completely paid off!",
    body:"<p>Hi {{fname}},</p><p>What a milestone! Your Simtec Therapeutic mattress is now completely yours - paid in full.</p><p>We hope it has given you hundreds of great nights of sleep and we are so grateful you chose us.</p><p>If a friend or family member buys a Simtec mattress on your recommendation, we would love to thank you with <strong>{{referral_incentive}}</strong>. Simply have them mention your name when they order.</p><p>Thank you for being a wonderful customer.</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong></p>" },
  end_of_loan_sms: { label:"End of loan congratulations SMS", type:"sms",
    body:"Hi {{fname}}, congratulations - your Simtec mattress is fully paid off! Thank you for being a wonderful customer. Know someone who would love better sleep? Have them mention your name and we will thank you with {{referral_incentive}}. Call 09 886 9897." },
  referral_email: { label:"Referral ask email", type:"email",
    subject:"Know someone who deserves better sleep, {{fname}}?",
    body:"<p>Hi {{fname}},</p><p>We hope you are still loving your Simtec mattress!</p><p>If you refer a friend or family member who goes ahead with a Simtec mattress, we would love to thank you with <strong>{{referral_incentive}}</strong>. Just have them mention your name when they order.</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong><br>09 886 9897</p>" },
  referral_sms: { label:"Referral ask SMS", type:"sms",
    body:"Hi {{fname}}, hope you are loving your Simtec mattress! Know someone who deserves better sleep? Refer them and we will thank you with {{referral_incentive}}. Have them mention your name. Call 09 886 9897." },
  marketing_email: { label:"Marketing / re-engagement email", type:"email",
    subject:"A special message for you from Simtec Therapeutic",
    body:"<p>Hi {{fname}},</p><p>We wanted to reach out with something we think you will find interesting.</p><p>[Edit this section with your current offer or message]</p><p>Warm regards,<br><strong>The Simtec Therapeutic Team</strong><br>09 886 9897</p>" },
  marketing_sms: { label:"Marketing / re-engagement SMS", type:"sms",
    body:"Hi {{fname}}, this is Simtec Therapeutic with a message we think you will like. [Edit with your current offer]. Call 09 886 9897." },
  commission_sms: { label:"Weekly commission SMS (to consultant)", type:"sms",
    body:"Hi {{fname}}, great week! {{sales}} sales this week, commission of ${{commission}}. {{award_message}} Keep it up! - Simtec" },
  award_notification_sms: { label:"Award achievement SMS (to consultant)", type:"sms",
    body:"Congratulations {{fname}}! You have just achieved your {{award_level}} Award. Well done - the whole team is proud of you! - Simtec" }
};
let currentTemplateKey = null;

async function loadTemplateEditor(key) {
  if (!key) { document.getElementById('template-editor').style.display = 'none'; return; }
  currentTemplateKey = key;

  // Load from config if saved, otherwise use default
  const saved = configCache['templates'] && configCache['templates'][key];
  const def = DEFAULT_TEMPLATES[key];
  const tmpl = saved ? { ...def, ...saved } : def;

  if (!tmpl) return;

  const editor = document.getElementById('template-editor');
  const fields = document.getElementById('template-editor-fields');
  editor.style.display = 'block';

  let html = `<div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:12px">${tmpl.label}</div>`;

  if (tmpl.type === 'email') {
    html += `<div><label class="flabel">Subject line</label>
      <input class="finput" id="tmpl-subject" value="${(tmpl.subject||'').replace(/"/g,'&quot;')}" /></div>
      <div><label class="flabel">Email body (HTML supported)</label>
      <textarea class="finput" id="tmpl-body" rows="12" style="font-family:monospace;font-size:12px;resize:vertical">${tmpl.body||''}</textarea></div>`;
  } else {
    html += `<div><label class="flabel">SMS message (keep under 160 characters for single SMS)</label>
      <textarea class="finput" id="tmpl-body" rows="4" style="resize:vertical">${tmpl.body||''}</textarea>
      <div id="sms-char-count" style="font-size:11px;color:var(--gm);margin-top:4px">0 characters</div></div>`;
  }

  fields.innerHTML = html;

  // SMS character counter
  const bodyEl = document.getElementById('tmpl-body');
  if (tmpl.type === 'sms' && bodyEl) {
    bodyEl.addEventListener('input', () => {
      const count = bodyEl.value.length;
      const counter = document.getElementById('sms-char-count');
      if (counter) counter.textContent = count + ' characters' + (count > 160 ? ' — will send as ' + Math.ceil(count/160) + ' SMS' : '');
    });
    bodyEl.dispatchEvent(new Event('input'));
  }
}

async function saveTemplate() {
  if (!currentTemplateKey || !sbClient) return;
  const def = DEFAULT_TEMPLATES[currentTemplateKey];
  const subjectEl = document.getElementById('tmpl-subject');
  const bodyEl = document.getElementById('tmpl-body');

  const updated = {
    ...def,
    subject: subjectEl ? subjectEl.value : def.subject,
    body: bodyEl ? bodyEl.value : def.body,
  };

  await saveConfigVal('templates', currentTemplateKey, updated);
  showToast('Template saved ✓', 'success');
}

async function resetTemplate() {
  if (!currentTemplateKey) return;
  if (!confirm('Reset this template to the default wording?')) return;

  // Delete from config so default is used
  const { error } = await sbClient.from('config')
    .delete()
    .eq('category', 'templates')
    .eq('key', currentTemplateKey);

  if (!error) {
    // Reload config cache
    await loadConfig();
    loadTemplateEditor(currentTemplateKey);
    showToast('Template reset to default ✓', 'success');
  }
}

// Helper: get template with placeholders filled
function fillTemplate(templateKey, data) {
  const saved = configCache['templates'] && configCache['templates'][templateKey];
  const def = DEFAULT_TEMPLATES[templateKey];
  const tmpl = saved ? { ...def, ...saved } : (def || {});

  const replacePlaceholders = (str) => {
    if (!str) return '';
    return str
      .replace(/\{\{fname\}\}/g, data.fname || '')
      .replace(/\{\{lname\}\}/g, data.lname || '')
      .replace(/\{\{amount\}\}/g, data.amount || '')
      .replace(/\{\{weekly\}\}/g, data.weekly || '')
      .replace(/\{\{address\}\}/g, data.address || '')
      .replace(/\{\{phone\}\}/g, data.phone || '')
      .replace(/\{\{consultant\}\}/g, data.consultant || '')
      .replace(/\{\{date\}\}/g, data.date || '')
      .replace(/\{\{reference\}\}/g, data.reference || '')
      .replace(/\{\{referral_incentive\}\}/g, data.referral_incentive || 'a special thank you gift');
  };

  return {
    subject: replacePlaceholders(tmpl.subject),
    body: replacePlaceholders(tmpl.body),
    type: tmpl.type,
  };
}

// ══════════════════════════════════════════════════════
// REPORTS SCREEN
// ══════════════════════════════════════════════════════

// Chart instances - keep references so we can destroy before redraw
let salesChartInstance = null;
let valueChartInstance = null;

async function loadTrendData(recentOrders) {
  // We already have 4 weeks of data from loadReports
  // For longer periods fetch more
  const weeks = parseInt(document.getElementById('trend-period')?.value || '12');

  const now = new Date();
  const nzNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const dayOfWeek = nzNow.getUTCDay();
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisWeekStart = new Date(nzNow);
  thisWeekStart.setUTCDate(nzNow.getUTCDate() - daysFromMon);
  thisWeekStart.setUTCHours(0, 0, 0, 0);

  const periodStart = new Date(thisWeekStart);
  periodStart.setUTCDate(periodStart.getUTCDate() - (weeks * 7));
  const periodStartUTC = new Date(periodStart.getTime() - 12 * 60 * 60 * 1000);

  const { data: allOrders } = await sbClient
    .from('orders')
    .select('created_at, total')
    .gte('created_at', periodStartUTC.toISOString())
    .is('cancelled_at', null)
    .order('created_at', { ascending: true });

  // Build weekly buckets
  const weekLabels = [];
  const weeklySales = [];
  const weeklyValues = [];

  for (let w = weeks - 1; w >= 0; w--) {
    const wStart = new Date(thisWeekStart);
    wStart.setUTCDate(wStart.getUTCDate() - w * 7);
    const wEnd = new Date(wStart);
    wEnd.setUTCDate(wEnd.getUTCDate() + 7);

    const wStartUTC = new Date(wStart.getTime() - 12 * 60 * 60 * 1000);
    const wEndUTC = new Date(wEnd.getTime() - 12 * 60 * 60 * 1000);

    const wOrders = (allOrders || []).filter(o =>
      new Date(o.created_at) >= wStartUTC && new Date(o.created_at) < wEndUTC
    );

    const label = wStart.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
    weekLabels.push(label);
    weeklySales.push(wOrders.length);
    weeklyValues.push(wOrders.reduce((s, o) => s + (o.total || 0), 0));
  }

  renderTrendChartsWithData(weekLabels, weeklySales, weeklyValues);
}

function renderTrendChartsWithData(labels, sales, values) {
  // Sales count chart
  const salesCtx = document.getElementById('trend-sales-chart');
  if (salesCtx) {
    if (salesChartInstance) salesChartInstance.destroy();
    salesChartInstance = new Chart(salesCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Sales',
          data: sales,
          backgroundColor: sales.map((v, i) => i === sales.length - 1 ? 'rgba(201,168,76,0.8)' : 'rgba(30,58,110,0.7)'),
          borderColor: sales.map((v, i) => i === sales.length - 1 ? '#c9a84c' : '#1e3a6e'),
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' sales' } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1, color: '#888', font: { size: 11 } }, grid: { color: '#f0f4fb' } },
          x: { ticks: { color: '#888', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }

  // Value chart
  const valueCtx = document.getElementById('trend-value-chart');
  if (valueCtx) {
    if (valueChartInstance) valueChartInstance.destroy();
    valueChartInstance = new Chart(valueCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Value',
          data: values,
          borderColor: '#1a7a44',
          backgroundColor: 'rgba(26,122,68,0.08)',
          borderWidth: 2,
          pointBackgroundColor: '#1a7a44',
          pointRadius: 3,
          fill: true,
          tension: 0.3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: ctx => '$' + ctx.parsed.y.toLocaleString('en-NZ') } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#888', font: { size: 11 },
              callback: v => '$' + (v/1000).toFixed(0) + 'k' }, grid: { color: '#f0f4fb' } },
          x: { ticks: { color: '#888', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }

  // Summary stats
  const avg = sales.length > 0 ? (sales.reduce((a, b) => a + b, 0) / sales.length).toFixed(1) : '—';
  const best = sales.length > 0 ? Math.max(...sales) : '—';

  // Growth: compare last 4 weeks vs previous 4 weeks
  let growth = '—';
  let growthColour = 'var(--gm)';
  if (sales.length >= 8) {
    const recent4 = sales.slice(-4).reduce((a, b) => a + b, 0);
    const prev4 = sales.slice(-8, -4).reduce((a, b) => a + b, 0);
    if (prev4 > 0) {
      const pct = Math.round((recent4 - prev4) / prev4 * 100);
      growth = (pct >= 0 ? '+' : '') + pct + '%';
      growthColour = pct > 0 ? '#1a7a44' : pct < 0 ? '#8a2222' : '#8a5500';
    }
  }

  const m = (id, val, col) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = val; if (col) el.style.color = col; }
  };
  m('trend-avg-sales', avg);
  m('trend-best-week', best.toString());
  m('trend-growth', growth, growthColour);
}

function renderTrendCharts() {
  // Called when period selector changes - re-fetch
  if (sbClient) loadTrendData([]);
}

async function loadReports() {
  if (!sbClient) return;

  // ── THIS WEEK SO FAR ──
  const now = new Date();
  // NZ is UTC+12 — get start of current NZ week (Monday)
  const nzNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const dayOfWeek = nzNow.getUTCDay(); // 0=Sun
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(nzNow);
  weekStart.setUTCDate(nzNow.getUTCDate() - daysFromMon);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekStartUTC = new Date(weekStart.getTime() - 12 * 60 * 60 * 1000);

  const weekLabel = weekStart.toLocaleDateString('en-NZ', { weekday:'long', day:'numeric', month:'long' });
  const weekLabelEl = document.getElementById('reports-week-label');
  if (weekLabelEl) weekLabelEl.textContent = 'Week starting ' + weekLabel;

  const { data: weekOrders } = await sbClient
    .from('orders')
    .select('*')
    .gte('created_at', weekStartUTC.toISOString())
    .is('cancelled_at', null);

  const orders = weekOrders || [];
  const totalSales = orders.length;
  const totalValue = orders.reduce((s, o) => s + (o.total || 0), 0);
  const avgSale = totalSales > 0 ? Math.round(totalValue / totalSales) : 0;
  const cashSales = orders.filter(o => o.pay_type === 'c').length;

  const m = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  m('rep-week-sales', totalSales);
  m('rep-week-value', '$' + totalValue.toLocaleString('en-NZ'));
  m('rep-week-avg', avgSale > 0 ? '$' + avgSale.toLocaleString('en-NZ') : '—');
  m('rep-week-cash', cashSales);

  // Consultant breakdown
  const byConsultant = {};
  for (const o of orders) {
    const name = o.consultant || 'Unknown';
    if (!byConsultant[name]) byConsultant[name] = { sales: 0, value: 0 };
    byConsultant[name].sales++;
    byConsultant[name].value += (o.total || 0);
  }

  const breakdown = document.getElementById('rep-consultant-breakdown');
  if (breakdown) {
    if (Object.keys(byConsultant).length === 0) {
      breakdown.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:8px 0">No sales recorded yet this week.</div>';
    } else {
      breakdown.innerHTML = '<table class="dtable"><tr><th>Consultant</th><th>Sales</th><th>Total value</th><th>Avg sale</th></tr>' +
        Object.entries(byConsultant)
          .sort((a, b) => b[1].value - a[1].value)
          .map(([name, s]) => '<tr><td><b>' + name + '</b></td><td>' + s.sales + '</td><td>$' + s.value.toLocaleString('en-NZ') + '</td><td>$' + (s.sales > 0 ? Math.round(s.value/s.sales).toLocaleString('en-NZ') : '—') + '</td></tr>')
          .join('') +
        '</table>';
    }
  }

  // ── LOAN BOOK SUMMARY ──
  const { data: allOrders } = await sbClient
    .from('orders')
    .select('id, total, delivered_at, cancelled_at')
    .is('cancelled_at', null);

  const activeOrders = (allOrders || []);
  const bookValue = activeOrders.reduce((s, o) => s + (o.total || 0), 0);
  const delivered = activeOrders.filter(o => o.delivered_at).length;
  const pendingDelivery = activeOrders.filter(o => !o.delivered_at).length;

  m('rep-book-active', activeOrders.length);
  m('rep-book-value', '$' + bookValue.toLocaleString('en-NZ'));
  m('rep-book-eligible', delivered);
  m('rep-book-pending', pendingDelivery);

  // ── TREND CHARTS ──
  await loadTrendData(orders);

  // ── REPORT RECIPIENTS ──
  if (configCache['reports'] && configCache['reports']['recipients']) {
    const r = configCache['reports']['recipients'];
    const daily = (r.daily_sales || []).join(', ') || 'None configured';
    const weekly = (r.weekly_commission || []).join(', ') || 'None configured';
    m('rep-daily-recipients', '📧 ' + daily);
    m('rep-weekly-recipients', '📧 ' + weekly);
  } else {
    m('rep-daily-recipients', 'Go to Config → Reports to set recipients');
    m('rep-weekly-recipients', 'Go to Config → Reports to set recipients');
  }
}

// ══════════════════════════════════════════════════════
// STAFF EDIT FUNCTIONS
// ══════════════════════════════════════════════════════

function openStaffEdit(key) {
  const staff = configCache['staff'] && configCache['staff'][key];
  if (!staff) return;

  document.getElementById('edit-staff-key').value = key;
  document.getElementById('edit-staff-name').value = staff.name || '';
  document.getElementById('edit-staff-phone').value = staff.phone || '';
  document.getElementById('edit-staff-email').value = staff.email || '';
  document.getElementById('edit-staff-role').value = staff.role || 'Sleep Consultant';
  document.getElementById('edit-staff-award').value = staff.award_level || '';

  // Populate TL dropdown from staff list
  const tlSelect = document.getElementById('edit-staff-tl');
  tlSelect.innerHTML = '<option value="">— None —</option>';
  const allStaff = configCache['staff'] || {};
  Object.values(allStaff).forEach(s => {
    if (s.name !== staff.name && s.role === 'Team Leader' && s.active !== false) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      if (s.name === staff.team_leader) opt.selected = true;
      tlSelect.appendChild(opt);
    }
  });
  tlSelect.value = staff.team_leader || '';

  document.getElementById('staff-edit-modal').style.display = 'block';
  document.getElementById('staff-edit-modal').scrollIntoView({ behavior: 'smooth' });
}

function closeStaffEdit() {
  document.getElementById('staff-edit-modal').style.display = 'none';
}

async function saveStaffEdit() {
  const key = document.getElementById('edit-staff-key').value;
  const existing = configCache['staff'] && configCache['staff'][key];
  if (!key || !existing) return;

  const updated = {
    ...existing,
    name: document.getElementById('edit-staff-name').value.trim(),
    phone: document.getElementById('edit-staff-phone').value.trim(),
    email: document.getElementById('edit-staff-email').value.trim(),
    role: document.getElementById('edit-staff-role').value,
    team_leader: document.getElementById('edit-staff-tl').value || null,
    award_level: document.getElementById('edit-staff-award').value || null,
  };

  await saveConfigVal('staff', key, updated);
  await loadConsultants();
  closeStaffEdit();
  showToast(updated.name + ' updated ✓', 'success');
}

// ══════════════════════════════════════════════════════
// LOAN COMPLETION & END-OF-LOAN EMAIL
// ══════════════════════════════════════════════════════

async function markLoanComplete(orderId, customerName) {
  if (!sbClient) return;
  if (!confirm('Mark loan for ' + customerName + ' as fully paid off? This will send them a congratulations email and referral ask.')) return;

  // Get full order
  const { data: orderData } = await sbClient.from('orders').select('*').eq('id', orderId).single();
  if (!orderData) return;

  // Mark loan as complete
  const { error } = await sbClient.from('orders').update({
    loan_completed_at: new Date().toISOString()
  }).eq('id', orderId);

  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  // Send end-of-loan email via Edge Function
  try {
    fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/end-of-loan-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ'
      },
      body: JSON.stringify({ order: orderData })
    });
  } catch(e) { /* email failed silently */ }

  // Close modal and refresh
  document.getElementById('customer-profile-modal')?.remove();
  showToast('Loan marked complete ✓ — congratulations email sent to ' + customerName, 'success');
}

// Also called automatically by Ezidebit webhook when balance reaches zero
async function checkAndCompleteEzidebitLoan(orderId) {
  if (!sbClient) return;
  const { data: order } = await sbClient.from('orders').select('*').eq('id', orderId).single();
  if (!order || order.loan_completed_at || order.cancelled_at) return;

  // Calculate balance: total - sum of all payments
  const { data: payments } = await sbClient
    .from('payments')
    .select('amount')
    .eq('order_id', orderId)
    .eq('status', 'on_time');

  const paid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  const balance = (order.total || 0) - paid;

  if (balance <= 0) {
    await markLoanComplete(orderId, order.fname + ' ' + order.lname);
  }
}

// ══════════════════════════════════════════════════════
// USER MANAGEMENT
// ══════════════════════════════════════════════════════

const ROLE_LABELS = {
  admin: { label: 'Admin', colour: '#8a2222', bg: '#fff0f0' },
  office: { label: 'Office', colour: '#1a7a44', bg: '#edfaf3' },
  consultant: { label: 'Sleep Consultant', colour: '#1e3a6e', bg: '#f0f4fb' },
  caller: { label: 'Caller', colour: '#8a5500', bg: '#fdf6e3' },
};


async function userMgmtCall(payload) {
  const session = await sbClient.auth.getSession();
  const token = session?.data?.session?.access_token || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2cWpvZW5hdW5ndWJwb2VneXZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MzQyMjYsImV4cCI6MjA5NjExMDIyNn0.ypVt8578XTdNwBH6TRDn30s1cF_rHTu67qCWYv5XHcQ';
  const res = await fetch('https://jvqjoenaungubpoegyvf.supabase.co/functions/v1/clever-function', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'User management error');
  return data;
}
async function loadUsers() {
  const container = document.getElementById('users-list');
  if (!container || !sbClient) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gm);font-size:13px">Loading...</div>';

  try {
    const data = await userMgmtCall({ action: 'list' });
    const users = (data.users || []).sort((a, b) => {
      const ra = a.user_metadata?.role || 'z';
      const rb = b.user_metadata?.role || 'z';
      return ra.localeCompare(rb) || (a.user_metadata?.name || '').localeCompare(b.user_metadata?.name || '');
    });

    if (users.length === 0) {
      container.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:12px 0">No users found.</div>';
      return;
    }

    container.innerHTML = users.map(u => {
      const role = u.user_metadata?.role || 'unknown';
      const name = u.user_metadata?.name || '—';
      const roleInfo = ROLE_LABELS[role] || { label: role, colour: '#888', bg: '#f4f6fa' };
      const lastSeen = u.last_sign_in_at ? timeAgo(u.last_sign_in_at) : 'Never';
      const confirmed = u.email_confirmed_at ? true : false;

      return `<div class="config-row" style="flex-wrap:wrap;gap:8px;align-items:center">
        <div style="flex:2;min-width:180px">
          <div class="config-label">${name}</div>
          <div class="config-sub">${u.email}</div>
          <div style="font-size:11px;color:var(--gm);margin-top:2px">Last login: ${lastSeen} ${!confirmed ? '· <span style="color:#8a5500">Invite pending</span>' : ''}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:${roleInfo.colour};background:${roleInfo.bg};padding:4px 10px;border-radius:20px">${roleInfo.label}</span>
          <button class="btn-outline btn-sm" onclick="openEditUser('${u.id}','${name.replace(/'/g,'&apos;')}','${u.email}','${role}')">Edit</button>
          ${u.email !== currentUser?.email ? `<button class="btn-red btn-sm" onclick="deactivateUser('${u.id}','${name.replace(/'/g,'&apos;')}')">Remove</button>` : '<span style="font-size:11px;color:var(--gm)">(you)</span>'}
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    container.innerHTML = `<div style="color:var(--red);font-size:13px;padding:12px">
      Could not load users. This requires admin API access.<br>
      <span style="font-size:12px;color:var(--gm)">Error: ${e.message}</span>
    </div>`;
  }
}

function openEditUser(userId, name, email, role) {
  const existing = document.getElementById('edit-user-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'edit-user-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px;width:100%;max-width:440px;box-shadow:0 4px 32px rgba(30,58,110,.18)">
      <div style="font-size:17px;font-weight:700;color:var(--navy);margin-bottom:16px">Edit user — ${name}</div>
      <div style="font-size:13px;color:var(--gm);margin-bottom:16px">${email}</div>
      <div class="form-grid">
        <div class="fg-full"><label class="flabel">Full name</label>
          <input class="finput" id="edit-user-name" value="${name}" /></div>
        <div class="fg-full"><label class="flabel">Role</label>
          <select class="finput" id="edit-user-role">
            <option value="consultant" ${role==='consultant'?'selected':''}>Sleep Consultant</option>
            <option value="office" ${role==='office'?'selected':''}>Office</option>
            <option value="caller" ${role==='caller'?'selected':''}>Caller</option>
            <option value="admin" ${role==='admin'?'selected':''}>Admin</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button onclick="saveUserEdit('${userId}')"
          style="flex:1;padding:13px;background:var(--navy);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">
          Save changes
        </button>
        <button onclick="document.getElementById('edit-user-modal').remove()"
          style="padding:13px 20px;background:#f4f6fa;color:var(--navy);border:none;border-radius:10px;font-size:14px;cursor:pointer;font-family:inherit">
          Cancel
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveUserEdit(userId) {
  const name = document.getElementById('edit-user-name').value.trim();
  const role = document.getElementById('edit-user-role').value;
  if (!name) { showToast('Please enter a name', 'error'); return; }

  try {
    await userMgmtCall({ action: 'update', userId, name, roleVal: role });

    // Also update in config staff table if consultant
    await loadConsultants();
    document.getElementById('edit-user-modal')?.remove();
    showToast(name + ' updated ✓', 'success');
    loadUsers();
  } catch(e) {
    showToast('Error updating user: ' + e.message, 'error');
  }
}

async function inviteUser() {
  const name = document.getElementById('new-user-name').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const role = document.getElementById('new-user-role').value;

  if (!name || !email) { showToast('Please enter name and email', 'error'); return; }
  if (!email.includes('@')) { showToast('Please enter a valid email address', 'error'); return; }

  try {
    // Invite the user
    await userMgmtCall({ action: 'invite', email, name, roleVal: role });

    // If consultant, also add to config staff table
    if (role === 'consultant') {
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await addConfigRow('staff', key, { name, email, role: 'Sleep Consultant', active: true }, name);
      await loadConsultants();
    }

    // Clear form
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-email').value = '';
    document.getElementById('new-user-role').value = 'consultant';

    showToast(name + ' invited ✓ — they will receive an email to set their password', 'success');
    loadUsers();
  } catch(e) {
    showToast('Error inviting user: ' + e.message, 'error');
  }
}

async function deactivateUser(userId, name) {
  if (!confirm('Remove ' + name + '? They will no longer be able to log in. Their historical data is preserved.')) return;

  try {
    await userMgmtCall({ action: 'delete', userId });
    showToast(name + ' removed ✓', 'success');
    loadUsers();
  } catch(e) {
    showToast('Error removing user: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════
// CLAWBACK MANAGEMENT
// ══════════════════════════════════════════════════════

async function loadClawbacks() {
  if (!sbClient) return;

  // Fetch all cancelled orders with clawback status
  const { data: clawbacks } = await sbClient
    .from('orders')
    .select('*')
    .not('clawback_status', 'is', null)
    .order('cancelled_at', { ascending: false });

  const all = clawbacks || [];
  const pending = all.filter(o => o.clawback_status === 'pending');
  const applied = all.filter(o => o.clawback_status === 'applied');

  // Week start
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7*24*60*60*1000);
  const appliedThisWeek = applied.filter(o => new Date(o.clawback_applied_at || 0) > weekAgo);

  const pendingValue = pending.reduce((s, o) => s + getClawbackAmount(o), 0);

  const m = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  m('claw-pending', pending.length);
  m('claw-applied-week', appliedThisWeek.length);
  m('claw-pending-value', '$' + pendingValue.toLocaleString('en-NZ'));
  m('claw-total', all.length);

  // Render pending list
  const pendingList = document.getElementById('claw-pending-list');
  if (pendingList) {
    if (pending.length === 0) {
      pendingList.innerHTML = '<div style="color:var(--green);font-size:13px;padding:12px 0">No pending clawbacks ✓</div>';
    } else {
      pendingList.innerHTML = '<table class="dtable">' +
        '<tr><th>Customer</th><th>Consultant</th><th>Sale value</th><th>Commission paid</th><th>Clawback</th><th>Cancelled</th><th>Reason</th><th></th></tr>' +
        pending.map(o => {
          const claw = getClawbackAmount(o);
          const commPaid = getCommissionPaid(o);
          return '<tr>' +
            '<td><b>' + o.fname + ' ' + o.lname + '</b></td>' +
            '<td>' + (o.consultant || '-') + '</td>' +
            '<td>$' + (o.total || 0).toLocaleString('en-NZ') + '</td>' +
            '<td style="color:var(--gm)">$' + commPaid.toLocaleString('en-NZ') + '</td>' +
            '<td style="font-weight:700;color:#8a2222">-$' + claw.toLocaleString('en-NZ') + '</td>' +
            '<td style="font-size:12px;color:var(--gm)">' + formatDate(o.cancelled_at) + '</td>' +
            '<td style="font-size:12px;color:var(--gm)">' + (o.cooling_off_cancel ? 'Cooling-off' : 'Pre-delivery') + '</td>' +
            '<td><button class="btn-outline btn-sm" onclick="applyClawback(\'' + o.id + '\',\'' + o.consultant + '\',' + claw + ')">Mark applied</button></td>' +
            '</tr>';
        }).join('') + '</table>';
    }
  }

  // Render applied list
  const appliedList = document.getElementById('claw-applied-list');
  if (appliedList) {
    if (applied.length === 0) {
      appliedList.innerHTML = '<div style="color:var(--gm);font-size:13px;padding:12px 0">No applied clawbacks yet.</div>';
    } else {
      appliedList.innerHTML = '<table class="dtable">' +
        '<tr><th>Customer</th><th>Consultant</th><th>Clawback</th><th>Applied</th></tr>' +
        applied.slice(0, 20).map(o => '<tr>' +
          '<td><b>' + o.fname + ' ' + o.lname + '</b></td>' +
          '<td>' + (o.consultant || '-') + '</td>' +
          '<td style="color:var(--gm)">-$' + getClawbackAmount(o).toLocaleString('en-NZ') + '</td>' +
          '<td style="font-size:12px;color:var(--gm)">' + (o.clawback_applied_at ? formatDate(o.clawback_applied_at) : '-') + '</td>' +
          '</tr>').join('') + '</table>';
    }
  }
}

function getClawbackAmount(order) {
  // Clawback = commission that was paid on this sale
  // Uses same logic as weekly commission calculation
  const sales = 1; // This was one sale
  const total = order.total || 0;
  const isMkIKS = (order.items || []).some(i => (i.name || '').includes('Mk I') && (i.name || '').includes('King Single'));
  if (isMkIKS) return 0; // No commission on Mk I King Single
  const isCash = order.pay_type === 'c';
  // Use config commission tiers
  const tiers = configCache['commission'] && configCache['commission']['tiers']
    ? configCache['commission']['tiers']
    : { 1: 200, 5: 300, 10: 400 };
  // Single sale = lowest tier
  const baseComm = tiers[1] || 200;
  const cashBonus = isCash ? (configCache['commission']?.settings?.cash_bonus || 100) : 0;
  return baseComm + cashBonus;
}

function getCommissionPaid(order) {
  return getClawbackAmount(order);
}

async function applyClawback(orderId, consultantName, amount) {
  if (!sbClient) return;
  if (!confirm('Mark this clawback of $' + amount + ' as applied against ' + consultantName + "'s next commission run?")) return;

  await sbClient.from('orders').update({
    clawback_status: 'applied',
    clawback_applied_at: new Date().toISOString()
  }).eq('id', orderId);

  showToast('Clawback of $' + amount + ' applied ✓', 'success');
  loadClawbacks();
}

// ══════════════════════════════════════════════════════
// CONSULTANT SCORECARDS
// ══════════════════════════════════════════════════════

async function loadScorecards() {
  if (!sbClient) return;
  const container = document.getElementById('scorecard-container');
  if (container) container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">Loading...</div>';

  const filterConsultant = document.getElementById('scorecard-consultant-filter')?.value || '';

  // Date ranges
  const now = new Date();
  const nzNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const dayOfWeek = nzNow.getUTCDay();
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisWeekStart = new Date(nzNow);
  thisWeekStart.setUTCDate(nzNow.getUTCDate() - daysFromMon);
  thisWeekStart.setUTCHours(0,0,0,0);
  const thisWeekUTC = new Date(thisWeekStart.getTime() - 12*60*60*1000);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  const lastWeekUTC = new Date(lastWeekStart.getTime() - 12*60*60*1000);

  const fourWeeksAgo = new Date(thisWeekStart);
  fourWeeksAgo.setUTCDate(fourWeeksAgo.getUTCDate() - 28);
  const fourWeeksUTC = new Date(fourWeeksAgo.getTime() - 12*60*60*1000);

  // Fetch orders
  const { data: allOrders } = await sbClient
    .from('orders')
    .select('*')
    .gte('created_at', fourWeeksUTC.toISOString())
    .is('cancelled_at', null);

  // Fetch appointments (4 weeks)
  const fourWeeksDateStr = fourWeeksAgo.toISOString().split('T')[0];
  const { data: allAppts } = await sbClient
    .from('appointments')
    .select('*')
    .gte('appt_date', fourWeeksDateStr);

  const orders = allOrders || [];
  const appts = allAppts || [];

  // Get consultant list from config
  const consultants = configCache['staff']
    ? Object.values(configCache['staff']).filter((s) => s.active !== false).map((s) => s.name)
    : [...new Set(orders.map((o) => o.consultant).filter(Boolean))];

  // Populate filter dropdown
  const filterEl = document.getElementById('scorecard-consultant-filter');
  if (filterEl && filterEl.options.length <= 1) {
    consultants.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      filterEl.appendChild(opt);
    });
  }

  const targetConsultants = filterConsultant ? [filterConsultant] : consultants;

  // Build scorecard per consultant
  const scorecards = targetConsultants.map((name) => {
    const myOrders = orders.filter((o) => o.consultant === name);
    const thisWeek = myOrders.filter((o) => new Date(o.created_at) >= thisWeekUTC);
    const lastWeek = myOrders.filter((o) => new Date(o.created_at) >= lastWeekUTC && new Date(o.created_at) < thisWeekUTC);
    const fourWeeks = myOrders;

    const avgPerWeek = fourWeeks.length / 4;
    const thisWeekValue = thisWeek.reduce((s, o) => s + (o.total || 0), 0);
    const lastWeekValue = lastWeek.reduce((s, o) => s + (o.total || 0), 0);

    // Appointment stats this week
    const myAppts = appts.filter((a) => a.consultant === name);
    const thisWeekAppts = myAppts.filter((a) => a.appt_date >= thisWeekStart.toISOString().split('T')[0]);
    const presented = thisWeekAppts.filter((a) => a.status === 'presented' || a.outcome).length;
    const sold = thisWeekAppts.filter((a) => a.outcome === 'sold').length;
    const bookRate = thisWeekAppts.length > 0 ? Math.round(presented / thisWeekAppts.length * 100) : null;
    const closeRate = presented > 0 ? Math.round(sold / presented * 100) : null;

    // Trend arrow
    const trend = thisWeek.length > lastWeek.length ? '▲' : thisWeek.length < lastWeek.length ? '▼' : '→';
    const trendColour = thisWeek.length > lastWeek.length ? '#1a7a44' : thisWeek.length < lastWeek.length ? '#8a2222' : '#8a5500';

    // Award progress
    const staffData = configCache['staff'] && Object.values(configCache['staff']).find((s) => s.name === name);
    const awardLevel = staffData?.award_level || 'None';
    const awardIcons = { 'Initial':'🎖','Pearl':'🦪','Ruby':'❤️','Emerald':'💚','Sapphire':'💙','Grand Diamond':'💎' };
    const awardIcon = awardIcons[awardLevel] || '';

    // Award sales count = unique customers this week (by phone, fallback to name)
    // Commission is per mattress line but awards count one customer as one sale
    const thisWeekUniqueCustomers = new Set(thisWeek.map(o => o.phone || (o.fname + ' ' + o.lname))).size;
    const lastWeekUniqueCustomers = new Set(lastWeek.map(o => o.phone || (o.fname + ' ' + o.lname))).size;
    const fourWeekUniqueCustomers = new Set(fourWeeks.map(o => o.phone || (o.fname + ' ' + o.lname))).size;

    return { name, thisWeek: thisWeek.length, lastWeek: lastWeek.length, avgPerWeek,
      thisWeekAward: thisWeekUniqueCustomers, lastWeekAward: lastWeekUniqueCustomers, fourWeekAward: fourWeekUniqueCustomers,
      thisWeekValue, lastWeekValue, trend, trendColour,
      appts: thisWeekAppts.length, presented, sold, bookRate, closeRate,
      awardLevel, awardIcon };
  });

  // Sort by this week sales desc
  scorecards.sort((a, b) => b.thisWeek - a.thisWeek);

  if (!container) return;

  if (scorecards.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gm);font-size:13px">No consultant data found.</div>';
    return;
  }

  container.innerHTML = scorecards.map((s) => `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:17px;font-weight:700;color:var(--navy)">${s.name} ${s.awardIcon}</div>
          <div style="font-size:12px;color:var(--gm)">${s.awardLevel !== 'None' ? s.awardLevel + ' Award' : 'No award yet'}</div>
        </div>
        <div style="font-size:28px;font-weight:800;color:${s.trendColour}">${s.trend}</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
        <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:var(--navy)">${s.thisWeek}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Orders this wk</div>
          <div style="font-size:10px;color:var(--navy);font-weight:600;margin-top:2px">${s.thisWeekAward} customers</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:var(--gm)">${s.lastWeek}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Last week</div>
          <div style="font-size:10px;color:var(--gm);font-weight:600;margin-top:2px">${s.lastWeekAward} customers</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:var(--navy)">${s.avgPerWeek.toFixed(1)}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">4-wk avg</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:16px;font-weight:800;color:var(--navy)">$${s.thisWeekValue.toLocaleString('en-NZ')}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">This week $</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div style="background:var(--gl);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:700;color:var(--navy)">${s.appts}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Appts</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:700;color:var(--navy)">${s.presented}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Presented</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:700;color:${s.bookRate !== null ? (s.bookRate >= 70 ? '#1a7a44' : s.bookRate >= 50 ? '#8a5500' : '#8a2222') : 'var(--gm)'}">${s.bookRate !== null ? s.bookRate + '%' : '—'}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Book→Present</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:16px;font-weight:700;color:${s.closeRate !== null ? (s.closeRate >= 60 ? '#1a7a44' : s.closeRate >= 40 ? '#8a5500' : '#8a2222') : 'var(--gm)'}">${s.closeRate !== null ? s.closeRate + '%' : '—'}</div>
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600">Present→Sale</div>
        </div>
      </div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════
// CUSTOMER SEARCH
// ══════════════════════════════════════════════════════

let customerSearchTimer = null;

function searchCustomers(query) {
  clearTimeout(customerSearchTimer);
  const results = document.getElementById('customer-search-results');
  if (!query || query.trim().length < 2) {
    if (results) results.innerHTML = '<div style="text-align:center;padding:30px;color:var(--gm);font-size:13px">Start typing to search customers...</div>';
    return;
  }
  if (results) results.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gm);font-size:13px">Searching...</div>';
  customerSearchTimer = setTimeout(() => runCustomerSearch(query.trim()), 300);
}

async function runCustomerSearch(query) {
  if (!sbClient) return;
  const results = document.getElementById('customer-search-results');

  // Search across name, phone, email, address
  const { data, error } = await sbClient
    .from('orders')
    .select('*')
    .or(`fname.ilike.%${query}%,lname.ilike.%${query}%,phone.ilike.%${query}%,email.ilike.%${query}%,address.ilike.%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) {
    if (results) results.innerHTML = '<div style="color:var(--red);font-size:13px;padding:12px">Search error. Please try again.</div>';
    return;
  }

  if (data.length === 0) {
    if (results) results.innerHTML = '<div style="text-align:center;padding:30px;color:var(--gm);font-size:13px">No customers found matching "' + query + '"</div>';
    return;
  }

  const statusBadge = (o) => {
    if (o.cancelled_at) return o.cooling_off_cancel ? '<span class="badge b-amber">Cooling off</span>' : '<span class="badge b-red">Cancelled</span>';
    if (o.delivered_at) return '<span class="badge b-green">Delivered</span>';
    return '<span class="badge b-blue">Active</span>';
  };

  if (results) results.innerHTML = '<table class="dtable">' +
    '<tr><th>Customer</th><th>Phone</th><th>Email</th><th>Consultant</th><th>Sale</th><th>Date</th><th>Status</th><th></th></tr>' +
    data.map(o => '<tr>' +
      '<td><b>' + o.fname + ' ' + o.lname + '</b><div style="font-size:11px;color:var(--gm)">' + (o.address || '') + '</div></td>' +
      '<td style="font-size:12px">' + (o.phone || '-') + '</td>' +
      '<td style="font-size:12px">' + (o.email || '-') + '</td>' +
      '<td style="font-size:12px">' + (o.consultant || '-') + '</td>' +
      '<td style="font-size:12px;font-weight:600;color:var(--navy)">$' + (o.total || 0).toLocaleString('en-NZ') + '</td>' +
      '<td style="font-size:12px;color:var(--gm)">' + formatDate(o.created_at) + '</td>' +
      '<td>' + statusBadge(o) + '</td>' +
      '<td><button class="btn-outline btn-sm" onclick="showCustomerProfile(\'' + o.id + '\')">' + 'View</button></td>' +
    '</tr>').join('') +
    '</table><div style="font-size:12px;color:var(--gm);margin-top:8px">' + data.length + ' result' + (data.length !== 1 ? 's' : '') + ' found</div>';
}

// ══════════════════════════════════════════════════════
// CUSTOMER PROFILE & ORDER MANAGEMENT
// ══════════════════════════════════════════════════════

async function showCustomerProfile(orderId) {
  if (!sbClient) return;
  const { data: o } = await sbClient.from('orders').select('*').eq('id', orderId).single();
  if (!o) return;

  // Fetch manual payments for this order
  const { data: manPays } = await sbClient
    .from('manual_payments')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  const existing = document.getElementById('customer-profile-modal');
  if (existing) existing.remove();

  const statusText = o.cancelled_at ? (o.cooling_off_cancel ? 'Cooling-off cancellation' : 'Cancelled') : o.delivered_at ? 'Delivered' : 'Active — awaiting delivery';
  const statusColour = o.cancelled_at ? '#8a2222' : o.delivered_at ? '#1a7a44' : '#1e3a6e';
  const products = (o.items || []).map(i => i.name + (i.qty > 1 ? ' x' + i.qty : '')).join(', ') || 'No items recorded';

  // Loan calculations
  const loanTerm = o.loan_term_weeks || calcLoanTerm(o.items || []);
  const weeklyRep = o.weekly_rep || 0;
  const totalPaid_ezidebit = 0; // placeholder — would come from payments table
  const manualPaidTotal = (manPays || []).reduce((s, p) => s + (p.amount || 0), 0);
  const totalPaid = manualPaidTotal; // will grow as we hook in Ezidebit payments
  const balanceOwing = Math.max(0, (o.total || 0) - totalPaid);
  const weeksRemaining = weeklyRep > 0 ? Math.ceil(balanceOwing / weeklyRep) : loanTerm;
  const depositTarget = ((o.total || 0) * ((configCache['delivery']?.settings?.threshold_pct || 10) / 100));
  const depositMet = totalPaid >= depositTarget;

  // Payment holiday status
  const onHoliday = o.payment_holiday_weeks > 0;
  const holidayHtml = onHoliday
    ? `<div style="background:#fef3e2;border:1px solid #e08c10;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#8a5500">
        ⏸ Payment holiday active — ${o.payment_holiday_weeks} week${o.payment_holiday_weeks !== 1 ? 's' : ''} remaining
        ${o.payment_holiday_reason ? '<br><span style="color:var(--gm)">' + o.payment_holiday_reason + '</span>' : ''}
      </div>` : '';

  // Bank change flag
  const bankFlagHtml = o.bank_change_pending
    ? `<div style="background:#fdecea;border:1px solid #d63030;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#8a2222">
        ⚠️ Bank account change pending — new DDR authority required
      </div>` : '';

  // Manual payments history
  const manPayHtml = (manPays && manPays.length > 0)
    ? `<div style="background:var(--gl);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:8px">Manual payments recorded</div>
        ${manPays.map(p => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--navy)">${p.payment_type === 'lump_sum' ? 'Lump sum' : p.payment_type === 'partial' ? 'Partial payment' : 'Early payoff'} — ${p.note || ''}</span>
          <span style="font-weight:700;color:var(--green)">+$${(p.amount||0).toFixed(2)}</span>
        </div>`).join('')}
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;padding-top:6px;color:var(--navy)">
          <span>Total manual payments</span><span>$${manualPaidTotal.toFixed(2)}</span>
        </div>
      </div>` : '';

  // Admin-only manage button (only for active, non-cancelled orders)
  const manageBtn = (currentRole === 'admin' && !o.cancelled_at && !o.loan_completed_at)
    ? `<button onclick="showOrderManagement('${o.id}')" style="width:100%;padding:12px;margin-bottom:8px;background:var(--navy);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">⚙️ Manage order</button>`
    : '';

  const modal = document.createElement('div');
  modal.id = 'customer-profile-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.6);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px;width:100%;max-width:580px;box-shadow:0 4px 32px rgba(30,58,110,.18);margin:auto">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:20px;font-weight:700;color:var(--navy)">${o.fname} ${o.lname}</div>
          <div style="font-size:13px;color:var(--gm)">${o.address || 'No address recorded'}</div>
        </div>
        <span style="font-size:12px;font-weight:700;color:${statusColour};background:${statusColour}18;padding:4px 10px;border-radius:20px">${statusText}</span>
      </div>

      ${holidayHtml}${bankFlagHtml}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Phone</div>
          <div style="font-size:14px;font-weight:600;color:var(--navy)">${o.phone || '—'}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Email</div>
          <div style="font-size:13px;font-weight:600;color:var(--navy)">${o.email || '—'}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Total sale</div>
          <div style="font-size:18px;font-weight:700;color:var(--navy)">$${(o.total || 0).toLocaleString('en-NZ')}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Weekly payment</div>
          <div style="font-size:18px;font-weight:700;color:var(--navy)">$${weeklyRep.toFixed(2)}/wk</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Loan term</div>
          <div style="font-size:14px;font-weight:600;color:var(--navy)">${loanTermLabel(loanTerm)}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Balance owing</div>
          <div style="font-size:18px;font-weight:700;color:var(--navy)">$${balanceOwing.toLocaleString('en-NZ', {minimumFractionDigits:2})}</div>
        </div>
        <div style="background:${depositMet ? '#edfaf3' : '#fef3e2'};border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">10% deposit</div>
          <div style="font-size:14px;font-weight:700;color:${depositMet ? '#1a7a44' : '#8a5500'}">${depositMet ? '✓ Met' : 'Target: $' + depositTarget.toFixed(2)}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Weeks remaining</div>
          <div style="font-size:18px;font-weight:700;color:var(--navy)">${weeksRemaining}</div>
        </div>
      </div>

      <div style="background:var(--gl);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Products</div>
        <div style="font-size:13px;color:var(--navy)">${products}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Consultant</div>
          <div style="font-size:14px;font-weight:600;color:var(--navy)">${o.consultant || '—'}${o.reassigned_from ? '<div style="font-size:11px;color:var(--gm)">Reassigned from ' + o.reassigned_from + '</div>' : ''}</div>
        </div>
        <div style="background:var(--gl);border-radius:8px;padding:12px">
          <div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Order date</div>
          <div style="font-size:14px;font-weight:600;color:var(--navy)">${formatDate(o.created_at)}</div>
        </div>
      </div>

      ${manPayHtml}
      ${o.call_notes ? '<div style="background:var(--gl);border-radius:8px;padding:12px;margin-bottom:12px"><div style="font-size:10px;color:var(--gm);text-transform:uppercase;font-weight:600;margin-bottom:4px">Call notes</div><div style="font-size:13px;color:var(--navy)">' + o.call_notes + '</div></div>' : ''}

      ${manageBtn}
      ${!o.cancelled_at && !o.loan_completed_at ? '<button onclick="markLoanComplete(\'' + o.id + '\',\'' + o.fname + ' ' + o.lname + '\')" style="width:100%;padding:12px;margin-bottom:8px;background:#1a7a44;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">✓ Mark loan as fully paid off</button>' : ''}
      ${o.loan_completed_at ? '<div style="text-align:center;padding:10px;background:#edfaf3;border-radius:8px;margin-bottom:8px;font-size:13px;font-weight:600;color:#1a7a44">✓ Loan completed ' + formatDate(o.loan_completed_at) + '</div>' : ''}
      <button onclick="document.getElementById('customer-profile-modal').remove()" style="width:100%;padding:12px;background:var(--gl);border:none;border-radius:10px;font-size:14px;font-weight:600;color:var(--navy);cursor:pointer;font-family:inherit">Close</button>
    </div>`;
  document.body.appendChild(modal);
}

// ══════════════════════════════════════════════════════
// ORDER MANAGEMENT PANEL
// ══════════════════════════════════════════════════════

async function showOrderManagement(orderId) {
  if (!sbClient || currentRole !== 'admin') return;
  const { data: o } = await sbClient.from('orders').select('*').eq('id', orderId).single();
  if (!o) return;

  const existing = document.getElementById('order-mgmt-modal');
  if (existing) existing.remove();

  // Get consultant list for reassignment
  const consultants = configCache['staff']
    ? Object.values(configCache['staff']).filter(s => s.active !== false).map(s => s.name)
    : [];

  const modal = document.createElement('div');
  modal.id = 'order-mgmt-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(20,30,60,.7);z-index:2100;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:600px;box-shadow:0 4px 32px rgba(30,58,110,.22);margin:auto;overflow:hidden">

      <!-- Header -->
      <div style="background:var(--navy);padding:20px 24px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:17px;font-weight:700;color:#fff">⚙️ Manage Order</div>
          <div style="font-size:13px;color:var(--gm);margin-top:2px">${o.fname} ${o.lname}</div>
        </div>
        <button onclick="document.getElementById('order-mgmt-modal').remove()" style="background:rgba(255,255,255,.12);border:none;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:13px">✕ Close</button>
      </div>

      <div style="padding:24px;display:flex;flex-direction:column;gap:16px">

        <!-- SECTION: Manual Payment -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">💵 Record manual payment</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="flabel">Payment type</label>
                <select class="finput" id="mgmt-pay-type" style="margin-bottom:0">
                  <option value="lump_sum">Lump sum (toward deposit / balance)</option>
                  <option value="partial">Partial payment</option>
                  <option value="early_payoff">Full early payoff</option>
                </select>
              </div>
              <div>
                <label class="flabel">Amount ($)</label>
                <input class="finput" id="mgmt-pay-amount" type="number" min="1" step="0.01" placeholder="0.00" style="margin-bottom:0" />
              </div>
            </div>
            <div>
              <label class="flabel">Note (optional)</label>
              <input class="finput" id="mgmt-pay-note" type="text" placeholder="e.g. Cash received in store" style="margin-bottom:0" />
            </div>
            <div style="background:#fdf6e3;border-radius:8px;padding:10px 12px;font-size:12px;color:#554400;line-height:1.5">
              ⚠️ Note: the 5 consecutive Ezidebit payments rule applies separately. A lump sum shortens the loan term but does not count as one of the 5 consecutive payments.
            </div>
            <button onclick="recordManualPayment('${o.id}')" style="padding:11px;background:var(--navy);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Record payment</button>
          </div>
        </div>

        <!-- SECTION: Payment Holiday -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">⏸ Payment holiday</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            ${o.payment_holiday_weeks > 0 ? `<div style="background:#fef3e2;border-radius:8px;padding:10px 12px;font-size:13px;color:#8a5500">Currently on holiday: ${o.payment_holiday_weeks} week(s) — ${o.payment_holiday_reason || 'no reason recorded'}</div>` : ''}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="flabel">Freeze for (weeks)</label>
                <input class="finput" id="mgmt-holiday-weeks" type="number" min="1" max="26" placeholder="e.g. 4" value="${o.payment_holiday_weeks || ''}" style="margin-bottom:0" />
              </div>
              <div>
                <label class="flabel">Reason</label>
                <input class="finput" id="mgmt-holiday-reason" type="text" placeholder="e.g. Medical leave" value="${o.payment_holiday_reason || ''}" style="margin-bottom:0" />
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button onclick="savePaymentHoliday('${o.id}')" style="flex:1;padding:11px;background:var(--amber);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Save holiday</button>
              ${o.payment_holiday_weeks > 0 ? `<button onclick="clearPaymentHoliday('${o.id}')" style="padding:11px 16px;background:var(--gl);color:var(--navy);border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Clear</button>` : ''}
            </div>
          </div>
        </div>

        <!-- SECTION: Edit Customer Details -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">✏️ Edit customer details</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="flabel">First name</label>
                <input class="finput" id="mgmt-fname" type="text" value="${o.fname || ''}" style="margin-bottom:0" />
              </div>
              <div>
                <label class="flabel">Last name</label>
                <input class="finput" id="mgmt-lname" type="text" value="${o.lname || ''}" style="margin-bottom:0" />
              </div>
            </div>
            <div>
              <label class="flabel">Phone</label>
              <input class="finput" id="mgmt-phone" type="text" value="${o.phone || ''}" style="margin-bottom:0" />
            </div>
            <div>
              <label class="flabel">Email</label>
              <input class="finput" id="mgmt-email" type="text" value="${o.email || ''}" style="margin-bottom:0" />
            </div>
            <div>
              <label class="flabel">Address</label>
              <input class="finput" id="mgmt-address" type="text" value="${o.address || ''}" style="margin-bottom:0" />
            </div>
            <button onclick="saveCustomerDetails('${o.id}')" style="padding:11px;background:var(--navy);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Save details</button>
          </div>
        </div>

        <!-- SECTION: Ezidebit ID -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">🏦 Ezidebit Payer ID</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:12px;color:var(--gm);line-height:1.5">Enter the Payer ID exactly as shown in the Ezidebit portal once this customer's direct debit account is set up (format e.g. 558-998-400). This is what the settlement report import matches against — payments won't link to this customer without it.</div>
            <input class="finput" id="mgmt-ezidebit-id" type="text" placeholder="e.g. 558-998-400" value="${o.ezidebit_id || ''}" style="margin-bottom:0" />
            <button onclick="saveEzidebitId('${o.id}')" style="padding:11px;background:var(--navy);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Save Payer ID</button>
          </div>
        </div>

        <!-- SECTION: Bank Account Change -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">🏦 Bank account change</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="background:#fdf6e3;border-radius:8px;padding:12px;font-size:13px;color:#554400;line-height:1.7">
              <b>Steps to process a bank change:</b><br>
              1. Get customer to sign a new Ezidebit Direct Debit Request authority<br>
              2. Log into Ezidebit portal and update the customer's bank details<br>
              3. Confirm the change has been saved in Ezidebit<br>
              4. Click <b>Mark bank change complete</b> below to clear the flag
            </div>
            ${o.bank_change_pending
              ? `<div style="background:#fdecea;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:600;color:#8a2222">⚠️ Bank change currently flagged as pending</div>
                 <div style="display:flex;gap:8px">
                   <button onclick="setBankChangePending('${o.id}', false)" style="flex:1;padding:11px;background:#1a7a44;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">✓ Mark bank change complete</button>
                 </div>`
              : `<button onclick="setBankChangePending('${o.id}', true)" style="padding:11px;background:var(--amber);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Flag bank change in progress</button>`
            }
          </div>
        </div>

        <!-- SECTION: Reassign Consultant -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">👤 Reassign consultant</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:13px;color:var(--gm)">Currently assigned to: <b style="color:var(--navy)">${o.consultant || '—'}</b></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="flabel">Reassign to</label>
                <select class="finput" id="mgmt-reassign-to" style="margin-bottom:0">
                  <option value="">— Select consultant —</option>
                  ${consultants.filter(c => c !== o.consultant).map(c => `<option value="${c}">${c}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="flabel">Reason</label>
                <input class="finput" id="mgmt-reassign-reason" type="text" placeholder="e.g. Consultant left" style="margin-bottom:0" />
              </div>
            </div>
            <button onclick="reassignConsultant('${o.id}', '${o.consultant || ''}')" style="padding:11px;background:var(--navy);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Reassign</button>
          </div>
        </div>

        <!-- SECTION: Delivery / Collection -->
        <div style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden">
          <div style="background:var(--gl);padding:12px 16px;font-size:13px;font-weight:700;color:var(--navy);border-bottom:1px solid var(--border)">🚚 Delivery settings</div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div>
              <label class="flabel">Preferred delivery date</label>
              <input class="finput" id="mgmt-delivery-date" type="date" value="${o.preferred_delivery_date || ''}" style="margin-bottom:0" />
            </div>
            <button onclick="saveDeliveryDate('${o.id}')" style="padding:11px;background:var(--navy);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Update delivery date</button>
          </div>
        </div>

      </div>
    </div>`;
  document.body.appendChild(modal);
}

// ── Ezidebit settlement import ──

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Order Management Actions ──

async function saveEzidebitId(orderId) {
  const val = document.getElementById('mgmt-ezidebit-id')?.value.trim() || '';
  const { error } = await sbClient.from('orders').update({ ezidebit_id: val || null }).eq('id', orderId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Ezidebit Payer ID saved ✓', 'success');
}

async function importEzidebitPdf() {
  const input = document.getElementById('ezidebit-pdf-input');
  const file = input?.files?.[0];
  const resultEl = document.getElementById('ezidebit-import-result');
  if (!file) { showToast('Choose a PDF first', 'error'); return; }

  const btn = document.getElementById('ezidebit-import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing...';
  resultEl.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--gm);font-size:13px">Reading report and matching payments...</div></div>`;

  try {
    const base64 = await fileToBase64(file);
    const { data, error } = await sbClient.functions.invoke('ezidebit-pdf-import', {
      body: { file_base64: base64 }
    });

    if (error) {
      resultEl.innerHTML = `<div class="card"><div style="color:#8a2222;font-size:13px">Import failed: ${error.message}</div></div>`;
      return;
    }
    if (data?.error) {
      resultEl.innerHTML = `<div class="card"><div style="color:#8a2222;font-size:13px">Import failed: ${data.error}</div></div>`;
      return;
    }

    const unmatchedRows = (data.unmatched || []).map(r => `
      <tr>
        <td style="padding:8px;font-size:12px">${r.trans_date}</td>
        <td style="padding:8px;font-size:12px">${r.ezidebit_payer_id}</td>
        <td style="padding:8px;font-size:12px">${r.payer_name}</td>
        <td style="padding:8px;font-size:12px">${r.result}</td>
        <td style="padding:8px;font-size:12px;text-align:right">$${r.payment_amt.toFixed(2)}</td>
      </tr>`).join('');

    resultEl.innerHTML = `
      <div class="card">
        <div class="card-title">Import summary</div>
        <div class="metric-grid" style="margin-top:10px">
          <div class="mcard"><div class="mcard-label">Rows in report</div><div class="mcard-val">${data.total_rows}</div></div>
          <div class="mcard"><div class="mcard-label">Paid imported</div><div class="mcard-val" style="color:var(--green)">${data.paid_imported}</div></div>
          <div class="mcard"><div class="mcard-label">Failed imported</div><div class="mcard-val" style="color:#8a2222">${data.failed_imported}</div></div>
          <div class="mcard"><div class="mcard-label">Duplicates skipped</div><div class="mcard-val">${data.duplicates_skipped}</div></div>
        </div>
        ${data.errors?.length ? `<div style="margin-top:14px;background:#fdecea;border-radius:8px;padding:10px 12px;font-size:12px;color:#8a2222">${data.errors.length} row(s) hit an error — check Edge Function logs in Supabase.</div>` : ''}
      </div>
      ${data.unmatched?.length ? `
      <div class="card">
        <div class="card-title">⚠️ Unmatched — no order found with this Ezidebit Payer ID</div>
        <div class="card-sub">Add the Payer ID to the customer's order (Customer search → View → ⚙️ Manage order), then re-upload this same report — already-imported rows will be skipped automatically.</div>
        <table style="width:100%;border-collapse:collapse;margin-top:8px">
          <tr style="border-bottom:1.5px solid var(--border)">
            <th style="padding:8px;text-align:left;font-size:11px;color:var(--gm)">Date</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:var(--gm)">Payer ID</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:var(--gm)">Name</th>
            <th style="padding:8px;text-align:left;font-size:11px;color:var(--gm)">Result</th>
            <th style="padding:8px;text-align:right;font-size:11px;color:var(--gm)">Amount</th>
          </tr>
          ${unmatchedRows}
        </table>
      </div>` : ''}
    `;
  } catch (e) {
    resultEl.innerHTML = `<div class="card"><div style="color:#8a2222;font-size:13px">Import failed: ${e.message}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload & import';
  }
}

async function recordManualPayment(orderId) {
  const type = document.getElementById('mgmt-pay-type')?.value;
  const amount = parseFloat(document.getElementById('mgmt-pay-amount')?.value || '0');
  const note = document.getElementById('mgmt-pay-note')?.value.trim() || '';
  if (!amount || amount <= 0) { showToast('Please enter a valid amount', 'error'); return; }

  const { error } = await sbClient.from('manual_payments').insert([{
    order_id: orderId,
    amount,
    payment_type: type,
    note,
    recorded_by: currentUser?.email || 'admin'
  }]);

  if (error) { showToast('Error: ' + error.message, 'error'); return; }

  // If early payoff, mark loan complete
  if (type === 'early_payoff') {
    await sbClient.from('orders').update({ loan_completed_at: new Date().toISOString() }).eq('id', orderId);
    showToast('Early payoff recorded — loan marked complete ✓', 'success');
  } else {
    showToast('Payment of $' + amount.toFixed(2) + ' recorded ✓', 'success');
  }

  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function savePaymentHoliday(orderId) {
  const weeks = parseInt(document.getElementById('mgmt-holiday-weeks')?.value || '0');
  const reason = document.getElementById('mgmt-holiday-reason')?.value.trim() || '';
  if (!weeks || weeks < 1) { showToast('Please enter number of weeks', 'error'); return; }

  const { error } = await sbClient.from('orders').update({
    payment_holiday_weeks: weeks,
    payment_holiday_reason: reason,
    payment_holiday_start_date: new Date().toISOString().split('T')[0]
  }).eq('id', orderId);

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Payment holiday saved — ' + weeks + ' week(s) ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function clearPaymentHoliday(orderId) {
  if (!confirm('Clear the payment holiday for this customer?')) return;
  await sbClient.from('orders').update({
    payment_holiday_weeks: 0,
    payment_holiday_reason: null,
    payment_holiday_start_date: null
  }).eq('id', orderId);
  showToast('Payment holiday cleared ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function saveCustomerDetails(orderId) {
  const fname = document.getElementById('mgmt-fname')?.value.trim();
  const lname = document.getElementById('mgmt-lname')?.value.trim();
  const phone = document.getElementById('mgmt-phone')?.value.trim();
  const email = document.getElementById('mgmt-email')?.value.trim();
  const address = document.getElementById('mgmt-address')?.value.trim();
  if (!fname || !lname) { showToast('Name is required', 'error'); return; }

  const { error } = await sbClient.from('orders').update({ fname, lname, phone, email, address }).eq('id', orderId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Customer details updated ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function setBankChangePending(orderId, pending) {
  const { error } = await sbClient.from('orders').update({ bank_change_pending: pending }).eq('id', orderId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast(pending ? 'Bank change flagged — complete Ezidebit steps ✓' : 'Bank change marked complete ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function reassignConsultant(orderId, currentConsultant) {
  const newConsultant = document.getElementById('mgmt-reassign-to')?.value;
  const reason = document.getElementById('mgmt-reassign-reason')?.value.trim() || '';
  if (!newConsultant) { showToast('Please select a consultant', 'error'); return; }
  if (!confirm('Reassign this order from ' + currentConsultant + ' to ' + newConsultant + '?')) return;

  const { error } = await sbClient.from('orders').update({
    consultant: newConsultant,
    reassigned_from: currentConsultant,
    reassigned_reason: reason
  }).eq('id', orderId);

  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Order reassigned to ' + newConsultant + ' ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

async function saveDeliveryDate(orderId) {
  const date = document.getElementById('mgmt-delivery-date')?.value;
  const { error } = await sbClient.from('orders').update({ preferred_delivery_date: date || null }).eq('id', orderId);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Delivery date updated ✓', 'success');
  document.getElementById('order-mgmt-modal')?.remove();
  showCustomerProfile(orderId);
}

// ══════════════════════════════════════════════════════
// NO SALE CONTACTS
// ══════════════════════════════════════════════════════

let noSaleData = [];

async function loadNoSaleContacts() {
  if (!sbClient) return;

  const reasonFilter = document.getElementById('nosale-filter-reason')?.value || '';
  const consultantFilter = document.getElementById('nosale-filter-consultant')?.value || '';
  const searchVal = document.getElementById('nosale-search')?.value.toLowerCase() || '';

  let query = sbClient
    .from('appointments')
    .select('*')
    .eq('outcome', 'no_sale')
    .order('created_at', { ascending: false });

  if (reasonFilter) query = query.eq('no_sale_reason', reasonFilter);
  if (consultantFilter) query = query.eq('consultant', consultantFilter);

  const { data, error } = await query;
  if (error) return;

  // Filter by search
  noSaleData = (data || []).filter(a => {
    if (!searchVal) return true;
    return (a.customer_name || '').toLowerCase().includes(searchVal) ||
           (a.address || '').toLowerCase().includes(searchVal) ||
           (a.phone || '').toLowerCase().includes(searchVal);
  });

  // Metrics
  const total = data?.length || 0;
  const cantAfford = (data || []).filter(a => a.no_sale_reason === 'cant_afford').length;
  const didntLike = (data || []).filter(a => a.no_sale_reason === 'didnt_like').length;
  const other = (data || []).filter(a => a.no_sale_reason === 'other').length;

  const m = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  m('nosale-total', total);
  m('nosale-cant-afford', cantAfford);
  m('nosale-didnt-like', didntLike);
  m('nosale-other', other);

  // Populate consultant filter
  const consultantSelect = document.getElementById('nosale-filter-consultant');
  if (consultantSelect && consultantSelect.options.length <= 1) {
    const consultants = [...new Set((data || []).map(a => a.consultant).filter(Boolean))].sort();
    consultants.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      consultantSelect.appendChild(opt);
    });
  }

  // Render table
  const container = document.getElementById('nosale-list');
  if (!container) return;

  if (noSaleData.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--gm);font-size:13px">No no-sale contacts found.</div>';
    return;
  }

  const reasonLabel = { cant_afford: "Can't afford", didnt_like: "Didn't like", other: "Other" };

  const rows = noSaleData.map(function(a) {
    const dateStr = a.appt_date ? new Date(a.appt_date + 'T00:00:00').toLocaleDateString('en-NZ', { day:'numeric', month:'short', year:'numeric' }) : '-';
    const reason = reasonLabel[a.no_sale_reason] || a.no_sale_reason || '-';
    const rc = a.no_sale_reason === 'cant_afford' ? 'color:#8a5500' : a.no_sale_reason === 'didnt_like' ? 'color:#8a2222' : '';
    return '<tr>' +
      '<td style="font-size:12px;color:var(--gm)">' + dateStr + '</td>' +
      '<td><b>' + (a.customer_name || '-') + '</b></td>' +
      '<td style="font-size:12px">' + (a.phone || '-') + '</td>' +
      '<td style="font-size:12px;color:var(--gm)">' + (a.address || '-') + '</td>' +
      '<td style="font-size:12px">' + (a.consultant || '-') + '</td>' +
      '<td style="font-size:12px;font-weight:600;' + rc + '">' + reason + '</td>' +
      '<td style="font-size:12px;color:var(--gm)">' + (a.no_sale_notes || '-') + '</td>' +
      '</tr>';
  }).join('');
  container.innerHTML = '<table class="dtable"><tr><th>Date</th><th>Customer</th><th>Phone</th><th>Address</th><th>Consultant</th><th>Reason</th><th>Notes</th></tr>' + rows + '</table>';
}

function exportNoSaleContacts() {
  if (!noSaleData || noSaleData.length === 0) {
    showToast('No contacts to export', 'error');
    return;
  }

  const headers = ['Date', 'Customer Name', 'Phone', 'Address', 'Consultant', 'Reason', 'Notes'];
  const rows = noSaleData.map(a => [
    a.appt_date || '',
    a.customer_name || '',
    a.phone || '',
    a.address || '',
    a.consultant || '',
    a.no_sale_reason || '',
    (a.no_sale_notes || '').replace(/,/g, ' ')
  ]);

    const csv = [headers, ...rows].map(function(r){ return r.map(function(v){ return '"' + String(v).replace(/"/g,'""') + '"'; }).join(','); }).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `simtec_nosale_contacts_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${noSaleData.length} contacts ✓`, 'success');
}
