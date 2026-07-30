/* doubtful.js — shared "unlikely to collect" flag.
   Any office user can tick it on a customer/arrears/risk screen. It is stored on
   the ORDER (sim_orders.doubtful) so it shows as a red ✗ wherever that order
   appears, and feeds the admin-only Real Debt Book page (debt-book.html).
   Ticking here changes NOTHING about how the client is chased — it is purely a
   provisioning flag. Include this file after the Supabase library on any page. */
(function () {
  var SB = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(
        "https://jvqjoenaungubpoegyvf.supabase.co",
        "sb_publishable_J4MYTdJJyEaWe-GadpwdYA_upPT2rKw")
    : null;

  function who () {
    try { return (window.SIMTEC_USER && (window.SIMTEC_USER.full_name || window.SIMTEC_USER.email)) || null; }
    catch (e) { return null; }
  }

  // Red ✗ badge shown wherever a flagged customer appears.
  function badge (on) {
    return on
      ? '<span class="dbtf-x" title="Flagged: unlikely to collect" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:#fdecec;color:#c02626;font-weight:800;font-size:13px;line-height:1;vertical-align:middle;margin-left:6px">&#10007;</span>'
      : '';
  }

  // A ready-made checkbox + adjacent badge. Ticking saves and updates the badge live.
  function toggleHtml (orderId, on) {
    var esc = String(orderId).replace(/'/g, "");
    return '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#5b6675;cursor:pointer;user-select:none">'
      + '<input type="checkbox" ' + (on ? 'checked' : '')
      + ' onchange="DOUBTFUL.save(\'' + esc + '\',this.checked);var b=document.getElementById(\'dbtfx_' + esc + '\');if(b)b.innerHTML=DOUBTFUL.badge(this.checked)">'
      + 'Unlikely to collect</label>'
      + '<span id="dbtfx_' + esc + '">' + badge(on) + '</span>';
  }

  // Persist the flag (with who/when). Returns a promise.
  function save (orderId, on) {
    if (!SB) { alert("Not connected — please refresh."); return Promise.reject("no client"); }
    var patch = on
      ? { doubtful: true,  doubtful_at: new Date().toISOString(), doubtful_by: who() }
      : { doubtful: false, doubtful_at: null, doubtful_by: null };
    return SB.from("sim_orders").update(patch).eq("id", orderId).then(function (r) {
      if (r.error) { alert("Couldn't save the flag: " + r.error.message); throw r.error; }
      return true;
    });
  }

  window.DOUBTFUL = { badge: badge, toggleHtml: toggleHtml, save: save };
})();
