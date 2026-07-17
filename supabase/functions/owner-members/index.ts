import { createClient } from 'npm:@supabase/supabase-js@2';
import { type MemberCatalog, type Tier } from '../_shared/membership.ts';
import { sendEmail } from '../_shared/notify.ts';
import { provisionMember } from '../_shared/member_provision.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Customer name/email are typed by the customer at booking time and rendered
// into this token-bearing owner page — escape them so a booking can never
// inject script that steals the owner's admin token.
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const page = (inner: string) => new Response(
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BLD Members</title><style>
  body{background:#0E0D11;color:#fff;font-family:system-ui;margin:0;padding:24px;max-width:560px;margin-inline:auto}
  .card{background:#141217;border:1px solid #34303A;border-radius:16px;padding:20px;margin-bottom:16px}
  h1{font-size:22px;color:#A855F7}h2{font-size:16px;color:#fff}.muted{color:#A9A4AF;font-size:14px}
  .code{font-family:ui-monospace,monospace;font-size:24px;color:#F5B942;letter-spacing:2px}
  button,input,select{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid #34303A;font-size:15px;margin-top:8px}
  input,select{background:#0E0D11;color:#fff}
  .primary{background:linear-gradient(135deg,#7028C9,#A855F7);color:#fff;border:none;font-weight:700}
  .ghost{background:#141217;color:#D5D7DC}.danger{background:#141217;color:#F97066;border-color:#F97066}
  .row{display:flex;gap:8px}.row>*{flex:1}
  .tier-bronze{color:#CD7F32}.tier-silver{color:#C0C0C0}.tier-gold{color:#F5B942}
  </style></head><body>${inner}</body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

async function authed(req: Request): Promise<string | null> {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return null;
  const { data } = await admin().from('app_config').select('value').eq('key', 'owner_admin_token').single();
  const expected = data?.value ?? '';
  return expected && token === expected ? token : null;
}

async function renderHome(token: string) {
  const db = admin();
  const [{ data: members }, { data: jobs }] = await Promise.all([
    db.from('memberships').select('id, code, tier, active, customers(name, email)').order('created_at', { ascending: false }),
    db.from('bookings').select('id, preferred_day, time_slot, status, items, customers(name, email), membership_id')
      .in('status', ['requested', 'confirmed']).order('preferred_day'),
  ]);
  const memberRows = (members ?? []).map((m) => {
    const c = m.customers as unknown as { name: string; email: string };
    return `<div class="card">
      <h2>${esc(c?.name || c?.email || '—')} <span class="tier-${m.tier}">${(m.tier ?? '').toUpperCase()}</span>${m.active ? '' : ' · <span class="muted">INACTIVE</span>'}</h2>
      <div class="code">${m.code ?? ''}</div>
      <form method="POST" class="row">
        <input type="hidden" name="token" value="${token}"><input type="hidden" name="id" value="${m.id}">
        <select name="tier"><option value="bronze"${m.tier === 'bronze' ? ' selected' : ''}>Bronze</option><option value="silver"${m.tier === 'silver' ? ' selected' : ''}>Silver</option><option value="gold"${m.tier === 'gold' ? ' selected' : ''}>Gold</option></select>
        <button class="ghost" name="action" value="tier">Set tier</button>
        <button class="ghost" name="action" value="stamp">+1 stamp</button>
        <button class="danger" name="action" value="${m.active ? 'deactivate' : 'activate'}">${m.active ? 'Deactivate' : 'Reactivate'}</button>
      </form>
    </div>`;
  }).join('');
  const jobRows = (jobs ?? []).map((b) => {
    const c = b.customers as unknown as { name: string; email: string };
    const cars = (b.items as unknown[]).length;
    return `<div class="card"><h2>${b.preferred_day} ${b.time_slot ?? ''} — ${esc(c?.name || c?.email || '')}</h2>
      <p class="muted">${cars} car(s) · ${b.status}${b.membership_id ? ' · MEMBER' : ''}</p>
      <form method="POST"><input type="hidden" name="token" value="${token}"><input type="hidden" name="id" value="${b.id}">
      <button class="primary" name="action" value="done">Mark done${b.membership_id ? ' (+stamps)' : ''}</button></form></div>`;
  }).join('');
  return page(`
    <div class="card"><h1>Add a member</h1>
      <form method="POST">
        <input type="hidden" name="token" value="${token}">
        <input name="name" placeholder="Name" required>
        <input name="email" placeholder="Email" type="email" required>
        <select name="tier"><option value="bronze">Bronze</option><option value="silver">Silver</option><option value="gold">Gold</option></select>
        <button class="primary" name="action" value="add">Create member → get code</button>
      </form>
    </div>
    <div class="card"><h1>Jobs to finish</h1>${jobRows || '<p class="muted">No open jobs.</p>'}</div>
    <h1 style="margin:16px 0 8px">Members</h1>${memberRows || '<p class="muted">No members yet.</p>'}`);
}

Deno.serve(async (req) => {
  const token = await authed(req);
  if (!token) return page('<div class="card"><h1>Not found</h1><p class="muted">This link is invalid.</p></div>');
  const db = admin();

  if (req.method === 'GET') return renderHome(token);

  if (req.method === 'POST') {
    const form = await req.formData();
    const action = String(form.get('action') ?? '');
    const id = String(form.get('id') ?? '');

    if (action === 'add') {
      const name = String(form.get('name') ?? '').trim();
      const email = String(form.get('email') ?? '').trim().toLowerCase();
      const tier = String(form.get('tier') ?? 'bronze') as Tier;
      if (!name || !email) return page('<div class="card"><h1>Name and email required</h1></div>');

      // Same provisioning path the Stripe webhook uses (owner-issued = no stripe ids).
      const res = await provisionMember(db, { email, name, tier });
      if (!res.ok) return page(`<div class="card"><h1>Could not create — ${esc(res.error)}</h1></div>`);
      return page(`<div class="card"><h1>Member created ✓</h1>
        <p>${esc(name)} · ${tier.toUpperCase()} · ${res.credits} credits granted · welcome email sent.</p>
        <p class="muted">Their code (also emailed):</p><div class="code">${res.code}</div>
        <form method="GET"><input type="hidden" name="token" value="${token}"><button class="ghost">← Back</button></form></div>`);
    }

    if (action === 'tier') {
      const tier = String(form.get('tier') ?? '') as Tier;
      const { data: cat } = await db.from('catalog').select('config').eq('id', 1).single();
      const plan = (cat!.config as MemberCatalog).plans[tier];
      if (!plan) return page('<div class="card"><h1>Unknown tier</h1></div>');
      await db.from('memberships').update({ tier, plan: tier, credits_per_period: plan.credits }).eq('id', id);
      return renderHome(token);
    }
    if (action === 'deactivate' || action === 'activate') {
      await db.from('memberships').update({ active: action === 'activate' }).eq('id', id);
      return renderHome(token);
    }
    if (action === 'stamp') {
      await db.from('reward_ledger').insert({ membership_id: id, delta: 1, reason: 'manual grant' });
      return renderHome(token);
    }
    if (action === 'done') {
      const { data: b } = await db.from('bookings')
        .select('id, items, membership_id, customers(email, name)').eq('id', id).single();
      if (!b) return renderHome(token);
      await db.from('bookings').update({ status: 'done' }).eq('id', b.id);
      if (b.membership_id) {
        const stamps = (b.items as unknown[]).length;
        await db.from('reward_ledger').insert({
          membership_id: b.membership_id, delta: stamps, reason: 'wash completed', booking_id: b.id,
        });
        const c = b.customers as unknown as { email: string; name: string };
        const { data: bal } = await db.from('reward_ledger').select('delta').eq('membership_id', b.membership_id);
        const total = (bal ?? []).reduce((s, r) => s + r.delta, 0);
        await sendEmail(c.email, `+${stamps} stamp${stamps > 1 ? 's' : ''} earned — you have ${total}`,
          `<h2 style="color:#A855F7;margin:0 0 12px">Stamp${stamps > 1 ? 's' : ''} earned 🎉</h2>
           <p>Wash complete — you earned <b>${stamps} stamp${stamps > 1 ? 's' : ''}</b>. You now have <b>${total}</b>. Open the app to redeem rewards.</p>`);
      }
      return renderHome(token);
    }
    return page('<div class="card"><h1>Unknown action</h1></div>');
  }
  return new Response('method not allowed', { status: 405 });
});
