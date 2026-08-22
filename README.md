# LoadShift

## Run locally

```bash
npm install
npm run dev
```

The app reads these variables from `.env` or `.env.local`:

```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

## Supabase setup

Run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL Editor. It creates:

- `profiles`, linked to `auth.users`.
- `workloads`, linked to each user through `user_id`.
- Row Level Security policies so users can only read or modify their own rows.
- A trigger that creates a profile when a user signs up.

Email/password auth is handled by [`app/ui/auth-panel.js`](./app/ui/auth-panel.js). The protected workspace is [`app/dashboard/page.js`](./app/dashboard/page.js). Supabase clients live in `lib/supabase`, and [`proxy.js`](./proxy.js) refreshes the cookie-based session for Next.js 16.

For email confirmation, add `http://localhost:3000/auth/callback` to Supabase Auth → URL Configuration → Redirect URLs. Add your Vercel URL there before deploying.

## Production build

```bash
npm run build -- --webpack
```
