"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import GridHero from "@/app/ui/grid-hero";
import { hasWebGL } from "@/app/ui/grid-hero-3d";
import { getFullSourceLegend, getSourceLegend } from "@/lib/energy-sources";
import { optimiseFleet } from "@/lib/optimiser";

const GridHero3D = dynamic(() => import("@/app/ui/grid-hero-3d"), { ssr: false });

const DEFAULT_DELAY_HOURS = 6;
const ALL_REGIONS = "all";

function formatKg(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatDelay(hours) {
  if (hours === 0) return "0h";
  if (hours >= 24) return "24h";
  return `${hours}h`;
}

function getDefaultDelay(workload) {
  return workload.shiftable ? DEFAULT_DELAY_HOURS : 0;
}

// Weighted by how much of the fleet's energy actually sits in each region, so the
// blended curve leans toward wherever the compute really is.
function blendBuckets(regions, workloads) {
  if (regions.length === 1) return regions[0].buckets;

  const weights = new Map();
  for (const workload of workloads) {
    const watts = workload.hours.reduce((sum, hour) => sum + hour.watts, 0);
    weights.set(workload.nemRegion, (weights.get(workload.nemRegion) || 0) + watts);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0) || regions.length;

  return regions[0].buckets.map((_, index) => {
    let intensity = 0;
    const sourceMix = {};
    for (const region of regions) {
      const weight = weights.get(region.nemRegion) ?? total / regions.length;
      const bucket = region.buckets[index];
      intensity += bucket.intensity * weight;
      for (const [source, percentage] of Object.entries(bucket.sourceMix || {})) {
        sourceMix[source] = (sourceMix[source] || 0) + percentage * weight;
      }
    }
    return {
      timestamp: regions[0].buckets[index].timestamp,
      intensity: intensity / total,
      sourceMix: Object.fromEntries(Object.entries(sourceMix).map(([source, value]) => [source, value / total])),
    };
  });
}

export default function FleetConsole({ demo = false }) {
  const [fleet, setFleet] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [supports3D, setSupports3D] = useState(false);
  const [sampleMode, setSampleMode] = useState(false);

  const [delayByWorkload, setDelayByWorkload] = useState({});
  const [optimised, setOptimised] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(ALL_REGIONS);

  function setDelay(workloadId, hours) {
    setDelayByWorkload((current) => ({ ...current, [workloadId]: hours }));
    setOptimised(false);
  }

  useEffect(() => {
    setSupports3D(hasWebGL());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadDemo = demo || sampleMode;

    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(loadDemo ? "/api/fleet?demo=1" : "/api/fleet");
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to read your fleet.");
        if (!cancelled) setFleet(result);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to read your fleet.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [demo, sampleMode]);

  const view = useMemo(() => {
    if (!fleet?.regions?.length) return null;

    const regions = selectedRegion === ALL_REGIONS
      ? fleet.regions
      : fleet.regions.filter((region) => region.nemRegion === selectedRegion);
    const workloads = selectedRegion === ALL_REGIONS
      ? fleet.workloads
      : fleet.workloads.filter((workload) => workload.nemRegion === selectedRegion);

    if (!regions.length) return null;

    const effectiveDelayByWorkload = Object.fromEntries(
      workloads.map((workload) => [
        workload.id,
        delayByWorkload[workload.id] ?? getDefaultDelay(workload),
      ]),
    );

    const result = optimiseFleet({
      regions,
      workloads,
      delayHoursByWorkload: effectiveDelayByWorkload,
      defaultDelayHours: 0,
    });
    const buckets = blendBuckets(regions, workloads);
    const fleetCapacityWatts = workloads.reduce(
      (sum, workload) => sum + Math.max(0, Number(workload.maxWatts) || 0),
      0,
    );
    const graphPeakLoad = Math.max(1, fleetCapacityWatts, ...result.baselineLoad);

    return { ...result, regions, buckets, blended: regions.length > 1, graphPeakLoad };
  }, [fleet, selectedRegion, delayByWorkload]);

  if (isLoading) {
    return (
      <div className="console-state">
        <h2>Reading your fleet…</h2>
        <p>Pulling EC2 inventory, CloudWatch CPU, and the last 24 hours of NEM grid data.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="console-state">
        <h2>Couldn&apos;t build your view</h2>
        <p className="form-error" role="alert">{error}</p>
      </div>
    );
  }

  if (!view || !fleet.workloads.length) {
    return (
      <div className="console-state">
        <h2>Nothing running to measure</h2>
        <p>No running EC2 instances were found in the NEM-mapped regions (Sydney and Melbourne).</p>
      </div>
    );
  }

  const legend = supports3D ? getFullSourceLegend() : getSourceLegend(view.buckets.at(-1)?.sourceMix);
  const regionLabel = selectedRegion === ALL_REGIONS
    ? "Your fleet"
    : view.regions[0].city;

  return (
    <div className="console">
      <section className="console-stage">
        <header className="stage-head">
          <div className="stage-title">
            <h2>{fleet.demo ? "Enterprise demo" : regionLabel} · last 24 hours</h2>
          </div>

          {fleet.regions.length > 1 && (
            <div className="region-switch" role="group" aria-label="Region">
              <button
                className={selectedRegion === ALL_REGIONS ? "active" : ""}
                onClick={() => setSelectedRegion(ALL_REGIONS)}
                type="button"
              >
                All
              </button>
              {fleet.regions.map((region) => (
                <button
                  className={selectedRegion === region.nemRegion ? "active" : ""}
                  key={region.nemRegion}
                  onClick={() => setSelectedRegion(region.nemRegion)}
                  type="button"
                >
                  {region.city}
                </button>
              ))}
            </div>
          )}
        </header>

        {supports3D ? (
          <GridHero3D
            baselineLoad={view.baselineLoad}
            buckets={view.buckets}
            peakLoad={view.graphPeakLoad}
            optimised={optimised}
            optimisedLoad={view.optimisedLoad}
          />
        ) : (
          <GridHero
            baselineLoad={view.baselineLoad}
            buckets={view.buckets}
            peakLoad={view.graphPeakLoad}
            optimised={optimised}
            optimisedLoad={view.optimisedLoad}
          />
        )}

        <div className="source-legend">
          {legend.map((item) => (
            <span key={item.source}>
              <i className="legend-swatch" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </section>

      <aside className="console-rail">
        <div className="rail-figures">
          <div className="figure baseline">
            <span>As scheduled</span>
            <strong>{formatKg(view.baselineKg)}<small>kg CO₂e</small></strong>
          </div>
          <div className="figure-arrow" aria-hidden="true">↓</div>
          <div className="figure optimised">
            <span>Shifted</span>
            <strong>{formatKg(view.optimisedKg)}<small>kg CO₂e</small></strong>
          </div>
          <div className="figure-delta">
            <strong>−{formatKg(view.savedKg)} kg/day · {view.savedPercent.toFixed(0)}% less</strong>
          </div>
        </div>

        <div className="rail-control">
          <button
            className={optimised ? "optimise-button active" : "optimise-button"}
            onClick={() => setOptimised(!optimised)}
            type="button"
          >
            {optimised ? "Show current" : "Optimise"}
          </button>

        </div>

        <div className="rail-workloads">
          <div className="workloads-head">
            <h3>EC2 instances</h3>
            <span>{view.workloads.length} in view</span>
          </div>
          <ul className="workload-list">
            {view.workloads.map((workload) => (
              <li className="workload" key={workload.id}>
                <div className="workload-body">
                  <div className="workload-line">
                    <strong>{workload.name}</strong>
                    <span className="workload-saving">{workload.savedKg > 0 ? `−${formatKg(workload.savedKg)} kg` : "—"}</span>
                  </div>
                  <small>{workload.instanceType} · {workload.nemRegion}{workload.profileSource !== "teads" ? " · est. power" : ""}</small>
                  <label className="delay-slider workload-delay">
                    <span className="delay-label">
                      <span>Time-sensitivity</span>
                      <strong>{formatDelay(delayByWorkload[workload.id] ?? getDefaultDelay(workload))}</strong>
                    </span>
                    <input
                      aria-label={`Time-sensitivity for ${workload.name}`}
                      max={24}
                      min={0}
                      onChange={(event) => setDelay(workload.id, Number(event.target.value))}
                      step={1}
                      type="range"
                      value={delayByWorkload[workload.id] ?? getDefaultDelay(workload)}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
          {!demo && (
            <div className="workloads-demo">
              <button
                onClick={() => {
                  setSampleMode((current) => !current);
                  setOptimised(false);
                }}
                type="button"
              >
                {sampleMode ? "Use live fleet" : "Demo enterprise fleet"}
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
