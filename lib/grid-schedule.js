import { getLastCompleteInterval, OpenElectricityClient } from "openelectricity";

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_HOURS = 24;
const DEFAULT_FLEXIBLE_PERCENT = 25;
const DEFAULT_WINDOW_HOURS = 1;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatNaiveDateTime(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:00:00`;
}

function getRecentNEMWindow() {
  const lastCompleteInterval = getLastCompleteInterval("NEM");
  const end = new Date(`${lastCompleteInterval}Z`);
  end.setUTCMinutes(0, 0, 0);
  end.setTime(end.getTime() - HOUR_MS);
  const start = new Date(end.getTime() - (LOOKBACK_HOURS - 1) * HOUR_MS);

  return {
    dateStart: formatNaiveDateTime(start),
    dateEnd: formatNaiveDateTime(end),
  };
}

function extractRegionBuckets(response) {
  const valuesByTimestamp = new Map();

  for (const series of response?.data || []) {
    for (const result of series.results || []) {
      const source = result.columns?.fueltech_group || result.columns?.fueltech || "total";

      for (const [interval, value] of result.data || []) {
        const timestamp = Date.parse(interval);
        const numericValue = Number(value);
        if (!Number.isFinite(timestamp) || !Number.isFinite(numericValue)) continue;

        const hour = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
        const current = valuesByTimestamp.get(hour) || {
          emissions: 0,
          energy: 0,
          energyBySource: {},
        };

        if (series.metric === "emissions") {
          current.emissions += numericValue;
        }

        if (series.metric === "energy") {
          if (source === "total") {
            current.energy += numericValue;
          } else {
            current.energyBySource[source] = (current.energyBySource[source] || 0) + numericValue;
          }
        }

        valuesByTimestamp.set(hour, current);
      }
    }
  }

  return [...valuesByTimestamp.entries()]
    .map(([timestamp, values]) => {
      const energyFromSources = Object.values(values.energyBySource).reduce((sum, value) => sum + value, 0);
      const totalEnergy = values.energy || energyFromSources;
      const sourceMix = totalEnergy > 0
        ? Object.fromEntries(
            Object.entries(values.energyBySource)
              .map(([source, energy]) => [source, (energy / totalEnergy) * 100])
              .filter(([, percentage]) => percentage >= 0.5),
          )
        : {};

      return {
        timestamp: new Date(timestamp).toISOString(),
        intensity: totalEnergy > 0 && Number.isFinite(values.emissions)
          ? (values.emissions / totalEnergy) * 1000
          : null,
        sourceMix,
      };
    })
    .filter((bucket) => Number.isFinite(bucket.intensity))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function getRegionData(nemRegion, window) {
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

  return extractRegionBuckets(response);
}

function getInstanceAverageWatts(instance) {
  if (Number.isFinite(instance.averageWatts)) return instance.averageWatts;

  if (Array.isArray(instance.usageBuckets) && instance.usageBuckets.length) {
    const watts = instance.usageBuckets
      .map((bucket) => Number(bucket.watts))
      .filter((value) => Number.isFinite(value));
    if (watts.length) return watts.reduce((sum, value) => sum + value, 0) / watts.length;
  }

  return Number.isFinite(instance.kwh) && Number.isFinite(instance.buckets) && instance.buckets > 0
    ? (instance.kwh / instance.buckets) * 1000
    : null;
}

function getRegionWeights(instances) {
  const weights = new Map();

  for (const instance of instances) {
    if (!instance.nemRegion) continue;
    const watts = getInstanceAverageWatts(instance) || 1;
    weights.set(instance.nemRegion, (weights.get(instance.nemRegion) || 0) + watts);
  }

  return weights;
}

function combineRegionalBuckets(regions, weights) {
  const bucketsByTimestamp = new Map();

  for (const region of regions) {
    for (const bucket of region.buckets) {
      const current = bucketsByTimestamp.get(bucket.timestamp) || {
        intensity: 0,
        sourceMix: {},
        totalWeight: 0,
      };
      const weight = weights.get(region.nemRegion) || 0;
      if (!weight) continue;

      current.intensity += bucket.intensity * weight;
      current.totalWeight += weight;
      for (const [source, percentage] of Object.entries(bucket.sourceMix || {})) {
        current.sourceMix[source] = (current.sourceMix[source] || 0) + percentage * weight;
      }
      bucketsByTimestamp.set(bucket.timestamp, current);
    }
  }

  return [...bucketsByTimestamp.entries()]
    .sort(([left], [right]) => Date.parse(left) - Date.parse(right))
    .map(([timestamp, bucket]) => ({
      timestamp,
      intensity: bucket.totalWeight ? round(bucket.intensity / bucket.totalWeight, 1) : null,
      sourceMix: bucket.totalWeight
        ? Object.fromEntries(
            Object.entries(bucket.sourceMix).map(([source, value]) => [source, round(value / bucket.totalWeight, 1)]),
          )
        : {},
    }))
    .filter((bucket) => Number.isFinite(bucket.intensity));
}

function addComputeUsage(buckets, instances) {
  const usageByTimestamp = new Map();

  for (const instance of instances) {
    for (const usage of instance.usageBuckets || []) {
      const timestamp = Date.parse(usage.timestamp);
      const watts = Number(usage.watts);
      if (!Number.isFinite(timestamp) || !Number.isFinite(watts)) continue;

      const hour = new Date(Math.floor(timestamp / HOUR_MS) * HOUR_MS).toISOString();
      usageByTimestamp.set(hour, (usageByTimestamp.get(hour) || 0) + watts);
    }
  }

  const computeWatts = buckets.map((bucket) => usageByTimestamp.get(bucket.timestamp) || 0);
  const peakWatts = Math.max(...computeWatts, 0);

  return buckets.map((bucket, index) => ({
    ...bucket,
    computeWatts: round(computeWatts[index], 1),
    computePercent: peakWatts > 0 ? round((computeWatts[index] / peakWatts) * 100, 1) : null,
  }));
}

function getAverageIntensity(buckets) {
  return buckets.length
    ? buckets.reduce((sum, bucket) => sum + bucket.intensity, 0) / buckets.length
    : null;
}

function getContiguousWindow(buckets, start, hours) {
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

    const averageIntensity = getAverageIntensity(selected);
    if (!best || averageIntensity < best.averageIntensity) {
      const start = Date.parse(bucket.timestamp);
      best = {
        start: bucket.timestamp,
        end: new Date(start + hours * HOUR_MS).toISOString(),
        averageIntensity,
      };
    }
  }

  return best;
}

function buildInstanceBreakdown(instances) {
  return instances.map((instance) => ({
    id: instance.id,
    name: instance.name || instance.id,
    instanceType: instance.instanceType,
    region: instance.region,
    nemRegion: instance.nemRegion,
    averageWatts: round(getInstanceAverageWatts(instance), 1),
  }));
}

export async function getGridSchedule({
  instances = [],
  flexiblePercent = DEFAULT_FLEXIBLE_PERCENT,
  windowHours = DEFAULT_WINDOW_HOURS,
}) {
  const normalisedPercent = Math.min(100, Math.max(1, Number(flexiblePercent) || DEFAULT_FLEXIBLE_PERCENT));
  const normalisedHours = Math.min(8, Math.max(1, Number(windowHours) || DEFAULT_WINDOW_HOURS));
  const weights = getRegionWeights(instances);
  const regionNames = [...weights.keys()];

  if (!regionNames.length) {
    throw new Error("No supported AWS region data is available for scheduling.");
  }

  const window = getRecentNEMWindow();
  const regionResults = await Promise.all(regionNames.map(async (nemRegion) => {
    try {
      return {
        nemRegion,
        buckets: await getRegionData(nemRegion, window),
        error: null,
      };
    } catch (error) {
      return {
        nemRegion,
        buckets: [],
        error: error instanceof Error ? error.message : "Unable to read this NEM region.",
      };
    }
  }));
  const usableRegions = regionResults.filter((region) => region.buckets.length > 0);

  if (!usableRegions.length) {
    throw new Error(regionResults.map((region) => `${region.nemRegion}: ${region.error}`).join(" "));
  }

  const buckets = addComputeUsage(combineRegionalBuckets(usableRegions, weights), instances);
  const averageIntensity = getAverageIntensity(buckets);
  const recommendedWindow = findCleanestWindow(buckets, normalisedHours);
  if (!recommendedWindow) throw new Error("Open Electricity did not return enough contiguous hourly data for a recommendation.");

  const breakdown = buildInstanceBreakdown(instances);
  const regions = usableRegions.map((region) => ({
    nemRegion: region.nemRegion,
    weight: round(weights.get(region.nemRegion) || 0, 1),
    averageIntensity: round(getAverageIntensity(region.buckets), 1),
    currentIntensity: round(region.buckets.at(-1)?.intensity, 1),
    buckets: region.buckets,
  }));

  return {
    averageIntensity: round(averageIntensity, 1),
    buckets,
    breakdown,
    flexiblePercent: normalisedPercent,
    generatedAt: new Date().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    recommendedWindow: {
      ...recommendedWindow,
      savingIntensity: round(Math.max(0, averageIntensity - recommendedWindow.averageIntensity), 1),
    },
    regions,
    source: "Open Electricity hourly emissions, energy, and fueltech mix",
    window,
    windowHours: normalisedHours,
  };
}
