/* ============================================================
   SIMTEC — client-errors.js
   Tells the office when a page goes wrong out there.

   A page includes this file and then, in any catch that used to swallow the
   error or only show an alert, adds one line:

       reportClientError('save the checklist', e);            // or
       reportClientError('save the checklist', e, orderId);   // or
       reportClientError('save the checklist', e, { order: oid, customer: cid });

   The fault goes to report_client_error(): the page, what was being attempted,
   the error text, the order and customer ids if known, the build, the URL and
   the user agent. Uncaught errors, unhandled promise rejections and scripts
   that fail to load are reported by themselves — nobody has to remember.

   ⚠ REPORTING A FAULT MUST NEVER CAUSE ONE. This never throws, is never
     awaited, and changes nothing the caller already does. No client, no
     session, no such function, RLS refusing it — the report is dropped and
     the page carries on exactly as it did before.

   ⚠ DIAGNOSTIC ONLY, AND NOTHING PERSONAL. Ids, not names. Nothing may ever
     be decided from it.

   ⚠ NEVER A FLOOD. The same fault is reported once per page load, and no page
     load reports more than MAX faults. A page stuck in a loop must not fill
     the table.

   The function is deliberately NOT called reportError: every browser already
   has a window.reportError(), which throws its argument as an uncaught error.
   ============================================================ */
(function () {
  "use strict";

  var MAX = 30;
  var sent = {};
  var count = 0;

  function pageName() {
    try { return (location.pathname.split("/").pop() || "index.html").replace(/\.html$/i, ""); }
    catch (e) { return "unknown"; }
  }

  // auth.js's client carries the session; the page's own `sb` is the fallback.
  // Both are looked up at CALL time — the page may not have created it yet when
  // this file loads.
  function client() {
    try { if (window.SIMTEC_SB && window.SIMTEC_SB.rpc) return window.SIMTEC_SB; } catch (e) {}
    try { if (typeof sb !== "undefined" && sb && sb.rpc) return sb; } catch (e) {}
    return null;
  }

  function text(err) {
    try {
      if (err == null) return "";
      if (typeof err === "string") return err;
      var m = err.message || err.error_description || err.hint || err.details || err.error;
      if (m) return String(m) + (err.code ? " [" + err.code + "]" : "");
      if (err.reason) return text(err.reason);
      var s = JSON.stringify(err);
      return (s && s !== "{}") ? s : String(err);
    } catch (e) { return "(unreadable error)"; }
  }

  function reportClientError(attempting, err, ids) {
    try {
      var c = client();
      if (!c) return;
      var message = text(err);
      var key = String(attempting) + "|" + message;
      if (sent[key] || count >= MAX) return;
      sent[key] = true; count++;

      if (typeof ids === "string") ids = { order: ids };
      ids = ids || {};
      var q = c.rpc("report_client_error", {
        p_page:       pageName(),
        p_action:     String(attempting || "").slice(0, 200),
        p_message:    String(message).slice(0, 1000),
        p_order:      ids.order    || window.__ORDER_ID__ || null,
        p_customer:   ids.customer || window.__CUST_ID__  || null,
        p_build:      window.SIMTEC_BUILD || "unknown",
        p_url:        String(location.href || "").slice(0, 500),
        p_user_agent: String(navigator.userAgent || "").slice(0, 300)
      });
      /* A PostgREST builder does not run until something asks for the result,
         so it is asked — and the answer thrown away, both ways. */
      if (q && q.then) q.then(function () {}, function () {});
    } catch (e) { /* deliberately nothing: reporting a fault must never cause one */ }
  }
  window.reportClientError = reportClientError;

  /* ---- the faults nobody catches ---------------------------------------
     Capture phase, so a <script> or <img> that fails to load is seen too —
     "no library loaded, no client created" is the failure that looks like
     nothing at all from the office. */
  window.addEventListener("error", function (ev) {
    try {
      var t = ev && ev.target;
      if (t && t !== window && t.tagName) {
        var src = t.src || t.href || "";
        if (!src) return;
        reportClientError("load <" + t.tagName.toLowerCase() + "> " + String(src).split("/").pop().split("?")[0],
                          "the browser could not load it");
        return;
      }
      var where = ev && ev.filename ? " in " + String(ev.filename).split("/").pop() + ":" + ev.lineno : "";
      reportClientError("uncaught error" + where, (ev && ev.error) || (ev && ev.message) || "unknown");
    } catch (e) {}
  }, true);

  window.addEventListener("unhandledrejection", function (ev) {
    try { reportClientError("unhandled promise rejection", ev && ev.reason); } catch (e) {}
  });
})();
