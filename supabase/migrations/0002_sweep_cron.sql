-- Applied to project fiaadogbkvjcddehnymj on 2026-07-16 via MCP apply_migration "sweep_cron".
-- Vault secrets project_functions_url + sweep_bearer (anon key) were created in the same migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select vault.create_secret('<functions base url>', 'project_functions_url');
-- select vault.create_secret('<anon key>', 'sweep_bearer');

select cron.schedule(
  'sweep-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_functions_url') || '/sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_bearer'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb)
  $$
);
