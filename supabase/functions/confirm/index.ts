// Old emailed "confirm" links. Supabase serves HTML from functions as text/plain, so the
// owner now confirms, reschedules and declines in the dashboard; this only forwards a
// link from an older email to that booking there. Deployed with verify_jwt=false.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { adminLink, adminUrl } from '../_shared/notify.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const { data } = token
    ? await db.from('bookings').select('id').eq('confirm_token', token).maybeSingle()
    : { data: null };
  return new Response(null, { status: 302, headers: { Location: data ? adminLink(data.id) : adminUrl() } });
});
