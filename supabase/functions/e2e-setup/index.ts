// TEST-ONLY helper for the member-mode E2E. Runs with the service role, so it
// is gated behind the owner admin token (same secret as the owner page) to keep
// it from being an open backdoor. Two actions:
//   create-user  { email, password }  -> mints a confirmed email user + session-able account
//   cleanup      { emailLike }        -> deletes all test data for emails matching a prefix
// The legacy phone create-user path is kept for older callers.
import { createClient } from 'npm:@supabase/supabase-js@2';

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

  if (action === 'cleanup') {
    const like = String(body.emailLike ?? '');
    if (!like || like.length < 4) return Response.json({ error: 'emailLike too broad' }, { status: 400 });
    const { data: custs } = await db.from('customers').select('id, email').ilike('email', `${like}%`);
    const ids = (custs ?? []).map((c) => c.id);
    let bookings = 0, members = 0, users = 0;
    if (ids.length) {
      const { data: bk } = await db.from('bookings').select('id').in('customer_id', ids);
      const bookingIds = (bk ?? []).map((b) => b.id);
      const { data: mem } = await db.from('memberships').select('id').in('customer_id', ids);
      const memberIds = (mem ?? []).map((m) => m.id);
      // Children first (FKs).
      if (bookingIds.length) await db.from('payments').delete().in('booking_id', bookingIds);
      if (memberIds.length) {
        await db.from('reward_ledger').delete().in('membership_id', memberIds);
        await db.from('redemptions').delete().in('membership_id', memberIds);
        await db.from('credit_ledger').delete().in('membership_id', memberIds);
      }
      if (bookingIds.length) { await db.from('bookings').delete().in('id', bookingIds); bookings = bookingIds.length; }
      if (memberIds.length) { await db.from('memberships').delete().in('id', memberIds); members = memberIds.length; }
      await db.from('customers').delete().in('id', ids);
    }
    // Always delete matching auth users by email prefix, even ones that never
    // created a customers row (e.g. a user minted but who never booked).
    const { data: list } = await db.auth.admin.listUsers();
    for (const u of list?.users ?? []) {
      if (u.email && u.email.startsWith(like)) { await db.auth.admin.deleteUser(u.id).catch(() => {}); users++; }
    }
    return Response.json({ ok: true, deleted: { customers: ids.length, bookings, members, users } });
  }

  return Response.json({ error: 'unknown action' }, { status: 400 });
});
