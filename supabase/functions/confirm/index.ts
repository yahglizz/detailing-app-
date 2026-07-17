import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { sendEmail } from '../_shared/notify.ts';
import { restoreMemberBalances } from '../_shared/member_refund.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const page = (inner: string) => new Response(
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Brotherly Love Detailing</title><style>
  body{background:#0E0D11;color:#fff;font-family:system-ui;margin:0;padding:24px;max-width:480px;margin-inline:auto}
  .card{background:#141217;border:1px solid #34303A;border-radius:16px;padding:20px;margin-bottom:16px}
  h1{font-size:22px;color:#A855F7}.muted{color:#A9A4AF;font-size:14px}
  button,input{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #34303A;font-size:16px;margin-top:10px}
  input{background:#0E0D11;color:#fff}
  .primary{background:linear-gradient(135deg,#7028C9,#A855F7);color:#fff;border:none;font-weight:700}
  .ghost{background:#141217;color:#D5D7DC}.danger{background:#141217;color:#F97066;border-color:#F97066}
  </style></head><body>${inner}</body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

async function loadBooking(token: string) {
  const { data } = await admin()
    .from('bookings')
    .select('*, customers(email, name)')
    .eq('confirm_token', token)
    .single();
  return data;
}

Deno.serve(async (req) => {
  const db = admin();

  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const b = await loadBooking(token);
    if (!b) return page('<div class="card"><h1>Not found</h1><p class="muted">This link is invalid.</p></div>');
    if (b.status !== 'requested') {
      return page(`<div class="card"><h1>Already handled</h1><p class="muted">Status: ${b.status}</p></div>`);
    }
    const items = (b.items as { size: string; service: string; extras: string[] }[])
      .map((i, n) => `<div>Car ${n + 1}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
      .join('');
    const q = b.quote as { total: number; deposit: number; remainder: number };
    return page(`
      <div class="card"><h1>New Detail Request</h1>
        ${items}
        <p class="muted">${b.preferred_day} · ${b.time_window} · ${b.address}</p>
        <p class="muted">Notes: ${b.notes || '—'}</p>
        <p>Total $${q.total} · Deposit $${q.deposit} PAID · $${q.remainder} due (${b.remainder_method})</p>
      </div>
      <form method="POST" class="card">
        <input type="hidden" name="token" value="${token}">
        <input name="time" placeholder="Exact time, e.g. Thu 10:00 AM">
        <button class="primary" name="action" value="confirm">Confirm this time</button>
        <button class="ghost" name="action" value="propose">Propose this time instead</button>
        <button class="danger" name="action" value="decline">Decline &amp; refund</button>
      </form>`);
  }

  if (req.method === 'POST') {
    const form = await req.formData();
    const token = String(form.get('token') ?? '');
    const action = String(form.get('action') ?? '');
    const time = String(form.get('time') ?? '').trim();
    const b = await loadBooking(token);
    if (!b || b.status !== 'requested') return page('<div class="card"><h1>Already handled</h1></div>');
    const customerEmail = (b.customers as { email: string }).email;

    if (action === 'confirm') {
      if (!time) return page('<div class="card"><h1>Enter a time first</h1><p class="muted">Go back and type the exact time.</p></div>');
      await db.from('bookings').update({ status: 'confirmed', scheduled_note: time }).eq('id', b.id);
      await sendEmail(customerEmail, `You're confirmed for ${time}`,
        `<h2 style="color:#A855F7;margin:0 0 12px">You're confirmed ✓</h2>
         <p>We'll see you <b>${time}</b> at ${b.address}.</p>
         <p style="color:#A9A4AF">Reply to this email if anything changes.</p>`);
      return page('<div class="card"><h1>Confirmed ✓</h1><p class="muted">Customer has been emailed.</p></div>');
    }
    if (action === 'propose') {
      if (!time) return page('<div class="card"><h1>Enter a time first</h1></div>');
      await sendEmail(customerEmail, `Does ${time} work instead?`,
        `<h2 style="color:#A855F7;margin:0 0 12px">Small change?</h2>
         <p>That window is tight for us — does <b>${time}</b> work instead?</p>
         <p style="color:#A9A4AF">Reply to this email and we'll lock it in.</p>`);
      return page('<div class="card"><h1>Proposal sent</h1><p class="muted">Booking stays pending until you confirm.</p></div>');
    }
    if (action === 'decline') {
      const { data: pay } = await db.from('payments').select('provider_ref')
        .eq('booking_id', b.id).eq('kind', 'deposit').eq('status', 'succeeded').single();
      if (pay?.provider_ref) {
        const r = await getProvider().refund({ bookingId: b.id, providerRef: pay.provider_ref });
        if (r.ok) {
          const q = b.quote as { deposit: number };
          await db.from('payments').insert({
            booking_id: b.id, kind: 'refund', amount_cents: q.deposit * 100,
            status: 'succeeded', provider: 'fake', provider_ref: r.ref,
          });
        }
      }
      await restoreMemberBalances(db, b);
      await db.from('bookings').update({ status: 'refunded' }).eq('id', b.id);
      await sendEmail(customerEmail, 'Your deposit has been refunded',
        `<h2 style="color:#A855F7;margin:0 0 12px">Sorry — we couldn't take this one</h2>
         <p>Your deposit has been refunded in full.</p>
         <p style="color:#A9A4AF">Hope to catch you next time.</p>`);
      return page('<div class="card"><h1>Declined &amp; refunded</h1><p class="muted">Customer has been emailed.</p></div>');
    }
    return page('<div class="card"><h1>Unknown action</h1></div>');
  }

  return new Response('method not allowed', { status: 405 });
});
