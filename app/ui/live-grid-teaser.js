import { aggregateSourceMix, SOURCE_LABELS } from "@/lib/energy-sources";

function buildSparkline(values, width, height) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return "";
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = Math.max(1, max - min);
  const step = width / (values.length - 1);

  return values
    .map((value, index) => {
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function topSource(sourceMix) {
  const totals = aggregateSourceMix(sourceMix);
  const [key] = Object.entries(totals).sort((left, right) => right[1] - left[1])[0] || [];
  return key ? (SOURCE_LABELS[key] || key) : null;
}

export default function LiveGridTeaser({ regions }) {
  if (!regions?.length) return null;

  return (
    <aside className="live-grid-teaser" aria-label="Current National Electricity Market carbon intensity">
      <div className="live-grid-head">
        <span className="live-dot" aria-hidden="true" />
        Live · National Electricity Market
      </div>
      <ul className="live-grid-list">
        {regions.map((region) => {
          const latest = region.buckets.at(-1);
          const source = latest ? topSource(latest.sourceMix) : null;
          const path = buildSparkline(region.buckets.map((bucket) => bucket.intensity), 92, 26);

          return (
            <li key={region.city}>
              <div className="live-grid-figure">
                <span className="live-grid-city">{region.city}</span>
                <strong>
                  {Number.isFinite(latest?.intensity) ? Math.round(latest.intensity) : "—"}
                  <small> gCO₂e/kWh</small>
                </strong>
                {source && <span className="live-grid-source">mostly {source.toLowerCase()}, right now</span>}
              </div>
              {path && (
                <svg aria-hidden="true" className="live-grid-spark" height="26" viewBox="0 0 92 26" width="92">
                  <path d={path} fill="none" />
                </svg>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
