import { createClient } from 'npm:@supabase/supabase-js@2';
import { priceOrder, type CarItem, type CatalogConfig } from '../_shared/pricing.ts';

Deno.serve(async (req) => {
  try {
    const { items } = (await req.json()) as { items: CarItem[] };
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await admin.from('catalog').select('config').eq('id', 1).single();
    if (error) throw error;
    const quote = priceOrder(items, data.config as CatalogConfig);
    return Response.json({ quote });
  } catch (e) {
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 400 });
  }
});
