-- 0010_quote_leads.sql
-- Capture instant-quote leads from the marketing website. A visitor picks a service +
-- vehicle size, gets an instant price (10% off first wash), and Accept/Decline records
-- the lead so the owner can follow up. Website inserts directly with the anon key.
create table if not exists quote_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  phone text,
  email text,
  vehicle text,
  service text,            -- catalog key: outside | inside | full | ceramic | membership
  size text,               -- sedan | suv | truck
  quoted_price int,        -- exact price for that service+size, in dollars
  discounted_price int,    -- after 10% first-wash discount
  accepted boolean not null default false,
  message text
);

alter table quote_leads enable row level security;

-- Anonymous website visitors may only INSERT a lead. No read/update/delete for anon;
-- the owner reads leads with the service role. (No SELECT policy = anon cannot read back.)
drop policy if exists quote_leads_anon_insert on quote_leads;
create policy quote_leads_anon_insert on quote_leads
  for insert to anon
  with check (true);
