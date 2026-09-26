// Brotherly Love Detailing — owner & management dashboard.
// Buildless: Preact + hooks + htm in one ESM file from jsdelivr. Everything talks to the
// `admin` edge function with the signed-in staff code; nothing here is trusted — the
// server checks every action and role.
import {
  html, render, useState, useEffect, useMemo, useCallback, useRef,
} from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';

const SUPABASE_URL = 'https://fiaadogbkvjcddehnymj.supabase.co';
// Public anon key (same one the website ships) — only identifies the project.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWFkb2dia3ZqY2RkZWhueW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjQ1OTUsImV4cCI6MjA5OTgwMDU5NX0.XR44tZS4Ntuvg7NZBdB5A_4_y6WjeTEgwweFeqwp8rE';
// Local dashboard work only: ?api=http://localhost:<port> points the page at a mock API.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const FN = (LOCAL && new URLSearchParams(location.search).get('api')) || `${SUPABASE_URL}/functions/v1/admin`;
const CODE_KEY = 'bld_staff_code';
const THEME_KEY = 'bld_theme';

// ——— storage (a per-device convenience; the page works without it) ———
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ——— API ———
class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
let staffCode = store.get(CODE_KEY) || '';
let onSignedOut = () => {};

async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-staff-code': staffCode, apikey: ANON },
      body: JSON.stringify({ ...payload, action }),
    });
  } catch { throw new ApiError('network', 0); }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { onSignedOut(); throw new ApiError('bad_code', 401); }
  if (!res.ok) throw new ApiError(body.error || 'server_error', res.status);
  return body;
}

const ERR = {
  network: 'Can’t reach the server. Check your connection and try again.',
  bad_code: 'That code didn’t work.',
  rate_limited: 'Too many tries. Wait 15 minutes, then try again.',
  forbidden: 'Only the owner can do that.',
  slot_taken: 'Another job already has that time. Pick a different slot.',
  not_open: 'This booking was already handled — refreshed.',
  refund_failed: 'The refund didn’t go through, so nothing changed. Try again, or refund it in Stripe.',
  bad_time: 'Pick a valid date and time.',
  bad_amount: 'Enter the amount collected in whole dollars.',
  bad_capacity: 'Cars per day must be a whole number from 0 to 50.',
  bad_weekdays: 'Pick the days you’re closed.',
  bad_key: 'That isn’t a Stripe secret key. It starts with sk_live_ or sk_test_.',
  stripe_not_set_up: 'Connect Stripe in Settings first.',
  cannot_remove_self: 'You can’t remove yourself.',
  bad_body: 'Write something in the report first.',
  bad_photos: 'A photo couldn’t be attached. Try again.',
  bad_member: 'Enter a name, a valid email and a tier.',
  bad_name: 'Enter a name.',
  upload_failed: 'A photo didn’t upload. Check your connection and try again.',
  server_error: 'Something went wrong on our side. Try again.',
};
function errText(e) {
  const c = String(e?.code ?? '');
  if (ERR[c]) return ERR[c];
  if (c.startsWith('bad_value:')) return `“${c.slice(10)}” isn’t an allowed number.`;
  if (c.startsWith('stripe_error')) return `Stripe said: ${c.replace(/^stripe_error:?\s*/, '') || 'error'}`;
  return ERR.server_error;
}

// ——— toasts ———
let pushToast = () => {};
const toast = (text) => pushToast(text, false);
const toastErr = (e) => pushToast(errText(e), true);
function Toasts() {
  const [list, setList] = useState([]);
  pushToast = (text, bad) => {
    const id = Math.random();
    setList((l) => [...l, { id, text, bad }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), bad ? 6500 : 4000);
  };
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div key=${t.id} class=${'toast' + (t.bad ? ' bad' : '')}>${t.text}</div>`)}
  </div>`;
}

// ——— routing: #/view/id ———
const parseHash = () => {
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { view: view || 'bookings', id: id || null };
};
const go = (path) => { location.hash = path; };
function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const f = () => setRoute(parseHash());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return route;
}

// ——— theme: system → light → dark ———
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get(THEME_KEY));

// ——— formatting ———
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLOTS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
const WINDOW = { morning: 'Morning', afternoon: 'Afternoon', either: 'Any time' };
const SERVICE = { outside: 'Outside', inside: 'Inside', full: 'Full detail', ceramic: 'Ceramic', membership: 'Membership' };
const SIZE = { sedan: 'Sedan', suv: 'SUV', truck: 'Truck/Van' };
const EXTRA = { ceramic: 'Ceramic coating', headlight: 'Headlight restore', engine: 'Engine bay', pet: 'Pet hair/odor' };
const STATUS = { requested: 'Awaiting', confirmed: 'Confirmed', done: 'Done', refunded: 'Cancelled', declined: 'Cancelled', pending_payment: 'Checking out' };
const CATEGORIES = [['note', 'Note'], ['damage', 'Damage'], ['complaint', 'Complaint'], ['no_show', 'No-show'], ['payment', 'Payment issue'], ['other', 'Other']];
const CAT_LABEL = Object.fromEntries(CATEGORIES);
const TIERS = ['bronze', 'silver', 'gold'];

const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const fmtDay = (iso) => { if (!iso) return '—'; const d = utc(iso); return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const fmtLongDay = (iso) => { const d = utc(iso); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const fmtSlot = (s) => { if (!s) return ''; const h = +s.slice(0, 2); return `${h % 12 || 12}:${s.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`; };
const timeOf = (b) => (b.slot ? fmtSlot(b.slot) : WINDOW[b.window] || 'Any time');
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const carLine = (c) => `${SERVICE[c.service] || c.service} · ${c.label ? `${c.label} (${SIZE[c.size] || c.size})` : SIZE[c.size] || c.size}`;
const itemsSummary = (items = []) => (items.length === 1 ? carLine(items[0])
  : `${items.length} cars · ${[...new Set(items.map((i) => SERVICE[i.service] || i.service))].join(', ')}`);
const initials = (s = '') => s.trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ref = (id = '') => `BLD-${id.slice(0, 6).toUpperCase()}`;
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function ago(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; };
const isOpen = (b) => b.status === 'requested' || b.status === 'confirmed';

// ——— icons (1.8px line) ———
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS = {
  list: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M3.5 6l1.5 1.5L7.5 5', 'M3.5 12l1.5 1.5L7.5 11', 'M3.5 18l1.5 1.5L7.5 17'],
  cal: ['M8 3v4', 'M16 3v4', 'M3.5 10h17', 'M5.5 5h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
  users: ['M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', circle(9.5, 7.5, 3.5), 'M21 20v-1.5a4 4 0 0 0-3-3.85', 'M15.5 4.15a3.5 3.5 0 0 1 0 6.7'],
  inbox: ['M21.5 12.5h-5.5l-2 3h-4l-2-3H2.5', 'M5.5 5.2L2.5 12.5V18a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5.5l-3-7.3A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.2z'],
  crown: ['M4 19h16', 'M4 16L3 7l5 4 4-6 4 6 5-4-1 9z'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  gear: [circle(12, 12, 3), 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  home: ['M3 10.5L12 3l9 7.5', 'M5.5 9v11h13V9', 'M10 20v-6h4v6'],
  clock: [circle(12, 12, 9), 'M12 7v5l3.2 2'],
  dollar: ['M12 2.5v19', 'M16.5 6.5H10a3.25 3.25 0 0 0 0 6.5h4a3.25 3.25 0 0 1 0 6.5H7'],
  search: [circle(11, 11, 7), 'M20.5 20.5l-4.3-4.3'],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.5-6', 'M20.5 3.5V9H15'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  info: [circle(12, 12, 9), 'M12 11v5', 'M12 8h.01'],
  lock: ['M5.5 11h13v10h-13z', 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'],
  camera: ['M22 18.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.5l2-3h5l2 3H20a2 2 0 0 1 2 2z', circle(12, 13, 3.8)],
  ext: ['M7 17L17 7', 'M8.5 7H17v8.5'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  logout: ['M9 20.5H5.5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2H9', 'M16 16.5l4.5-4.5L16 7.5', 'M20.5 12H9'],
  moon: ['M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  phone: ['M21.5 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.6 4.2 2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L7.5 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.9 2.2z'],
  mail: ['M4 4.5h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z', 'M22 6.5l-10 7-10-7'],
  pin: ['M19.5 10c0 5.8-7.5 12-7.5 12S4.5 15.8 4.5 10a7.5 7.5 0 0 1 15 0z', circle(12, 10, 2.8)],
  flag: ['M4.5 15s1-1 4-1 5 2 8 2 3.5-1 3.5-1V3.5s-.5 1-3.5 1-5-2-8-2-4 1-4 1z', 'M4.5 21.5v-6.5'],
  check: ['M20 6.5L9 17.5l-5-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  spark: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z'],
  card: ['M3 6.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 10h18', 'M7 15h3'],
};
const Icon = ({ name, size = 20 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(ICONS[name] || []).map((d) => html`<path d=${d} />`)}</svg>`;

// ——— small pieces ———
const Mark = ({ href = '#/bookings' }) => html`<a class="mark" href=${href} aria-label="Brotherly Love Detailing">
  <span class="mark-top">BROTHERLY</span><span class="mark-script">Love</span><span class="mark-sub">MINISTRY DETAILING</span></a>`;
const Loading = () => html`<div class="empty"><span class="spinner"></span></div>`;
const Pill = ({ status }) => html`<span class=${`pill ${status}`}>${STATUS[status] || status}</span>`;
const Tier = ({ tier }) => (tier ? html`<span class=${`tier ${tier}`}>${tier.toUpperCase()}</span>` : null);
const Head = ({ eyebrow, title, lede }) => html`<header class="rise">
  ${eyebrow && html`<p class="eyebrow">${eyebrow}</p>`}
  <h1 class="hello">${title}</h1>
  ${lede && html`<p class="lede">${lede}</p>`}
</header>`;

function copy(text) {
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => toast('Copied.'), () => toast('Select the code and copy it.'));
}

// A button that runs an async action once, shows it's busy, and reports failures.
function ActionButton({ run, class: cls = 'btn', children, confirmText, disabled }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try { await run(); } catch (e) { toastErr(e); }
    setBusy(false);
  };
  return html`<button type="button" class=${cls} disabled=${busy || disabled} onClick=${click}>
    ${busy ? html`<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>` : children}</button>`;
}

// ═══════════════════════════ app ═══════════════════════════
function App() {
  const [me, setMe] = useState(null);
  const [phase, setPhase] = useState('checking');

  // Always ask the server first: while the owner has the login switched off (admin_open)
  // it lets everyone straight in, and the sign-in screen only shows once it's back on.
  const check = useCallback(() => {
    setPhase('checking');
    api('me').then((m) => { setMe(m); setPhase('in'); }).catch((e) => setPhase(e.status === 401 ? 'out' : 'offline'));
  }, []);

  const signOut = useCallback(() => {
    staffCode = '';
    store.set(CODE_KEY, null);
    setMe(null);
    setPhase('out');
  }, []);

  useEffect(() => {
    onSignedOut = signOut;
    check();
  }, []);

  let body;
  if (phase === 'checking') body = html`<div class="boot"><span class="spinner"></span></div>`;
  else if (phase === 'offline') {
    body = html`<div class="login"><div class="card rise"><${Mark} /><p>${ERR.network}</p>
      <button class="btn primary block" onClick=${check}>Try again</button></div></div>`;
  } else if (phase === 'out') body = html`<${Login} onIn=${(m) => { setMe(m); setPhase('in'); }} />`;
  else body = html`<${Shell} me=${me} signOut=${signOut} />`;
  return html`${body}<${Toasts} />`;
}

function Login({ onIn }) {
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true); setErr('');
    staffCode = code.trim();
    try {
      const m = await api('me');
      store.set(CODE_KEY, staffCode);
      onIn(m);
    } catch (x) {
      staffCode = '';
      setErr(errText(x));
      setBusy(false);
    }
  };
  return html`<div class="login">
    <div class="card rise">
      <${Mark} />
      <p>Owner and management only. Sign in with your staff code.</p>
      <form onSubmit=${submit}>
        <label class="field"><span>Staff code</span>
          <div style="position:relative">
            <input class="input" type=${show ? 'text' : 'password'} autocomplete="current-password" autocapitalize="characters"
              spellcheck="false" placeholder="STAFF-XXXXX-XXXXX" value=${code} onInput=${(e) => setCode(e.target.value)} style="padding-right:64px" />
            <button type="button" class="btn ghost sm" style="position:absolute;right:4px;top:5px;border:0" onClick=${() => setShow(!show)}>${show ? 'Hide' : 'Show'}</button>
          </div>
        </label>
        ${err && html`<div class="err" role="alert">${err}</div>`}
        <button class="btn primary block" disabled=${busy} style="min-height:48px">${busy ? 'Checking…' : 'Sign in'}</button>
      </form>
    </div>
  </div>`;
}

const OWNER_VIEWS = ['members', 'pricing', 'settings'];

function Shell({ me, signOut }) {
  const route = useRoute();
  const [ov, setOv] = useState(null);
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(store.get(THEME_KEY) || 'system');
  const owner = me.role === 'owner';

  const load = useCallback(() => api('overview').then(setOv).catch(toastErr), []);
  useEffect(() => {
    load();
    // Stays live on the shop tablet: refresh every minute and whenever it's looked at again.
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const t = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick); };
  }, []);
  useEffect(() => { setMenu(false); window.scrollTo({ top: 0 }); }, [route.view]);

  const cycleTheme = () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[theme];
    setTheme(next); store.set(THEME_KEY, next === 'system' ? null : next); applyTheme(next);
    toast(`Theme: ${next === 'system' ? 'match this device' : next}`);
  };

  const view = !owner && OWNER_VIEWS.includes(route.view) ? 'bookings' : route.view;
  const awaiting = ov?.stats.awaiting ?? 0;
  const leads = ov?.newLeads ?? 0;
  const main = [['bookings', 'Bookings', 'list', awaiting], ['calendar', 'Calendar', 'cal'], ['customers', 'Customers', 'users'], ['leads', 'Leads', 'inbox', leads]];
  const biz = [['members', 'Members', 'crown'], ['pricing', 'Pricing', 'tag'], ['settings', 'Settings', 'gear']];
  const link = ([key, label, icon, n]) => html`<a key=${key} href=${`#/${key}`} class=${view === key ? 'on' : ''} aria-current=${view === key ? 'page' : null}>
    <${Icon} name=${icon} /> ${label} ${n ? html`<span class=${'badge' + (key === 'bookings' ? ' hot' : '')}>${n}</span>` : null}</a>`;

  let page;
  if (view === 'calendar') page = html`<${Calendar} />`;
  else if (view === 'customers') page = route.id ? html`<${CustomerPage} id=${route.id} me=${me} />` : html`<${Customers} />`;
  else if (view === 'leads') page = html`<${Leads} onChange=${load} />`;
  else if (view === 'members') page = html`<${Members} />`;
  else if (view === 'pricing') page = html`<${Pricing} />`;
  else if (view === 'settings') page = html`<${Settings} me=${me} signOut=${signOut} />`;
  else page = html`<${Bookings} ov=${ov} me=${me} reload=${load} />`;

  return html`<div class="shell">
    <aside class=${'side' + (menu ? ' open' : '')} aria-label="Main menu">
      <${Mark} />
      <nav>
        <div class="nav-label">Operations</div>
        <div class="nav">${main.map(link)}</div>
      </nav>
      ${owner && html`<nav><div class="nav-label">Business</div><div class="nav">${biz.map(link)}</div></nav>`}
      <div class="side-card">
        <${Icon} name="spark" size=${26} />
        <h3>Every car leaves better than it came.</h3>
        <p>Clean cars. Clear minds. Christ first.</p>
        <a href="/" target="_blank" rel="noopener">View website <${Icon} name="ext" size=${16} /></a>
      </div>
      <div class="whoami">
        <div class="avatar">${initials(me.name)}</div>
        <div><b>${me.name}</b><small>${me.role}</small></div>
        <button class="icon-btn" title="Change theme" aria-label="Change theme" onClick=${cycleTheme}><${Icon} name="moon" size=${18} /></button>
        ${!me.open && html`<button class="icon-btn" title="Sign out" aria-label="Sign out" onClick=${signOut}><${Icon} name="logout" size=${18} /></button>`}
      </div>
    </aside>
    ${menu && html`<div class="scrim" style="z-index:45" onClick=${() => setMenu(false)}></div>`}
    <div>
      <div class="topbar">
        <${Mark} />
        <button class="icon-btn" aria-label="Open menu" onClick=${() => setMenu(true)}><${Icon} name="menu" /></button>
      </div>
      <main>${page}</main>
    </div>
    <nav class="tabbar" aria-label="Sections">
      ${main.map(([key, label, icon, n]) => html`<a key=${key} href=${`#/${key}`} class=${view === key ? 'on' : ''}>
        <${Icon} name=${icon} size=${22} />${label}${n ? html`<span class="dotbadge">${n}</span>` : null}</a>`)}
      <button onClick=${() => setMenu(true)}><${Icon} name="more" size=${22} />More</button>
    </nav>
    ${route.view === 'bookings' && route.id && html`<${BookingDrawer} key=${route.id} id=${route.id} me=${me} reload=${load}
      onClose=${() => go('/bookings')} />`}
  </div>`;
}

// ═══════════════════════════ bookings ═══════════════════════════
const TABS = [['all', 'All bookings'], ['requested', 'Awaiting'], ['confirmed', 'Confirmed'], ['done', 'Done'], ['cancelled', 'Cancelled']];
const inTab = (b, t) => t === 'all' || (t === 'cancelled' ? b.status === 'refunded' || b.status === 'declined' : b.status === t);

function Bookings({ ov, me, reload }) {
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [spin, setSpin] = useState(false);
  if (!ov) return html`<${Head} eyebrow="A good day at BLD" title=${`${greet()}.`} /><${Loading} />`;
  const { stats, bookings, today } = ov;
  const first = me.name === 'Owner' ? 'boss' : me.name.split(' ')[0];
  const needle = q.trim().toLowerCase();
  const rows = bookings
    .filter((b) => inTab(b, tab))
    .filter((b) => !needle || [b.customer.name, b.customer.email, b.address, ref(b.id), itemsSummary(b.items)]
      .some((s) => (s || '').toLowerCase().includes(needle)))
    // Coming up soonest first, then everything already behind us, most recent first.
    .sort((a, b) => {
      const ac = isOpen(a) && a.day >= today, bc = isOpen(b) && b.day >= today;
      if (ac !== bc) return ac ? -1 : 1;
      const k = `${a.day}${a.slot || '99'}`.localeCompare(`${b.day}${b.slot || '99'}`);
      return ac ? k : -k;
    });
  const refresh = async () => { setSpin(true); await reload(); setSpin(false); };

  return html`
    ${me.open && html`<div class="banner rise"><${Icon} name="lock" />
      <div><b>Login is off.</b> Anyone with this link can use the dashboard. Turn it back on before launch.</div></div>`}
    <${Head} eyebrow="A good day at BLD" title=${html`${greet()}, <em>${first}</em>.`}
      lede="Every car on the schedule, and what needs you next." />
    ${stats.awaiting > 0 && html`<div class="banner rise" style="--i:1"><${Icon} name="clock" />
      <div><b>${plural(stats.awaiting, 'booking')} waiting for a time.</b> Paid requests refund themselves after 48 hours if nobody confirms them.</div></div>`}
    <div class="stats">
      <${Stat} i=${2} label="Cars today" icon="home" value=${stats.today} hint=${fmtLongDay(today)} />
      <${Stat} i=${3} label="Upcoming" icon="cal" value=${stats.upcoming} hint="Awaiting + confirmed" />
      <${Stat} i=${4} label="Awaiting confirmation" icon="clock" value=${stats.awaiting} attn=${stats.awaiting > 0}
        hint=${stats.awaiting ? 'A little attention needed' : 'All caught up'} />
      <${Stat} i=${5} label="Due at jobs" icon="dollar" value=${money(stats.owing)} hint="Still to collect in person" />
    </div>
    <section class="card rise" style="--i:6">
      <div class="card-head">
        <div><h2 class="title">Every car, every appointment.</h2><p class="muted" style="margin:0">Search, filter and open any booking.</p></div>
        <button class="icon-btn" aria-label="Refresh" title="Refresh" onClick=${refresh}>${spin ? html`<span class="spinner" style="width:16px;height:16px"></span>` : html`<${Icon} name="refresh" size=${18} />`}</button>
      </div>
      <div class="row" style="justify-content:space-between;margin-bottom:18px">
        <div class="tabs" role="tablist">${TABS.map(([k, label]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>
          ${label}<span class="n">${bookings.filter((b) => inTab(b, k)).length}</span></button>`)}</div>
        <label class="search"><${Icon} name="search" size=${18} /><input class="input" type="search" placeholder="Search name, email, address…"
          value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search bookings" /></label>
      </div>
      ${rows.length ? html`<table class="table">
        <thead><tr><th>Customer & car</th><th>Date</th><th>Total</th><th>Status</th><th>Reference</th></tr></thead>
        <tbody>${rows.map((b) => html`<${BookingRow} key=${b.id} b=${b} />`)}</tbody>
      </table>` : html`<div class="empty"><${Icon} name="cal" size=${40} /><div>${needle ? 'No bookings match that search.' : tab === 'all' ? 'No bookings yet. They show up here the moment a customer pays.' : 'Nothing here right now.'}</div></div>`}
    </section>`;
}

const Stat = ({ i, label, icon, value, hint, attn }) => html`<div class=${'stat rise' + (attn ? ' attn' : '')} style=${`--i:${i}`}>
  <div class="label">${label}<${Icon} name=${icon} /></div>
  <div class="value">${value}</div>
  <div class="hint">${hint}</div>
</div>`;

function BookingRow({ b }) {
  const open = () => go(`/bookings/${b.id}`);
  return html`<tr tabindex="0" onClick=${open} onKeyDown=${(e) => e.key === 'Enter' && open()}>
    <td class="span"><div class="who">
      <div class=${'avatar' + (b.status === 'requested' ? ' alt' : '')}>${initials(b.customer.name || b.customer.email)}</div>
      <div style="min-width:0"><b>${b.customer.name || b.customer.email} ${b.test && html`<span class="tag">TEST</span>`} <${Tier} tier=${b.tier} /></b>
        <small>${itemsSummary(b.items)} ${b.reports > 0 && html`<span class="flag"><${Icon} name="flag" size=${13} />${b.reports}</span>`}</small></div>
    </div></td>
    <td><div class="when"><b>${fmtDay(b.day)}</b><small>${timeOf(b)} · ${plural(b.items.length, 'car')}</small></div></td>
    <td class="hide-sm"><div class="when"><b>${money(b.total)}</b><small>${b.owing > 0 ? `${money(b.owing)} due` : b.status === 'refunded' ? 'Refunded' : 'Paid'}</small></div></td>
    <td style="text-align:right"><${Pill} status=${b.status} /></td>
    <td class="hide-sm mono muted">${ref(b.id)}</td>
  </tr>`;
}

function BookingDrawer({ id, me, reload, onClose }) {
  const [b, setB] = useState(null);
  const [day, setDay] = useState('');
  const [slot, setSlot] = useState('');
  const [collect, setCollect] = useState(true);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [writing, setWriting] = useState(false);
  const panel = useRef(null);

  const fetchIt = useCallback(() => api('booking', { id }).then((x) => {
    setB(x); setDay(x.day); setSlot(x.slot || ''); setCollect(x.owing > 0);
    setAmount(x.owing ? String(x.owing) : ''); setMethod(x.remainderMethod === 'card' ? 'card' : 'cash');
  }).catch((e) => { toastErr(e); onClose(); }), [id]);
  useEffect(() => { fetchIt(); }, [fetchIt]);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    panel.current?.focus();
    return () => removeEventListener('keydown', esc);
  }, []);

  const after = async (msg) => { toast(msg); await Promise.all([fetchIt(), reload()]); };
  const fail = async (e) => { if (e.code === 'not_open') await Promise.all([fetchIt(), reload()]); throw e; };
  const confirmTime = () => api('confirm', { id, day, slot: slot || null })
    .then((r) => after(b.status === 'confirmed' ? `Moved to ${r.when}. Customer emailed.` : `Confirmed for ${r.when}. Customer emailed.`), fail);
  const done = () => {
    const collected = collect && amount ? { amount: Number(amount), method } : null;
    return api('done', { id, collected }).then((r) => after(`Job done${r.stamps ? ` · +${r.stamps} stamps sent` : ''}.`), fail);
  };
  const decline = () => api('decline', { id })
    .then((r) => after(r.refundedCents ? `Cancelled · ${money(r.refundedCents / 100)} refunded.` : 'Cancelled. Customer emailed.'), fail);

  return html`<div class="scrim" onClick=${onClose}></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Booking" tabindex="-1" ref=${panel}>
    ${!b ? html`<${Loading} />` : html`
      <div class="drawer-head">
        <div>
          <p class="eyebrow" style="margin-bottom:6px">${ref(b.id)} · booked ${ago(b.createdAt)}</p>
          <h2 class="title">${b.customer.name || b.customer.email}</h2>
          <div class="chips" style="margin-top:10px;align-items:center"><${Pill} status=${b.status} /> <${Tier} tier=${b.tier} /> ${b.test && html`<span class="tag">TEST</span>`}</div>
        </div>
        <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
      </div>
      ${b.reports > 0 && html`<a class="banner" href=${`#/customers/${b.customer.id}`} style="text-decoration:none">
        <${Icon} name="flag" /><div><b>${plural(b.reports, 'private report')}</b> on this customer. Read before the job →</div></a>`}

      <div class="section"><h4>When & where</h4>
        <dl class="kv">
          <dt>Date</dt><dd>${fmtLongDay(b.day)}</dd>
          <dt>Time</dt><dd>${timeOf(b)}</dd>
          <dt>Address</dt><dd><a href=${`https://maps.google.com/?q=${encodeURIComponent(b.address)}`} target="_blank" rel="noopener">${b.address}</a></dd>
          ${b.notes && html`<dt>Notes</dt><dd style="white-space:pre-wrap">${b.notes}</dd>`}
          <dt>Customer</dt><dd><a href=${`#/customers/${b.customer.id}`}>${b.customer.email}</a></dd>
        </dl>
      </div>

      <div class="section"><h4>${plural(b.items.length, 'car')}</h4>
        <div class="cars">${b.items.map((c, n) => html`<div class="car"><div><b>${carLine(c)}</b>
          <small>${c.extras?.length ? c.extras.map((e) => EXTRA[e] || e).join(' · ') : 'No extras'}</small></div><span class="muted small">Car ${n + 1}</span></div>`)}</div>
      </div>

      <div class="section"><h4>Money</h4>
        <dl class="kv">
          <dt>Total</dt><dd>${money(b.total)}</dd>
          ${b.savings > 0 && html`<dt>Member savings</dt><dd>−${money(b.savings)}</dd>`}
          ${b.creditsUsed > 0 && html`<dt>Member credits</dt><dd>${b.creditsUsed}</dd>`}
          ${b.walletUsed > 0 && html`<dt>From balance</dt><dd>${money(b.walletUsed)}</dd>`}
          <dt>Paid online</dt><dd>${money(b.paidOnline)}</dd>
          ${b.collected > 0 && html`<dt>Collected at detail</dt><dd>${money(b.collected)}</dd>`}
          <dt>Still due</dt><dd class="big">${money(b.owing)}</dd>
        </dl>
        ${b.owing > 0 && html`<p class="muted small" style="margin:8px 0 0">Customer planned to pay the rest by ${b.remainderMethod}.</p>`}
      </div>

      ${isOpen(b) && html`<div class="section"><h4>${b.status === 'requested' ? 'Confirm a time' : 'Move this job'}</h4>
        <div class="row">
          <label class="field"><span>Day</span><input class="input" type="date" value=${day} onInput=${(e) => setDay(e.target.value)} /></label>
          <label class="field"><span>Time</span><select class="input" value=${slot} onChange=${(e) => setSlot(e.target.value)}>
            <option value="">${WINDOW[b.window] || 'Any time'} (no exact time)</option>
            ${SLOTS.map((s) => html`<option value=${s}>${fmtSlot(s)}</option>`)}</select></label>
        </div>
        <div style="margin-top:12px"><${ActionButton} class="btn primary block" run=${confirmTime}>
          <${Icon} name="check" size=${18} /> ${b.status === 'requested' ? 'Confirm & email customer' : 'Save new time & email customer'}<//></div>
      </div>
      <div class="section"><h4>Finish the job</h4>
        ${b.owing > 0 && html`<label class="switch" style="margin-bottom:12px"><input type="checkbox" checked=${collect} onChange=${(e) => setCollect(e.target.checked)} /> Collected the balance</label>`}
        ${b.owing > 0 && collect && html`<div class="row" style="margin-bottom:12px">
          <label class="field"><span>Amount</span><div class="money-wrap"><input class="input money" inputmode="numeric" value=${amount} onInput=${(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} /></div></label>
          <label class="field"><span>Paid by</span><select class="input" value=${method} onChange=${(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option><option value="card">Card in person</option></select></label>
        </div>`}
        <${ActionButton} class="btn block" run=${done}><${Icon} name="check" size=${18} /> Mark job done<//>
        ${me.role === 'owner' && html`<div style="margin-top:10px"><${ActionButton} class="btn danger block" run=${decline}
          confirmText=${`Cancel this booking${b.paidOnline ? ` and refund ${money(b.paidOnline)} to their card` : ''}? Any balance, credits and rewards go back to them too.`}>
          Cancel & refund<//></div>`}
      </div>`}

      <div class="section"><h4><span class="private"><${Icon} name="lock" size=${14} /> Private report</span></h4>
        ${writing ? html`<${ReportForm} customerId=${b.customer.id} bookingId=${b.id}
            onSaved=${() => { setWriting(false); fetchIt(); reload(); }} onCancel=${() => setWriting(false)} />`
          : html`<button class="btn block" onClick=${() => setWriting(true)}><${Icon} name="flag" size=${18} /> Write a report about this job</button>`}
      </div>
    `}
  </aside>`;
}

// ═══════════════════════════ calendar ═══════════════════════════
const monthOf = (iso) => iso.slice(0, 7);
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function Calendar() {
  const [month, setMonth] = useState(monthOf(localISO()));
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(localISO());
  const load = useCallback(() => api('calendar', { month }).then(setData).catch(toastErr), [month]);
  useEffect(() => { setData(null); load(); }, [load]);

  const today = data?.today ?? localISO();
  const [y, mo] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const days = data?.days ?? [];
  const selState = days.find((d) => d.day === sel);
  const def = data?.schedule?.dailyCapacity ?? 9;

  return html`
    <${Head} eyebrow="Availability" title="A little room to plan."
      lede="See who’s booked, close days off, and set how many cars you can take." />
    <div class="split">
      <section class="card rise" style="--i:1">
        <div class="cal-head">
          <h2 class="title">${MONTH[mo - 1]} ${y}</h2>
          <div class="cal-nav">
            <button class="icon-btn" aria-label="Previous month" onClick=${() => setMonth(shiftMonth(month, -1))}><${Icon} name="left" /></button>
            <button class="btn sm" onClick=${() => { setMonth(monthOf(today)); setSel(today); }}>Today</button>
            <button class="icon-btn" aria-label="Next month" onClick=${() => setMonth(shiftMonth(month, 1))}><${Icon} name="right" /></button>
          </div>
        </div>
        ${!data ? html`<${Loading} />` : html`
          <div class="cal">
            ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="dow">${d}</div>`)}
            ${Array.from({ length: lead }, () => html`<div></div>`)}
            ${days.map((d) => {
              const free = Math.max(0, d.capacity - d.booked);
              const full = !d.closed && free === 0;
              const override = data.overrides.some((o) => o.day === d.day);
              const cls = ['day', d.closed && 'closed', full && 'full', d.day < today && 'past', d.day === today && 'today', d.day === sel && 'sel'].filter(Boolean).join(' ');
              return html`<button class=${cls} onClick=${() => setSel(d.day)} aria-label=${`${fmtLongDay(d.day)}: ${d.closed ? 'closed' : full ? 'full' : `${free} free`}`}>
                <span class="n">${+d.day.slice(8)}</span>
                <span class="free">${d.closed ? 'Closed' : full ? 'Full' : html`${free}<span class="w"> free</span>`}</span>
                ${override && html`<span class="dot" title="Changed for this day"></span>`}
                <span class="bar"><i style=${`width:${d.capacity ? Math.min(100, (d.booked / d.capacity) * 100) : d.booked ? 100 : 0}%`}></i></span>
              </button>`;
            })}
          </div>
          <div class="legend">
            <span><i style="background:var(--ok)"></i>Open</span>
            <span><i style="background:var(--bad)"></i>Full</span>
            <span><i style="background:var(--muted)"></i>Closed</span>
            <span><i style="background:var(--brand-2)"></i>Changed for that day</span>
            <span>Usual: ${plural(def, 'car')} a day</span>
          </div>`}
      </section>
      <div class="stack">
        ${data && selState && html`<${DayPanel} key=${sel} day=${sel} state=${selState} def=${def}
          override=${data.overrides.find((o) => o.day === sel)} jobs=${data.jobs.filter((j) => j.day === sel)} onSaved=${load} />`}
        ${data && html`<${WeekDefaults} schedule=${data.schedule} onSaved=${load} />`}
      </div>
    </div>`;
}

function DayPanel({ day, state, def, override, jobs, onSaved }) {
  const [closed, setClosed] = useState(state.closed);
  const [cap, setCap] = useState(override?.capacity ?? '');
  const [note, setNote] = useState(override?.note ?? '');
  const save = () => api('set_day', { day, closed, capacity: cap === '' ? null : Number(cap), note })
    .then(() => { toast(`${fmtDay(day)} saved. The app updates right away.`); onSaved(); });
  const reset = () => api('set_day', { day, clear: true }).then(() => { toast(`${fmtDay(day)} back to your usual week.`); onSaved(); });
  return html`<section class="card rise" style="--i:2">
    <p class="eyebrow" style="margin-bottom:4px">${state.closed ? 'Closed' : `${Math.max(0, state.capacity - state.booked)} of ${state.capacity} open`}</p>
    <h3 class="sub">${fmtLongDay(day)}</h3>
    <div class="stack" style="gap:8px;margin-bottom:18px">
      ${jobs.length ? jobs.map((j) => html`<a class="job" href=${`#/bookings/${j.id}`}>
        <span class="time">${j.slot ? fmtSlot(j.slot) : WINDOW[j.window]}</span>
        <span style="flex:1;min-width:0"><b>${j.name}</b> ${j.test && html`<span class="tag">TEST</span>`}<br /><small class="muted">${plural(j.cars, 'car')}</small></span>
        <${Pill} status=${j.status} /></a>`) : html`<p class="muted" style="margin:0">No cars booked.</p>`}
    </div>
    <div class="stack">
      <label class="switch"><input type="checkbox" checked=${closed} onChange=${(e) => setClosed(e.target.checked)} /> Closed this day</label>
      ${!closed && html`<label class="field"><span>Cars this day</span>
        <input class="input" inputmode="numeric" placeholder=${`Usual (${def})`} value=${cap} onInput=${(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} /></label>`}
      <label class="field"><span>Note (only staff see it)</span><input class="input" maxlength="200" placeholder="e.g. Church event, rain day" value=${note} onInput=${(e) => setNote(e.target.value)} /></label>
      <div class="row">
        <${ActionButton} class="btn primary" run=${save}>Save day<//>
        ${override && html`<${ActionButton} class="btn ghost" run=${reset}>Use usual week<//>`}
      </div>
    </div>
  </section>`;
}

function WeekDefaults({ schedule, onSaved }) {
  const [cap, setCap] = useState(String(schedule?.dailyCapacity ?? 9));
  const [closed, setClosed] = useState(schedule?.closedWeekdays ?? []);
  const toggle = (d) => setClosed((c) => (c.includes(d) ? c.filter((x) => x !== d) : [...c, d]));
  const save = () => api('set_schedule', { dailyCapacity: Number(cap), closedWeekdays: closed })
    .then(() => { toast('Usual week saved. The app follows it now.'); onSaved(); });
  return html`<section class="card rise" style="--i:3">
    <h3 class="sub">Your usual week</h3>
    <div class="stack">
      <label class="field"><span>Cars per day</span><input class="input" inputmode="numeric" value=${cap} onInput=${(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} /></label>
      <div class="field"><span>Closed every</span>
        <div class="chips">${DOW.map((d, i) => html`<button type="button" class=${'chip' + (closed.includes(i) ? ' on' : '')} aria-pressed=${closed.includes(i)} onClick=${() => toggle(i)}>${d}</button>`)}</div></div>
      <${ActionButton} class="btn" run=${save}>Save usual week<//>
    </div>
  </section>`;
}

// ═══════════════════════════ customers + reports ═══════════════════════════
function Customers() {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => api('customers', { q }).then(setList).catch(toastErr), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);
  return html`
    <${Head} eyebrow="Customers" title="The people behind the cars." lede="Profiles, booking history and private reports only you and your managers can see." />
    <section class="card rise" style="--i:1">
      <div class="row" style="margin-bottom:18px"><label class="search" style="max-width:none"><${Icon} name="search" size=${18} />
        <input class="input" type="search" placeholder="Search by name or email…" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search customers" /></label></div>
      ${!list ? html`<${Loading} />` : list.length ? html`<table class="table">
        <thead><tr><th>Customer</th><th>Membership</th><th>Bookings</th><th>Reports</th><th>Since</th></tr></thead>
        <tbody>${list.map((c) => html`<tr key=${c.id} tabindex="0" onClick=${() => go(`/customers/${c.id}`)} onKeyDown=${(e) => e.key === 'Enter' && go(`/customers/${c.id}`)}>
          <td class="span"><div class="who"><div class="avatar">${initials(c.name || c.email)}</div><div style="min-width:0"><b>${c.name || '—'}</b><small>${c.email}</small></div></div></td>
          <td>${c.tier ? html`<${Tier} tier=${c.tier} />` : html`<span class="muted small">—</span>`}</td>
          <td class="hide-sm">${c.bookings}</td>
          <td>${c.reports ? html`<span class="flag"><${Icon} name="flag" size=${14} />${c.reports}</span>` : html`<span class="muted small">—</span>`}</td>
          <td class="hide-sm muted small">${ago(c.since)}</td>
        </tr>`)}</tbody></table>`
      : html`<div class="empty"><${Icon} name="users" size=${40} /><div>${q ? 'No one matches that search.' : 'No customers yet.'}</div></div>`}
    </section>`;
}

function CustomerPage({ id, me }) {
  const [d, setD] = useState(null);
  const load = useCallback(() => api('customer', { id }).then(setD).catch((e) => { toastErr(e); go('/customers'); }), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return html`<${Loading} />`;
  const c = d.customer;
  const m = d.memberships.find((x) => x.active) ?? d.memberships[0];
  const del = (r) => api('report_delete', { id: r.id }).then(() => { toast('Report deleted.'); load(); });
  return html`
    <a href="#/customers" class="btn ghost sm" style="margin-bottom:18px"><${Icon} name="left" size=${16} /> All customers</a>
    <header class="rise" style="display:flex;gap:18px;align-items:center;margin-bottom:26px;flex-wrap:wrap">
      <div class="avatar" style="width:68px;height:68px;font-size:24px;border-radius:20px">${initials(c.name || c.email)}</div>
      <div style="flex:1;min-width:220px">
        <h1 class="hello" style="font-size:clamp(30px,4vw,44px);margin-bottom:6px">${c.name || c.email}</h1>
        <div class="chips" style="align-items:center">
          <a class="btn sm" href=${`mailto:${c.email}`}><${Icon} name="mail" size=${16} /> ${c.email}</a>
          ${m && html`<${Tier} tier=${m.tier} />`} ${m && !m.active && html`<span class="tag">INACTIVE</span>`}
          ${m?.is_test && html`<span class="tag">TEST</span>`}
          <span class="muted small">Customer since ${new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
        </div>
      </div>
    </header>
    <div class="split">
      <div class="stack" style="gap:20px">
        <section class="card rise" style="--i:1">
          <div class="card-head" style="margin-bottom:14px"><h2 class="title" style="font-size:24px">Private reports</h2>
            <span class="private"><${Icon} name="lock" size=${14} /> Only owner & managers see these</span></div>
          <${ReportForm} customerId=${c.id} onSaved=${load} />
          <div style="margin-top:20px">${d.reports.length ? d.reports.map((r) => html`<article class="report" key=${r.id}>
            <div class="report-head"><span class=${`cat ${r.category}`}>${CAT_LABEL[r.category]}</span>
              <b style="font-size:14px">${r.author_name}</b><span class="muted small">${ago(r.created_at)}</span>
              ${r.booking_id && html`<a class="small" href=${`#/bookings/${r.booking_id}`}>${ref(r.booking_id)}</a>`}
              ${(r.mine || me.role === 'owner') && html`<span style="margin-left:auto"><${ActionButton} class="btn ghost sm" run=${() => del(r)} confirmText="Delete this report and its photos?">Delete<//></span>`}
            </div>
            <p>${r.body}</p>
            ${r.photoUrls.length > 0 && html`<div class="thumbs">${r.photoUrls.map((u) => html`<a href=${u} target="_blank" rel="noopener"><img src=${u} alt="Report photo" loading="lazy" /></a>`)}</div>`}
          </article>`) : html`<p class="muted" style="margin:0">No reports. Anything worth remembering about this customer goes here.</p>`}</div>
        </section>
        <section class="card rise" style="--i:2">
          <h2 class="title" style="font-size:24px;margin-bottom:14px">Bookings</h2>
          ${d.bookings.length ? html`<table class="table"><tbody>${d.bookings.map((b) => html`<${BookingRow} key=${b.id} b=${b} />`)}</tbody></table>`
            : html`<p class="muted" style="margin:0">No bookings yet.</p>`}
        </section>
      </div>
      <div class="stack">
        <section class="card rise" style="--i:3">
          <h3 class="sub">Account</h3>
          <dl class="kv">
            <dt>Balance</dt><dd class="big">${money(d.wallet)}</dd>
            <dt>Membership</dt><dd>${m ? `${m.tier[0].toUpperCase()}${m.tier.slice(1)}${m.active ? '' : ' (inactive)'}` : 'None'}</dd>
            ${m && html`<dt>Billing</dt><dd>${m.billing ? 'Stripe (automatic)' : 'Set up by hand'}</dd>`}
            ${(m?.code || c.code) && html`<dt>Login code</dt><dd class="mono">${m?.code || c.code}</dd>`}
          </dl>
        </section>
        <section class="card rise" style="--i:4">
          <h3 class="sub">Address & cars</h3>
          <p style="margin:0 0 12px">${c.address ? html`<a href=${`https://maps.google.com/?q=${encodeURIComponent(c.address)}`} target="_blank" rel="noopener">${c.address}</a>` : html`<span class="muted">No saved address</span>`}</p>
          <div class="cars">${(c.cars ?? []).length ? c.cars.map((car) => html`<div class="car"><div><b>${car.label || 'Car'}</b><small>${SIZE[car.size] || car.size || ''}</small></div></div>`)
            : html`<span class="muted small">No saved cars</span>`}</div>
        </section>
      </div>
    </div>`;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const MAX_PHOTO = 10 * 1024 * 1024;

function ReportForm({ customerId, bookingId, onSaved, onCancel }) {
  const [cat, setCat] = useState('note');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const pick = (e) => {
    const picked = [...e.target.files].filter((f) => EXT[f.type] || /\.(heic|heif)$/i.test(f.name));
    if (picked.some((f) => f.size > MAX_PHOTO)) pushToast('Photos over 10 MB were skipped.', true);
    setFiles((fs) => [...fs, ...picked.filter((f) => f.size <= MAX_PHOTO)].slice(0, 6));
    e.target.value = '';
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return pushToast(ERR.bad_body, true);
    setBusy(true);
    try {
      const photos = [];
      for (const f of files) {
        const ext = EXT[f.type] || f.name.split('.').pop().toLowerCase();
        const { path, signedUrl } = await api('photo_upload_url', { customerId, ext });
        const form = new FormData();
        form.append('cacheControl', '3600');
        form.append('', f);
        const up = await fetch(signedUrl, { method: 'PUT', body: form, headers: { apikey: ANON, 'x-upsert': 'false' } }).catch(() => null);
        if (!up?.ok) throw new ApiError('upload_failed', 0);
        photos.push(path);
      }
      await api('report_add', { customerId, bookingId, category: cat, body: body.trim(), photos });
      toast('Report saved. Only staff can see it.');
      setBody(''); setFiles([]); setCat('note');
      onSaved?.();
    } catch (x) { toastErr(x); }
    setBusy(false);
  };
  return html`<form class="stack" onSubmit=${submit}>
    <div class="chips" role="radiogroup" aria-label="Report type">${CATEGORIES.map(([k, label]) => html`<button type="button" role="radio" aria-checked=${cat === k}
      class=${'chip' + (cat === k ? ' on' : '')} onClick=${() => setCat(k)}>${label}</button>`)}</div>
    <textarea class="input" maxlength="4000" placeholder="What happened? Scratches before we started, a complaint, a no-show…" value=${body} onInput=${(e) => setBody(e.target.value)}></textarea>
    ${files.length > 0 && html`<div class="thumbs">${previews.map((u, i) => html`<div class="pending"><img src=${u} alt="" />
      <button type="button" aria-label="Remove photo" onClick=${() => setFiles((fs) => fs.filter((_, j) => j !== i))}>×</button></div>`)}</div>`}
    <div class="row" style="justify-content:space-between">
      <label class="btn sm" style="cursor:pointer"><${Icon} name="camera" size=${16} /> Add photos
        <input type="file" accept="image/*" multiple onChange=${pick} style="display:none" /></label>
      <div class="row">
        ${onCancel && html`<button type="button" class="btn ghost sm" onClick=${onCancel}>Cancel</button>`}
        <button class="btn primary sm" disabled=${busy}>${busy ? 'Saving…' : 'Save report'}</button>
      </div>
    </div>
  </form>`;
}

// ═══════════════════════════ leads ═══════════════════════════
const LEAD_TABS = [['new', 'New'], ['contacted', 'Contacted'], ['booked', 'Booked'], ['lost', 'Lost'], ['all', 'All']];

function Leads({ onChange }) {
  const [list, setList] = useState(null);
  const [tab, setTab] = useState('new');
  useEffect(() => { api('leads').then(setList).catch(toastErr); }, []);
  const setStatus = (l, status) => api('lead_status', { id: l.id, status }).then(() => {
    setList((xs) => xs.map((x) => (x.id === l.id ? { ...x, status } : x)));
    onChange();
  }).catch(toastErr);
  const rows = (list ?? []).filter((l) => tab === 'all' || l.status === tab);
  return html`
    <${Head} eyebrow="From the website" title="Fresh leads." lede="Everyone who asked for a quote on the website. Reach out, then mark where they landed." />
    <section class="card rise" style="--i:1">
      <div class="tabs" style="margin-bottom:18px">${LEAD_TABS.map(([k, label]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>
        ${label}<span class="n">${(list ?? []).filter((l) => k === 'all' || l.status === k).length}</span></button>`)}</div>
      ${!list ? html`<${Loading} />` : rows.length ? html`<table class="table">
        <thead><tr><th>Lead</th><th>Asked about</th><th>Quote</th><th>When</th><th>Status</th></tr></thead>
        <tbody>${rows.map((l) => html`<tr key=${l.id} style="cursor:default">
          <td class="span"><div class="who"><div class="avatar">${initials(l.name || l.email || '?')}</div><div style="min-width:0">
            <b>${l.name || 'No name'}</b>
            <small>${l.phone && html`<a href=${`tel:${l.phone}`}><${Icon} name="phone" size=${13} /> ${l.phone}</a>`} ${l.email && html`<a href=${`mailto:${l.email}`}>${l.email}</a>`}</small>
            ${l.message && html`<small style="display:block;margin-top:4px;white-space:pre-wrap">“${l.message}”</small>`}
          </div></div></td>
          <td><div class="when"><b>${SERVICE[l.service] || l.service || '—'}</b><small>${[SIZE[l.size] || l.size, l.vehicle].filter(Boolean).join(' · ')}</small></div></td>
          <td class="hide-sm"><div class="when">${l.quoted_price ? html`<b>${money(l.discounted_price ?? l.quoted_price)}</b><small>${l.accepted ? 'Accepted' : 'Declined'} · was ${money(l.quoted_price)}</small>` : html`<span class="muted small">Asked for a quote</span>`}</div></td>
          <td class="hide-sm muted small">${ago(l.created_at)}</td>
          <td><select class="input" style="min-height:36px;padding:6px 10px;width:auto" value=${l.status} onChange=${(e) => setStatus(l, e.target.value)} aria-label="Lead status">
            ${LEAD_TABS.slice(0, 4).map(([k, label]) => html`<option value=${k}>${label}</option>`)}</select></td>
        </tr>`)}</tbody></table>`
      : html`<div class="empty"><${Icon} name="inbox" size=${40} /><div>${tab === 'new' ? 'No new leads. Nice work.' : 'Nothing here.'}</div></div>`}
    </section>`;
}

// ═══════════════════════════ members (owner) ═══════════════════════════
function Members() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', tier: 'bronze' });
  const [made, setMade] = useState(null);
  const load = useCallback(() => api('members').then(setList).catch(toastErr), []);
  useEffect(() => { load(); }, []);
  const add = () => api('member_add', form).then((r) => {
    setMade({ ...r, name: form.name }); setForm({ name: '', email: '', tier: 'bronze' }); load();
  });
  const act = (fn) => fn.then((r) => { if (r?.warning) pushToast(r.warning, true); else toast('Saved.'); load(); }).catch(toastErr);
  return html`
    <${Head} eyebrow="The Brotherhood" title="Members." lede="People who join through the app or website appear here on their own. You can also add someone by hand." />
    <section class="card rise" style="--i:1">
      <h3 class="sub">Add a member by hand</h3>
      <div class="row">
        <label class="field"><span>Name</span><input class="input" value=${form.name} onInput=${(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label class="field"><span>Email</span><input class="input" type="email" value=${form.email} onInput=${(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label class="field" style="flex:0 1 150px"><span>Tier</span><select class="input" value=${form.tier} onChange=${(e) => setForm({ ...form, tier: e.target.value })}>
          ${TIERS.map((t) => html`<option value=${t}>${t[0].toUpperCase() + t.slice(1)}</option>`)}</select></label>
        <${ActionButton} class="btn primary" run=${add}><${Icon} name="plus" size=${18} /> Add & email code<//>
      </div>
      ${made && html`<div class="reveal" style="margin-top:16px"><div><b>${made.name}</b> is in, with ${plural(made.credits, 'credit')}. Their code was emailed:</div>
        <code>${made.code}</code><button class="btn sm" onClick=${() => copy(made.code)}>Copy</button></div>`}
    </section>
    <section class="card rise" style="--i:2">
      ${!list ? html`<${Loading} />` : list.length ? html`<table class="table">
        <thead><tr><th>Member</th><th>Code</th><th>Tier</th><th>Billing</th><th>Active</th><th></th></tr></thead>
        <tbody>${list.map((m) => html`<tr key=${m.id} style="cursor:default">
          <td class="span"><div class="who"><div class="avatar">${initials(m.customers?.name || m.customers?.email)}</div><div style="min-width:0">
            <b><a href=${`#/customers/${m.customers?.id}`} style="text-decoration:none">${m.customers?.name || m.customers?.email}</a> ${m.is_test && html`<span class="tag">TEST</span>`}</b><small>${m.customers?.email}</small></div></div></td>
          <td class="mono hide-sm">${m.code}</td>
          <td><select class="input" style="min-height:36px;padding:6px 10px;width:auto" value=${m.tier} onChange=${(e) => act(api('member_tier', { id: m.id, tier: e.target.value }))} aria-label="Tier">
            ${TIERS.map((t) => html`<option value=${t}>${t[0].toUpperCase() + t.slice(1)}</option>`)}</select></td>
          <td class="hide-sm">${m.billing ? html`<span class="tag">STRIPE</span>` : html`<span class="tag">BY HAND</span>`}</td>
          <td><label class="switch"><input type="checkbox" checked=${m.active} aria-label="Active" onChange=${(e) => act(api('member_active', { id: m.id, active: e.target.checked }))} /></label></td>
          <td class="hide-sm"><${ActionButton} class="btn sm" run=${() => api('member_stamp', { id: m.id }).then(() => toast('+1 stamp.'))}>+1 stamp<//></td>
        </tr>`)}</tbody></table>`
      : html`<div class="empty"><${Icon} name="crown" size=${40} /><div>No members yet.</div></div>`}
    </section>`;
}

// ═══════════════════════════ pricing (owner) ═══════════════════════════
const getPath = (o, p) => p.reduce((x, k) => x?.[k], o);
const setPath = (o, p, v) => {
  const copy = JSON.parse(JSON.stringify(o));
  let x = copy;
  for (const k of p.slice(0, -1)) x = x[k] ??= {};
  x[p[p.length - 1]] = v;
  return copy;
};

function Pricing() {
  const [orig, setOrig] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('pricing_get').then((r) => { setOrig(r.config); setDraft(r.config); }).catch(toastErr); }, []);
  if (!draft) return html`<${Head} eyebrow="Pricing" title="What a shine costs." /><${Loading} />`;

  const dirty = JSON.stringify(draft) !== JSON.stringify(orig);
  const planMoved = TIERS.filter((t) => draft.plans?.[t]?.price !== orig.plans?.[t]?.price);
  // A plain render helper, not a component: a component defined here would remount (and
  // drop focus) on every keystroke.
  const num = (path, label, kind = 'money') => {
    const v = getPath(draft, path);
    const input = html`<input class=${'input' + (kind === 'money' ? ' money' : '')} inputmode="decimal" value=${v ?? ''}
      onInput=${(e) => { const raw = e.target.value.replace(/[^\d.]/g, ''); setDraft(setPath(draft, path, raw === '' ? '' : Number(raw))); }} />`;
    const wrapped = kind === 'money' ? html`<div class="money-wrap">${input}</div>`
      : kind === 'n' ? input : html`<div class="suffix-wrap" data-suffix=${kind === 'pct' ? '%' : '×'}>${input}</div>`;
    return html`<label class="field"><span>${label}</span>${wrapped}</label>`;
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api('pricing_save', { config: draft });
      setOrig(r.config); setDraft(r.config);
      toast('Prices saved. The app and website show them now.');
      if (r.stripeUpdated?.length) toast(`Stripe checkout updated for ${r.stripeUpdated.join(', ')}.`);
      if (r.warning) pushToast(r.warning, true);
    } catch (e) { toastErr(e); }
    setBusy(false);
  };

  return html`
    <${Head} eyebrow="Pricing" title="What a shine costs." lede="Change a number here and the app, the website and checkout all use it right away. No app update needed." />
    <div class="stack" style="gap:20px">
      <section class="card rise" style="--i:1"><h3 class="sub">Details (per car, sedan price)</h3>
        <div class="price-grid">${Object.keys(draft.services ?? {}).map((k) => html`${num(['services', k], SERVICE[k] || k)}`)}</div></section>
      <section class="card rise" style="--i:2"><h3 class="sub">Extras</h3>
        <div class="price-grid">${Object.keys(draft.extras ?? {}).map((k) => html`${num(['extras', k], EXTRA[k] || k)}`)}</div></section>
      <section class="card rise" style="--i:3"><h3 class="sub">Vehicle size</h3>
        <p class="muted small" style="margin:-6px 0 14px">The detail price is multiplied by this. Sedan is usually 1.</p>
        <div class="price-grid">${Object.keys(draft.sizeMultipliers ?? {}).map((k) => html`${num(['sizeMultipliers', k], SIZE[k] || k, 'x')}`)}</div></section>
      <section class="card rise" style="--i:4"><h3 class="sub">Checkout & website</h3>
        <div class="price-grid">
          ${num(['depositPercent'], 'Deposit', 'pct')}
          ${num(['anchorPrice'], 'Lock-my-slot fee')}
          ${num(['firstWashDiscountPercent'], 'First-wash discount', 'pct')}
          ${num(['packages', 'ministry'], 'Ministry package')}
          ${num(['topup', 'min'], 'Smallest top-up')}
          ${num(['topup', 'max'], 'Largest top-up')}
        </div></section>
      <section class="card rise" style="--i:5"><h3 class="sub">Membership plans</h3>
        ${planMoved.length > 0 && html`<div class="banner info"><${Icon} name="info" /><div>New members pay the new price and the join buttons update themselves.
          Current members keep the price they signed up at.</div></div>`}
        <div style="overflow-x:auto"><table class="plan-table">
          <thead><tr><th>Tier</th><th>Monthly</th><th>Details / mo</th><th>Member discount</th><th>Top-up bonus</th><th>Stamps per car</th></tr></thead>
          <tbody>${TIERS.filter((t) => draft.plans?.[t]).map((t) => html`<tr>
            <td><${Tier} tier=${t} /></td>
            <td style="min-width:110px">${num(['plans', t, 'price'], '')}</td>
            <td style="min-width:90px">${num(['plans', t, 'credits'], '', 'n')}</td>
            <td style="min-width:100px">${num(['plans', t, 'discountPercent'], '', 'pct')}</td>
            <td style="min-width:100px">${num(['plans', t, 'topupBonusPercent'], '', 'pct')}</td>
            <td style="min-width:90px">${num(['plans', t, 'stampsPerCar'], '', 'n')}</td>
          </tr>`)}</tbody></table></div>
      </section>
    </div>
    ${dirty && html`<div class="savebar"><span>Unsaved price changes</span><div class="row">
      <button class="btn sm" onClick=${() => setDraft(orig)}>Undo</button>
      <button class="btn primary sm" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : 'Save prices'}</button></div></div>`}`;
}

// ═══════════════════════════ settings (owner) ═══════════════════════════
function Settings({ me, signOut }) {
  return html`
    <${Head} eyebrow="Settings" title="Your team & payments." lede="Who can sign in, and how customers pay." />
    <div class="grid-2">
      <${Team} me=${me} />
      <${StripeCard} />
    </div>
    ${!me.open && html`<section class="card rise" style="--i:4;margin-top:20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div><b>Signed in as ${me.name}</b><div class="muted small">Sign out on shared devices.</div></div>
      <button class="btn" onClick=${signOut}><${Icon} name="logout" size=${18} /> Sign out</button>
    </section>`}`;
}

function Team({ me }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('manager');
  const [shown, setShown] = useState(null);
  const load = useCallback(() => api('staff_list').then(setList).catch(toastErr), []);
  useEffect(() => { load(); }, []);
  const add = () => api('staff_add', { name, role }).then((r) => { setShown({ name, code: r.code }); setName(''); load(); });
  const reset = (s) => api('staff_reset', { id: s.id }).then((r) => { setShown({ name: s.name, code: r.code }); load(); });
  const remove = (s) => api('staff_remove', { id: s.id }).then(() => { toast(`${s.name} can’t sign in anymore.`); load(); });
  return html`<section class="card rise" style="--i:1">
    <h3 class="sub">Team</h3>
    <p class="muted small" style="margin:-6px 0 16px">Managers run bookings, the calendar, customers, reports and leads. Prices, refunds, members, team and Stripe stay with owners.</p>
    ${shown && html`<div class="reveal" style="margin-bottom:16px"><div><b>${shown.name}</b>’s code. Share it privately; it won’t be shown again.</div>
      <code>${shown.code}</code><button class="btn sm" onClick=${() => copy(shown.code)}>Copy</button></div>`}
    ${!list ? html`<${Loading} />` : html`<div class="stack" style="gap:10px;margin-bottom:18px">
      ${list.length ? list.map((s) => html`<div class="car" key=${s.id} style="align-items:center">
        <div><b>${s.name}${s.id === me.id ? ' (you)' : ''}</b><small>${s.role === 'owner' ? 'Owner' : 'Manager'} · ${s.last_seen_at ? `seen ${ago(s.last_seen_at)}` : 'hasn’t signed in yet'}</small></div>
        <div class="row" style="gap:6px;flex-wrap:nowrap">
          <${ActionButton} class="btn sm" run=${() => reset(s)} confirmText=${`Make a new code for ${s.name}? Their old code stops working.`}>New code<//>
          ${s.id !== me.id && html`<${ActionButton} class="btn danger sm" run=${() => remove(s)} confirmText=${`Remove ${s.name}? They can’t sign in anymore.`}>Remove<//>`}
        </div></div>`) : html`<p class="muted" style="margin:0">Only the owner key so far. Add yourself and your managers.</p>`}
    </div>`}
    <div class="row">
      <label class="field"><span>Name</span><input class="input" value=${name} maxlength="60" onInput=${(e) => setName(e.target.value)} /></label>
      <label class="field" style="flex:0 1 140px"><span>Role</span><select class="input" value=${role} onChange=${(e) => setRole(e.target.value)}>
        <option value="manager">Manager</option><option value="owner">Owner</option></select></label>
      <${ActionButton} class="btn primary" run=${add} disabled=${!name.trim()}><${Icon} name="plus" size=${18} /> Add<//>
    </div>
  </section>`;
}

function StripeCard() {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api('stripe_status').then(setSt).catch(toastErr), []);
  useEffect(() => { load(); }, []);
  const connect = (secretKey = key) => api('stripe_connect', { secretKey }).then((r) => {
    setKey(''); setOpen(false);
    toast(`Stripe connected (${r.mode}). Webhook, plans and billing portal are set up.`);
    (r.warnings ?? []).forEach((w) => pushToast(w, true));
    load();
  }, (e) => { if (e.status === 502) pushToast('Stripe rejected the setup. Check the key has full (not restricted) access.', true); else throw e; });
  const Row = ({ label, children }) => html`<dt>${label}</dt><dd>${children}</dd>`;
  return html`<section class="card rise" style="--i:2">
    <h3 class="sub">Stripe payments</h3>
    ${!st ? html`<${Loading} />` : html`
      ${st.connected ? html`<dl class="kv" style="margin-bottom:16px">
          <${Row} label="Status"><span class="pill confirmed">Connected · ${st.mode === 'live' ? 'Live' : 'Test mode'}</span><//>
          <${Row} label="Account">${st.account}<//>
          <${Row} label="Webhook">${st.webhook === 'enabled' ? 'Working' : html`<span style="color:var(--bad)">${st.webhook} — reconnect</span>`}<//>
          <${Row} label="Member billing portal">${st.portal ? 'On' : 'Off'}<//>
        </dl>`
        : html`<div class="banner"><${Icon} name="alert" /><div><b>Not connected.</b> Customers can’t pay by card and memberships won’t set themselves up until you connect Stripe.</div></div>`}
      ${st.connected && (!st.portal || st.webhook !== 'enabled') && html`<div class="banner info"><${Icon} name="info" />
        <div style="flex:1"><b>Finish setup.</b> Turns on members switching plans and updating cards themselves, and makes sure every payment event reaches the app.</div>
        <${ActionButton} class="btn primary sm" run=${() => connect('')}>Finish setup<//></div>`}
      <div class="chips" style="margin-bottom:16px">${TIERS.filter((t) => st.links?.[t]).map((t) => html`<a class="chip" href=${st.links[t]} target="_blank" rel="noopener">${t[0].toUpperCase() + t.slice(1)} join link ↗</a>`)}</div>
      ${st.connected && !open ? html`<button class="btn sm" onClick=${() => setOpen(true)}>Reconnect or switch key</button>` : html`<div class="stack">
        <label class="field"><span>Stripe secret key</span><input class="input" type="password" autocomplete="off" spellcheck="false" placeholder="sk_test_… or sk_live_…"
          value=${key} onInput=${(e) => setKey(e.target.value.trim())} /></label>
        <p class="muted small" style="margin:0">Stripe Dashboard → Developers → API keys → Secret key. Try a test key first. Connecting sets up the webhook, the three membership plans and the members’ self-serve billing page for you.</p>
        <${ActionButton} class="btn primary" run=${() => connect()} disabled=${!key}><${Icon} name="card" size=${18} /> Connect Stripe<//>
      </div>`}`}
  </section>`;
}

render(html`<${App} />`, document.getElementById('app'));
