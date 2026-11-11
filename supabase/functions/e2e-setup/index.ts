// TEST-ONLY helper for the member-mode E2E. Runs with the service role, so it
// is gated behind the owner admin token (same secret as the owner page) to keep
// it from being an open backdoor. Actions:
//   create-user    { email, password } -> mints a confirmed email user + session-able account
//   booking-token  { bookingId }       -> returns a booking's confirm_token + status (for decline)
//   wallet-credit  { email, amount }    -> test balance for an @bldtest.co account; returns its login code
//   cleanup        { emailLike }        -> deletes all test data for emails matching a prefix
// The legacy phone create-user path is kept for older callers.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { loginCode } from '../_shared/codes.ts';

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function authorized(token: string): Promise<boolean> {
  if (!token) return false;
  const { data } = await admin().from('app_config').select('value').eq('key', 'owner_admin_token').single();
  return !!data?.value && token === data.value;
}

Deno.serve(async (req) => {
  const db = admin();
  const body = await req.json().catch(() => ({}));
  if (!(await authorized(String(body.token ?? '')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const action = String(body.action ?? (body.phone ? 'create-phone' : 'create-user'));

  if (action === 'create-phone') {
    const { data, error } = await db.auth.admin.createUser({ phone: body.phone, password: body.password, phone_confirm: true });
    if (error && !error.message.includes('already')) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ ok: true, userId: data?.user?.id ?? 'existing' });
  }

  if (action === 'create-user') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) return Response.json({ error: 'email+password required' }, { status: 400 });
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error && !error.message.includes('already')) return Response.json({ error: error.message }, { status: 400 });
    let userId = data?.user?.id;
    if (!userId) {
      // Already exists — find the id by listing (email filter).
      const { data: list } = await db.auth.admin.listUsers();
      userId = list?.users.find((u) => u.email === email)?.id;
    }
    return Response.json({ ok: true, userId });
  }

  if (action === 'booking-token') {
    // Return a booking's confirm_token (+status) so the E2E script can drive the
    // owner confirm/decline page without the service-role key. Member bookings
    // are keyed to membership.customer_id (not the auth uid), so RLS blocks the
    // booker's own session from reading confirm_token — this guarded read is the
    // only self-contained way for the standalone script to reach it.
    const id = String(body.bookingId ?? '');
    if (!id) return Response.json({ error: 'bookingId required' }, { status: 400 });
    const { data } = await db.from('bookings').select('confirm_token, status').eq('id', id).single();
    return Response.json({ ok: true, confirmToken: data?.confirm_token ?? null, status: data?.status ?? null });
  }

  if (action === 'wallet-credit') {
    // Balance without a Stripe payment, so the E2E can book with nothing due. Test
    // addresses only: it must not be a way to hand a real account free money.
    const email = String(body.email ?? '').trim().toLowerCase();
    const amount = Number(body.amount);
    if (!/^[^\s@]+@bldtest\.co$/.test(email)) return Response.json({ error: 'test emails only' }, { status: 400 });
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return Response.json({ error: 'bad amount' }, { status: 400 });
    await db.from('customers').upsert({ id: crypto.randomUUID(), email, name: 'E2E Tester' }, { onConflict: 'email', ignoreDuplicates: true });
    const { data: c } = await db.from('customers').select('id').eq('email', email).single();
    if (!c) return Response.json({ error: 'customer_failed' }, { status: 500 });
    const { error } = await db.from('wallet_ledger').insert({
      customer_id: c.id, delta: amount, reason: 'e2e credit', ref: `e2e:${crypto.randomUUID()}`,
    });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, code: await loginCode(db, c.id) });
  }

  if (action === 'cleanup') {
    const like = String(body.emailLike ?? '');
    if (!like || like.length < 4) return Response.json({ error: 'emailLike too broad' }, { status: 400 });
    const { data: custs } = await db.from('customers').select('id, email').ilike('email', `${like}%`);
    const ids = (custs ?? []).map((c) => c.id);
    let bookings = 0, members = 0, users = 0;
    if (ids.length) {
      const { data: bk, error: be } = await db.from('bookings').select('id').in('customer_id', ids);
      const bookingIds = (bk ?? []).map((b) => b.id);
      const { data: mem, error: me } = await db.from('memberships').select('id').in('customer_id', ids);
      if (be || me) return Response.json({ error: `lookup: ${(be ?? me)!.message}` }, { status: 500 });
      const memberIds = (mem ?? []).map((m) => m.id);
      // Children first (FKs). Any database error stops here and is reported (no false "ok").
      const steps: [string, unknown[], () => PromiseLike<{ error: { message: string } | null }>][] = [
        ['payments', bookingIds, () => db.from('payments').delete().in('booking_id', bookingIds)],
        ['customer_reports', bookingIds, () => db.from('customer_reports').delete().in('booking_id', bookingIds)],
        ['wallet_ledger', ids, () => db.from('wallet_ledger').delete().in('customer_id', ids)],
        ['topups', ids, () => db.from('topups').delete().in('customer_id', ids)],
        ['reward_ledger', memberIds, () => db.from('reward_ledger').delete().in('membership_id', memberIds)],
        ['redemptions', memberIds, () => db.from('redemptions').delete().in('membership_id', memberIds)],
        ['credit_ledger', memberIds, () => db.from('credit_ledger').delete().in('membership_id', memberIds)],
        ['bookings', bookingIds, () => db.from('bookings').delete().in('id', bookingIds)],
        ['memberships', memberIds, () => db.from('memberships').delete().in('id', memberIds)],
        ['customers', ids, () => db.from('customers').delete().in('id', ids)],
      ];
      for (const [t, list, run] of steps) {
        if (!list.length) continue;
        const { error } = await run();
        if (error) return Response.json({ error: `${t}: ${error.message}` }, { status: 500 });
      }
      bookings = bookingIds.length; members = memberIds.length;
    }
    // Always delete matching auth users by email prefix, even ones that never
    // created a customers row (e.g. a user minted but who never booked).
    const { data: list } = await db.auth.admin.listUsers();
    for (const u of list?.users ?? []) {
      if (u.email && u.email.startsWith(like)) { await db.auth.admin.deleteUser(u.id).catch(() => {}); users++; }
    }
    return Response.json({ ok: true, deleted: { customers: ids.length, bookings, members, users } });
  }

  if (action === 'member-reset') {
    // Undo an E2E run on the is_test member: its listed bookings (with their ledger rows, so
    // visits, balance and stamps come back) plus the 'test credit' top-ups made since `since`.
    // Test members only, and only bookings that belong to that member's customer.
    const code = String(body.code ?? '').trim().toUpperCase();
    const since = String(body.since ?? '');
    const wanted = Array.isArray(body.bookingIds) ? body.bookingIds.map(String) : [];
    if (!code || Number.isNaN(Date.parse(since))) return Response.json({ error: 'code+since required' }, { status: 400 });
    const { data: m, error: me } = await db.from('memberships').select('customer_id, is_test').eq('code', code).maybeSingle();
    if (me) return Response.json({ error: `memberships: ${me.message}` }, { status: 500 });
    if (!m?.is_test) return Response.json({ error: 'test members only' }, { status: 400 });
    const { data: bk, error: be } = wanted.length
      ? await db.from('bookings').select('id').in('id', wanted).eq('customer_id', m.customer_id)
      : { data: [], error: null };
    if (be) return Response.json({ error: `bookings: ${be.message}` }, { status: 500 });
    const ids = (bk ?? []).map((b) => b.id);
    const fail = (t: string, e: { message: string }) => Response.json({ error: `${t}: ${e.message}` }, { status: 500 });
    if (ids.length) {
      // a voucher that existed before the run goes back to the member; one made during the run goes
      const { error: re } = await db.from('redemptions').update({ status: 'issued', booking_id: null })
        .in('booking_id', ids).lt('created_at', since);
      if (re) return fail('redemptions', re);
      for (const t of ['payments', 'customer_reports', 'reward_ledger', 'redemptions', 'credit_ledger']) {
        const { error } = await db.from(t).delete().in('booking_id', ids);
        if (error) return fail(t, error);
      }
      // only this run's balance moves on these bookings; anything older is kept (and blocks the delete)
      const { error: we } = await db.from('wallet_ledger').delete().in('booking_id', ids).gte('created_at', since);
      if (we) return fail('wallet_ledger', we);
      const { error } = await db.from('bookings').delete().in('id', ids);
      if (error) return fail('bookings', error);
    }
    // exactly the test credits this run made (newest first), never another run's
    const n = Math.max(0, Math.min(50, Number(body.testCredits) || 0));
    let credits = 0;
    if (n) {
      const { data: rows, error: le } = await db.from('wallet_ledger').select('id')
        .eq('customer_id', m.customer_id).eq('reason', 'test credit').is('booking_id', null).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(n);
      if (le) return fail('wallet_ledger', le);
      const del = (rows ?? []).map((r) => r.id);
      if (del.length) {
        const { error: de } = await db.from('wallet_ledger').delete().in('id', del);
        if (de) return fail('wallet_ledger', de);
      }
      credits = del.length;
    }
    return Response.json({ ok: true, bookings: ids.length, testCredits: credits });
  }

  return Response.json({ error: 'unknown action' }, { status: 400 });
});
