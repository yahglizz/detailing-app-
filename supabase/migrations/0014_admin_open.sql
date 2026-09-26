-- 0014_admin_open.sql
-- Pre-launch: the owner asked for the dashboard with no login until everything is
-- published. While this is 'true', anyone who opens /admin is treated as the owner.
-- Turn the login back on before launch (no redeploy needed):
--   update app_config set value = 'false', updated_at = now() where key = 'admin_open';
insert into app_config (key, value) values ('admin_open', 'true')
  on conflict (key) do update set value = excluded.value, updated_at = now();
