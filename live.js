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
    catch (e) { console.error("SIMTEC live reload failed:", e); }
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
    b.innerHTML =
      '<div style="font-size:24px">\uD83D\uDECF\uFE0F</div>' +
      '<div style="flex:1"><div style="font-weight:800;font-size:16px">New order \u2014 ' + esc(name) + "</div>" +
      '<div style="font-size:13px;opacity:.9">' + esc(c.suburb || "") +
        (o && o.consultant_name ? " \u00B7 " + esc(o.consultant_name) : "") +
        " \u00B7 needs a confirmation call</div></div>" +
      (here ? "" :
        '<a href="confirmation.html" style="background:#fff;color:#1c6b34;border-radius:8px;padding:9px 16px;' +
        'font-weight:700;text-decoration:none">Open confirmation calls</a>') +
      '<button onclick="this.parentNode.remove()" style="background:transparent;border:1px solid #fff;color:#fff;' +
      'border-radius:8px;padding:9px 14px;cursor:pointer">Dismiss</button>';
    chime();
    flashTitle(name);
  }

  function subscribe(sb) {
    if (started) return;
    started = true;

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
        .then(function (r) { newOrderBanner((r && r.data) || { sim_customers: {} }); })
        .catch(function () { newOrderBanner({ sim_customers: {} }); });
    }
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "sim_orders" }, function (p) {
      maybeAnnounce(p && p.new);
    });
    ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "sim_orders" }, function (p) {
      maybeAnnounce(p && p.new);
    });

    TABLES.forEach(function (t) {
      ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () {
        reload("realtime:" + t);
        toast("Updated — data changed elsewhere");
      });
    });
    ch.subscribe(function (status) {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        // Don't pretend it's fine. The poll below still covers us.
        console.warn("SIMTEC live: realtime unavailable (" + status + "). Falling back to polling.");
      }
    });
  }

  // auth.js sets window.SIMTEC_SB asynchronously; wait for it rather than racing.
  function waitForClient(tries) {
    if (window.SIMTEC_SB) { subscribe(window.SIMTEC_SB); return; }
    if (typeof sb !== "undefined" && sb && sb.channel) { subscribe(sb); return; }
    if (tries <= 0) {
      console.warn("SIMTEC live: no Supabase client found. Focus and poll refresh still active.");
      return;
    }
    setTimeout(function () { waitForClient(tries - 1); }, 150);
  }

  // Someone cancelled a customer in another tab, then switched back to this one.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) reload("visible");
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
