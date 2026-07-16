import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';
import { getProvider } from '../_shared/payments/provider.ts';
import type { CardDetails } from '../_shared/payments/types.ts';
import { sendEmail, ownerEmail, functionsBaseUrl, button } from '../_shared/notify.ts';

interface BookBody {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
  expectedTotal: number;
  card: CardDetails;
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user || !user.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body: BookBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.address?.trim() || !body.preferredDay) return Response.json({ error: 'missing_fields' }, { status: 400 });

  const { data: cat, error: catErr } = await admin.from('catalog').select('config').eq('id', 1).single();
  if (catErr) return Response.json({ error: 'catalog_unavailable' }, { status: 500 });

  let quote;
  try {
    quote = priceOrder(body.items, cat.config as CatalogConfig);
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 400 });
  }
  // Server price is authoritative; surface any drift BEFORE charging.
  if (body.expectedTotal !== quote.total) {
    return Response.json({ error: 'price_changed', quote }, { status: 409 });
  }

  await admin.from('customers').upsert({ id: user.id, email: user.email, name: body.name ?? '' });

  const confirmToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const { data: booking, error: insErr } = await admin
    .from('bookings')
    .insert({
      customer_id: user.id,
      items: body.items,
      quote,
      address: body.address.trim(),
      preferred_day: body.preferredDay,
      time_window: body.window,
      notes: body.notes ?? '',
      remainder_method: body.remainderMethod,
      status: 'pending_payment',
      confirm_token: confirmToken,
    })
    .select()
    .single();
  if (insErr) return Response.json({ error: 'booking_insert_failed' }, { status: 500 });

  const charge = await getProvider().chargeDeposit({
    bookingId: booking.id,
    amountCents: quote.deposit * 100,
    card: body.card,
  });
  if (!charge.ok) {
    // Booking stays pending_payment; customer can retry; sweep ignores it.
    return Response.json({ error: charge.error }, { status: 402 });
  }

  await admin.from('payments').insert({
    booking_id: booking.id,
    kind: 'deposit',
    amount_cents: quote.deposit * 100,
    status: 'succeeded',
    provider: 'fake',
    provider_ref: charge.ref,
  });
  await admin.from('bookings').update({ status: 'requested' }).eq('id', booking.id);

  const summary = body.items
    .map((i, n) => `<div>Car ${n + 1}: <b>${i.service}</b> / ${i.size}${i.extras.length ? ' + ' + i.extras.join(', ') : ''}</div>`)
    .join('');
  const link = `${functionsBaseUrl()}/confirm?token=${confirmToken}`;
  const shortSummary = body.items.map((i) => `${i.service}/${i.size}`).join(', ');

  await sendEmail(
    ownerEmail(),
    `New detail — ${shortSummary} — $${quote.deposit} deposit PAID`,
    `<h2 style="color:#A855F7;margin:0 0 12px">New Detail Request</h2>
     ${summary}
     <p style="color:#A9A4AF">${body.preferredDay} · ${body.window} · ${body.address}</p>
     <p style="color:#A9A4AF">Notes: ${body.notes || '—'}</p>
     <p>Total $${quote.total} · Deposit $${quote.deposit} PAID · $${quote.remainder} due (${body.remainderMethod})</p>
     ${button(link, 'Confirm or decline →')}`,
  );

  await sendEmail(
    user.email,
    `We got your detail request — $${quote.deposit} deposit received`,
    `<h2 style="color:#A855F7;margin:0 0 12px">Thanks${body.name ? ', ' + body.name : ''}!</h2>
     ${summary}
     <p style="color:#A9A4AF">${body.preferredDay} · ${body.window} · ${body.address}</p>
     <p>Deposit paid: $${quote.deposit}. Due at the detail: $${quote.remainder} (${body.remainderMethod}).</p>
     <p style="color:#A9A4AF">We'll email you shortly to lock in your exact time.</p>`,
  );

  return Response.json({ bookingId: booking.id, quote });
});
