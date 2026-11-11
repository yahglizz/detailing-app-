/* Starting-price booking flow: Package > Vehicle > Address > Appointment > Review > Deposit > Done.
 * Every number on screen (starting price, deposit, balance) comes from the `detail` edge function.
 * The browser never computes a price. Payments are a labelled demo: no card is charged. */
(function () {
  'use strict';

  const FN = 'https://fiaadogbkvjcddehnymj.supabase.co/functions/v1/detail';
  // Public anon key (identifies the project only; same one the rest of the site ships).
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWFkb2dia3ZqY2RkZWhueW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ1OTUsImV4cCI6MjA5OTgwMDU5NX0.XR44tZS4Ntuvg7NZBdB5A_4_y6WjeTEgwweFeqwp8rE';
  const DISCLAIMER = 'Prices shown are starting estimates. Final pricing is confirmed after an in-person vehicle inspection. Your booking deposit is applied toward your final service total. Any additional charges must be approved before work begins.';
  const STEPS = ['Package', 'Vehicle', 'Address', 'Appointment', 'Review', 'Deposit'];
  const TITLES = ['Choose your package', 'Tell us about your vehicle', 'Where should we come?', 'Pick a day and time',
    'Review your estimate', 'Reserve with a deposit', 'Request received'];
  const CONDITIONS = [['light', 'Light', 'Mostly clean, light dust'], ['moderate', 'Moderate', 'Everyday dirt and clutter'], ['heavy', 'Heavy', 'Built-up dirt, stains or odor']];
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
  const MAX_FILES = 4;
  const MAX_BYTES = 10 * 1024 * 1024;
  const MSG = {
    network: 'We couldn’t reach the server. Check your connection and try again.',
    slot_taken: 'That time was just taken. Pick another time.',
    day_full: 'That day is fully booked. Pick another day.',
    day_closed: 'We aren’t taking appointments that day. Pick another day.',
    too_many: 'Too many requests from this device. Please try again in an hour.',
    bad_day: 'That date isn’t available. Pick another day.',
    bad_slot: 'That time isn’t available. Pick another time.',
    not_pending: 'This request already went through, or the held time expired. Close this and start again if you still need a time.',
    payments_not_demo: 'Online deposits aren’t available right now. Please try again later.',
    not_found: 'We couldn’t find that booking. Start again.',
  };

  let cfg = null; // validated pricing from the server (names, copy, prices for the cards only)
  let S = null;
  let opener = null;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const money = (n) => '$' + n;
  const icon = (id) => '<svg class="i" aria-hidden="true"><use href="#i-' + id + '"></use></svg>';
  const errText = (e) => MSG[e && e.code] || 'Something went wrong on our side. Try again in a moment.';

  function call(action, payload) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + ANON },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    }).then(
      (r) => r.json().catch(() => ({})).then((b) => {
        if (!r.ok) { const e = new Error(b.error || 'server_error'); e.code = b.error || 'server_error'; throw e; }
        return b;
      }),
      () => { const e = new Error('network'); e.code = 'network'; throw e; },
    );
  }

  const fresh = () => ({
    step: 0, service: '', vehicleType: '', year: '', make: '', condition: '', petHair: null,
    name: '', phone: '', email: '', street: '', zip: '', notes: '', files: [],
    day: '', slot: '', days: null, slots: [], taken: null, loadingDays: false, loadingSlots: false,
    minSlot: '00:00', quote: null, quoteFor: '', quoting: false, quoteErr: '', booking: null, busy: false, err: '', errs: {}, warn: '',
  });

  // ——— pricing cards on the page (static markup, patched from the catalog) ———
  function patchCards() {
    if (!cfg) return;
    Object.keys(cfg.services).forEach((k) => {
      const c = $('[data-pr-card="' + k + '"]');
      const s = cfg.services[k];
      if (!c) return;
      const set = (sel, t) => { const el = $(sel, c); if (el && el.textContent !== t) el.textContent = t; };
      set('.pr-name', s.name); set('.pr-blurb', s.blurb); set('.pr-amt', money(s.prices.sedan)); set('.pr-dur', 'Estimated ' + s.duration);
      const ul = $('.pr-feats', c);
      const feats = s.includes.map((t) => '<li>' + icon('check') + '<span>' + esc(t) + '</span></li>').join('');
      if (ul && ul.getAttribute('data-sig') !== feats) { ul.innerHTML = feats; ul.setAttribute('data-sig', feats); }
      c.classList.toggle('is-pop', !!s.popular);
      const tag = $('.pr-pop-tag', c); if (tag) tag.hidden = !s.popular;
      const b = $('[data-bk-open]', c);
      if (b) { b.classList.toggle('btn-primary', !!s.popular); b.classList.toggle('btn-secondary', !s.popular); }
    });
  }
  // ——— membership plans (static markup is the fallback; the server's numbers replace it) ———
  let mem = null, memVeh = 'sedan';
  function memHTML(t) {
    const m = mem[t], p = m.prices[memVeh];
    return '<img src="assets/ui/tiers/web/' + t + '.jpg" alt="" width="84" height="84" loading="lazy" />' +
      '<span class="tier-name">' + esc(m.name) + '</span><p class="mem-tag">' + esc(m.tagline) + '</p>' +
      '<div class="tier-price">$<span class="mem-price">' + p.price + '</span><small>/mo</small></div>' +
      (p.save > 0 ? '<p class="mem-save">Worth ' + money(p.worth) + ' booked one at a time. You save ' + money(p.save) + ' a month.</p>' : '') +
      '<div class="mem-lbl">Every month</div><ul class="mem-list">' + m.includes.map((x) => '<li>' + icon('check') + '<span>' + esc(x) + '</span></li>').join('') + '</ul>' +
      '<div class="mem-lbl">Member perks</div><ul class="mem-list">' + m.perks.map((x) => '<li>' + icon('check') + '<span>' + esc(x) + '</span></li>').join('') + '</ul>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-mem-ask="' + t + '">Ask about ' + esc(m.name) + '</button>';
  }
  function patchMembership() {
    const root = $('#bld-tiers');
    if (!mem || !cfg || !root) return;
    ['bronze', 'silver', 'gold'].forEach((t) => {
      if (!mem[t]) return;
      let card = $('[data-mem-tier="' + t + '"]', root);
      if (!card) { card = document.createElement('article'); card.className = 'tier mem-tier'; card.setAttribute('data-mem-tier', t); root.appendChild(card); }
      const sig = JSON.stringify(mem[t]) + memVeh;
      if (card.getAttribute('data-sig') !== sig) { card.innerHTML = memHTML(t); card.setAttribute('data-sig', sig); }
    });
    document.querySelectorAll('[data-mem-veh]').forEach((b) => {
      const v = b.getAttribute('data-mem-veh');
      if (cfg.vehicleTypes[v] && b.textContent !== cfg.vehicleTypes[v]) b.textContent = cfg.vehicleTypes[v];
      b.setAttribute('aria-pressed', String(v === memVeh));
    });
    window.__BLD_MEM_FROM = Math.min.apply(null, ['bronze', 'silver', 'gold'].filter((t) => mem[t]).map((t) => mem[t].prices.sedan.price));
  }
  function loadConfig() {
    return call('config').then((r) => { cfg = r.pricing; mem = r.membership || null; patchCards(); patchMembership(); if (S && !$('#bk').hidden) render(); }).catch(() => { /* static fallbacks stay */ });
  }

  // ——— quote (server is the only source of numbers) ———
  const keyOf = () => S.service + '|' + S.vehicleType;
  function refreshQuote() {
    if (!S.service || !S.vehicleType) { S.quote = null; S.quoteFor = ''; paintSummary(); return Promise.resolve(); }
    const key = keyOf();
    S.quoting = true; S.quoteErr = ''; paintSummary();
    return call('quote', { service: S.service, vehicleType: S.vehicleType }).then((q) => {
      if (!S || keyOf() !== key) return;
      S.quote = q; S.quoteFor = key; S.quoting = false; paintSummary();
    }).catch((e) => {
      if (!S || keyOf() !== key) return;
      S.quoting = false; S.quote = null; S.quoteFor = ''; S.quoteErr = errText(e); paintSummary();
    });
  }
  const quoteReady = () => !!S.quote && S.quoteFor === keyOf();

  // ——— availability ———
  function loadDays() {
    if (S.days) return Promise.resolve();
    S.loadingDays = true; renderStep();
    return call('availability', {}).then((r) => { if (S) { S.days = r.days; S.slots = r.slots; } }).catch((e) => { if (S) { S.err = errText(e); S.days = null; } })
      .then(() => { if (S) { S.loadingDays = false; renderStep(); } });
  }
  function pickDay(day) {
    S.day = day; S.slot = ''; S.taken = null; S.loadingSlots = true; delete S.errs.day; renderStep();
    call('availability', { day: day }).then((r) => { if (S && S.day === day) { S.taken = r.taken || []; S.slots = r.slots; S.minSlot = r.minSlot || '00:00'; } })
      .catch((e) => { if (S && S.day === day) { S.err = errText(e); S.taken = []; } })
      .then(() => { if (S && S.day === day) { S.loadingSlots = false; renderStep(); } });
  }

  // ——— rendering ———
  const fmtSlot = (s) => { const h = +s.slice(0, 2); return (h % 12 || 12) + ':' + s.slice(3, 5) + ' ' + (h < 12 ? 'AM' : 'PM'); };
  const dayParts = (d) => { const t = new Date(d + 'T12:00:00'); return { dow: t.toLocaleDateString('en-US', { weekday: 'short' }), mon: t.toLocaleDateString('en-US', { month: 'short' }), n: t.getDate() }; };
  const fmtDay = (d) => { const p = dayParts(d); return p.dow + ', ' + p.mon + ' ' + p.n; };
  const svc = () => (cfg && S.service ? cfg.services[S.service] : null);
  const vname = (v) => (cfg && cfg.vehicleTypes[v]) || '';

  function field(k, label, o) {
    o = o || {};
    const err = S.errs[k];
    return '<div class="field' + (o.full ? ' full' : '') + '"><label for="bk-' + k + '">' + label + '</label>' +
      '<input id="bk-' + k + '" data-k="' + k + '" type="' + (o.type || 'text') + '" value="' + esc(S[k]) + '"' +
      (o.auto ? ' autocomplete="' + o.auto + '"' : '') + (o.mode ? ' inputmode="' + o.mode + '"' : '') +
      (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + (o.max ? ' maxlength="' + o.max + '"' : '') +
      (err ? ' aria-invalid="true" aria-describedby="bk-e-' + k + '"' : '') + '>' +
      (err ? '<p class="bk-fe" id="bk-e-' + k + '">' + esc(err) + '</p>' : '') + '</div>';
  }
  const groupErr = (k) => (S.errs[k] ? '<p class="bk-fe" id="bk-e-' + k + '" tabindex="-1">' + esc(S.errs[k]) + '</p>' : '');
  function yesno(k, label) {
    const v = S[k];
    return '<div class="bk-group" role="group" aria-label="' + esc(label) + '"><label class="bk-lbl" style="display:block;font:600 12px/1 \'Hanken Grotesk\',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">' + esc(label) + '</label>' +
      '<div class="bk-yn"><button type="button" class="bk-opt" data-set="' + k + '" data-bool="1" aria-pressed="' + (v === true) + '">Yes</button>' +
      '<button type="button" class="bk-opt" data-set="' + k + '" data-bool="0" aria-pressed="' + (v === false) + '">No</button></div>' + groupErr(k) + '</div>';
  }

  function stepHTML() {
    const st = S.step;
    if (!cfg && st < 6) return '<p class="bk-sub">Loading prices…</p>';
    if (st === 0) {
      return '<p class="bk-sub">Prices are starting estimates. You’ll choose your vehicle type next.</p>' +
        '<div class="bk-opts" role="radiogroup" aria-label="Package">' + Object.keys(cfg.services).map((k) => {
          const s = cfg.services[k];
          return '<button type="button" class="bk-opt" role="radio" data-svc="' + k + '" aria-checked="' + (S.service === k) + '">' +
            '<span class="row"><b style="color:var(--text)">' + esc(s.name) + '</b><span style="color:var(--text)">from ' + money(s.prices.sedan) + '</span></span>' +
            (s.popular ? '<span class="bk-pop">Most popular</span>' : '') +
            '<small>' + esc(s.blurb) + ' · ' + esc(s.duration) + '</small></button>';
        }).join('') + '</div>' + groupErr('service');
    }
    if (st === 1) {
      return '<div class="bk-fields">' + field('year', 'Year', { mode: 'numeric', max: 4, ph: '2021', auto: 'off' }) +
        field('make', 'Car brand', { ph: 'Toyota', max: 40 }) + '</div>' +
        '<div class="bk-group"><label style="display:block;font:600 12px/1 \'Hanken Grotesk\',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Vehicle type</label>' +
        '<div class="bk-opts cols3" role="group" aria-label="Vehicle type">' + Object.keys(cfg.vehicleTypes).map((v) =>
          '<button type="button" class="bk-opt" data-set="vehicleType" data-v="' + v + '" aria-pressed="' + (S.vehicleType === v) + '">' + esc(cfg.vehicleTypes[v]) +
          '<small>' + ({ sedan: 'Cars and coupes', suv: 'SUVs, crossovers, pickups', large: 'Three-row SUVs and vans' }[v] || '') + '</small></button>').join('') + '</div>' + groupErr('vehicleType') + '</div>' +
        '<div class="bk-group"><label style="display:block;font:600 12px/1 \'Hanken Grotesk\',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Interior condition</label>' +
        '<div class="bk-opts cols3" role="group" aria-label="Interior condition">' + CONDITIONS.map((c) =>
          '<button type="button" class="bk-opt" data-set="condition" data-v="' + c[0] + '" aria-pressed="' + (S.condition === c[0]) + '">' + c[1] + '<small>' + c[2] + '</small></button>').join('') + '</div>' + groupErr('condition') + '</div>' +
        yesno('petHair', 'Pet hair?') +
        '<div class="bk-note">' + icon('shield') + '<span>This helps us plan the visit. It doesn’t change your starting price. We confirm the final price in person.</span></div>';
    }
    if (st === 2) {
      return '<h3 style="margin-bottom:12px;font-size:16px">Your details</h3><div class="bk-fields">' +
        field('name', 'Full name', { auto: 'name', max: 60, full: true }) +
        field('phone', 'Phone', { type: 'tel', auto: 'tel', ph: '(302) 555-0123', max: 30 }) +
        field('email', 'Email', { type: 'email', auto: 'email', max: 254 }) + '</div>' +
        '<h3 style="margin:28px 0 12px;font-size:16px">Service address</h3><div class="bk-fields">' +
        field('street', 'Street address', { auto: 'street-address', max: 120, full: true }) +
        field('zip', 'ZIP code', { mode: 'numeric', auto: 'postal-code', max: 5, ph: '19801' }) + '</div>' +
        '<div class="bk-fields" style="margin-top:22px"><div class="field full"><label for="bk-notes">Special instructions (optional)</label>' +
        '<textarea id="bk-notes" data-k="notes" rows="3" maxlength="500" placeholder="Gate code, where to park, areas to focus on">' + esc(S.notes) + '</textarea></div>' +
        '<div class="field full"><label for="bk-files">Vehicle photos (optional, up to 4)</label><input id="bk-files" type="file" accept="image/*" multiple' + (S.files.length >= MAX_FILES ? ' disabled' : '') + '>' +
        '<div class="bk-files" id="bk-filelist">' + fileList() + '</div>' + (S.errs.files ? '<p class="bk-fe">' + esc(S.errs.files) + '</p>' : '') + '</div></div>';
    }
    if (st === 3) {
      let h = '<p class="bk-sub">Pick a day, then a start time. You’ll get the exact time confirmed by email.</p>';
      if (S.loadingDays) return h + '<p>Checking the calendar…</p>';
      if (!S.days) return h + '<button type="button" class="btn btn-secondary" data-act="retrydays">Try again</button>';
      h += '<div class="bk-days" role="group" aria-label="Day">' + S.days.map((d) => {
        const p = dayParts(d.day); const off = d.closed || d.booked >= d.capacity;
        return '<button type="button" class="bk-opt bk-day" data-day="' + d.day + '" aria-pressed="' + (S.day === d.day) + '"' + (off ? ' disabled aria-label="' + fmtDay(d.day) + ', unavailable"' : '') + '><small>' + p.dow + '</small><b>' + p.n + '</b><small>' + p.mon + '</small></button>';
      }).join('') + '</div>' + groupErr('day');
      if (S.day) {
        h += '<div class="bk-group"><label style="display:block;font:600 12px/1 \'Hanken Grotesk\',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Start time on ' + esc(fmtDay(S.day)) + '</label>';
        h += S.loadingSlots ? '<p>Checking times…</p>' : '<div class="bk-slots" role="group" aria-label="Start time">' + S.slots.map((t) => {
          const off = (S.taken || []).indexOf(t) !== -1 || t < (S.minSlot || '00:00');
          return '<button type="button" class="bk-opt" data-slot="' + t + '" aria-pressed="' + (S.slot === t) + '"' + (off ? ' disabled aria-label="' + fmtSlot(t) + ', unavailable"' : '') + '>' + fmtSlot(t) + '</button>';
        }).join('') + '</div>' + groupErr('slot');
        h += '</div>';
      }
      return h;
    }
    if (st === 4) return reviewHTML();
    if (st === 5) {
      const q = S.booking.quote;
      return '<span class="bk-demo">' + icon('lock') + 'Demo payment · no card is charged</span>' +
        '<p class="bk-sub">Your time is held for 45 minutes (closing this releases it). In the live version you’ll pay your booking deposit here. For now this step is a demo, so no money is taken.</p>' +
        '<div class="bk-price"><div class="r big"><span>Deposit due today</span><b>' + money(q.deposit) + '</b></div>' +
        '<div class="r"><span>Starting price</span><b>' + money(q.startingPrice) + '</b></div>' +
        '<div class="r"><span>Estimated balance after deposit</span><b>' + money(q.balance) + '</b></div></div>' +
        '<p class="bk-legal">' + DISCLAIMER + '</p>' +
        (S.warn ? '<div class="bk-note" role="status">' + icon('shield') + '<span>' + esc(S.warn) + '</span></div>' : '');
    }
    const q = S.booking.quote;
    return '<div class="bk-done"><span class="ok-mark">' + icon('check') + '</span>' +
      '<p class="bk-sub" style="margin-bottom:8px">Thanks, ' + esc(S.name.split(' ')[0]) + '. We’ll email <b style="color:var(--text)">' + esc(S.email) + '</b> once we confirm your exact time.</p>' +
      '<div class="bk-ref">REFERENCE BLD-' + esc(S.booking.bookingId.slice(0, 6).toUpperCase()) + '</div></div>' +
      '<div class="bk-review">' + [['Package', svc().name], ['Vehicle', vname(S.vehicleType) + ' · ' + [S.year, S.make].join(' ')],
        ['Requested', fmtDay(S.day) + ' at ' + fmtSlot(S.slot)], ['Address', S.street + ', ' + S.zip]].map((r) => '<span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span><span></span>').join('') + '</div>' +
      '<div class="bk-price"><div class="r"><span>Starting price</span><b>' + money(q.startingPrice) + '</b></div>' +
      '<div class="r"><span>Booking deposit (demo, no money taken)</span><b>' + money(q.deposit) + '</b></div>' +
      '<div class="r"><span>Estimated balance after deposit</span><b>' + money(q.balance) + '</b></div></div>' +
      '<p class="bk-legal">' + DISCLAIMER + '</p>';
  }

  function fileList() {
    return S.files.map((f, i) => '<div class="bk-file"><span>' + esc(f.name) + '</span><button type="button" class="btn btn-ghost btn-sm" data-rmfile="' + i + '" aria-label="Remove ' + esc(f.name) + '">Remove</button></div>').join('');
  }

  function reviewHTML() {
    const rows = [
      ['Package', svc().name, 0], ['Vehicle type', vname(S.vehicleType), 1], ['Vehicle', [S.year, S.make].join(' '), 1],
      ['Interior', S.condition.charAt(0).toUpperCase() + S.condition.slice(1) + (S.petHair ? ' · pet hair' : ''), 1],
      ['Address', S.street + ', ' + S.zip, 2],
      ['Contact', S.name + ' · ' + S.phone + ' · ' + S.email, 2], ['Appointment', fmtDay(S.day) + ' at ' + fmtSlot(S.slot), 3],
      ['Photos', S.files.length ? S.files.length + ' attached' : 'None', 2],
    ];
    const q = S.quote;
    return '<p class="bk-sub">Check everything, then reserve your time with a small deposit.</p>' +
      '<div class="bk-review">' + rows.map((r) => '<span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span><button type="button" data-goto="' + r[2] + '" aria-label="Change ' + r[0] + '">Change</button>').join('') + '</div>' +
      '<div class="bk-price' + (S.quoting ? ' is-busy' : '') + '" aria-live="polite">' +
      '<div class="r big"><span>Starting at</span><b>' + (q ? money(q.startingPrice) : '—') + '</b></div>' +
      '<div class="r due"><span>Deposit due today</span><b>' + (q ? money(q.deposit) : '—') + '</b></div>' +
      '<div class="r"><span>Estimated balance after deposit</span><b>' + (q ? money(q.balance) : '—') + '</b></div></div>' +
      (S.quoteErr ? '<div class="bk-err" role="alert">' + esc(S.quoteErr) + '</div>' : '') +
      '<p class="bk-legal">' + DISCLAIMER + '</p>';
  }

  function summaryParts() {
    const s = svc();
    const q = quoteReady() ? S.quote : null;
    const stale = S.quote && !q;
    const from = !q && s && !S.vehicleType ? money(s.prices.sedan) : null;
    return {
      s: s, q: q, price: q ? money(q.startingPrice) : (from || (stale ? money(S.quote.startingPrice) : '—')), label: from ? 'Starting from' : 'Starting at',
      dep: q ? money(q.deposit) : (stale ? money(S.quote.deposit) : '—'), bal: q ? money(q.balance) : '—', busy: S.quoting || stale,
    };
  }
  function paintSummary() {
    if (!S || $('#bk').hidden) return;
    const p = summaryParts();
    $('#bk-sum').innerHTML = '<h3>Your booking</h3>' +
      '<div class="line"><span>Package</span><b>' + (p.s ? esc(p.s.name) : '—') + '</b></div>' +
      '<div class="line"><span>Vehicle</span><b>' + (S.vehicleType ? esc(vname(S.vehicleType)) : '—') + '</b></div>' +
      '<div class="line"><span>When</span><b>' + (S.day && S.slot ? esc(fmtDay(S.day) + ' · ' + fmtSlot(S.slot)) : '—') + '</b></div>' +
      '<div class="tot' + (p.busy ? ' bk-price is-busy' : '') + '" style="' + (p.busy ? 'border:0;background:none;padding:16px 0 0;margin-top:16px;border-top:1px solid var(--line);border-radius:0' : '') + '" aria-live="polite"><small>' + p.label + '</small><div class="big">' + p.price + '</div>' +
      '<div class="line"><span>Deposit due today</span><b>' + p.dep + '</b></div><div class="line"><span>Est. balance after deposit</span><b>' + p.bal + '</b></div></div>' +
      '<p class="fine">Final price is confirmed in person after we inspect the vehicle. Your deposit is credited toward it.</p>';
    $('#bk-bar').innerHTML = '<div><small>' + (p.s ? esc(p.s.name) : 'Starting at') + '</small><b>' + p.price + '</b></div><div class="dep"><small>Deposit today</small><b>' + p.dep + '</b></div>';
    $('#bk-bar').style.display = S.step >= 6 ? 'none' : '';
  }

  function navHTML() {
    const st = S.step;
    const spin = '<span class="bk-spin" aria-hidden="true"></span>';
    if (st === 6) return '<button type="button" class="btn btn-primary" data-act="done">Done</button>';
    const back = st > 0 && st < 5 ? '<button type="button" class="btn btn-secondary" data-act="back"' + (S.busy ? ' disabled' : '') + '>Back</button>' : '<span></span>';
    if (st === 5) return '<span></span><button type="button" class="btn btn-primary btn-lg" data-act="pay"' + (S.busy ? ' disabled aria-busy="true"' : '') + '>' + (S.busy ? spin + ' Reserving…' : icon('lock') + ' Reserve with demo deposit') + '</button>';
    const label = st === 4 ? 'Continue to deposit' : 'Continue';
    return back + '<button type="button" class="btn btn-primary" data-act="next"' + (S.busy ? ' disabled aria-busy="true"' : '') + '>' + (S.busy ? spin + ' One moment…' : label) + '</button>';
  }

  function progressHTML() {
    return STEPS.map((n, i) => '<li' + (i === S.step ? ' aria-current="step"' : '') + (i < S.step ? ' class="is-done"' : '') + '><b>' + (i < S.step ? '✓' : i + 1) + '</b>' + n + '</li>').join('');
  }

  function renderStep() {
    if (!S) return;
    const el = $('#bk-step');
    el.innerHTML = stepHTML();
    $('#bk-err').textContent = S.err;
    $('#bk-nav').innerHTML = navHTML();
    paintSummary();
  }
  function render(focus) {
    $('#bk-prog').innerHTML = S.step < 6 ? progressHTML() : '';
    $('#bk-stepcount').textContent = S.step < 6 ? 'Step ' + (S.step + 1) + ' of ' + STEPS.length + ' · ' + STEPS[S.step] : '';
    const t = $('#bk-title'); t.textContent = TITLES[S.step];
    $('#bk-main').classList.remove('bk-step'); void $('#bk-main').offsetWidth; $('#bk-main').classList.add('bk-step');
    renderStep();
    $('.bk-scroll').scrollTop = 0;
    if (focus !== false) t.focus();
  }

  // ——— validation ———
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validate(step) {
    const e = {};
    const need = (k, msg) => { if (!String(S[k]).trim()) e[k] = msg; };
    if (step === 0 && !S.service) e.service = 'Pick a package to continue.';
    if (step === 1) {
      if (!/^(19|20)\d{2}$/.test(S.year.trim())) e.year = 'Enter a 4-digit year, like 2021.';
      need('make', 'Enter the car brand, like Toyota.');
      if (!S.vehicleType) e.vehicleType = 'Choose your vehicle type.';
      if (!S.condition) e.condition = 'Choose the interior condition.';
      if (S.petHair === null) e.petHair = 'Tell us if there is pet hair.';
    }
    if (step === 2) {
      need('name', 'Enter your full name.');
      const digits = S.phone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) e.phone = 'Enter a phone number with area code.';
      if (!EMAIL.test(S.email.trim())) e.email = 'Enter a valid email address.';
      need('street', 'Enter the street address.');
      if (!/^\d{5}$/.test(S.zip.trim())) e.zip = 'Enter a 5-digit ZIP code.';
    }
    if (step === 3) {
      if (!S.day) e.day = 'Pick a day.';
      else if (!S.slot) e.slot = 'Pick a start time.';
    }
    return e;
  }
  function focusFirstError() {
    const el = $('#bk [aria-invalid="true"]') || $('#bk .bk-fe');
    if (el) { try { el.focus(); } catch (x) { /* ignore */ } el.scrollIntoView({ block: 'center' }); }
  }

  // ——— actions ———
  function payload() {
    return {
      name: S.name.trim(), phone: S.phone.trim(), email: S.email.trim(), vehicle: { year: S.year.trim(), make: S.make.trim() },
      vehicleType: S.vehicleType, service: S.service, condition: S.condition, petHair: S.petHair, day: S.day, slot: S.slot,
      street: S.street.trim(), zip: S.zip.trim(), notes: S.notes.trim(),
      photoExts: S.files.map((f) => extOf(f.name)),
    };
  }
  const extOf = (n) => (n.split('.').pop() || '').toLowerCase();

  function next() {
    S.err = '';
    const errs = validate(S.step);
    S.errs = errs;
    if (Object.keys(errs).length) { renderStep(); focusFirstError(); return; }
    if (S.step === 2) { S.step = 3; render(); loadDays(); return; }
    if (S.step === 3 && !quoteReady()) { S.step = 4; render(); refreshQuote(); return; }
    if (S.step === 4) { return reserve(); }
    S.step += 1; render();
    if (S.step === 4) refreshQuote();
  }
  function reserve() {
    if (!quoteReady()) { S.quoteErr = S.quoteErr || 'We’re still confirming your price. Try again in a moment.'; renderStep(); refreshQuote(); return; }
    S.busy = true; S.err = ''; renderStep();
    call('reserve', payload()).then((r) => {
      if (!S) { release(r); return; } // closed while we were reserving: give the hold back
      S.booking = r; S.quote = r.quote; S.quoteFor = keyOf(); S.busy = false; S.step = 5; render();
    }).catch((e) => {
      if (!S) return;
      S.busy = false; S.err = errText(e);
      if (['slot_taken', 'day_full', 'day_closed', 'bad_day', 'bad_slot'].indexOf(e.code) !== -1) { S.step = 3; S.slot = ''; S.taken = null; S.days = null; render(); loadDays(); if (S.day) pickDay(S.day); }
      else if (e.code === 'bad_email' || e.code === 'bad_phone' || e.code === 'bad_zip') { S.err = 'Please check your contact details.'; S.step = 2; render(); }
      else renderStep();
    });
  }
  function pay() {
    S.busy = true; S.err = ''; S.warn = ''; renderStep();
    const uploads = (S.booking.uploads || []);
    const sends = S.files.map((f, i) => (uploads[i] ? fetch(uploads[i].signedUrl, { method: 'PUT', headers: { 'content-type': MIME[extOf(f.name)] || 'image/jpeg' }, body: f }).then((r) => r.ok, () => false) : Promise.resolve(false)));
    Promise.all(sends).then((oks) => {
      if (!S) return Promise.reject({ code: 'closed' });
      if (oks.some((x) => !x)) S.warn = 'One or more photos didn’t upload. Your request still goes through. You can show us the photos at the inspection.';
      return call('pay-demo', { bookingId: S.booking.bookingId, payKey: S.booking.payKey });
    }).then(() => { if (S) { S.busy = false; S.step = 6; render(); } })
      .catch((e) => { if (!S || (e && e.code === 'closed')) return; S.busy = false; S.err = errText(e); renderStep(); });
  }
  function addFiles(list) {
    S.errs.files = '';
    Array.prototype.forEach.call(list, (f) => {
      const ext = extOf(f.name);
      if (S.files.length >= MAX_FILES) { S.errs.files = 'You can add up to 4 photos.'; return; }
      if (!MIME[ext]) { S.errs.files = '“' + f.name + '” isn’t a supported photo (jpg, png, heic or webp).'; return; }
      if (f.size > MAX_BYTES) { S.errs.files = '“' + f.name + '” is over 10 MB.'; return; }
      S.files.push(f);
    });
    renderStep();
  }

  // ——— open / close ———
  function open(service) {
    S = fresh();
    if (service && cfg && cfg.services[service]) { S.service = service; S.step = 1; }
    opener = document.activeElement;
    $('#bk-scrim').hidden = false; $('#bk').hidden = false;
    document.body.style.overflow = 'hidden';
    render();
    if (S.service) refreshQuote();
    if (!cfg) loadConfig();
  }
  // Free an unpaid hold (best effort; the sweep also releases it after 45 minutes).
  function release(b) {
    if (b && b.bookingId && b.payKey) call('release', { bookingId: b.bookingId, payKey: b.payKey }).catch(() => { /* swept later */ });
  }
  function close() {
    if (S && S.booking && S.step === 5) release(S.booking);
    $('#bk').hidden = true; $('#bk-scrim').hidden = true;
    document.body.style.overflow = '';
    S = null;
    if (opener && opener.focus) opener.focus();
  }

  // ——— events ———
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    const openBtn = t.closest('[data-bk-open]');
    if (openBtn) { open(openBtn.getAttribute('data-service') || ''); return; }
    const vehBtn = t.closest('[data-mem-veh]');
    if (vehBtn) { memVeh = vehBtn.getAttribute('data-mem-veh'); patchMembership(); return; }
    // Joining is by request for now: reuse the page's quote request form.
    if (t.closest('[data-mem-ask]')) { const q = document.getElementById('open-quote'); if (q) q.click(); return; }
    const root = t.closest('#bk');
    if (!root || !S) return;
    const get = (a) => { const el = t.closest('[' + a + ']'); return el ? el.getAttribute(a) : null; };
    if (t.closest('[data-close]')) return close();
    const act = get('data-act');
    if (act === 'back') { S.err = ''; S.errs = {}; S.step -= 1; render(); return; }
    if (act === 'next') return next();
    if (act === 'pay') return pay();
    if (act === 'done') return close();
    if (act === 'retrydays') { S.err = ''; return loadDays(); }
    const svcId = get('data-svc');
    if (svcId) { S.service = svcId; delete S.errs.service; renderStep(); refreshQuote(); return; }
    const key = t.closest('[data-set]');
    if (key) {
      const k = key.getAttribute('data-set');
      S[k] = key.hasAttribute('data-bool') ? key.getAttribute('data-bool') === '1' : key.getAttribute('data-v');
      delete S.errs[k]; renderStep();
      if (k === 'vehicleType') refreshQuote();
      return;
    }
    const day = get('data-day'); if (day) return pickDay(day);
    const slot = get('data-slot'); if (slot) { S.slot = slot; delete S.errs.slot; renderStep(); paintSummary(); return; }
    const go = get('data-goto'); if (go !== null) { S.err = ''; S.step = +go; render(); return; }
    const rm = get('data-rmfile'); if (rm !== null) { S.files.splice(+rm, 1); S.errs.files = ''; renderStep(); return; }
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target; if (!S || !el || !el.getAttribute) return;
    const k = el.getAttribute('data-k'); if (!k) return;
    if (k === 'zip' || k === 'year') { const v = el.value.replace(/\D/g, ''); if (v !== el.value) el.value = v; }
    S[k] = el.value;
    if (S.errs[k]) { delete S.errs[k]; el.removeAttribute('aria-invalid'); const p = $('#bk-e-' + k); if (p) p.remove(); }
  });
  document.addEventListener('change', (ev) => {
    if (S && ev.target && ev.target.id === 'bk-files') { addFiles(ev.target.files); ev.target.value = ''; }
  });
  document.addEventListener('keydown', (ev) => {
    if (!S || $('#bk').hidden) return;
    if (ev.key === 'Escape') { close(); return; }
    if (ev.key === 'Tab') { // keep focus inside the dialog
      const f = Array.prototype.filter.call($('#bk').querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"],#bk-title'), (e) => !e.disabled && e.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  // The instant-quote section on the page asks the server for its numbers through this.
  window.__BLD_QUOTE = (service, vehicleType) => call('quote', { service: service, vehicleType: vehicleType });

  // Static pricing cards: patch from the server. The page runtime may redraw them, so re-patch.
  loadConfig();
  window.addEventListener('load', () => { setTimeout(patchCards, 400); setTimeout(patchCards, 1500); });
  setInterval(() => { if (cfg) { patchCards(); patchMembership(); } }, 4000);
})();
