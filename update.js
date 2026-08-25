/* Simtec — keep an iPad's saved copy of a page up to date.
 *
 * WHY THIS EXISTS (10 Aug 2026): iOS keeps its own copy of a page that has been
 * added to the Home Screen, and will keep serving that copy for days after the
 * server has changed. On 10 Aug the delivery iPad showed a white screen all
 * morning because it was running the copy it saved before the fixes went up.
 *
 * HOW IT WORKS: every page that opts in declares the version it is running:
 *     <script>window.SIMTEC_BUILD="2026-08-10-01";</script>
 * On start-up this file asks the server for a fresh copy of the SAME page and
 * reads the version out of it. Different version = this device is behind, so
 * reload once from a slightly different address, which the cache cannot answer.
 *
 * ⚠⚠ v2, 25 Aug 2026 — WHY THE SECOND CHECK EXISTS. READ THIS BEFORE REMOVING IT.
 * The version check alone is only as good as somebody remembering to bump the
 * version. On 21 and 23 Aug order-app.html was fixed and pushed WITHOUT bumping
 * its SIMTEC_BUILD. Every consultant iPad therefore compared "2026-08-15-01"
 * against "2026-08-15-01", concluded it was current, and kept running the old
 * copy for days — including the Ezidebit fault where the sign-up form demanded
 * a once-off payment amount on a weekly-only sale and then refused to submit.
 * The safeguard was in place and it did nothing, exactly as its own warning
 * said it would.
 *
 * So this version ALSO fingerprints the copy on the server. If the fingerprint
 * changes while the declared version does not, the file was edited without a
 * bump, and the device reloads anyway. Bumping SIMTEC_BUILD is still the right
 * habit — it acts on the very next launch — but forgetting it can no longer
 * strand anybody. Worst case is a device picks the change up one launch later.
 *
 * THE SAFETY RULES, deliberately:
 *  - AT MOST ONE reload per launch, per page. A second attempt is impossible,
 *    so this can never loop.
 *  - Nothing downloaded is ever executed or put into the page. The only things
 *    read out of the response are a version string, through a strict pattern
 *    that allows letters, digits, dot, dash and underscore, and a numeric
 *    fingerprint of the text.
 *  - Only ever asks for the page it is already on, on the same site. No keys,
 *    no outside service, nothing new to configure.
 *  - If the check fails, times out, or the wi-fi is off, the app carries on
 *    exactly as before.
 *  - If the person has started typing, it does NOT reload underneath them; it
 *    offers a button instead. An unsaved order is worth more than being current.
 *  - If a reload happened and the device is STILL behind, it says so in plain
 *    words rather than pretending, and stops.
 */
(function () {
  "use strict";

  var RUNNING = String(window.SIMTEC_BUILD || "");
  if (!RUNNING) return;                 // page has not opted in — do nothing

  var KEY = "simtec_update_tried:" + location.pathname;   // this launch only
  var FPKEY = "simtec_update_fp:" + location.pathname;    // survives launches
  var TIMEOUT_MS = 6000;
  var typed = false;

  function onTyped() { typed = true; }
  document.addEventListener("input", onTyped, true);
  document.addEventListener("change", onTyped, true);

  function remember(v) { try { sessionStorage.setItem(KEY, v); } catch (e) {} }
  function recall()    { try { return sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function forget()    { try { sessionStorage.removeItem(KEY); } catch (e) {} }

  function fpSaved()   { try { return localStorage.getItem(FPKEY) || ""; } catch (e) { return ""; } }
  function fpSave(v)   { try { localStorage.setItem(FPKEY, v); } catch (e) {} }

  /* A plain, dependency-free fingerprint of the served text (FNV-1a, 32 bit, as
     hex, with the length appended). It is NOT security — nothing is trusted on
     the strength of it — it only has to change when the file changes. */
  function fingerprint(text) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8) + ":" + text.length;
  }

  function bar(text, buttonText, onTap) {
    function draw() {
      if (document.getElementById("simtec-update-bar")) return;
      var d = document.createElement("div");
      d.id = "simtec-update-bar";
      d.style.cssText =
        "position:fixed;left:0;right:0;top:0;z-index:99998;background:#0b3d91;color:#fff;" +
        "font:600 15px/1.35 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:12px 14px;" +
        "display:flex;align-items:center;gap:10px;box-shadow:0 2px 8px rgba(0,0,0,.25)";
      var span = document.createElement("span");
      span.style.cssText = "flex:1";
      span.textContent = text;
      d.appendChild(span);
      if (buttonText) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = buttonText;
        b.style.cssText =
          "background:#fff;color:#0b3d91;border:none;border-radius:8px;padding:10px 16px;" +
          "font:800 15px -apple-system,Segoe UI,Roboto,Arial,sans-serif";
        b.onclick = onTap;
        d.appendChild(b);
      }
      var x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", "Hide this message");
      x.textContent = "\u2715";
      x.style.cssText = "background:none;border:none;color:#cfe0ff;font-size:18px;padding:4px 6px";
      x.onclick = function () { d.remove(); };
      d.appendChild(x);
      document.body.appendChild(d);
    }
    if (document.body) draw();
    else document.addEventListener("DOMContentLoaded", draw);
  }

  function reloadTo(tag) {
    var u;
    try {
      u = new URL(location.href);
      u.searchParams.set("v", tag);
      u.searchParams.delete("cb");
      location.replace(u.toString());
    } catch (e) {
      location.replace(location.pathname + "?v=" + encodeURIComponent(tag));
    }
  }

  function check() {
    var controller = null, timer = null;
    try { controller = new AbortController(); } catch (e) {}
    var opts = { cache: "no-store" };
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, TIMEOUT_MS);
    }

    fetch(location.pathname + "?cb=" + Date.now(), opts)
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (timer) clearTimeout(timer);
        if (!text) return;

        var m = /SIMTEC_BUILD\s*=\s*"([A-Za-z0-9._-]{1,32})"/.exec(text);
        if (!m) return;                       // cannot tell — leave well alone
        var onServer = m[1];

        var fpNow = fingerprint(text);
        var fpWas = fpSaved();

        /* CHECK 1 — the declared version. Acts on the very next launch. */
        var behind = (onServer !== RUNNING);

        /* CHECK 2 — the fingerprint, which catches an edit pushed without a
           bump. Only meaningful once this device has seen the page before; the
           first launch simply records what it saw and does nothing. */
        if (!behind && fpWas && fpWas !== fpNow) behind = true;

        if (!behind) { fpSave(fpNow); forget(); return; }   // already current

        /* The one-reload marker carries BOTH signals, so a second, different
           edit under the same version counts as a fresh attempt rather than
           being mistaken for the one that just failed. */
        var tag = onServer + "-" + fpNow.split(":")[0];

        if (recall() === tag) {                // already reloaded, still behind
          bar("This iPad is still showing an older version. Close the app from the app " +
              "switcher and open it again.", null, null);
          return;
        }

        remember(tag);
        fpSave(fpNow);

        if (typed) {
          bar("An update is ready. Finish what you are doing first.", "Update now",
              function () { reloadTo(tag); });
        } else {
          reloadTo(tag);
        }
      })
      .catch(function () { if (timer) clearTimeout(timer); });
  }

  if (typeof fetch !== "function") return;    // very old browser — do nothing
  if (document.readyState === "complete") check();
  else window.addEventListener("load", check);
})();
