// TEST-ONLY helper: creates a phone+password test user so the E2E script can
// mint a real session without SMS. Deleted immediately after the E2E run.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { phone, password } = await req.json();
  const { data, error } = await admin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  if (error && !error.message.includes('already')) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  return Response.json({ ok: true, userId: data?.user?.id ?? 'existing' });
});
