# Aqualama Hydration Tracker

React hydration tracking app with dashboard, reminders, stats, premium state, WhatsApp/SMS reminder links, LocalStorage fallback, and optional Supabase persistence.

## Run Locally

```bash
npm install
npm run dev
```

## Connect Supabase

1. Open your Supabase project SQL editor:
   `https://supabase.com/dashboard/project/fowusyimwdvbldpzject/sql`
2. Copy everything from `supabase-schema.sql`.
3. Paste it into the SQL editor and run it.
4. Copy `.env.example` to `.env.local`.
5. In `.env.local`, keep:
   `VITE_SUPABASE_URL=https://fowusyimwdvbldpzject.supabase.co`
6. Replace `VITE_SUPABASE_ANON_KEY` with the anon public key from:
   Project Settings -> API -> Project API keys -> anon public.
7. Restart the dev server.

When connected, the app header will show `Supabase connected` or `Supabase synced`.

## Tables

- `users`
- `water_entries`
- `goals`
- `subscriptions`

The current SQL policies are permissive for a demo app. For production, replace them with authenticated-user policies tied to `auth.uid()`.
