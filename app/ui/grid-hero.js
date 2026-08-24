"use client";

const SOURCE_COLORS = {
  coal: "#5a5a5a",
  gas: "#b47752",
  wind: "#4a9bb5",
  solar: "#e0af3f",
  hydro: "#5c82bd",
  battery: "#8d68aa",
  bioenergy: "#6b9458",
  distillate: "#92745f",
};

const SOURCE_LABELS = {
  coal: "Coal",
  gas: "Gas",
  wind: "Wind",
  solar: "Solar",
  hydro: "Hydro",
  battery: "Battery",
  bioenergy: "Bioenergy",
  distillate: "Distillate",
};

function getSourceColor(source) {
  const group = source.toLowerCase().split("_")[0];
  return SOURCE_COLORS[group] || "#9b9b9b";
}

function getSourceLabel(source) {
  const group = source.toLowerCase().split("_")[0];
  return SOURCE_LABELS[group] || source.replaceAll("_", " ");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getY(value, min, max, top, bottom) {
  if (!Number.isFinite(value)) return bottom;
  return bottom - ((value - min) / Math.max(1, max - min)) * (bottom - top);
}

function buildPath(points) {
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

export default function GridHero({ buckets, selectedStart, windowHours, onSelectStart }) {
  if (!buckets?.length) return null;

  const width = 960;
  const height = 360;
  const left = 50;
  const right = 28;
  const top = 28;
  const bottom = 226;
  const sourceTop = 274;
  const sourceBottom = 328;
  const chartWidth = width - left - right;
  const step = chartWidth / Math.max(1, buckets.length - 1);
  const intensities = buckets.map((bucket) => bucket.intensity).filter(Number.isFinite);
  const minimum = Math.max(0, Math.floor(Math.min(...intensities) / 100) * 100 - 100);
  const maximum = Math.max(minimum + 100, Math.ceil(Math.max(...intensities) / 100) * 100 + 100);
  const points = buckets.map((bucket, index) => [
    left + index * step,
    getY(bucket.intensity, minimum, maximum, top, bottom),
  ]);
  const linePath = buildPath(points);
  const areaPath = `${linePath} L${(left + (buckets.length - 1) * step).toFixed(2)},${bottom} L${left},${bottom} Z`;
  const selectedIndex = Math.max(0, buckets.findIndex((bucket) => bucket.timestamp === selectedStart));
  const selectionWidth = Math.max(step, Math.min(chartWidth - selectedIndex * step, windowHours * step));
  const yTicks = [0, 0.5, 1].map((ratio) => ({
    value: Math.round(maximum - (maximum - minimum) * ratio),
    y: top + (bottom - top) * ratio,
  }));
  const xLabels = buckets.filter((_, index) => index === 0 || index === buckets.length - 1 || index % 6 === 0);

  return (
    <div className="grid-hero-canvas">
      <div className="chart-scale-label chart-scale-intensity">gCO₂e/kWh</div>
      <div className="chart-scale-label chart-scale-compute">relative compute</div>
      <svg aria-label="NEM carbon intensity, energy mix, and relative AWS compute over the last 24 hours" className="grid-hero-svg" role="img" viewBox={`0 0 ${width} ${height}`}>
        <rect className="chart-selected" height={height - top - 22} width={selectionWidth} x={left + selectedIndex * step - (selectedIndex === 0 ? 0 : step / 2)} y={top} />

        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-gridline" x1={left} x2={width - right} y1={tick.y} y2={tick.y} />
            <text className="chart-y-label" x={left - 10} y={tick.y + 3} textAnchor="end">{tick.value}</text>
          </g>
        ))}

        {buckets.map((bucket, index) => {
          const x = left + index * step;
          const compute = clamp(Number(bucket.computePercent) || 0, 0, 100);
          const barHeight = ((compute / 100) * (bottom - top)) * 0.72;
          return (
            <g key={bucket.timestamp}>
              <rect className="compute-bar" height={barHeight} width={Math.max(10, step * 0.56)} x={x - Math.max(10, step * 0.56) / 2} y={bottom - barHeight} />
              <rect aria-label={`Select ${formatHour(bucket.timestamp)}`} className="chart-hit-area" height={bottom - top} onClick={() => onSelectStart(bucket.timestamp)} width={Math.max(18, step)} x={x - Math.max(18, step) / 2} y={top} />
            </g>
          );
        })}

        <path className="chart-area" d={areaPath} />
        <path className="chart-line" d={linePath} />
        {points.map(([x, y], index) => (
          <circle className={buckets[index].timestamp === selectedStart ? "chart-point selected" : "chart-point"} cx={x} cy={y} key={buckets[index].timestamp} r={buckets[index].timestamp === selectedStart ? 5 : 3} />
        ))}

        <line className="chart-axis" x1={left} x2={width - right} y1={bottom} y2={bottom} />
        <line className="chart-axis" x1={left} x2={left} y1={top} y2={bottom} />
        <text className="chart-band-label" x={left} y={sourceTop - 10}>NEM generation mix</text>
        <line className="chart-band-line" x1={left} x2={width - right} y1={sourceTop} y2={sourceTop} />
        {buckets.map((bucket, index) => {
          const x = left + index * step;
          let offset = 0;
          return Object.entries(bucket.sourceMix || {}).map(([source, percentage]) => {
            const segmentHeight = ((Number(percentage) || 0) / 100) * (sourceBottom - sourceTop);
            const segment = (
              <rect fill={getSourceColor(source)} height={segmentHeight} key={`${bucket.timestamp}-${source}`} opacity="0.85" width={Math.max(8, step * 0.72)} x={x - Math.max(8, step * 0.72) / 2} y={sourceBottom - offset - segmentHeight} />
            );
            offset += segmentHeight;
            return segment;
          });
        })}

        {xLabels.map((bucket) => {
          const index = buckets.indexOf(bucket);
          return <text className="chart-x-label" key={bucket.timestamp} textAnchor={index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"} x={left + index * step} y={height - 12}>{formatHour(bucket.timestamp)}</text>;
        })}
      </svg>
      <p className="chart-interaction-hint">Click an hour to test shifting flexible compute</p>
    </div>
  );
}

function formatHour(timestamp) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function getSourceLegend(sourceMix = {}) {
  return Object.keys(sourceMix)
    .sort((left, right) => (sourceMix[right] || 0) - (sourceMix[left] || 0))
    .slice(0, 6)
    .map((source) => ({
      source,
      label: getSourceLabel(source),
      color: getSourceColor(source),
    }));
}
