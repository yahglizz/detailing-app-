// The owner / management dashboard's API (the dashboard itself is a static page on
// Vercel — Supabase serves HTML from functions as text/plain, so no pages live here).
//
// POST {action, ...} with header x-staff-code:
//   - a staff member's personal code (only its sha256 is stored), or
//   - the owner master key, app_config.owner_admin_token (scripts use this too).
// Wrong codes share the member-code rate limit (code_attempts). Every action is checked
// against admin_rules.can(): managers run the day; prices, staff, refunds, members and
// Stripe are the owner's.
//
// Deployed with verify_jwt=false: browsers send an OPTIONS preflight with no JWT, and the
// staff code is the auth.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { can, validateCatalog, type Role } from '../_shared/admin_rules.ts';
import { clientIp, rateLimited, recordMiss } from '../_shared/codes.ts';
import { confirmBooking, declineBooking, markDone, type ActionResult } from '../_shared/owner_actions.ts';
import { provisionMember } from '../_shared/member_provision.ts';
import { walletBalance } from '../_shared/wallet.ts';
import type { MemberCatalog, Tier } from '../_shared/membership.ts';
import { stripeConnect, stripeStatus, syncPlanPrices } from '../_shared/stripe_admin.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CORS = {
  'Access-Control-Allow-Origin': '*', // auth is a header, never a cookie
  'Access-Control-Allow-Headers': 'content-type, x-staff-code, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const bad = (error: string, status = 400) => json({ error }, status);
const result = (r: ActionResult) =>
  r.ok ? json(r) : bad(r.error, r.error === 'not_found' ? 404 : r.error === 'bad_time' || r.error === 'bad_amount' ? 400 : 409);

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
type Staff = { id: string | null; name: string; role: Role };

const TIERS: Tier[] = ['bronze', 'silver', 'gold'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ['note', 'damage', 'complaint', 'no_show', 'payment', 'other'];
const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const BUCKET = 'report-photos';

// The business is in Philadelphia; "today" is its day, not UTC's.
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function staffCode(): string {
  const s = Array.from(crypto.getRandomValues(new Uint32Array(10)), (x) => ALPHABET[x % ALPHABET.length]).join('');
  return `STAFF-${s.slice(0, 5)}-${s.slice(5)}`;
}

async function signIn(req: Request): Promise<Staff | 'rate_limited' | null> {
  const ip = clientIp(req);
  if (await rateLimited(db, ip)) return 'rate_limited';
  const code = (req.headers.get('x-staff-code') ?? '').trim();
  if (code.length >= 8 && code.length <= 128) {
    const { data: s } = await db.from('staff').select('id, name, role')
      .eq('code_hash', await sha256(code.toUpperCase())).eq('active', true).maybeSingle();
    if (s) {
      await db.from('staff').update({ last_seen_at: new Date().toISOString() }).eq('id', s.id);
      return s as Staff;
    }
    const { data: t } = await db.from('app_config').select('value').eq('key', 'owner_admin_token').maybeSingle();
    const token = String(t?.value ?? '');
    // Hash both sides so the comparison time says nothing about the key.
    if (token && (await sha256(code)) === (await sha256(token))) return { id: null, name: 'Owner', role: 'owner' };
  }
  await recordMiss(db, ip);
  return null;
}

async function catalog(): Promise<MemberCatalog & Obj> {
  const { data, error } = await db.from('catalog').select('config').eq('id', 1).single();
  if (error) throw error;
  return data.config;
}

// ponytail: read-modify-write of the single catalog row (see stripe_admin.ts).
async function saveCatalog(config: Obj) {
  const { error } = await db.from('catalog').update({ config }).eq('id', 1);
  if (error) throw error;
}

// ——— bookings, shaped for the dashboard ———
const BOOKING_COLS = `id, preferred_day, time_slot, time_window, status, items, quote, address, notes,
  remainder_method, pay_mode, membership_id, scheduled_note, created_at, customer_id,
  customers(id, name, email, customer_reports(count)),
  payments(kind, amount_cents, provider, status, created_at)`;

function shape(b: Obj) {
  const q = b.quote ?? {};
  const pays = ((b.payments ?? []) as Obj[]).filter((p) => p.status === 'succeeded');
  const collected = pays.filter((p) => p.kind === 'remainder').reduce((s, p) => s + p.amount_cents, 0) / 100;
  const balanceDue = Number(q.balanceDue ?? q.remainder ?? 0);
  const voided = b.status === 'refunded' || b.status === 'declined';
  const c = b.customers ?? {};
  return {
    id: b.id, day: b.preferred_day, slot: b.time_slot, window: b.time_window, status: b.status,
    when: b.scheduled_note, address: b.address, notes: b.notes, remainderMethod: b.remainder_method,
    payMode: b.pay_mode, createdAt: b.created_at, items: b.items,
    customer: { id: c.id, name: c.name, email: c.email },
    reports: c.customer_reports?.[0]?.count ?? 0,
    total: Number(q.total ?? 0), payable: Number(q.payable ?? q.total ?? 0),
    paidOnline: Number(q.paidOnline ?? q.deposit ?? 0), walletUsed: Number(q.walletUsed ?? 0),
    creditsUsed: Number(q.creditsUsed ?? 0), savings: Number(q.savings ?? 0),
    balanceDue, collected, owing: voided ? 0 : Math.max(0, balanceDue - collected),
    tier: q.tier ?? null, member: !!b.membership_id, test: !!q.test,
    payments: pays.map((p) => ({ kind: p.kind, amount: p.amount_cents / 100, provider: p.provider, at: p.created_at })),
  };
}

// ——— actions ———
type Handler = (body: Obj, me: Staff) => Promise<Response>;

const handlers: Record<string, Handler> = {
  me: async (_b, me) => json({ id: me.id, name: me.name, role: me.role }),

  overview: async (_b, me) => {
    const today = todayISO();
    const [{ data: rows, error }, { count: newLeads }] = await Promise.all([
      db.from('bookings').select(BOOKING_COLS)
        .not('status', 'in', '("pending_payment","declined")') // mid-checkout / never paid
        .or(`preferred_day.gte.${addDays(today, -60)},status.in.(requested,confirmed)`)
        .order('preferred_day').order('time_slot', { nullsFirst: false }),
      db.from('quote_leads').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    ]);
    if (error) throw error;
    const bookings = (rows ?? []).map(shape);
    const open = (s: string) => s === 'requested' || s === 'confirmed';
    return json({
      me: { id: me.id, name: me.name, role: me.role }, today, newLeads: newLeads ?? 0, bookings,
      stats: {
        today: bookings.filter((b) => b.day === today && b.status !== 'refunded').length,
        upcoming: bookings.filter((b) => b.day >= today && open(b.status)).length,
        awaiting: bookings.filter((b) => b.status === 'requested').length,
        owing: bookings.filter((b) => b.status === 'confirmed' || b.status === 'done').reduce((s, b) => s + b.owing, 0),
      },
    });
  },

  booking: async (b) => {
    if (!UUID.test(String(b.id))) return bad('bad_id');
    const { data, error } = await db.from('bookings').select(BOOKING_COLS).eq('id', b.id).maybeSingle();
    if (error) throw error;
    return data ? json(shape(data)) : bad('not_found', 404);
  },

  confirm: async (b) => result(await confirmBooking(db, String(b.id), String(b.day ?? ''), b.slot ? String(b.slot) : null)),
  decline: async (b) => result(await declineBooking(db, String(b.id))),
  done: async (b) => result(await markDone(db, String(b.id),
    b.collected ? { amount: Number(b.collected.amount), method: b.collected.method } : null)),

  // ——— calendar ———
  calendar: async (b) => {
    const month = String(b.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad('bad_month');
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const [days, overrides, jobs, cfg] = await Promise.all([
      db.rpc('day_states', { from_day: from, to_day: to }),
      db.from('day_overrides').select('day, closed, capacity, note').gte('day', from).lte('day', to),
      db.from('bookings').select('id, preferred_day, time_slot, time_window, status, items, quote, customers(name, email)')
        .gte('preferred_day', from).lte('preferred_day', to).not('status', 'in', '("declined","refunded")')
        .order('time_slot', { nullsFirst: false }),
      catalog(),
    ]);
    if (days.error) throw days.error;
    return json({
      month, today: todayISO(), schedule: cfg.schedule ?? { dailyCapacity: 9, closedWeekdays: [] },
      days: days.data, overrides: overrides.data ?? [],
      jobs: (jobs.data ?? []).map((j: Obj) => ({
        id: j.id, day: j.preferred_day, slot: j.time_slot, window: j.time_window, status: j.status,
        name: j.customers?.name || j.customers?.email || '', cars: (j.items ?? []).length, test: !!j.quote?.test,
      })),
    });
  },

  set_day: async (b) => {
    const day = String(b.day ?? '');
    if (!ISO_DAY.test(day)) return bad('bad_day');
    if (b.clear) {
      const { error } = await db.from('day_overrides').delete().eq('day', day);
      if (error) throw error;
      return json({ ok: true });
    }
    const cap = b.capacity === null || b.capacity === undefined || b.capacity === '' ? null : Number(b.capacity);
    if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 50)) return bad('bad_capacity');
    const { error } = await db.from('day_overrides')
      .upsert({ day, closed: !!b.closed, capacity: cap, note: String(b.note ?? '').slice(0, 200) });
    if (error) throw error;
    return json({ ok: true });
  },

  set_schedule: async (b) => {
    const cap = Number(b.dailyCapacity);
    const closed = Array.isArray(b.closedWeekdays) ? [...new Set(b.closedWeekdays.map(Number))] : null;
    if (!Number.isInteger(cap) || cap < 0 || cap > 50) return bad('bad_capacity');
    if (!closed || closed.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return bad('bad_weekdays');
    const cfg = await catalog();
    await saveCatalog({ ...cfg, schedule: { dailyCapacity: cap, closedWeekdays: closed.sort() } });
    return json({ ok: true });
  },

  // ——— customers + private reports ———
  customers: async (b) => {
    let q = db.from('customers')
      .select('id, name, email, created_at, memberships(tier, active), customer_reports(count), bookings(count)')
      .order('created_at', { ascending: false }).limit(200);
    const s = String(b.q ?? '').replace(/[^\p{L}\p{N}@._+\- ]/gu, '').trim().slice(0, 60);
    if (s) q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
    const { data, error } = await q;
    if (error) throw error;
    return json((data ?? []).map((c: Obj) => ({
      id: c.id, name: c.name, email: c.email, since: c.created_at,
      tier: (c.memberships ?? []).find((m: Obj) => m.active)?.tier ?? null,
      reports: c.customer_reports?.[0]?.count ?? 0, bookings: c.bookings?.[0]?.count ?? 0,
    })));
  },

  customer: async (b, me) => {
    if (!UUID.test(String(b.id))) return bad('bad_id');
    const [{ data: c }, { data: bookings }, { data: reports }, { data: memberships }, wallet] = await Promise.all([
      db.from('customers').select('id, name, email, address, cars, code, created_at').eq('id', b.id).maybeSingle(),
      db.from('bookings').select(BOOKING_COLS).eq('customer_id', b.id)
        .not('status', 'in', '("pending_payment","declined")').order('preferred_day', { ascending: false }).limit(50),
      db.from('customer_reports').select('*').eq('customer_id', b.id).order('created_at', { ascending: false }),
      db.from('memberships').select('id, tier, active, code, is_test, stripe_subscription_id, created_at')
        .eq('customer_id', b.id).order('created_at', { ascending: false }),
      walletBalance(db, String(b.id)),
    ]);
    if (!c) return bad('not_found', 404);
    const paths = (reports ?? []).flatMap((r: Obj) => r.photos ?? []);
    const urls: Record<string, string> = {};
    if (paths.length) {
      const { data: signed } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
      for (const s of signed ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
    }
    // Login codes unlock a customer's balance: only the owner sees them.
    const owner = me.role === 'owner';
    return json({
      customer: { ...c, code: owner ? c.code : undefined },
      wallet,
      memberships: (memberships ?? []).map((m: Obj) => ({ ...m, code: owner ? m.code : undefined, billing: !!m.stripe_subscription_id })),
      bookings: (bookings ?? []).map(shape),
      reports: (reports ?? []).map((r: Obj) => ({
        ...r, photoUrls: (r.photos ?? []).map((p: string) => urls[p]).filter(Boolean),
        mine: !!me.id && r.author_staff_id === me.id,
      })),
    });
  },

  photo_upload_url: async (b) => {
    const ext = String(b.ext ?? '').toLowerCase();
    if (!UUID.test(String(b.customerId)) || !PHOTO_EXT.includes(ext)) return bad('bad_photo');
    const path = `${b.customerId}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    return json({ path, signedUrl: data.signedUrl });
  },

  report_add: async (b, me) => {
    const customerId = String(b.customerId ?? '');
    const category = String(b.category ?? 'note');
    const body = String(b.body ?? '').trim();
    const photos: unknown[] = Array.isArray(b.photos) ? b.photos : [];
    if (!UUID.test(customerId)) return bad('bad_id');
    if (!CATEGORIES.includes(category)) return bad('bad_category');
    if (!body || body.length > 4000) return bad('bad_body');
    const photoRe = new RegExp(`^${customerId}/[0-9a-f-]{36}\\.(${PHOTO_EXT.join('|')})$`);
    if (photos.length > 6 || photos.some((p) => typeof p !== 'string' || !photoRe.test(p))) return bad('bad_photos');
    let bookingId: string | null = null;
    if (b.bookingId) {
      const { data: bk } = await db.from('bookings').select('customer_id').eq('id', b.bookingId).maybeSingle();
      if (bk?.customer_id !== customerId) return bad('bad_booking');
      bookingId = String(b.bookingId);
    }
    const { data, error } = await db.from('customer_reports').insert({
      customer_id: customerId, booking_id: bookingId, category, body, photos,
      author_staff_id: me.id, author_name: me.name,
    }).select('id').single();
    if (error) throw error;
    return json({ ok: true, id: data.id });
  },

  report_delete: async (b, me) => {
    const { data: r } = await db.from('customer_reports').select('id, photos, author_staff_id').eq('id', b.id).maybeSingle();
    if (!r) return bad('not_found', 404);
    if (me.role !== 'owner' && r.author_staff_id !== me.id) return bad('forbidden', 403);
    if (r.photos?.length) await db.storage.from(BUCKET).remove(r.photos);
    const { error } = await db.from('customer_reports').delete().eq('id', r.id);
    if (error) throw error;
    return json({ ok: true });
  },

  // ——— website leads ———
  leads: async () => {
    const { data, error } = await db.from('quote_leads').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    return json(data ?? []);
  },

  lead_status: async (b) => {
    if (!['new', 'contacted', 'booked', 'lost'].includes(b.status)) return bad('bad_status');
    const { error } = await db.from('quote_leads').update({ status: b.status }).eq('id', b.id);
    if (error) throw error;
    return json({ ok: true });
  },

  // ——— members (owner) ———
  members: async () => {
    const { data, error } = await db.from('memberships')
      .select('id, code, tier, active, is_test, stripe_subscription_id, created_at, customers(id, name, email)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return json((data ?? []).map((m: Obj) => ({ ...m, billing: !!m.stripe_subscription_id, stripe_subscription_id: undefined })));
  },

  member_add: async (b) => {
    const name = String(b.name ?? '').trim().slice(0, 80);
    const email = String(b.email ?? '').trim().toLowerCase();
    const tier = String(b.tier ?? '') as Tier;
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !TIERS.includes(tier)) return bad('bad_member');
    const r = await provisionMember(db, { email, name, tier }); // same path the Stripe webhook uses
    return r.ok ? json({ ok: true, code: r.code, credits: r.credits }) : bad(r.error, 409);
  },

  member_tier: async (b) => {
    const tier = String(b.tier ?? '') as Tier;
    if (!TIERS.includes(tier)) return bad('bad_tier');
    const plan = (await catalog()).plans[tier];
    const { data, error } = await db.from('memberships')
      .update({ tier, plan: tier, credits_per_period: plan.credits }).eq('id', b.id).select('stripe_subscription_id');
    if (error) throw error;
    return json({
      ok: true,
      // Stripe keeps billing the plan they pay for; they switch it themselves in the app.
      warning: data?.[0]?.stripe_subscription_id ? 'This member pays through Stripe — their card is still billed for their old plan.' : undefined,
    });
  },

  member_active: async (b) => {
    const { error } = await db.from('memberships').update({ active: !!b.active }).eq('id', b.id);
    if (error) throw error;
    return json({ ok: true });
  },

  member_stamp: async (b) => {
    const { error } = await db.from('reward_ledger').insert({ membership_id: b.id, delta: 1, reason: 'manual grant' });
    if (error) throw error;
    return json({ ok: true });
  },

  // ——— prices (owner) ———
  pricing_get: async () => json({ config: await catalog() }),

  pricing_save: async (b) => {
    const prev = await catalog();
    const r = validateCatalog(b.config, prev);
    if (!r.ok) return bad(r.error);
    // Stripe first: if the new plan prices can't be made there, nothing changes here.
    const sync = await syncPlanPrices(db, r.config, r.changedPlanPrices);
    if (!sync.ok) return bad(sync.error, 502);
    if (sync.stripe) r.config.stripe = sync.stripe;
    await saveCatalog(r.config);
    return json({
      ok: true, config: r.config, warning: sync.warning,
      stripeUpdated: sync.stripe ? r.changedPlanPrices : [],
    });
  },

  // ——— staff (owner) ———
  staff_list: async () => {
    const { data, error } = await db.from('staff').select('id, name, role, active, created_at, last_seen_at').order('created_at');
    if (error) throw error;
    return json(data ?? []);
  },

  staff_add: async (b) => {
    const name = String(b.name ?? '').trim().slice(0, 60);
    const role = b.role === 'owner' ? 'owner' : 'manager';
    if (!name) return bad('bad_name');
    const code = staffCode();
    const { data, error } = await db.from('staff').insert({ name, role, code_hash: await sha256(code) }).select('id').single();
    if (error) throw error;
    return json({ ok: true, id: data.id, code }); // shown once, never stored in the clear
  },

  staff_reset: async (b) => {
    const code = staffCode();
    const { data, error } = await db.from('staff').update({ code_hash: await sha256(code), active: true }).eq('id', b.id).select('id');
    if (error) throw error;
    return data?.length ? json({ ok: true, code }) : bad('not_found', 404);
  },

  staff_remove: async (b, me) => {
    if (b.id === me.id) return bad('cannot_remove_self');
    const { error } = await db.from('staff').delete().eq('id', b.id);
    if (error) throw error;
    return json({ ok: true });
  },

  // ——— Stripe (owner) ———
  stripe_status: async () => json(await stripeStatus(db)),
  stripe_connect: async (b) => {
    const r = await stripeConnect(db, b.secretKey);
    return r.ok ? json(r) : json(r, r.error === 'bad_key' ? 400 : 502);
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return bad('method_not_allowed', 405);
  let body: Obj;
  try { body = await req.json(); } catch { return bad('bad_json'); }
  if (!body || typeof body !== 'object') return bad('bad_json');

  const me = await signIn(req);
  if (me === 'rate_limited') return bad('rate_limited', 429);
  if (!me) return bad('bad_code', 401);

  const action = String(body.action ?? '');
  if (!can(me.role, action)) return bad('forbidden', 403);
  try {
    return await handlers[action](body, me);
  } catch (e) {
    console.error('admin action failed', action, (e as Error)?.message ?? e);
    return bad('server_error', 500);
  }
});
