// Builds the single payload the dashboard runs on: one shared 24h timeline, one
// grid series per NEM region, and one hour-aligned power trace per workload.
// Everything downstream indexes by hour position, so no consumer has to re-derive
// which bucket lines up with which.

import {
  assumeCustomerRole,
  estimatePowerProfile,
  getAvailableRegions,
  getCpuBuckets,
  getInstanceTypeSpecs,
  listInstancesInRegion,
} from "@/lib/aws-carbon";
import { getRegionMeta } from "@/lib/aws-regions";
import { classifyWorkload } from "@/lib/classify";
import { getRegionGridData, getWindow } from "@/lib/grid-data";
import { findCleanestHour, findDirtiestHour } from "@/lib/optimiser";

function resolveProfile(instanceType, teadsProfiles, specs) {
  const teads = teadsProfiles.get(instanceType);
  if (teads) {
    return {
      idleWatts: Number(teads.idle_watts),
      maxWatts: Number(teads.max_watts),
      profileSource: "teads",
    };
  }

  const estimate = estimatePowerProfile(specs.get(instanceType));
  return {
    idleWatts: Number(estimate.idleWatts.toFixed(1)),
    maxWatts: Number(estimate.maxWatts.toFixed(1)),
    profileSource: estimate.source,
  };
}

export async function getFleet({ roleArn, externalId, profiles = [] }) {
  const window = getWindow();
  const { timeline } = window;
  const warnings = [];

  const credentials = await assumeCustomerRole(roleArn, externalId);
  const availableRegions = await getAvailableRegions(credentials);

  const inventories = await Promise.all(availableRegions.map(async (awsRegion) => {
    try {
      return await listInstancesInRegion(awsRegion, credentials);
    } catch (error) {
      warnings.push(`${awsRegion}: ${error instanceof Error ? error.message : "unable to read EC2."}`);
      return [];
    }
  }));

  const instances = inventories.flat();
  if (!instances.length) {
    return {
      demo: false,
      generatedAt: new Date().toISOString(),
      lookbackHours: timeline.length,
      timeline,
      regions: [],
      workloads: [],
      warnings: [...warnings, "No running EC2 instances were found in the NEM-mapped regions."],
    };
  }

  const teadsProfiles = new Map(profiles.map((profile) => [profile.instance_type, profile]));
  const activeAwsRegions = [...new Set(instances.map((instance) => instance.awsRegion))];

  const [cpuByRegion, specsByRegion] = await Promise.all([
    Promise.all(activeAwsRegions.map(async (awsRegion) => {
      const ids = instances.filter((instance) => instance.awsRegion === awsRegion).map((instance) => instance.id);
      try {
        return [awsRegion, await getCpuBuckets(awsRegion, ids, credentials, window.start, window.end)];
      } catch (error) {
        warnings.push(`${awsRegion}: ${error instanceof Error ? error.message : "unable to read CloudWatch."}`);
        return [awsRegion, new Map()];
      }
    })).then((entries) => new Map(entries)),
    Promise.all(activeAwsRegions.map(async (awsRegion) => {
      const missing = [...new Set(instances
        .filter((instance) => instance.awsRegion === awsRegion && !teadsProfiles.has(instance.instanceType))
        .map((instance) => instance.instanceType))];
      return [awsRegion, await getInstanceTypeSpecs(awsRegion, missing, credentials)];
    })).then((entries) => new Map(entries)),
  ]);

  const activeNemRegions = [...new Set(instances.map((instance) => instance.nemRegion).filter(Boolean))];
  const regionResults = await Promise.all(activeNemRegions.map(async (nemRegion) => {
    try {
      return { nemRegion, buckets: await getRegionGridData(nemRegion, window) };
    } catch (error) {
      warnings.push(`${nemRegion}: ${error instanceof Error ? error.message : "unable to read Open Electricity."}`);
      return { nemRegion, buckets: null };
    }
  }));

  const regions = regionResults
    .filter((result) => result.buckets)
    .map((result) => {
      const intensities = result.buckets.map((bucket) => bucket.intensity);
      const meta = getRegionMeta(result.nemRegion);
      return {
        nemRegion: result.nemRegion,
        awsRegion: meta?.awsRegion || null,
        city: meta?.city || result.nemRegion,
        buckets: result.buckets,
        intensities,
        averageIntensity: intensities.reduce((sum, value) => sum + value, 0) / intensities.length,
        cleanestHour: findCleanestHour(intensities),
        dirtiestHour: findDirtiestHour(intensities),
      };
    });

  if (!regions.length) {
    throw new Error(warnings.join(" ") || "No NEM grid data was available for your regions.");
  }

  const mappedRegions = new Set(regions.map((region) => region.nemRegion));
  const workloads = instances
    .filter((instance) => mappedRegions.has(instance.nemRegion))
    .map((instance) => {
      const profile = resolveProfile(instance.instanceType, teadsProfiles, specsByRegion.get(instance.awsRegion) || new Map());
      const cpuByHour = cpuByRegion.get(instance.awsRegion)?.get(instance.id) || new Map();

      const hours = timeline.map((timestamp) => {
        const cpu = cpuByHour.get(timestamp);
        const measured = Number.isFinite(cpu);
        const utilisation = measured ? Math.min(100, Math.max(0, cpu)) : 0;
        return {
          timestamp,
          cpu: Number(utilisation.toFixed(1)),
          // An hour with no datapoint still draws idle power — the instance is running.
          watts: Number((profile.idleWatts + (profile.maxWatts - profile.idleWatts) * (utilisation / 100)).toFixed(2)),
          measured,
        };
      });

      const cpuValues = hours.filter((hour) => hour.measured).map((hour) => hour.cpu);
      const classification = classifyWorkload({
        name: instance.name,
        instanceType: instance.instanceType,
        tags: instance.tags,
        cpuValues,
      });

      return {
        id: instance.id,
        name: instance.name,
        instanceType: instance.instanceType,
        awsRegion: instance.awsRegion,
        nemRegion: instance.nemRegion,
        ...profile,
        averageCpu: cpuValues.length ? cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length : 0,
        hours,
        ...classification,
      };
    });

  const estimatedCount = workloads.filter((workload) => workload.profileSource !== "teads").length;
  if (estimatedCount) {
    warnings.push(`${estimatedCount} instance type${estimatedCount === 1 ? "" : "s"} used an estimated power profile.`);
  }

  return {
    demo: false,
    generatedAt: new Date().toISOString(),
    lookbackHours: timeline.length,
    timeline,
    regions,
    workloads,
    warnings,
  };
}
