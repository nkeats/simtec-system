/* ============================================================================
 * auth.js — Simtec shared login gate
 * ----------------------------------------------------------------------------
 * Add ONE line to any page you want protected, right AFTER the supabase-js
 * <script> tag, e.g.:
 *   <script src="auth.js" data-roles="admin,manager,office"></script>
 * - No data-roles  -> any logged-in user may view.
 * - data-roles=...  -> only those roles may view; others see "No access".
 * Not logged in     -> bounced to login.html.  Adds a Log out button.
 * Do NOT add this to login.html or reset-password.html.
 * ==========================================================================*/
(function () {
  var me = document.currentScript;
  window.__SIMTEC_ROLES__ = (me && me.dataset && me.dataset.roles)
    ? me.dataset.roles.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    : null;
  try {
    var st = document.createElement('style');
    st.id = 'simtec-auth-hide';
    st.textContent = 'body{visibility:hidden !important}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
})();

(async function () {
  var URL_ = "https://jvqjoenaungubpoegyvf.supabase.co";
  var KEY_ = "sb_publishable_J4MYTdJJyEaWe-GadpwdYA_upPT2rKw";

  function reveal() { var s = document.getElementById('simtec-auth-hide'); if (s) s.remove(); }
  function toLogin() { location.replace('login.html'); }

  var tries = 0;
  while (typeof supabase === 'undefined' && tries < 60) { await new Promise(function (r) { setTimeout(r, 40); }); tries++; }
  if (typeof supabase === 'undefined') { reveal(); return; }

  var _sb = supabase.createClient(URL_, KEY_);

  var sess = await _sb.auth.getSession();
  var session = sess && sess.data ? sess.data.session : null;
  if (!session) { toLogin(); return; }

  var prof = null;
  try {
    var res = await _sb.from('profiles').select('role,active,consultant_name,full_name,email').eq('id', session.user.id).maybeSingle();
    prof = res.data;
  } catch (e) {}
  if (!prof || prof.active === false) { await _sb.auth.signOut(); toLogin(); return; }

  var role = prof.role || 'office';
  window.SIMTEC_USER = {
    id: session.user.id,
    email: prof.email || session.user.email,
    role: role,
    consultant_name: prof.consultant_name || null,
    full_name: prof.full_name || null
  };
  window.SIMTEC_SB = _sb;

  var allowed = window.__SIMTEC_ROLES__;
  if (Array.isArray(allowed) && allowed.indexOf(role) === -1) {
    reveal();
    document.body.innerHTML =
      '<div style="max-width:440px;margin:90px auto;padding:0 20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;color:#1a2334">' +
      '<div style="font-size:24px;font-weight:800;color:#122347;letter-spacing:.5px">SIMTEC</div>' +
      '<h2 style="color:#122347;margin-top:22px">No access</h2>' +
      '<p style="color:#6b7889">Your account doesn\u2019t have permission for this page.</p>' +
      '<p style="margin-top:18px"><a href="home.html" style="color:#1c3363;font-weight:600">Back to home</a>' +
      ' &nbsp;·&nbsp; <a href="#" id="_simlo" style="color:#1c3363;font-weight:600">Log out</a></p></div>';
    var lo = document.getElementById('_simlo');
    if (lo) lo.onclick = async function (e) { e.preventDefault(); await _sb.auth.signOut(); toLogin(); };
    return;
  }

  function addLogout() {
    if (document.getElementById('simtec-logout')) return;
    var b = document.createElement('button');
    b.id = 'simtec-logout';
    b.textContent = 'Log out';
    b.title = window.SIMTEC_USER.email + ' (' + role + ')';
    b.style.cssText = 'position:fixed;top:10px;right:12px;z-index:99999;background:#122347;color:#fff;border:1px solid #c6a15b;border-radius:7px;padding:6px 13px;font:600 12px -apple-system,Segoe UI,Roboto,Arial,sans-serif;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)';
    b.onclick = async function () { b.disabled = true; await _sb.auth.signOut(); toLogin(); };
    document.body.appendChild(b);
  }
  if (document.body) addLogout(); else document.addEventListener('DOMContentLoaded', addLogout);

  reveal();
})();
