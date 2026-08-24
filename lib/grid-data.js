import { getLastCompleteInterval, OpenElectricityClient } from "openelectricity";

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_HOURS = 24;

function formatNaiveDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:00:00`;
}

// One window for the whole app. Previously the AWS path and the grid path each
// derived their own, which meant the two series could be an hour out of step.
export function getWindow() {
  const end = new Date(`${getLastCompleteInterval("NEM")}Z`);
  end.setUTCMinutes(0, 0, 0);
  end.setTime(end.getTime() - HOUR_MS);
  const start = new Date(end.getTime() - (LOOKBACK_HOURS - 1) * HOUR_MS);

  return {
    start,
    end,
    dateStart: formatNaiveDateTime(start),
    dateEnd: formatNaiveDateTime(end),
    timeline: Array.from({ length: LOOKBACK_HOURS }, (_, index) =>
      new Date(start.getTime() + index * HOUR_MS).toISOString()),
  };
}

function extractRegionBuckets(response) {
  const valuesByHour = new Map();

  for (const series of response?.data || []) {
    for (const result of series.results || []) {
      const source = result.columns?.fueltech_group || result.columns?.fueltech || "total";

      for (const [interval, value] of result.data || []) {
        const timestamp = Date.parse(interval);
        const numericValue = Number(value);
        if (!Number.isFinite(timestamp) || !Number.isFinite(numericValue)) continue;

        const hour = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
        const current = valuesByHour.get(hour) || { emissions: 0, energy: 0, energyBySource: {} };

        if (series.metric === "emissions") current.emissions += numericValue;
        if (series.metric === "energy") {
          if (source === "total") current.energy += numericValue;
          else current.energyBySource[source] = (current.energyBySource[source] || 0) + numericValue;
        }

        valuesByHour.set(hour, current);
      }
    }
  }

  const byTimestamp = new Map();
  for (const [hour, values] of valuesByHour) {
    const energyFromSources = Object.values(values.energyBySource).reduce((sum, value) => sum + value, 0);
    const totalEnergy = values.energy || energyFromSources;
    if (!(totalEnergy > 0) || !Number.isFinite(values.emissions)) continue;

    byTimestamp.set(new Date(hour).toISOString(), {
      intensity: (values.emissions / totalEnergy) * 1000,
      sourceMix: Object.fromEntries(
        Object.entries(values.energyBySource)
          .map(([source, energy]) => [source, (energy / totalEnergy) * 100])
          .filter(([, percentage]) => percentage >= 0.5),
      ),
    });
  }

  return byTimestamp;
}

// Snaps whatever the API returned onto the canonical timeline, carrying the last
// known value across any gap so downstream code can index by hour without checking.
function alignToTimeline(byTimestamp, timeline) {
  const buckets = [];
  let lastKnown = null;

  for (const timestamp of timeline) {
    const match = byTimestamp.get(timestamp) || lastKnown;
    if (match) lastKnown = match;
    buckets.push({
      timestamp,
      intensity: match ? Number(match.intensity.toFixed(1)) : null,
      sourceMix: match?.sourceMix || {},
      estimated: !byTimestamp.has(timestamp),
    });
  }

  // A leading gap has no previous value to carry, so backfill from the first real reading.
  const firstReal = buckets.find((bucket) => bucket.intensity !== null);
  if (firstReal) {
    for (const bucket of buckets) {
      if (bucket.intensity === null) {
        bucket.intensity = firstReal.intensity;
        bucket.sourceMix = firstReal.sourceMix;
      }
    }
  }

  return buckets;
}

export async function getRegionGridData(nemRegion, window) {
  const apiKey = process.env.OPEN_ELECTRICITY_API_KEY || process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error("Missing OPEN_ELECTRICITY_API_KEY.");

  const client = new OpenElectricityClient({ apiKey });
  const { response } = await client.getNetworkData("NEM", ["emissions", "energy"], {
    dateStart: window.dateStart,
    dateEnd: window.dateEnd,
    interval: "1h",
    network_region: nemRegion,
    primaryGrouping: "network_region",
    secondaryGrouping: ["fueltech_group"],
  });

  const buckets = alignToTimeline(extractRegionBuckets(response), window.timeline);
  if (!buckets.some((bucket) => Number.isFinite(bucket.intensity))) {
    throw new Error(`Open Electricity returned no usable data for ${nemRegion}.`);
  }

  return buckets;
}
