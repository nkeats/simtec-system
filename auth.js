/* ============================================================================
 * auth.js — Simtec shared login gate
 * ----------------------------------------------------------------------------
 * Add ONE line to any page you want protected, right AFTER the supabase-js
 * <script> tag, e.g.:
 *
 *   <script src="auth.js" data-roles="admin,manager,office"></script>
 *
 * - No data-roles  -> any logged-in user may view.
 * - data-roles=...  -> only those roles may view; others see "No access".
 * Not logged in     -> bounced to login.html.
 * Adds a Log out button to every protected page.
 * Do NOT add this to login.html or reset-password.html.
 * ==========================================================================*/
(function () {
  // Capture allowed roles from this script tag, and hide the page until auth clears
  var me = document.currentScript;
  window.__SIMTEC_ROLES__ = (me && me.dataset && me.dataset.roles)
    ? me.dataset.roles.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    : null;
  try {
    // Open the connections to Supabase and the CDN NOW, in parallel with the
    // rest of the page, rather than waiting until the first query. On mobile
    // data this saves the DNS + TLS handshake on every single page load.
    ['https://jvqjoenaungubpoegyvf.supabase.co', 'https://cdn.jsdelivr.net'].forEach(function (h) {
      ['preconnect', 'dns-prefetch'].forEach(function (rel) {
        var l = document.createElement('link');
        l.rel = rel; l.href = h; if (rel === 'preconnect') l.crossOrigin = '';
        (document.head || document.documentElement).appendChild(l);
      });
    });

    // The page still stays hidden until we know who you are — but a blank white
    // screen reads as "the app has frozen", which is what a consultant reported.
    // Show the Simtec mark instead so the wait looks like loading, not a fault.
    var st = document.createElement('style');
    st.id = 'simtec-auth-hide';
    st.textContent =
      'body{visibility:hidden !important}' +
      '#simtec-boot{visibility:visible !important;position:fixed;inset:0;z-index:2147483647;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
      'background:#f4f6fa;font:600 13px -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#6b7889}' +
      '#simtec-boot .mk{font:800 22px/1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;' +
      'color:#122347;letter-spacing:2px}' +
      '#simtec-boot .sp{width:26px;height:26px;border:3px solid #d7deea;border-top-color:#122347;' +
      'border-radius:50%;animation:simspin .8s linear infinite}' +
      '@keyframes simspin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(st);

    document.addEventListener('DOMContentLoaded', function () {
      if (document.getElementById('simtec-auth-hide') && !document.getElementById('simtec-boot')) {
        var d = document.createElement('div');
        d.id = 'simtec-boot';
        d.innerHTML = '<div class="mk">SIMTEC</div><div class="sp"></div><div>Loading\u2026</div>';
        document.body.appendChild(d);
      }
    });
  } catch (e) {}
})();

(async function () {
  var URL_ = "https://jvqjoenaungubpoegyvf.supabase.co";
  var KEY_ = "sb_publishable_J4MYTdJJyEaWe-GadpwdYA_upPT2rKw";

  function reveal() {
    var s = document.getElementById('simtec-auth-hide'); if (s) s.remove();
    var b = document.getElementById('simtec-boot'); if (b) b.remove();
  }

  // Shown when we genuinely cannot establish who the user is. Fails CLOSED —
  // the page content is never revealed — but gives a retry so a flaky
  // connection does not look like a broken app.
  function cannotVerify(why) {
    reveal();
    document.body.innerHTML =
      '<div style="max-width:440px;margin:90px auto;padding:0 20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;color:#1a2334">' +
      '<div style="font-size:24px;font-weight:800;color:#122347;letter-spacing:.5px">SIMTEC</div>' +
      '<h2 style="color:#122347;margin-top:22px">Can\u2019t check your sign-in</h2>' +
      '<p style="color:#6b7889">' + (why || '') + ' Please check your connection and try again.</p>' +
      '<p style="margin-top:18px"><a href="#" id="_simrt" style="color:#1c3363;font-weight:600">Try again</a></p></div>';
    var rt = document.getElementById('_simrt');
    if (rt) rt.onclick = function (e) { e.preventDefault(); location.reload(); };
  }
  var inFrame = (function () { try { return window.top !== window.self; } catch (e) { return true; } })();
  function toLogin() { if (inFrame) { reveal(); return; } location.replace('login.html'); }

  // wait briefly for the supabase library to be present
  var tries = 0;
  while (typeof supabase === 'undefined' && tries < 60) { await new Promise(function (r) { setTimeout(r, 40); }); tries++; }
  // If the library never arrived we cannot check who you are. Revealing the page
  // anyway would mean an unchecked page render whenever the CDN is slow or blocked,
  // so say so and offer a retry instead.
  if (typeof supabase === 'undefined') { cannotVerify('We could not load the sign-in check.'); return; }

  var _sb = supabase.createClient(URL_, KEY_);

  var sess = await _sb.auth.getSession();
  var session = sess && sess.data ? sess.data.session : null;
  if (!session) { toLogin(); return; }

  // load the user's profile (role + active flag)
  var prof = null, cacheKey = 'simtec_profile_' + session.user.id, fromCache = false;
  try {
    var cached = sessionStorage.getItem(cacheKey);
    if (cached) { prof = JSON.parse(cached); fromCache = true; }
  } catch (e) {}

  // profileKnown = the lookup actually completed, so "no row" means "genuinely has
  // no staff profile" rather than "we could not find out". The gate below relies on
  // being able to tell those two apart.
  var profileKnown = false;

  if (!prof) {
    try {
      var res = await _sb.from('profiles').select('role,active,consultant_name,full_name,email').eq('id', session.user.id).maybeSingle();
      profileKnown = !(res && res.error);
      prof = res.data;
      if (prof) { try { sessionStorage.setItem(cacheKey, JSON.stringify(prof)); } catch (e) {} }
    } catch (e) { profileKnown = false; }
  } else {
    profileKnown = true;
    // re-check quietly; if anything important changed, take the page back
    _sb.from('profiles').select('role,active,consultant_name,full_name,email').eq('id', session.user.id).maybeSingle()
      .then(function (r) {
        var fresh = r && r.data; if (!fresh) return;
        try { sessionStorage.setItem(cacheKey, JSON.stringify(fresh)); } catch (e) {}
        if (fresh.active === false || fresh.role !== prof.role) location.reload();
      })
      .catch(function () {});
  }
  // ONLY a definitely-disabled account gets bounced. A missing profile or a read
  // error must NOT sign you out — that could cause a login loop.
  if (prof && prof.active === false) { await _sb.auth.signOut(); toLogin(); return; }

  var role = (prof && prof.role) ? prof.role : null;
  window.SIMTEC_USER = {
    id: session.user.id,
    email: (prof && prof.email) || session.user.email,
    role: role,
    consultant_name: (prof && prof.consultant_name) || null,
    full_name: (prof && prof.full_name) || null
  };
  window.SIMTEC_SB = _sb;

  // Role gate.
  //
  // ⚠ 9 Aug: this used to read `if (role && ...)`, so a NULL role skipped the gate
  // entirely. Every Games App customer is a signed-in user with NO profiles row and
  // therefore a null role, which meant a customer could open any office page in the
  // System. Same shape as the null-is-not-false bug found in the SQL guards.
  //
  // Now: a page that declares data-roles admits you only if your role is on the list.
  // No role + we know it (profileKnown) => denied. A failed lookup still lets you
  // through, so a network blip cannot lock staff out mid-shift — the database is the
  // real gate underneath either way.
  var allowed = window.__SIMTEC_ROLES__;
  var denied = Array.isArray(allowed) && (
    role ? allowed.indexOf(role) === -1
         : profileKnown
  );
  if (denied) {
    reveal();
    // A user with no staff role is a Games App customer — send them to the rewards
    // app, not to home.html, which would just be another "No access" screen.
    var landing = !role ? 'rewards.html'
      : (role === 'consultant' ? 'my-sales.html'
      : (role === 'matt' ? 'matt.html'
      : (role === 'driver' ? 'driver-day.html'
      : (role === 'warehouse' ? 'timesheet.html' : 'home.html'))));
    document.body.innerHTML =
      '<div style="max-width:440px;margin:90px auto;padding:0 20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;color:#1a2334">' +
      '<div style="font-size:24px;font-weight:800;color:#122347;letter-spacing:.5px">SIMTEC</div>' +
      '<h2 style="color:#122347;margin-top:22px">No access</h2>' +
      '<p style="color:#6b7889">Your account doesn\u2019t have permission for this page.</p>' +
      '<p style="margin-top:18px"><a href="' + landing + '" style="color:#1c3363;font-weight:600">Back to your home</a>' +
      ' &nbsp;·&nbsp; <a href="#" id="_simlo" style="color:#1c3363;font-weight:600">Log out</a></p></div>';
    var lo = document.getElementById('_simlo');
    if (lo) lo.onclick = async function (e) { e.preventDefault(); await _sb.auth.signOut(); toLogin(); };
    return;
  }

  // inject a Log out button
  function addLogout() {
    if (document.getElementById('simtec-logout')) return;
    // style: top-right on wide screens; bottom-right on phones so it never
    // sits on top of a page's own top navigation (e.g. diary/back buttons).
    if (!document.getElementById('simtec-logout-css')) {
      var st = document.createElement('style');
      st.id = 'simtec-logout-css';
      st.textContent =
        '#simtec-logout{position:fixed;top:10px;right:12px;bottom:auto;z-index:99999;' +
        'background:#c6a15b;color:#122347;border:none;border-radius:7px;padding:7px 15px;' +
        'font:700 12.5px -apple-system,Segoe UI,Roboto,Arial,sans-serif;cursor:pointer;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.28)}' +
        '@media(max-width:640px){#simtec-logout{top:auto;bottom:14px;right:14px;' +
        'border-radius:22px;padding:9px 16px;box-shadow:0 3px 12px rgba(0,0,0,.35)}}' +
        '@media print{#simtec-logout{display:none!important}}';
      document.head.appendChild(st);
    }
    var b = document.createElement('button');
    b.id = 'simtec-logout';
    b.textContent = 'Log out';
    b.title = window.SIMTEC_USER.email + ' (' + (role || 'no role') + ')';
    b.onclick = async function () { b.disabled = true; await _sb.auth.signOut(); toLogin(); };
    document.body.appendChild(b);
    keepLogoutClear();
  }

  /* -------------------------------------------------------------------------
     The Log out button is fixed to a corner and floats above everything, so it
     can cover a page's own buttons — it has done exactly that before, on the
     Sales App diary button, and a survey on 10 Aug found ten more pages at risk.
     Patching each page is whack-a-mole: the next page anyone builds starts the
     problem again.

     So instead of trusting every page to leave the corner free, this MEASURES.
     If the button is genuinely covering something you could tap, the page's own
     bar is padded until it isn't. If nothing is in the way, nothing changes.
     Works on pages that draw themselves later, and after a rotate or resize.
  ------------------------------------------------------------------------- */
  function keepLogoutClear() {
    var btn = document.getElementById('simtec-logout');
    if (!btn) return;

    var GAP = 10;                       // breathing room around the button
    var box = btn.getBoundingClientRect();
    if (!box.width) return;
    var zone = { left: box.left - GAP, right: box.right + GAP,
                 top: box.top - GAP,  bottom: box.bottom + GAP };

    var hits = document.querySelectorAll('button,a,input,select,label,[onclick],[role="button"]');
    for (var i = 0; i < hits.length; i++) {
      var el = hits[i];
      if (el === btn || el.closest('#simtec-logout')) continue;
      if (el.dataset && el.dataset.simtecShifted) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;                       // hidden
      if (r.right <= zone.left || r.left >= zone.right) continue; // clear across
      if (r.bottom <= zone.top || r.top >= zone.bottom) continue; // clear down

      // Something tappable is underneath. Push the bar it lives in out of the way.
      var bar = el, hops = 0;
      while (bar && bar !== document.body && hops < 6) {
        var w = bar.getBoundingClientRect().width;
        if (w > window.innerWidth * 0.6) break;   // wide enough to be the bar
        bar = bar.parentElement; hops++;
      }
      var target = (bar && bar !== document.body) ? bar : el;
      var need = Math.ceil(box.width + GAP * 2);
      var cur  = parseInt(window.getComputedStyle(target).paddingRight, 10) || 0;
      if (cur < need) {
        target.style.paddingRight = need + 'px';
        target.style.boxSizing = 'border-box';
      }
      if (target === el) el.dataset.simtecShifted = '1';
      return keepLogoutClear();                   // re-measure; layout has moved
    }
  }

  // Pages draw themselves at different moments, so check a few times, on resize,
  // and whenever the page adds something new.
  if (!inFrame) {
    var _t = null, _recheck = function () {
      clearTimeout(_t); _t = setTimeout(keepLogoutClear, 250);
    };
    [300, 1000, 2500, 5000].forEach(function (ms) { setTimeout(keepLogoutClear, ms); });
    window.addEventListener('resize', _recheck);
    window.addEventListener('orientationchange', _recheck);
    if (window.MutationObserver && document.body) {
      new MutationObserver(_recheck).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (!inFrame) { if (document.body) addLogout(); else document.addEventListener('DOMContentLoaded', addLogout); }

  reveal();
})();
