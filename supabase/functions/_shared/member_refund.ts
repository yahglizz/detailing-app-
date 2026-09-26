import { esc, ownerEmail, sendEmail } from './notify.ts';

// When a booking is voided — owner decline on the confirm page, the 48h stale
// auto-refund in sweep, or a checkout walked away from — hand back what it consumed:
// prepaid balance, member credit(s), and any reward voucher it claimed. Otherwise the
// customer loses money or a wash for a detail that never happened. Safe to call on any
// booking, and more than once: each comes back only as far as this booking's own
// ledger rows are still negative, and the balance refund is keyed to the booking.
// Returns the dollars put back on the balance (for the customer's email).
// deno-lint-ignore no-explicit-any
export async function restoreMemberBalances(admin: any, booking: { id: string; membership_id: string | null }): Promise<number> {
  let walletBack = 0;
  const { data: spent } = await admin.from('wallet_ledger').select('delta, customer_id').eq('booking_id', booking.id);
  const owedWallet = -((spent ?? []) as { delta: number }[]).reduce((s, r) => s + r.delta, 0);
  if (owedWallet > 0) {
    const { error } = await admin.from('wallet_ledger').insert({
      customer_id: spent[0].customer_id, delta: owedWallet, reason: 'booking voided',
      booking_id: booking.id, ref: `void:${booking.id}`,
    });
    if (!error) walletBack = owedWallet;
    else if (error.code !== '23505') await restoreFailed(booking.id, `$${owedWallet} of balance`, error.message); // 23505: already put back
  }

  if (!booking.membership_id) return walletBack;
  const { data: rows } = await admin.from('credit_ledger').select('delta').eq('booking_id', booking.id);
  const owed = -((rows ?? []) as { delta: number }[]).reduce((s, r) => s + r.delta, 0);
  if (owed > 0) {
    const { error } = await admin.from('credit_ledger').insert({
      membership_id: booking.membership_id, delta: owed, reason: 'void refund', booking_id: booking.id,
    });
    if (error) await restoreFailed(booking.id, `${owed} wash credit${owed > 1 ? 's' : ''}`, error.message);
  }
  // Return any reward that attached to this booking to the redeemable pool.
  await admin.from('redemptions')
    .update({ status: 'issued', booking_id: null })
    .eq('booking_id', booking.id).eq('status', 'applied');
  return walletBack;
}

// Callers have already voided the booking, so nothing retries this: tell the owner.
async function restoreFailed(bookingId: string, what: string, why: string): Promise<void> {
  console.error('restore failed', bookingId, what, why);
  await sendEmail(ownerEmail(), `Action needed — ${what} not given back`,
    `<p>Booking ${bookingId} was voided, but its ${what} couldn't be given back automatically (${esc(why)}). Add it back by hand.</p>`);
}
