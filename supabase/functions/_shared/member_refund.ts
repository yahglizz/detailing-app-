// When a member booking is voided — owner decline on the confirm page, or the
// 48h stale auto-refund in sweep — the deposit is refunded, but the booking
// already consumed the member's scarce balances at booking time: the credit(s)
// it spent and any reward voucher it claimed. Give those back, or the member
// loses a credit/reward for a wash that never happened (violates the
// no-credit/stamp-drift invariant). Safe to call on any booking; a no-op for
// non-member bookings.
// deno-lint-ignore no-explicit-any
export async function restoreMemberBalances(admin: any, booking: { id: string; membership_id: string | null; quote: unknown }): Promise<void> {
  if (!booking.membership_id) return;
  const creditsUsed = (booking.quote as { creditsUsed?: number })?.creditsUsed ?? 0;
  if (creditsUsed > 0) {
    await admin.from('credit_ledger').insert({
      membership_id: booking.membership_id, delta: creditsUsed, reason: 'void refund', booking_id: booking.id,
    });
  }
  // Return any reward that attached to this booking to the redeemable pool.
  await admin.from('redemptions')
    .update({ status: 'issued', booking_id: null })
    .eq('booking_id', booking.id).eq('status', 'applied');
}
