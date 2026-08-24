"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import GridHero, { getSourceLegend } from "@/app/ui/grid-hero";
import { getFullSourceLegend, hasWebGL } from "@/app/ui/grid-hero-3d";

const GridHero3D = dynamic(() => import("@/app/ui/grid-hero-3d"), { ssr: false });

const HOUR_MS = 60 * 60 * 1000;
const TIME_ZONE = "Australia/Melbourne";
const FLEXIBLE_OPTIONS = [25, 50, 100];
const WINDOW_OPTIONS = [1, 2, 4];

function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function formatWindow(start, end) {
  if (!start || !end) return "Select a time";
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function averageIntensity(buckets) {
  return buckets.length
    ? buckets.reduce((sum, bucket) => sum + bucket.intensity, 0) / buckets.length
    : null;
}

function getContiguousWindow(buckets, start, hours) {
  if (!start) return [];
  const startTime = Date.parse(start);
  const bucketsByTime = new Map(buckets.map((bucket) => [Date.parse(bucket.timestamp), bucket]));
  const selected = [];

  for (let index = 0; index < hours; index += 1) {
    const bucket = bucketsByTime.get(startTime + index * HOUR_MS);
    if (!bucket) return [];
    selected.push(bucket);
  }

  return selected;
}

function findCleanestWindow(buckets, hours) {
  let best = null;

  for (const bucket of buckets) {
    const selected = getContiguousWindow(buckets, bucket.timestamp, hours);
    if (selected.length !== hours) continue;

    const intensity = averageIntensity(selected);
    if (!best || intensity < best.averageIntensity) {
      best = {
        start: bucket.timestamp,
        end: new Date(Date.parse(bucket.timestamp) + hours * HOUR_MS).toISOString(),
        averageIntensity: intensity,
      };
    }
  }

  return best;
}

function formatKg(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} kg` : "—";
}

function SegmentButtons({ label, options, value, formatOption, onChange }) {
  return (
    <div className="segment-control">
      <span>{label}</span>
      <div role="group" aria-label={label}>
        {options.map((option) => (
          <button
            aria-pressed={value === option}
            className={value === option ? "active" : ""}
            key={option}
            onClick={() => onChange(option)}
            type="button"
          >
            {formatOption(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function GridSchedule({ instances }) {
  const [data, setData] = useState(null);
  const [flexiblePercent, setFlexiblePercent] = useState(25);
  const [windowHours, setWindowHours] = useState(1);
  const [selectedStart, setSelectedStart] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [supports3D, setSupports3D] = useState(false);

  useEffect(() => {
    setSupports3D(hasWebGL());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSchedule() {
      setIsLoading(true);
      setError("");

      try {
        const response = await fetch("/api/grid/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instances: instances.map((instance) => ({
              id: instance.id,
              name: instance.name,
              instanceType: instance.instanceType,
              region: instance.region,
              nemRegion: instance.nemRegion,
              buckets: instance.buckets,
              kwh: instance.kwh,
              usageBuckets: instance.usageBuckets,
            })),
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to load grid data.");

        if (!cancelled) {
          setData(result);
          setSelectedStart(result.recommendedWindow?.start || null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load grid data.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadSchedule();
    return () => {
      cancelled = true;
    };
  }, [instances]);

  const bestWindow = useMemo(
    () => data?.buckets?.length ? findCleanestWindow(data.buckets, windowHours) : null,
    [data, windowHours],
  );

  useEffect(() => {
    setSelectedStart(bestWindow?.start || null);
  }, [bestWindow?.start]);

  const selectedWindow = useMemo(
    () => data?.buckets && selectedStart
      ? getContiguousWindow(data.buckets, selectedStart, windowHours)
      : [],
    [data, selectedStart, windowHours],
  );
  const selectedIntensity = averageIntensity(selectedWindow);
  const totalWatts = data?.breakdown?.reduce(
    (sum, instance) => sum + (instance.averageWatts || 0),
    0,
  ) || null;
  const flexibleKwh = totalWatts !== null && selectedWindow.length === windowHours
    ? (totalWatts * (flexiblePercent / 100) * windowHours) / 1000
    : null;
  const estimatedSaving = flexibleKwh !== null
    && Number.isFinite(data?.averageIntensity)
    && Number.isFinite(selectedIntensity)
    ? (flexibleKwh * Math.max(0, data.averageIntensity - selectedIntensity)) / 1000
    : null;
  const latestBucket = data?.buckets?.at(-1);

  const breakdown = useMemo(() => {
    if (!data?.breakdown || !data.regions) return [];
    const regions = new Map(data.regions.map((region) => [region.nemRegion, region]));

    return data.breakdown.map((instance) => {
      const region = regions.get(instance.nemRegion);
      const regionWindow = region && selectedStart
        ? getContiguousWindow(region.buckets, selectedStart, windowHours)
        : [];
      const regionIntensity = averageIntensity(regionWindow);
      const instanceKwh = instance.averageWatts !== null && regionWindow.length === windowHours
        ? (instance.averageWatts * (flexiblePercent / 100) * windowHours) / 1000
        : null;
      const saving = instanceKwh !== null
        && Number.isFinite(region?.averageIntensity)
        && Number.isFinite(regionIntensity)
        ? (instanceKwh * Math.max(0, region.averageIntensity - regionIntensity)) / 1000
        : null;

      return { ...instance, regionIntensity, saving };
    }).sort((left, right) => (right.saving || 0) - (left.saving || 0));
  }, [data, flexiblePercent, selectedStart, windowHours]);

  function selectStart(timestamp) {
    if (!data?.buckets?.length) return;
    const requestedIndex = data.buckets.findIndex((bucket) => bucket.timestamp === timestamp);
    const lastValidIndex = Math.max(0, data.buckets.length - windowHours);
    const selectedIndex = Math.min(Math.max(0, requestedIndex), lastValidIndex);
    setSelectedStart(data.buckets[selectedIndex].timestamp);
  }

  if (isLoading) {
    return (
      <section className="grid-schedule grid-schedule-state">
        <p className="schedule-eyebrow">Grid signal</p>
        <h3>Reading the NEM…</h3>
        <p>Fetching the latest complete hourly conditions for your AWS regions.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="grid-schedule grid-schedule-state">
        <p className="schedule-eyebrow">Grid signal</p>
        <h3>Grid conditions unavailable</h3>
        <p className="form-error" role="alert">{error}</p>
      </section>
    );
  }

  if (!data?.buckets?.length) return null;

  const latestSourceMix = latestBucket?.sourceMix || {};
  const sourceLegend = supports3D ? getFullSourceLegend() : getSourceLegend(latestSourceMix);
  const peakCompute = Math.max(...data.buckets.map((bucket) => bucket.computePercent || 0), 0);
  const selectedIsBest = Boolean(bestWindow && selectedStart === bestWindow.start);
  const visibleBreakdown = breakdown.slice(0, 4);
  const remainingInstances = Math.max(0, breakdown.length - visibleBreakdown.length);

  return (
    <section className="grid-schedule" aria-labelledby="grid-schedule-title">
      <div className="schedule-heading">
        <div>
          <p className="schedule-eyebrow">Grid signal · NEM</p>
          <h2 id="grid-schedule-title">See your compute move through the market.</h2>
          <p>The line shows grid carbon intensity, the bars show relative AWS compute, and the strip shows the NEM generation mix.</p>
        </div>
        <a className="schedule-source" href="https://explore.openelectricity.org.au/energy/nem/" rel="noreferrer" target="_blank">Open Electricity ↗</a>
      </div>

      <div className="grid-hero-layout">
        <div className="grid-hero-panel">
          <div className="grid-hero-panel-header">
            <div><span>Interactive NEM model</span><strong>{latestBucket ? `${latestBucket.intensity.toFixed(0)} gCO₂e/kWh` : "—"}</strong></div>
            <div><span>Current relative load</span><strong>{latestBucket?.computePercent == null ? "—" : `${latestBucket.computePercent.toFixed(0)}%`}</strong></div>
          </div>
          {supports3D
            ? <GridHero3D buckets={data.buckets} />
            : <GridHero buckets={data.buckets} onSelectStart={selectStart} selectedStart={selectedStart} windowHours={windowHours} />}
          <div className="source-legend">
            {sourceLegend.map((item) => (
              <span key={item.source}>
                <i className={item.gradient ? "legend-swatch gradient" : "legend-swatch"} style={item.gradient ? undefined : { background: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        </div>

        <aside className="schedule-side-panel">
          <div className="schedule-signal">
            <span className="signal-label">LoadShift recommendation</span>
            <strong>{bestWindow ? formatWindow(bestWindow.start, bestWindow.end) : "Waiting for data"}</strong>
            <p>{bestWindow ? `Cleanest recent ${windowHours}-hour window across your AWS regions.` : "There is not enough contiguous data yet."}</p>
            <div className="signal-saving"><span>Potential saving</span><strong>{estimatedSaving === null ? "—" : `${estimatedSaving.toFixed(3)} kg`}</strong><small>CO₂e for flexible load</small></div>
          </div>

          <div className="schedule-facts">
            <div><span>Recent average</span><strong>{data.averageIntensity.toFixed(0)} g</strong><small>gCO₂e/kWh</small></div>
            <div><span>Peak compute</span><strong>{peakCompute.toFixed(0)}%</strong><small>relative to 24h peak</small></div>
          </div>

          <div className="schedule-toolbar">
            <SegmentButtons formatOption={(option) => `${option}h`} label="Window" onChange={setWindowHours} options={WINDOW_OPTIONS} value={windowHours} />
            <SegmentButtons formatOption={(option) => `${option}%`} label="Flexible load" onChange={setFlexiblePercent} options={FLEXIBLE_OPTIONS} value={flexiblePercent} />
          </div>

          <p className="schedule-side-note">{selectedIsBest ? "Cleanest recent window selected" : "Click an hour to explore another window"}</p>
        </aside>
      </div>

      <div className="schedule-breakdowns">
        <section className="breakdown-panel" aria-labelledby="region-breakdown-title">
          <div className="breakdown-heading"><div><span className="panel-eyebrow">Where it happens</span><h3 id="region-breakdown-title">Regional signal</h3></div><span>NEM regions</span></div>
          <div className="region-list">
            {data.regions.map((region) => {
              const selectedRegionWindow = selectedStart ? getContiguousWindow(region.buckets, selectedStart, windowHours) : [];
              const selectedRegionIntensity = averageIntensity(selectedRegionWindow);
              return (
                <div className="region-row" key={region.nemRegion}>
                  <div><strong>{region.nemRegion}</strong><small>{region.weight.toFixed(0)} W estimated load</small></div>
                  <div><strong>{region.averageIntensity.toFixed(0)}</strong><small>recent g/kWh</small></div>
                  <div><strong>{Number.isFinite(selectedRegionIntensity) ? selectedRegionIntensity.toFixed(0) : "—"}</strong><small>selected g/kWh</small></div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="breakdown-panel" aria-labelledby="instance-breakdown-title">
          <div className="breakdown-heading"><div><span className="panel-eyebrow">Where it saves</span><h3 id="instance-breakdown-title">Top instance contribution</h3></div><span>CO₂e</span></div>
          <div className="instance-list">
            {visibleBreakdown.map((instance) => (
              <div className="instance-row" key={instance.id}>
                <div className="instance-name"><strong>{instance.name}</strong><small>{instance.instanceType} · {instance.region}</small></div>
                <strong className="instance-saving">{formatKg(instance.saving)}</strong>
              </div>
            ))}
          </div>
          {remainingInstances > 0 && <p className="breakdown-more">+ {remainingInstances} more instance{remainingInstances === 1 ? "" : "s"}</p>}
        </section>
      </div>
    </section>
  );
}
