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

## Production build

```bash
npm run build -- --webpack
```
