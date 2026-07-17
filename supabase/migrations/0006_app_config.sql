-- App-level secrets/config the edge functions read at runtime. This project has
-- no Supabase CLI available to `secrets set`, so runtime tokens live in a
-- service-role-only table instead of Deno.env. RLS is on with NO public policy,
-- so only edge functions (service role) can read it — never anon/authenticated.
create table if not exists app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table app_config enable row level security;
-- No policies: anon/authenticated get zero rows; service role bypasses RLS.

-- Owner members-admin token. The owner opens
-- /functions/v1/owner-members?token=<value> to add/manage members. Rotate by
-- updating this row.
insert into app_config (key, value) values ('owner_admin_token', '9cf1a2bfc23b29d9ece0e92237abd6e5349b5c6d90f06320')
on conflict (key) do update set value = excluded.value, updated_at = now();
