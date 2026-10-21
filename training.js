/* ============================================================================
   training.js — the trainer's panel for the Sales App.   21 Oct 2026.
   [stated] Nigel: "a training tool for the ipads where I can put it on a big
   screen and click through page by page with new consultants. It needs to have
   the exact same look and buttons as the actual app."

   So this is NOT a copy of the app (a copy drifts the day the app changes). It
   is the real order-app.html opened with ?training=1, which also switches on the
   walkthrough: nothing is saved, nothing is sent, Ezidebit is the sandbox. This
   file only adds a panel for the trainer:
     ◀ ▶      move page by page, without filling anything in
     Fill     puts a made-up customer on the current page, so Next works
     Notes    what to tell the new consultants about this page
     A− A+    makes everything bigger for a projector or TV
     Ezidebit "show it set up" — the green "Direct debit set up" result, without
              doing the sandbox form (which opens in a second tab)
   Loaded only by order-app.html in training mode. Touches nothing outside the
   page — the walkthrough has already blocked every save.
============================================================================ */
(function(){
  'use strict';
  if(!new URLSearchParams(location.search).has('training')) return;

  /* ── what to say on each page ─────────────────────────────────────────── */
  const NOTES = {
    0: ['Pick <b>your own name</b> as the Sleep Consultant. The date of visit is today.',
        '<b>Sale type.</b> Unsolicited = we knocked on their door. The customer then has <b>5 working days to cool off</b>, and no money can be taken today.',
        'Solicited only when the customer <b>personally invited</b> the visit. Only then fill in "Referred by".',
        'Affiliated group: only if the customer is a member of one.',
        'Orders you parked earlier (no signal) are listed on this page.'],
    1: ['Pick each product from the list — the price fills in by itself.',
        'Use − and + for the quantity. <b>No more than 3 of any one product</b>. More than that needs Matt, on a paper order.',
        '<b>Delivery ($170)</b> is ticked. Only untick it if the customer is not having it delivered.',
        'The total at the bottom is what the customer pays.'],
    2: ['Names <b>exactly as on their ID</b>. Joint purchase → Applicant 2 "Yes".',
        'Mobile: if it already belongs to one of our customers, an <b>orange box</b> asks which it is — replacing their earlier order, an extra purchase, or a different person on the same phone. Ask the customer and answer honestly. Never cancel another consultant’s sale yourself; the office does that.',
        'Email: press <b>Send code</b>, the customer reads the code out from their email, type it in and press Verify.',
        'Income and notes: <b>everything on this page is saved</b>. The account note goes to the office straight away; the delivery note to the delivery team.'],
    3: ['Two referees who <b>do not live with</b> the customer. Name and phone as a minimum.'],
    4: ['The customer must <b>scroll to the bottom</b> of the terms before "I agree" can be ticked.',
        'Tick every acknowledgement, and the customer initials <b>every box</b> — both applicants on a joint purchase.',
        'The cooling-off acknowledgement only shows on an unsolicited sale.'],
    5: ['Photograph the <b>front and back</b> of each applicant’s ID — add as many photos as needed. ✕ removes a bad one.',
        'No ID? Press <b>No ID available</b> and choose why. It goes on the order and the office follows it up.'],
    6: ['<b>Ezidebit</b> is the normal way: direct debit set up on the next page.',
        '50% deposit: half now, the balance by direct debit. Paid in full: by bank transfer (proof shown to you) or one Ezidebit payment.',
        'Finance only appears when the office has switched it on for you.'],
    7: ['Go through the summary <b>with the customer</b>.',
        'Each applicant signs in the box and prints their name.',
        'The button saves the order and, for a direct debit, takes you to Ezidebit.'],
    8: ['Set the schedule <b>as agreed with the customer</b> — they may choose to pay more than the minimum. Nothing is calculated for you.',
        'No money is taken during the cooling-off period, so the one-off defaults to a week away and the plan starts after it.',
        'Tell the customer: Simtec charges nothing for a failed payment, but <b>Ezidebit charges them $11.50</b> for each one.',
        'Hand the iPad over: the customer types <b>their own</b> bank details on Ezidebit’s form, ticks the agreement and submits. A NZ account is 16 digits — the first 6 in one box, the rest in the other.',
        'The office rings for the confirmation call <b>as soon as the form is submitted</b>, while you are still in the house.',
        'If the form <b>refuses</b> the customer after trying again, use the red box <b>"Ezidebit won’t accept it?"</b> so the order reaches the office (21 Oct: an order sat unfinished because this wasn’t used). No signal → <b>Park</b> instead.'],
    9: ['The customer scans the <b>rewards app QR code</b> with their phone camera.',
        'Card or cash payments only on a <b>solicited</b> sale — an unsolicited sale is in its cooling-off period.',
        'The referral sheet is on paper. <b>10 or more referrals</b> → press "Add the free pillow".',
        '"Start new order" clears everything for the next customer.'],
    10:['Check the details with the customer, then send the application to the finance company.',
        'While you wait, the customer fills in a <b>paper</b> Ezidebit form — bank details on paper only, never into the iPad.',
        'The finance company texts your phone with the answer; press the matching button.']
  };

  /* ── made-up customer (never a real person: example.com, a 021 000 number) ── */
  const SAMPLE = { a1first:'Mere', a1last:'Sample', a1dl:'AB123456', mobile:'021 000 0000',
    email:'mere.sample@example.com', street:'12 Example Street', suburb:'Onehunga', city:'Auckland', postcode:'1061',
    employer1:'Example Ltd', occupation1:'Office manager', income1:'65000',
    r1name:'Hemi Example', r1phone:'021 000 0001', r1rel:'Brother', r2name:'Ana Example', r2phone:'021 000 0002', r2rel:'Friend',
    sigA1name:'Mere Sample' };
  const setv = (id, v) => { const el = document.getElementById(id); if(el && !el.value){ el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } };
  const pickSel = (id, test) => { const el = document.getElementById(id); if(!el || el.value) return;
    const o = [...el.options].find(x => x.value && test(x)); if(o){ el.value = o.value; el.dispatchEvent(new Event('change',{bubbles:true})); } };
  function scribble(id){
    const c = document.getElementById(id); if(!c || c.offsetParent === null) return;
    try{ sizeCanvas(c); }catch(_e){}
    if(!isBlank(id)) return;
    const x = c.getContext('2d'), w = c.width || 300, h = c.height || 120;
    x.lineWidth = 2.2; x.lineCap = 'round'; x.strokeStyle = '#12203f';
    x.beginPath(); x.moveTo(w*0.12, h*0.62);
    x.bezierCurveTo(w*0.25, h*0.15, w*0.32, h*0.95, w*0.45, h*0.45);
    x.bezierCurveTo(w*0.55, h*0.15, w*0.62, h*0.85, w*0.86, h*0.38); x.stroke();
    pads[id] = pads[id] || {}; pads[id].drawn = true;
  }
  const clickChoice = (wrapId, val) => { const w = document.getElementById(wrapId); if(!w) return;
    const c = val ? w.querySelector('.choice[data-val="'+val+'"]') : w.querySelector('.choice'); if(c) c.click(); };

  function fillPage(){
    const st = S.step;
    if(st === 0){
      pickSel('consultant', o => true);
      setv('visitDate', new Intl.DateTimeFormat('en-CA', { timeZone:'Pacific/Auckland' }).format(new Date()));
      if(!S.saleType) clickChoice('saleType', 'unsolicited');
    }
    if(st === 1){
      if(!S.products.length) addProduct();
      if(!S.products[0].name){
        const sel = document.querySelector('#prodBody select');
        const opts = sel ? [...sel.options].filter(o => o.value) : [];
        const o = opts.find(x => /mk\s*iii.*queen/i.test(x.textContent)) || opts.find(x => /queen/i.test(x.textContent)) || opts[0];
        if(o) pickProduct(0, o.value);
      }
    }
    if(st === 2){
      Object.keys(SAMPLE).forEach(k => setv(k, SAMPLE[k]));
      pickSel('empType1', o => /full/i.test(o.textContent));
      pickSel('homeowner1', o => /no/i.test(o.textContent));
      pickSel('purchaseReason', o => /sleep/i.test(o.textContent));
      S.emailVerified = true;
      const vs = document.getElementById('verifyState'); if(vs) vs.innerHTML = '<span class="badge ok">✓ Email verified (training)</span>';
    }
    if(st === 3) ['r1name','r1phone','r1rel','r2name','r2phone','r2rel'].forEach(k => setv(k, SAMPLE[k]));
    if(st === 4){
      S.tncRead = true;
      const a = document.getElementById('tncAgree'); if(a){ a.disabled = false; a.checked = true; a.dispatchEvent(new Event('change',{bubbles:true})); }
      document.querySelectorAll('.ackrow:not(.hidden) .ackbox').forEach(b => { if(!b.checked){ b.checked = true; b.dispatchEvent(new Event('change',{bubbles:true})); } });
      ['iTnc','iAck1','iAck2','iAck3','iAck4'].concat(S.a2 ? ['iTnc_2','iAck1_2','iAck2_2','iAck3_2','iAck4_2'] : []).forEach(scribble);
    }
    if(st === 5){
      if(!(S.idPhotos.A1||[]).length && !S.idMissing.A1){
        const b = document.getElementById('noIdBtnA1'); if(b) b.click();
        const c = document.querySelector('#noIdChoicesA1 .choice[data-val="Camera not working on this iPad"]') || document.querySelector('#noIdChoicesA1 .choice');
        if(c) c.click();
      }
    }
    if(st === 6){ if(!S.pay) clickChoice('payOption', 'ezidebit'); }
    if(st === 7){ scribble('sigA1'); setv('sigA1name', SAMPLE.sigA1name); if(S.a2) scribble('sigA2'); }
    if(st === 8) showDebitDone();
    note('Filled with the made-up customer Mere Sample. Press the app’s own Next button.');
  }

  /* the green "Direct debit set up" result, as the app shows it when Ezidebit returns */
  function showDebitDone(){
    if(S.step !== 8) return;
    S.eziRef = '00000000'; S.eziRefBad = null;
    try{ showEziDone({ cref:'00000000' }); }catch(_e){}
    const m = document.getElementById('eziDoneMsg');
    if(m) m.textContent = 'Ezidebit customer 00000000 — schedule stored on the order. (Training: this is what the consultant sees when Ezidebit sends the customer back.)';
    note('Shown as set up. In a real sale this appears by itself when the customer finishes Ezidebit’s form.');
  }

  /* move page by page without the checks — the screens are what is being taught */
  function jump(dir){
    const vis = visibleSteps(); let i = vis.indexOf(S.step); if(i < 0) i = 0;
    const n = Math.max(0, Math.min(vis.length - 1, i + dir));
    if(vis[n] === S.step) return;
    if(vis[n] >= 8 && !S.orderId) S.orderId = 'demo-training';     // later pages need an order to exist
    showStep(vis[n]);
  }

  /* ── the panel ──────────────────────────────────────────────────────────── */
  const css = document.createElement('style');
  css.textContent =
    '#trainPanel{position:fixed;right:14px;bottom:86px;z-index:99998;width:340px;max-width:calc(100vw - 28px);'
  + 'background:#0f2c57;color:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);'
  + 'font:500 14px -apple-system,Segoe UI,Roboto,Arial,sans-serif;zoom:1}'
  + '#trainPanel .th{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.15);cursor:pointer}'
  + '#trainPanel .th b{flex:1;font-size:15px}'
  + '#trainPanel .tb{padding:10px 12px}'
  + '#trainPanel .row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}'
  + '#trainPanel button{background:#fff;color:#0f2c57;border:0;border-radius:10px;padding:8px 11px;font:700 13px inherit;cursor:pointer}'
  + '#trainPanel button.alt{background:#c9a84c;color:#1a2438}'
  + '#trainPanel ul{margin:6px 0 0;padding-left:18px;line-height:1.45;max-height:42vh;overflow:auto}'
  + '#trainPanel li{margin-bottom:6px}'
  + '#trainPanel .msg{font-size:12.5px;color:#cfe0ff;min-height:16px;margin-top:6px}'
  + '#trainPanel.min .tb{display:none}';
  document.head.appendChild(css);

  const P = document.createElement('div'); P.id = 'trainPanel';
  P.innerHTML =
    '<div class="th" id="tpHead"><b>🎓 Trainer — <span id="tpStep"></span></b><span id="tpToggle">▾</span></div>'
  + '<div class="tb">'
  + '<div class="row"><button id="tpPrev">◀ Page</button><button id="tpNext">Page ▶</button>'
  + '<button id="tpFill" class="alt">Fill this page</button></div>'
  + '<div class="row"><button id="tpNotes">Hide notes</button><button id="tpSmall">A−</button><button id="tpBig">A+</button>'
  + '<button id="tpEzi" style="display:none">Show debit set up</button></div>'
  + '<ul id="tpList"></ul><div class="msg" id="tpMsg"></div></div>';
  document.body.appendChild(P);

  const $ = id => document.getElementById(id);
  let notesOn = true;
  function note(t){ $('tpMsg').textContent = t || ''; }
  function draw(){
    const st = S.step;
    $('tpStep').textContent = (STEP_LABELS[st] || 'Page') ;
    $('tpList').innerHTML = notesOn ? (NOTES[st] || []).map(n => '<li>' + n + '</li>').join('') : '';
    $('tpList').style.display = notesOn ? '' : 'none';
    $('tpEzi').style.display = (st === 8) ? '' : 'none';
  }
  /* follow the app's own page changes (its Next/Back buttons as well as ours) */
  const realShow = window.showStep;
  window.showStep = function(ds){ const r = realShow.apply(this, arguments); try{ draw(); note(''); }catch(_e){} return r; };

  $('tpPrev').onclick = () => jump(-1);
  $('tpNext').onclick = () => jump(1);
  $('tpFill').onclick = () => { try{ fillPage(); }catch(e){ note('Could not fill this page: ' + (e.message || e)); } };
  $('tpEzi').onclick = showDebitDone;
  $('tpNotes').onclick = () => { notesOn = !notesOn; $('tpNotes').textContent = notesOn ? 'Hide notes' : 'Show notes'; draw(); };
  $('tpHead').onclick = () => { P.classList.toggle('min'); $('tpToggle').textContent = P.classList.contains('min') ? '▸' : '▾'; };

  /* bigger for a projector: the whole app is scaled, the panel stays readable */
  let scale = 1;
  try{ scale = Number(localStorage.getItem('simtec_training_scale')) || 1; }catch(_e){}
  function applyScale(){
    document.body.style.zoom = String(scale);
    P.style.zoom = String(1 / scale);                          // the panel stays the same size
    try{ localStorage.setItem('simtec_training_scale', String(scale)); }catch(_e){}
  }
  $('tpSmall').onclick = () => { scale = Math.max(0.8, Math.round((scale - 0.1) * 10) / 10); applyScale(); };
  $('tpBig').onclick   = () => { scale = Math.min(1.8, Math.round((scale + 0.1) * 10) / 10); applyScale(); };
  applyScale();

  /* the email code: in training nothing is emailed, so show the code to the trainer */
  window.addEventListener('simtec-training-code', ev => {
    note('Training: no email is sent. The code is ' + (ev.detail || '') + ' — type it in and press Verify.');
  });

  draw();
})();
