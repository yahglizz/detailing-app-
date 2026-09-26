// The old owner page. Supabase serves HTML from functions as text/plain, so members,
// jobs and everything else moved to the dashboard; old bookmarks land there.
// Deployed with verify_jwt=false.
import { adminUrl } from '../_shared/notify.ts';

Deno.serve(() => new Response(null, { status: 302, headers: { Location: adminUrl() } }));
