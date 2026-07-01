create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Kailash',
  phone text,
  notification_method text not null default 'WhatsApp'
    check (notification_method in ('WhatsApp', 'SMS')),
  reminders_on boolean not null default true,
  reminder_gap_hours integer not null default 2
    check (reminder_gap_hours between 1 and 8),
  theme text not null default 'Lagoon'
    check (theme in ('Lagoon', 'Mint', 'Coral')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  daily_goal_ml integer not null default 2500
    check (daily_goal_ml between 1000 and 5000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.water_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  entry_date date not null default current_date,
  entry_time text not null,
  drink_type text not null default 'Water'
    check (drink_type in ('Water', 'Tea', 'Coffee', 'Juice')),
  amount_ml integer not null check (amount_ml > 0),
  hydration_credit_ml integer not null check (hydration_credit_ml > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plan text not null default 'Free'
    check (plan in ('Free', 'Monthly', 'Yearly')),
  status text not null default 'active'
    check (status in ('active', 'cancelled', 'expired')),
  price_inr integer not null default 0,
  started_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.reminder_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  method text not null check (method in ('WhatsApp', 'SMS')),
  phone text not null,
  message text not null,
  status text not null check (status in ('sent', 'failed')),
  provider_sid text,
  error_message text,
  sent_at timestamptz not null default now()
);

create index if not exists idx_goals_user_active on public.goals(user_id, active);
create index if not exists idx_water_entries_user_date on public.water_entries(user_id, entry_date desc);
create index if not exists idx_subscriptions_user_status on public.subscriptions(user_id, status);
create index if not exists idx_reminder_logs_user_sent on public.reminder_logs(user_id, sent_at desc);

alter table public.users enable row level security;
alter table public.goals enable row level security;
alter table public.water_entries enable row level security;
alter table public.subscriptions enable row level security;
alter table public.reminder_logs enable row level security;

drop policy if exists "Allow anon demo users read users" on public.users;
drop policy if exists "Allow anon demo users insert users" on public.users;
drop policy if exists "Allow anon demo users update users" on public.users;
drop policy if exists "Allow anon demo goals" on public.goals;
drop policy if exists "Allow anon demo water entries" on public.water_entries;
drop policy if exists "Allow anon demo subscriptions" on public.subscriptions;
drop policy if exists "Allow anon demo reminder logs" on public.reminder_logs;

create policy "Allow anon demo users read users"
  on public.users for select
  using (true);

create policy "Allow anon demo users insert users"
  on public.users for insert
  with check (true);

create policy "Allow anon demo users update users"
  on public.users for update
  using (true)
  with check (true);

create policy "Allow anon demo goals"
  on public.goals for all
  using (true)
  with check (true);

create policy "Allow anon demo water entries"
  on public.water_entries for all
  using (true)
  with check (true);

create policy "Allow anon demo subscriptions"
  on public.subscriptions for all
  using (true)
  with check (true);

create policy "Allow anon demo reminder logs"
  on public.reminder_logs for all
  using (true)
  with check (true);
