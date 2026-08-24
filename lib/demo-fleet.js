// Deterministic sample fleet. Two jobs: it lets the 3D scene be tuned without an
// AWS round trip on every reload, and it gives anyone without an AWS account
// something real to explore.
//
// The grid curve is generated from a generation stack rather than hand-drawn, so
// intensity, fuel mix and the shape of the day stay consistent with each other.

import { getWindow } from "@/lib/grid-data";
import { classifyWorkload } from "@/lib/classify";
import { findCleanestHour, findDirtiestHour } from "@/lib/optimiser";

const AEST_OFFSET_HOURS = 10;

const REGION_MODEL = {
  NSW1: {
    awsRegion: "ap-southeast-2",
    city: "Sydney",
    peakDemand: 9200,
    baseDemand: 5800,
    coalCap: 6500,
    coalFactor: 0.9,
    solarPeak: 3200,
    windBase: 800,
    windSwing: 600,
    hydroPeak: 420,
    seed: 20260824,
  },
  VIC1: {
    awsRegion: "ap-southeast-4",
    city: "Melbourne",
    peakDemand: 6100,
    baseDemand: 3900,
    coalCap: 4300,
    coalFactor: 1.22,
    solarPeak: 1650,
    windBase: 1100,
    windSwing: 900,
    hydroPeak: 260,
    seed: 71104,
  },
};

const GAS_FACTOR = 0.52;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function localHour(timestamp) {
  return (new Date(timestamp).getUTCHours() + AEST_OFFSET_HOURS) % 24;
}

function solarShape(hour) {
  if (hour < 6 || hour > 19) return 0;
  return Math.max(0, Math.sin(((hour - 6) / 13) * Math.PI)) ** 1.3;
}

function demandShape(hour) {
  const morning = Math.exp(-(((hour - 8) / 2.4) ** 2)) * 0.55;
  const evening = Math.exp(-(((hour - 18.5) / 2.6) ** 2)) * 0.85;
  const daytime = Math.exp(-(((hour - 13) / 5.5) ** 2)) * 0.35;
  return Math.min(1, 0.28 + morning + evening + daytime);
}

function buildRegionBuckets(nemRegion, timeline) {
  const model = REGION_MODEL[nemRegion];
  const random = mulberry32(model.seed);
  const windWalk = [];
  let wind = 0.5;

  for (let index = 0; index < timeline.length; index += 1) {
    wind = Math.min(1, Math.max(0, wind + (random() - 0.5) * 0.28));
    windWalk.push(wind);
  }

  return timeline.map((timestamp, index) => {
    const hour = localHour(timestamp);
    const demand = model.baseDemand + (model.peakDemand - model.baseDemand) * demandShape(hour);

    const solar = model.solarPeak * solarShape(hour);
    const windGen = model.windBase + model.windSwing * windWalk[index];
    const hydro = model.hydroPeak * (0.35 + 0.65 * Math.exp(-(((hour - 18) / 3) ** 2)));
    const battery = hour >= 17 && hour <= 21 ? 90 + random() * 60 : 0;
    const bioenergy = 45;

    const cleanTotal = solar + windGen + hydro + battery + bioenergy;
    const residual = Math.max(0, demand - cleanTotal);
    const coal = Math.min(model.coalCap, residual);
    const gas = Math.max(0, residual - coal);
    const distillate = gas > 400 ? 25 : 0;

    const generation = { coal, gas, distillate, hydro, wind: windGen, solar, battery, bioenergy };
    const total = Object.values(generation).reduce((sum, value) => sum + value, 0);
    const emissions = coal * model.coalFactor + gas * GAS_FACTOR + distillate * 0.75;

    return {
      timestamp,
      intensity: Number(((emissions / total) * 1000).toFixed(1)),
      sourceMix: Object.fromEntries(
        Object.entries(generation)
          .map(([source, value]) => [source, Number(((value / total) * 100).toFixed(1))])
          .filter(([, percentage]) => percentage >= 0.5),
      ),
      estimated: false,
    };
  });
}

const POWER_PROFILES = {
  "c5.xlarge": { idleWatts: 12, maxWatts: 48 },
  "c5.2xlarge": { idleWatts: 22, maxWatts: 90 },
  "c5.4xlarge": { idleWatts: 38, maxWatts: 168 },
  "m5.large": { idleWatts: 9.6, maxWatts: 30 },
  "m5.xlarge": { idleWatts: 15, maxWatts: 58 },
  "m5.2xlarge": { idleWatts: 26, maxWatts: 104 },
  "r5.large": { idleWatts: 10, maxWatts: 34 },
  "r5.xlarge": { idleWatts: 16, maxWatts: 62 },
  "r5.2xlarge": { idleWatts: 26, maxWatts: 98 },
  "r5.4xlarge": { idleWatts: 48, maxWatts: 186 },
  "t3.large": { idleWatts: 6, maxWatts: 24 },
};

function burst(hours, { peak, base, spread = 1.2 }) {
  return (hour, random) => {
    const distance = Math.min(...hours.map((centre) => {
      const delta = Math.abs(hour - centre);
      return Math.min(delta, 24 - delta);
    }));
    const envelope = Math.exp(-((distance / spread) ** 2));
    return base + (peak - base) * envelope * (0.75 + random() * 0.35);
  };
}

function steady(level, jitter) {
  return (_hour, random) => Math.max(1, level + (random() - 0.5) * jitter);
}

function diurnal(peak, trough) {
  return (hour, random) => trough + (peak - trough) * demandShape(hour) * (0.9 + random() * 0.2);
}

// Six representative enterprise instances: always-on services alongside CI,
// analytics, rendering, and overnight batch work with different daily shapes.
const DEMO_GROUPS = [
  { name: "analytics-batch", type: "r5.2xlarge", region: "VIC1", count: 1, seed: 221, shape: burst([6, 7, 8], { peak: 78, base: 3, spread: 1.3 }) },
  { name: "api-prod", type: "m5.xlarge", region: "NSW1", count: 1, seed: 101, shape: steady(38, 10) },
  { name: "ci-runner", type: "c5.2xlarge", region: "NSW1", count: 1, seed: 151, shape: burst([9, 10, 11, 14, 15, 16, 17], { peak: 86, base: 3, spread: 2.1 }) },
  { name: "db-primary", type: "r5.4xlarge", region: "NSW1", count: 1, seed: 121, shape: steady(52, 8) },
  { name: "etl-nightly", type: "m5.2xlarge", region: "NSW1", count: 1, seed: 161, shape: burst([2, 3, 4], { peak: 93, base: 2, spread: 1.1 }) },
  { name: "render-node", type: "c5.4xlarge", region: "VIC1", count: 1, seed: 211, shape: burst([13, 19, 20, 21], { peak: 89, base: 4, spread: 1.6 }) },
];

function instanceId(seed, index) {
  const hex = ((seed * 7919 + index * 104729) >>> 0).toString(16).padStart(8, "0");
  return `i-0${hex}${((seed + index) % 16).toString(16)}${(index % 16).toString(16)}`;
}

const DEMO_WORKLOADS = DEMO_GROUPS.flatMap((group) =>
  Array.from({ length: group.count }, (_, index) => ({
    id: instanceId(group.seed, index),
    name: group.count === 1 ? group.name : `${group.name}-${String(index + 1).padStart(2, "0")}`,
    instanceType: group.type,
    nemRegion: group.region,
    seed: group.seed + index * 13,
    shape: group.shape,
  })));

export function buildDemoFleet() {
  const window = getWindow();
  const { timeline } = window;

  const regions = Object.keys(REGION_MODEL).map((nemRegion) => {
    const buckets = buildRegionBuckets(nemRegion, timeline);
    const intensities = buckets.map((bucket) => bucket.intensity);
    return {
      nemRegion,
      awsRegion: REGION_MODEL[nemRegion].awsRegion,
      city: REGION_MODEL[nemRegion].city,
      buckets,
      intensities,
      averageIntensity: intensities.reduce((sum, value) => sum + value, 0) / intensities.length,
      cleanestHour: findCleanestHour(intensities),
      dirtiestHour: findDirtiestHour(intensities),
    };
  });

  const workloads = DEMO_WORKLOADS.map((definition) => {
    const random = mulberry32(definition.seed);
    const profile = POWER_PROFILES[definition.instanceType];
    const hours = timeline.map((timestamp) => {
      const cpu = Math.min(100, Math.max(0, definition.shape(localHour(timestamp), random)));
      return {
        timestamp,
        cpu: Number(cpu.toFixed(1)),
        watts: Number((profile.idleWatts + (profile.maxWatts - profile.idleWatts) * (cpu / 100)).toFixed(2)),
      };
    });

    const cpuValues = hours.map((hour) => hour.cpu);
    const classification = classifyWorkload({
      name: definition.name,
      instanceType: definition.instanceType,
      tags: { Name: definition.name },
      cpuValues,
    });

    return {
      id: definition.id,
      name: definition.name,
      instanceType: definition.instanceType,
      awsRegion: REGION_MODEL[definition.nemRegion].awsRegion,
      nemRegion: definition.nemRegion,
      idleWatts: profile.idleWatts,
      maxWatts: profile.maxWatts,
      profileSource: "teads",
      averageCpu: cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length,
      hours,
      ...classification,
    };
  });

  return {
    demo: true,
    generatedAt: new Date().toISOString(),
    lookbackHours: timeline.length,
    timeline,
    regions,
    workloads,
    warnings: [],
  };
}
