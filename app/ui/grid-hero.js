"use client";

import { formatHour, normaliseSourceKey, SOURCE_COLORS } from "@/lib/energy-sources";

// SVG fallback for machines without WebGL. Same story as the 3D scene, flattened:
// compute load as the curve, with the NEM fuel mix beneath it.

export default function GridHero({ buckets, baselineLoad = [], optimisedLoad = [], peakLoad, optimised = false }) {
  if (!buckets?.length) return null;

  const width = 960;
  const height = 360;
  const left = 54;
  const right = 26;
  const top = 26;
  const bottom = 250;
  const mixTop = 286;
  const mixBottom = 330;
  const chartWidth = width - left - right;
  const step = chartWidth / Math.max(1, buckets.length - 1);

  const load = optimised ? optimisedLoad : baselineLoad;
  const stablePeakLoad = Math.max(1, Number(peakLoad) || 0, ...baselineLoad);
  const yFor = (watts) => bottom - ((watts || 0) / stablePeakLoad) * (bottom - top) * 0.92;

  const linePath = buckets
    .map((bucket, index) => `${index ? "L" : "M"}${(left + index * step).toFixed(1)},${yFor(load[index]).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${(left + (buckets.length - 1) * step).toFixed(1)},${bottom} L${left},${bottom} Z`;

  return (
    <div className="grid-hero-canvas">
      <svg
        aria-label="Your compute load against the NEM fuel mix over the last 24 hours"
        className="grid-hero-svg"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[0, 50, 100].map((percent) => {
          const y = bottom - (percent / 100) * (bottom - top) * 0.92;
          return (
            <g key={percent}>
              <line className="chart-gridline" x1={left} x2={width - right} y1={y} y2={y} />
              <text className="chart-y-label" textAnchor="end" x={left - 10} y={y + 3}>{percent}%</text>
            </g>
          );
        })}

        <path className="chart-area" d={areaPath} />
        <path className="chart-line" d={linePath} />

        <line className="chart-axis" x1={left} x2={width - right} y1={bottom} y2={bottom} />
        <text className="chart-band-label" x={left} y={top - 10}>Compute load</text>
        <text className="chart-band-label" x={left} y={mixTop - 10}>NEM generation mix</text>

        {buckets.map((bucket, index) => {
          let offset = 0;
          return Object.entries(bucket.sourceMix || {}).map(([source, percentage]) => {
            const segmentHeight = ((Number(percentage) || 0) / 100) * (mixBottom - mixTop);
            const segment = (
              <rect
                fill={SOURCE_COLORS[normaliseSourceKey(source)] || "#9b9b9b"}
                height={segmentHeight}
                key={`${bucket.timestamp}-${source}`}
                opacity="0.9"
                width={Math.max(6, step * 0.74)}
                x={left + index * step - Math.max(6, step * 0.74) / 2}
                y={mixBottom - offset - segmentHeight}
              />
            );
            offset += segmentHeight;
            return segment;
          });
        })}

        {buckets.filter((_, index) => index % 4 === 0).map((bucket) => {
          const index = buckets.indexOf(bucket);
          return (
            <text className="chart-x-label" key={bucket.timestamp} textAnchor="middle" x={left + index * step} y={height - 6}>
              {formatHour(bucket.timestamp)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
