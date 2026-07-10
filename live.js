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

  function subscribe(sb) {
    if (started) return;
    started = true;

    var ch = sb.channel("simtec-live-" + Math.random().toString(36).slice(2, 8));
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
