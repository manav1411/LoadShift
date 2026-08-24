"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const GridHero3D = dynamic(() => import("@/app/ui/grid-hero-3d"), { ssr: false });

const SOURCES = ["coal", "gas", "hydro", "wind", "solar", "battery", "bioenergy", "distillate"];

function buildBuckets() {
  const buckets = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i -= 1) {
    const timestamp = new Date(now.getTime() - i * 60 * 60 * 1000);
    const hour = timestamp.getHours();
    const solar = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI)) * 45;
    const wind = 12 + 10 * Math.sin(hour / 3);
    const hydro = 6;
    const battery = hour > 17 && hour < 21 ? 5 : 1;
    const bioenergy = 2;
    const distillate = 1;
    const renewable = solar + wind + hydro + battery + bioenergy + distillate;
    const gas = Math.max(4, 30 - renewable * 0.3);
    const coal = Math.max(0, 100 - renewable - gas);
    const raw = { coal, gas, hydro, wind, solar, battery, bioenergy, distillate };
    const total = Object.values(raw).reduce((sum, v) => sum + v, 0);
    const sourceMix = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v / total) * 100]));
    const intensity = (coal / total) * 850 + (gas / total) * 450 + (renewable / total) * 40;
    const computePercent = hour >= 9 && hour <= 17 ? 60 + 35 * Math.sin(((hour - 9) / 8) * Math.PI) : 15 + 10 * Math.random();

    buckets.push({
      timestamp: timestamp.toISOString(),
      intensity,
      sourceMix,
      computeWatts: computePercent * 4,
      computePercent,
    });
  }
  return buckets;
}

export default function DevPreviewPage() {
  const [buckets] = useState(buildBuckets);

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16 }}>
      <h1 style={{ fontSize: 16, marginBottom: 8 }}>GridHero3D preview (synthetic data)</h1>
      <div style={{ display: "flex", flex: 1, border: "1px solid #e1e1e1", borderRadius: 4, minHeight: 500 }}>
        <GridHero3D buckets={buckets} />
      </div>
    </main>
  );
}
