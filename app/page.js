import { getHistoricalGenerationSnapshotStatus } from "@/lib/openelectricity-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function StatusPill({ children, tone }) {
  const tones = {
    danger: "border-amber-300 bg-amber-100 text-amber-900",
    neutral: "border-zinc-300 bg-zinc-100 text-zinc-900",
    success: "border-emerald-300 bg-emerald-100 text-emerald-900",
  };

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-sm font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function DefinitionRow({ label, value }) {
  return (
    <div className="flex flex-col gap-1 border-t border-black/10 py-3 first:border-t-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </dt>
      <dd className="font-mono text-sm text-zinc-900">{value}</dd>
    </div>
  );
}

export default async function Home() {
  const status = await getHistoricalGenerationSnapshotStatus();
  const snapshot = status.snapshot;
  const cacheStatus = !status.exists
    ? { label: "Not seeded yet", tone: "danger" }
    : status.stale
      ? { label: "Refresh needed", tone: "danger" }
      : { label: "Fresh cache", tone: "success" };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#fef3c7,_#fafaf9_40%,_#e4e4e7)] text-zinc-950">
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-10 px-6 py-16 sm:px-10">
        <section className="flex flex-col gap-6 rounded-[2rem] border border-black/10 bg-white/80 p-8 shadow-[0_30px_80px_rgba(24,24,27,0.08)] backdrop-blur">
          <StatusPill tone={cacheStatus.tone}>{cacheStatus.label}</StatusPill>
          <div className="space-y-4">
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
              Open Electricity snapshot service for the optimiser backend.
            </h1>
            <p className="max-w-3xl text-lg leading-8 text-zinc-600">
              The app now exposes a backend snapshot endpoint that stores the
              latest seven-day generation mix history locally and only refreshes
              it when the cache is stale.
            </p>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.25fr_0.9fr]">
          <article className="rounded-[2rem] border border-black/10 bg-white/80 p-8 shadow-[0_20px_60px_rgba(24,24,27,0.08)]">
            <h2 className="text-2xl font-semibold tracking-tight">
              Snapshot status
            </h2>
            <dl className="mt-6">
              <DefinitionRow
                label="API route"
                value="/api/openelectricity/history"
              />
              <DefinitionRow
                label="Cache file"
                value={status.filePath}
              />
              <DefinitionRow
                label="Refresh after"
                value={`${status.config.cacheMaxAgeHours} hours`}
              />
              <DefinitionRow
                label="Lookback window"
                value={`${status.config.lookbackDays} days`}
              />
              <DefinitionRow
                label="Interval"
                value={status.config.interval}
              />
              <DefinitionRow
                label="Network"
                value={status.config.networkCode}
              />
              <DefinitionRow
                label="Last fetched"
                value={snapshot?.fetchedAt ?? "No snapshot file yet"}
              />
              <DefinitionRow
                label="Rows stored"
                value={String(snapshot?.rawRowCount ?? 0)}
              />
              <DefinitionRow
                label="Intervals stored"
                value={String(snapshot?.intervalCount ?? 0)}
              />
              <DefinitionRow
                label="Fuel types"
                value={
                  snapshot?.fueltechGroups?.length
                    ? snapshot.fueltechGroups.join(", ")
                    : "Will populate after first refresh"
                }
              />
            </dl>
          </article>

          <article className="rounded-[2rem] border border-black/10 bg-zinc-950 p-8 text-zinc-50 shadow-[0_20px_60px_rgba(24,24,27,0.18)]">
            <h2 className="text-2xl font-semibold tracking-tight">
              How it behaves
            </h2>
            <div className="mt-6 space-y-4 text-sm leading-7 text-zinc-300">
              <p>
                `GET /api/openelectricity/history` returns the local snapshot.
                If the file is missing or older than the configured age, the
                route performs one refresh and writes a new JSON cache.
              </p>
              <p>
                Concurrent hits share the same in-flight refresh, so multiple
                requests landing together do not fan out into multiple Open
                Electricity API calls.
              </p>
              <p>
                Add `?refresh=1` if you want to bypass freshness checks
                manually.
              </p>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
