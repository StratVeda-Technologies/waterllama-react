alter table public.users
  drop constraint if exists users_reminder_gap_hours_check;

alter table public.users
  add constraint users_reminder_gap_hours_check
  check (reminder_gap_hours between 1 and 8);

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

create index if not exists idx_reminder_logs_user_sent
  on public.reminder_logs(user_id, sent_at desc);

alter table public.reminder_logs enable row level security;

drop policy if exists "Allow anon demo reminder logs" on public.reminder_logs;

create policy "Allow anon demo reminder logs"
  on public.reminder_logs for all
  using (true)
  with check (true);
