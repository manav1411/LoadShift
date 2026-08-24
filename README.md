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
SUPABASE_SERVICE_ROLE_KEY=...
OPEN_ELECTRICITY_API_KEY=...
```

`SUPABASE_SERVICE_ROLE_KEY` is used only by server routes to refresh/read the shared Open Electricity snapshot. Never expose it with `NEXT_PUBLIC_`.

## Supabase setup

Run [`supabase/aws-schema.sql`](./supabase/aws-schema.sql) in the Supabase SQL Editor. It creates:

- `aws_connections`, with Row Level Security so each user can only manage their own connection.
- `ec2_power_profiles`, the Teads instance type → idle/max wattage table.

Populate `ec2_power_profiles` with the complete Teads dataset before treating estimates as production-ready.

Email/password auth is handled by [`app/ui/auth-panel.js`](./app/ui/auth-panel.js). The protected workspace is [`app/dashboard/page.js`](./app/dashboard/page.js). Supabase clients live in `lib/supabase`, and [`proxy.js`](./proxy.js) refreshes the cookie-based session for Next.js 16.

For email confirmation, add `http://localhost:3000/auth/callback` to Supabase Auth → URL Configuration → Redirect URLs. Add your Vercel URL there before deploying.

## AWS connection

Set these server-only variables in `.env.local` or Vercel:

```text
AWS_LOADSHIFT_ACCOUNT_ID=your-loadshift-aws-account-id
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-2
AWS_CONTROL_REGION=ap-southeast-2
```

`AWS_LOADSHIFT_PRINCIPAL_ARN` can be used instead of the account ID. The first two AWS variables are the LoadShift server credentials, not customer credentials. Never expose them with `NEXT_PUBLIC_`.

When a customer connects AWS, LoadShift generates a unique external ID, gives them a trust-policy and read-only permission-policy template, validates the role with STS, and stores only the role ARN/external ID. The app never stores customer access keys.

After connection, `/api/aws/instances` uses `DescribeInstances`, CloudWatch `CPUUtilization` hourly buckets, the `ec2_power_profiles` Teads table, and regional Open Electricity emissions/energy data. The calculation is:

```text
watts = idle_watts + (max_watts - idle_watts) * cpu_utilisation / 100
kWh = watts / 1000 * bucket_hours
grams CO₂e = kWh * regional_grid_intensity_gCO₂e_per_kWh
```

The dashboard also calls `/api/grid/schedule`. It fetches the last 24 complete hours of regional Open Electricity emissions, energy, and fueltech mix data, weighted across the connected AWS regions. The dashboard presents this as a compact 2D chart: grid carbon intensity, relative AWS compute load, and a generation-mix strip. Users can select an hour, compare 1/2/4-hour windows, and estimate avoidable emissions for a configurable percentage of measured average EC2 load, with both regional and instance breakdowns. This is a historical scheduling signal, not a future electricity forecast.

The current mapping supports AWS Sydney (`ap-southeast-2` → `NSW1`) and Melbourne (`ap-southeast-4` → `VIC1`). Other AWS regions are reported as unmapped until an appropriate electricity region is defined.

AWS is the only cloud connection currently available.

## Production build

```bash
npm run build -- --webpack
```
