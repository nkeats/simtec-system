/* ============================================================
   SIMTEC — live.js
   Keeps every open screen honest.

   A page that includes this file just declares what to do when something
   it cares about changes:

       window.SIMTEC_RELOAD = function(reason){ load(); };

   and this module calls it whenever:
     * Postgres tells us a relevant row changed (Supabase Realtime),
     * the tab regains focus (someone switched back from another screen),
     * or 60 seconds pass while the tab is visible (belt and braces —
       realtime can drop a connection without saying so).

   Why all three: relying on a person to press refresh is how a cancelled
   customer stays sitting in the arrears list, and how somebody chases a
   debt that no longer exists.
   ============================================================ */
(function () {
  "use strict";

  // The tables whose changes affect what any screen displays.
  var TABLES = [
    "sim_orders",       // cancel, reinstate, schedule, contract value, delivery
    "sim_order_items",  // amendments, per-item delivery and cancellation
    "sim_payments",     // the daily import
    "sim_dishonours"
  ];

  var POLL_MS   = 60000;   // visible-tab safety net
  var DEBOUNCE  = 1200;    // a burst of row changes should cause ONE reload

  var timer = null;
  var lastRun = 0;
  var started = false;

  // Tell the office (client-errors.js) when this can. Pages without the helper
  // behave exactly as before — the console is all they get.
  function report(attempting, err) {
    try { if (typeof window.reportClientError === "function") window.reportClientError(attempting, err); }
    catch (e) {}
  }

  function reload(reason) {
    if (typeof window.SIMTEC_RELOAD !== "function") return;
    var now = Date.now();
    if (now - lastRun < DEBOUNCE) {           // coalesce bursts
      clearTimeout(timer);
      timer = setTimeout(function () { reload(reason); }, DEBOUNCE);
      return;
    }
    lastRun = now;
    try { window.SIMTEC_RELOAD(reason); }
    catch (e) { console.error("SIMTEC live reload failed:", e); report("redraw the screen after a change (" + reason + ")", e); }
  }

  // A quiet note, bottom-right, so the person knows the screen moved under them.
  function toast(msg) {
    var el = document.getElementById("simtecLiveToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "simtecLiveToast";
      el.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:9999;background:#122347;color:#fff;" +
        "border:1px solid #c6a15b;border-radius:9px;padding:9px 14px;font-size:13px;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .25s";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = "0"; }, 2600);
  }
  window.SIMTEC_TOAST = toast;


  /* ---------------------------------------------------------------
     A new order is the one event the whole office wants to know about,
     wherever they happen to be looking. It lived on two pages; it belongs
     here, so every screen that loads live.js announces it the same way.

     Sound needs a click first (browser rule), so the switch stays on the
     home page and the preference is shared through localStorage.
     --------------------------------------------------------------- */
  var AC = null;
  function soundOn() { try { return localStorage.getItem("simtec_order_sound") === "on"; } catch (e) { return false; } }
  function wakeAudio() {
    if (!soundOn()) return false;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === "suspended") AC.resume();
      return AC.state === "running";
    } catch (e) { return false; }
  }
  function chime() {
    if (!wakeAudio()) return;
    [[880, 0], [1174.7, 0.16], [1567.9, 0.32]].forEach(function (n) {
      var o = AC.createOscillator(), g = AC.createGain();
      o.type = "sine"; o.frequency.value = n[0];
      g.gain.setValueAtTime(0.0001, AC.currentTime + n[1]);
      g.gain.exponentialRampToValueAtTime(0.25, AC.currentTime + n[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + n[1] + 0.42);
      o.connect(g); g.connect(AC.destination);
      o.start(AC.currentTime + n[1]); o.stop(AC.currentTime + n[1] + 0.45);
    });
  }
  document.addEventListener("click", function () { wakeAudio(); }, { once: true });

  var TITLE_TIMER = null;
  function flashTitle(name) {
    var original = document.title, on = true;
    clearTimeout(TITLE_TIMER);
    TITLE_TIMER = setInterval(function () {
      document.title = on ? "\uD83D\uDD14 NEW ORDER \u2014 " + name : original;
      on = !on;
    }, 900);
    var stop = function () {
      clearInterval(TITLE_TIMER); document.title = original;
      window.removeEventListener("focus", stop); document.removeEventListener("click", stop);
    };
    window.addEventListener("focus", stop); document.addEventListener("click", stop);
  }

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  }

  function newOrderBanner(o) {
    var c = (o && o.sim_customers) || {};
    var name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "New customer";
    var b = document.getElementById("simtecNewOrder");
    if (!b) {
      b = document.createElement("div");
      b.id = "simtecNewOrder";
      b.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:10000;background:#1c6b34;color:#fff;" +
        "padding:14px 18px;display:flex;align-items:center;gap:14px;" +
        "box-shadow:0 3px 14px rgba(0,0,0,.3);" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
      document.body.appendChild(b);
    }
    var here = /confirmation\.html/i.test(location.pathname);
    // Dismiss sits on the far LEFT, on its own, so it cannot be hit by someone
    // reaching for "Open confirmation calls" on the right.
    // ⚠ Every property that decides size and position is set INLINE. This
    //   banner is injected into 18 different pages, five of which carry a
    //   global button{} rule; one page's stylesheet must not reshape it.
    var ctl = 'font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;margin:0;width:auto;' +
              'display:inline-block;box-sizing:border-box;flex:0 0 auto;white-space:nowrap;';
    b.innerHTML =
      '<button onclick="this.parentNode.remove()" style="' + ctl + 'background:transparent;border:1px solid #fff;color:#fff;' +
      'border-radius:8px;padding:9px 14px;cursor:pointer">Dismiss</button>' +
      '<div style="font-size:24px">\uD83D\uDECF\uFE0F</div>' +
      '<div style="flex:1"><div style="font-weight:800;font-size:16px">New order \u2014 ' + esc(name) + "</div>" +
      '<div style="font-size:13px;opacity:.9">' + esc(c.suburb || "") +
        (o && o.consultant_name ? " \u00B7 " + esc(o.consultant_name) : "") +
        " \u00B7 needs a confirmation call</div></div>" +
      (here ? "" :
        '<a href="confirmation.html" style="' + ctl + 'background:#fff;color:#1c6b34;border-radius:8px;padding:9px 16px;' +
        'font-weight:700;text-decoration:none">Open confirmation calls</a>');
    chime();
    flashTitle(name);
  }

  /* ---------------------------------------------------------------
     SALES IN PROGRESS — 9 Oct 2026. [stated] Nigel: "can we have it trigger
     earlier with a message like 'Confirmation call needed soon, waiting on ED'
     and then another saying call now when the rest of the application is done".

     ⚠ WHY THIS IS AMBER, SILENT AND SAYS "DON'T CALL YET". The green banner used
       to fire on INSERT and the office rang customers while the consultant was
       still sitting with them. So this strip never chimes, and it says plainly
       not to call. The green banner + chime (below) still mean "call now".
     ⚠ BUILT FROM THE DATABASE, NOT FROM EVENTS. Every sale still at 'draft' is
       listed, so a screen opened or refreshed mid-sale still shows it, and it
       goes the moment the sale is finished (pending) or cancelled.
     ⚠ RED AT 30 MINUTES — the same moment stuck_orders_to_alert() texts the
       office. Measured: finished sales go from saved to Done in under 7 minutes.
       Kiri Manga (PJ, 9 Oct) stalled at Ezidebit and nobody knew; two August
       sales had sat at draft for six weeks.
     --------------------------------------------------------------- */
  var STUCK_MIN = 30;
  var IP = { rows: [], dismissedKey: null, client: null, failed: false };

  function ipName(o) {
    var c = (o && o.sim_customers) || {};
    return [c.first_name, c.last_name].filter(Boolean).join(" ") || "New customer";
  }
  function ipMinutes(o) { return Math.max(0, Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000)); }
  function ipAge(m) {
    if (m < 60) return m + " min";
    if (m < 2880) return Math.floor(m / 60) + " hr";
    return Math.floor(m / 1440) + " days";
  }

  function renderInProgress() {
    var el = document.getElementById("simtecInProgress");
    var rows = IP.rows || [];
    if (!rows.length) { if (el) el.remove(); return; }
    var stuck = rows.filter(function (o) { return ipMinutes(o) >= STUCK_MIN; });
    var key = rows.map(function (o) { return o.id; }).sort().join(",") + "|" + stuck.length;
    if (IP.dismissedKey === key) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "simtecInProgress";
      document.body.appendChild(el);
    }
    var red = stuck.length > 0;
    // ⚠ Every property that decides size and position is set INLINE, for the same
    //   reason as the green banner: this lands on 18 pages with different CSS.
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;color:#fff;padding:9px 18px;" +
      "display:flex;align-items:center;gap:14px;box-shadow:0 3px 12px rgba(0,0,0,.25);" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "background:" + (red ? "#b4342e" : "#a86a12");
    var ctl = 'font-family:inherit;font-size:13px;font-weight:600;line-height:1.2;margin:0;width:auto;' +
              'display:inline-block;box-sizing:border-box;flex:0 0 auto;white-space:nowrap;';
    var lines = rows.slice(0, 4).map(function (o) {
      var m = ipMinutes(o), who = esc(ipName(o)) + " (" + esc(o.consultant_name || "no consultant") + ")";
      if (m >= STUCK_MIN) return "<b>" + who + "</b> not finished after " + ipAge(m) + " — ring the consultant";
      var stage = (o.ezidebit_payer_ref || o.ezidebit_customer_id) ? "finishing the application" : "waiting on Ezidebit";
      return "<b>" + who + "</b> · " + stage + " · " + ipAge(m);
    });
    if (rows.length > 4) lines.push("and " + (rows.length - 4) + " more");
    var head = red
      ? (stuck.length === 1 ? "Sale not finished" : stuck.length + " sales not finished")
      : (rows.length === 1 ? "Sale in progress — confirmation call needed soon. Don’t call yet."
                           : rows.length + " sales in progress — confirmation calls needed soon. Don’t call yet.");
    el.innerHTML =
      '<button type="button" id="simtecInProgressX" style="' + ctl + 'background:transparent;border:1px solid #fff;color:#fff;' +
      'border-radius:8px;padding:6px 12px;cursor:pointer">Dismiss</button>' +
      '<div style="flex:1;font-size:13px;line-height:1.35"><div style="font-weight:800;font-size:14px">' + head + "</div>" +
      lines.join("<br>") + "</div>";
    document.getElementById("simtecInProgressX").onclick = function () { IP.dismissedKey = key; el.remove(); };
  }

  function refreshInProgress() {
    var sb = IP.client;
    if (!sb || IP.failed) return;
    sb.from("sim_orders")
      .select("id, created_at, consultant_name, ezidebit_payer_ref, ezidebit_customer_id, sim_customers(first_name,last_name)")
      .eq("confirmation_status", "draft")
      .is("cancelled_at", null)
      .order("created_at", { ascending: true })
      .then(function (r) {
        if (r && r.error) {
          // A page whose user cannot read orders simply shows nothing — report once.
          IP.failed = true;
          report("read the sales in progress for the amber banner", r.error);
          return;
        }
        IP.rows = (r && r.data) || [];
        renderInProgress();
      })
      .catch(function (e) { report("read the sales in progress for the amber banner", e); });
  }

  function subscribe(sb) {
    if (started) return;
    started = true;
    IP.client = sb;
    refreshInProgress();
    setInterval(function () { if (!document.hidden) refreshInProgress(); }, 30000);   // minutes tick, and the poll safety net

    var ch = sb.channel("simtec-live-" + Math.random().toString(36).slice(2, 8));

    /* A FINISHED order: announce it, don't just quietly refresh.
       This used to fire on INSERT — but the Sales App has to save the order
       row before the Ezidebit step, so the office was being told about a sale
       the consultant was still in the middle of, and the confirmation call was
       going out while they were sitting with the customer. The Sales App now
       saves as 'draft' and promotes to 'pending' at the Done step, so THAT is
       what we listen for. Office-keyed orders carry no confirmation status and
       are deliberately not announced, exactly as before. */
    var announced = {};
    function maybeAnnounce(row) {
      if (!row || !row.id) return;
      if (row.confirmation_status !== "pending") return;
      if (announced[row.id]) return;          // one announcement per order, per screen
      announced[row.id] = true;
      sb.from("sim_orders").select("*, sim_customers(*)").eq("id", row.id).maybeSingle()
        .then(function (r) {
          if (r && r.error) report("read the new order for the banner (shown without a name)", r.error);
          newOrderBanner((r && r.data) || { sim_customers: {} });
        })
        .catch(function (e) { report("read the new order for the banner (shown without a name)", e); newOrderBanner({ sim_customers: {} }); });
    }
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "sim_orders" }, function (p) {
      maybeAnnounce(p && p.new);
      refreshInProgress();
    });
    ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "sim_orders" }, function (p) {
      maybeAnnounce(p && p.new);
      refreshInProgress();
    });

    TABLES.forEach(function (t) {
      ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () {
        reload("realtime:" + t);
        toast("Updated — data changed elsewhere");
      });
    });
    ch.subscribe(function (status, err) {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        // Don't pretend it's fine. The poll below still covers us — but the
        // new-order banner does NOT come from the poll, so the office must
        // hear that it is not going to appear.
        console.warn("SIMTEC live: realtime unavailable (" + status + "). Falling back to polling.");
        report("keep the live connection open (new-order banner will not appear): " + status, err || status);
      }
    });
  }

  // auth.js sets window.SIMTEC_SB asynchronously; wait for it rather than racing.
  function waitForClient(tries) {
    if (window.SIMTEC_SB) { subscribe(window.SIMTEC_SB); return; }
    if (typeof sb !== "undefined" && sb && sb.channel) { subscribe(sb); return; }
    if (tries <= 0) {
      console.warn("SIMTEC live: no Supabase client found. Focus and poll refresh still active.");
      report("find a Supabase client for live updates (no realtime, no new-order banner)",
             "neither SIMTEC_SB nor sb existed after 9 seconds");
      return;
    }
    setTimeout(function () { waitForClient(tries - 1); }, 150);
  }

  // Someone cancelled a customer in another tab, then switched back to this one.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { reload("visible"); refreshInProgress(); }
  });
  window.addEventListener("focus", function () { reload("focus"); });

  // Safety net: a dropped websocket must not leave a screen frozen and wrong.
  setInterval(function () {
    if (!document.hidden) reload("poll");
  }, POLL_MS);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { waitForClient(60); });
  } else {
    waitForClient(60);
  }
})();
