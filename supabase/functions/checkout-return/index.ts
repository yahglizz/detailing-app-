// Stripe Checkout sends the customer here when they finish or back out; bounce them
// straight into the app, which then asks `book` or `topup` (action 'settle') what happened.
// Only app deep links are allowed, so this can't be used as an open redirect.
// Deployed with verify_jwt=false: it's a plain browser redirect with no Supabase JWT.
Deno.serve((req) => {
  const to = new URL(req.url).searchParams.get('to') ?? '';
  if (!/^(exp|exps|bld):\/\/\S+$/.test(to)) return new Response('Bad return link', { status: 400 });
  return new Response(null, { status: 302, headers: { Location: to } });
});
