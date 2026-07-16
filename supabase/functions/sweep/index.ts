import { createClient } from 'npm:@supabase/supabase-js@2';
import { getProvider } from '../_shared/payments/provider.ts';
import { sendEmail, ownerEmail, functionsBaseUrl, button } from '../_shared/notify.ts';

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3600e3).toISOString();
  let reminded = 0, refunded = 0;

  const { data: stale } = await db.from('bookings')
    .select('id, confirm_token, created_at, quote, reminder_sent_at, customers(email)')
    .eq('status', 'requested').lt('created_at', dayAgo);

  for (const b of stale ?? []) {
    if (b.created_at < twoDaysAgo) {
      const { data: pay } = await db.from('payments').select('provider_ref')
        .eq('booking_id', b.id).eq('kind', 'deposit').eq('status', 'succeeded').single();
      if (pay?.provider_ref) {
        const r = await getProvider().refund({ bookingId: b.id, providerRef: pay.provider_ref });
        if (r.ok) {
          await db.from('payments').insert({
            booking_id: b.id, kind: 'refund',
            amount_cents: (b.quote as { deposit: number }).deposit * 100,
            status: 'succeeded', provider: 'fake', provider_ref: r.ref,
          });
        }
      }
      await db.from('bookings').update({ status: 'refunded' }).eq('id', b.id);
      await sendEmail((b.customers as unknown as { email: string }).email,
        'Your deposit has been refunded',
        `<h2 style="color:#A855F7;margin:0 0 12px">Sorry about that</h2>
         <p>We couldn't get to your request in time, so your deposit has been refunded in full.</p>`);
      refunded++;
    } else if (!b.reminder_sent_at) {
      await sendEmail(ownerEmail(), 'Unanswered detail request — auto-refund in 24h',
        `<h2 style="color:#A855F7;margin:0 0 12px">Still waiting on you</h2>
         <p>A detail request from yesterday hasn't been answered. It auto-refunds at 48 hours.</p>
         ${button(`${functionsBaseUrl()}/confirm?token=${b.confirm_token}`, 'Handle it now →')}`);
      await db.from('bookings').update({ reminder_sent_at: new Date().toISOString() }).eq('id', b.id);
      reminded++;
    }
  }
  return Response.json({ reminded, refunded });
});
