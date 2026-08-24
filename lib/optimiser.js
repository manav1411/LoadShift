// Pure, isomorphic. Runs on the client on every slider tick, so it must stay cheap
// and must never reach for the network.
//
// The model, stated plainly:
//   * Only workloads classified as flexible move at all. Always-on services stay put.
//   * Within a flexible workload, only its *active* hours move — an hour where the
//     instance is doing real work rather than sitting near its idle floor.
//   * An active hour moves in full, machine and all: rescheduling a batch job moves
//     the instance that runs it, not just the watts above idle.
//   * Genuinely idle hours stay where they are. An idling box is a rightsizing
//     problem, not a scheduling one, and pretending otherwise would invent savings.
//   * Work only moves *forward*, and only as far as the user says it can wait.
//   * The 24h window wraps, because the NEM's shape is a daily cycle: hour 23 + 3h
//     lands on hour 2 of a day that looks like the one we just measured.

const KM_PER_KG_CO2 = 5.9; // average AU passenger vehicle, ~170 gCO2e/km

// How far above its idle floor an instance must draw before the hour counts as work.
const ACTIVE_MULTIPLIER = 1.15;

export function findBestTargets(intensities, delayHours) {
  const count = intensities.length;
  const reach = Math.max(0, Math.min(delayHours, count - 1));
  const targets = new Array(count);

  for (let hour = 0; hour < count; hour += 1) {
    let bestIndex = hour;
    let bestIntensity = intensities[hour];

    for (let step = 1; step <= reach; step += 1) {
      const candidate = (hour + step) % count;
      if (intensities[candidate] < bestIntensity) {
        bestIntensity = intensities[candidate];
        bestIndex = candidate;
      }
    }

    targets[hour] = bestIndex;
  }

  return targets;
}

function optimiseWorkload(workload, intensities, targets, isShiftable) {
  const count = intensities.length;
  const baselineLoad = new Array(count).fill(0);
  const optimisedLoad = new Array(count).fill(0);
  const movements = [];
  const activeFloor = workload.idleWatts * ACTIVE_MULTIPLIER;
  let baselineGrams = 0;
  let optimisedGrams = 0;
  let energyKwh = 0;
  let shiftableKwh = 0;
  let activeHours = 0;

  for (let hour = 0; hour < count; hour += 1) {
    const intensity = intensities[hour];
    if (!Number.isFinite(intensity)) continue;

    const watts = Math.max(0, Number(workload.hours?.[hour]?.watts) || 0);
    baselineLoad[hour] = watts;
    energyKwh += watts / 1000;
    baselineGrams += (watts / 1000) * intensity;

    const isActive = watts > activeFloor;
    if (isActive) activeHours += 1;

    if (isShiftable && isActive) {
      const target = targets[hour];
      shiftableKwh += watts / 1000;
      optimisedLoad[target] += watts;
      optimisedGrams += (watts / 1000) * intensities[target];
      if (target !== hour) movements.push({ from: hour, to: target, watts });
    } else {
      optimisedLoad[hour] += watts;
      optimisedGrams += (watts / 1000) * intensity;
    }
  }

  return {
    baselineKg: baselineGrams / 1000,
    optimisedKg: optimisedGrams / 1000,
    savedKg: Math.max(0, (baselineGrams - optimisedGrams) / 1000),
    energyKwh,
    shiftableKwh,
    activeHours,
    baselineLoad,
    optimisedLoad,
    movements,
  };
}

function sumSeries(target, source) {
  for (let index = 0; index < source.length; index += 1) target[index] += source[index];
}

/**
 * @param regions  [{ nemRegion, intensities: number[] }]
 * @param workloads [{ id, nemRegion, idleWatts, hours: [{ watts }] , shiftable }]
 * @param delayHoursByWorkload workloadId -> how long that workload's flexible hours can wait
 * @param defaultDelayHours fallback for any workload not present in delayHoursByWorkload
 */
export function optimiseFleet({ regions = [], workloads = [], delayHoursByWorkload = {}, defaultDelayHours = 6 }) {
  const intensityByRegion = new Map(regions.map((region) => [region.nemRegion, region.intensities]));
  const targetsCache = new Map();

  function getTargets(nemRegion, delay) {
    const key = `${nemRegion}:${delay}`;
    if (!targetsCache.has(key)) {
      targetsCache.set(key, findBestTargets(intensityByRegion.get(nemRegion), delay));
    }
    return targetsCache.get(key);
  }

  const hourCount = regions[0]?.intensities.length || 0;

  const baselineLoad = new Array(hourCount).fill(0);
  const optimisedLoad = new Array(hourCount).fill(0);
  const movementsByRegion = new Map(regions.map((region) => [region.nemRegion, []]));

  let baselineKg = 0;
  let optimisedKg = 0;
  let shiftableKwh = 0;
  let energyKwh = 0;

  const results = workloads.map((workload) => {
    const intensities = intensityByRegion.get(workload.nemRegion);
    const delay = delayHoursByWorkload[workload.id] ?? defaultDelayHours;
    const targets = intensities ? getTargets(workload.nemRegion, delay) : null;
    if (!intensities || !targets) return { ...workload, savedKg: 0, baselineKg: 0, optimisedKg: 0 };

    // The user's per-instance delay is the source of truth. Zero means the
    // workload must run in its current hour; any positive value allows active
    // hours to move forward within that many hours.
    const isShiftable = delay > 0;
    const result = optimiseWorkload(workload, intensities, targets, isShiftable);

    baselineKg += result.baselineKg;
    optimisedKg += result.optimisedKg;
    shiftableKwh += result.shiftableKwh;
    energyKwh += result.energyKwh;
    sumSeries(baselineLoad, result.baselineLoad);
    sumSeries(optimisedLoad, result.optimisedLoad);
    movementsByRegion.get(workload.nemRegion).push(...result.movements);

    return { ...workload, ...result, shiftable: isShiftable };
  });

  // Movements from every workload in a region share the same target mapping, so they
  // collapse into one parcel per source hour without loss — which is what the 3D scene animates.
  const parcels = [];
  for (const [nemRegion, movements] of movementsByRegion) {
    const byHour = new Map();
    for (const movement of movements) {
      const existing = byHour.get(movement.from) || { from: movement.from, to: movement.to, watts: 0 };
      existing.watts += movement.watts;
      byHour.set(movement.from, existing);
    }
    for (const parcel of byHour.values()) parcels.push({ ...parcel, nemRegion });
  }
  parcels.sort((left, right) => left.from - right.from);

  const savedKg = Math.max(0, baselineKg - optimisedKg);

  return {
    baselineKg,
    optimisedKg,
    savedKg,
    savedPercent: baselineKg > 0 ? (savedKg / baselineKg) * 100 : 0,
    equivalentKm: savedKg * KM_PER_KG_CO2,
    // The recommendation is a daily cron, so the saving recurs. Annualising is the
    // honest unit for it — not a projection, just the same day repeated.
    savedKgPerYear: savedKg * 365,
    equivalentKmPerYear: savedKg * 365 * KM_PER_KG_CO2,
    energyKwh,
    shiftableKwh,
    baselineLoad,
    optimisedLoad,
    parcels,
    workloads: results.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function findCleanestHour(intensities) {
  let bestIndex = 0;
  for (let index = 1; index < intensities.length; index += 1) {
    if (intensities[index] < intensities[bestIndex]) bestIndex = index;
  }
  return bestIndex;
}

export function findDirtiestHour(intensities) {
  let worstIndex = 0;
  for (let index = 1; index < intensities.length; index += 1) {
    if (intensities[index] > intensities[worstIndex]) worstIndex = index;
  }
  return worstIndex;
}
