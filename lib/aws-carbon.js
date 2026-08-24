import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  AssumeRoleCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { OpenElectricityClient } from "openelectricity";
import { getNemRegion, SUPPORTED_AWS_REGIONS } from "@/lib/aws-regions";

const LOOKBACK_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

function getControlRegion() {
  return process.env.AWS_CONTROL_REGION || "ap-southeast-2";
}

export async function assumeCustomerRole(roleArn, externalId) {
  const sts = new STSClient({ region: getControlRegion() });
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: "LoadShiftReadOnly",
    ExternalId: externalId,
    DurationSeconds: 900,
  }));

  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
    throw new Error("AWS returned incomplete temporary credentials.");
  }

  return {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken,
  };
}

function createClients(region, credentials) {
  const config = { region, credentials };
  return {
    ec2: new EC2Client(config),
    cloudwatch: new CloudWatchClient(config),
  };
}

async function getAvailableRegions(credentials) {
  const ec2 = new EC2Client({ region: getControlRegion(), credentials });
  const { Regions = [] } = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  const enabled = new Set(Regions.map((region) => region.RegionName));
  return SUPPORTED_AWS_REGIONS.filter((region) => enabled.has(region));
}

async function listInstancesInRegion(region, credentials) {
  const { ec2 } = createClients(region, credentials);
  const instances = [];
  let nextToken;

  do {
    const response = await ec2.send(new DescribeInstancesCommand({
      NextToken: nextToken,
      Filters: [{ Name: "instance-state-name", Values: ["running"] }],
    }));

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        instances.push({
          id: instance.InstanceId,
          name: instance.Tags?.find((tag) => tag.Key === "Name")?.Value || instance.InstanceId,
          instanceType: instance.InstanceType,
          region,
          nemRegion: getNemRegion(region),
          launchTime: instance.LaunchTime,
        });
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return instances;
}

async function getCpuBuckets(region, instanceIds, credentials, startTime, endTime) {
  if (!instanceIds.length) return new Map();

  const { cloudwatch } = createClients(region, credentials);
  const metricQueries = instanceIds.map((instanceId, index) => ({
    Id: `cpu${index}`,
    MetricStat: {
      Metric: {
        Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
      },
      Period: 3600,
      Stat: "Average",
    },
    ReturnData: true,
  }));

  const { MetricDataResults = [] } = await cloudwatch.send(new GetMetricDataCommand({
    EndTime: endTime,
    MetricDataQueries: metricQueries,
    ScanBy: "TimestampAscending",
    StartTime: startTime,
  }));

  const byInstance = new Map();
  for (const result of MetricDataResults) {
    const index = Number(String(result.Id || "").replace("cpu", ""));
    if (!Number.isInteger(index) || !instanceIds[index]) continue;
    const buckets = (result.Timestamps || []).map((timestamp, timestampIndex) => ({
      timestamp: new Date(timestamp),
      cpuUtilisation: Number(result.Values?.[timestampIndex] || 0),
    }));
    byInstance.set(instanceIds[index], buckets);
  }

  return byInstance;
}

function toNaiveDateTime(date) {
  return date.toISOString().slice(0, 19);
}

function extractIntensitySeries(response) {
  const valuesByTimestamp = new Map();
  for (const series of response?.data || []) {
    for (const result of series.results || []) {
      for (const [interval, value] of result.data || []) {
        const timestamp = new Date(interval).getTime();
        const row = valuesByTimestamp.get(timestamp) || {};
        row[series.metric] = Number(value);
        valuesByTimestamp.set(timestamp, row);
      }
    }
  }

  return [...valuesByTimestamp.entries()]
    .map(([timestamp, row]) => ({
      timestamp,
      gramsPerKwh: row.energy > 0 && Number.isFinite(row.emissions)
        ? (row.emissions / row.energy) * 1000
        : null,
    }))
    .filter((row) => Number.isFinite(row.gramsPerKwh))
    .sort((left, right) => left.timestamp - right.timestamp);
}

async function getGridIntensity(nemRegion, startTime, endTime) {
  const apiKey = process.env.OPEN_ELECTRICITY_API_KEY || process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error("Missing OPEN_ELECTRICITY_API_KEY.");

  const client = new OpenElectricityClient({ apiKey });
  const { response } = await client.getNetworkData("NEM", ["emissions", "energy"], {
    dateStart: toNaiveDateTime(startTime),
    dateEnd: toNaiveDateTime(endTime),
    interval: "1h",
    network_region: nemRegion,
    primaryGrouping: "network_region",
  });

  return extractIntensitySeries(response);
}

function getClosestIntensity(series, timestamp) {
  if (!series.length) return null;
  let closest = series[0];
  for (const candidate of series) {
    if (Math.abs(candidate.timestamp - timestamp) < Math.abs(closest.timestamp - timestamp)) {
      closest = candidate;
    }
  }
  return Math.abs(closest.timestamp - timestamp) <= 2 * HOUR_MS ? closest.gramsPerKwh : null;
}

export function calculateInstanceCarbon(instance, cpuBuckets, profile, intensitySeries) {
  if (!profile || !cpuBuckets.length) {
    return { kilograms: null, kwh: null, buckets: 0 };
  }

  let kwh = 0;
  let grams = 0;
  let measuredBuckets = 0;
  for (const bucket of cpuBuckets) {
    const intensity = getClosestIntensity(intensitySeries, bucket.timestamp.getTime());
    if (!Number.isFinite(intensity)) continue;

    const cpuRatio = Math.min(100, Math.max(0, bucket.cpuUtilisation)) / 100;
    const watts = Number(profile.idle_watts) + (Number(profile.max_watts) - Number(profile.idle_watts)) * cpuRatio;
    const bucketKwh = (watts / 1000) * 1;
    kwh += bucketKwh;
    grams += bucketKwh * intensity;
    measuredBuckets += 1;
  }

  return {
    kilograms: grams / 1000,
    kwh,
    buckets: measuredBuckets,
    averageCpuUtilisation: cpuBuckets.reduce((sum, bucket) => sum + bucket.cpuUtilisation, 0) / cpuBuckets.length,
    instanceType: instance.instanceType,
  };
}

export async function getAwsInventory({ roleArn, externalId, profiles }) {
  const credentials = await assumeCustomerRole(roleArn, externalId);
  const availableRegions = await getAvailableRegions(credentials);
  const warnings = [];
  const unsupportedRegions = [];

  const regionResults = await Promise.all(availableRegions.map(async (region) => {
    try {
      const instances = await listInstancesInRegion(region, credentials);
      return { region, instances };
    } catch (error) {
      warnings.push(`${region}: ${error instanceof Error ? error.message : "Unable to read EC2."}`);
      return { region, instances: [] };
    }
  }));

  const instances = regionResults.flatMap((result) => result.instances);
  const profileByType = new Map((profiles || []).map((profile) => [profile.instance_type, profile]));
  const startTime = new Date(Date.now() - LOOKBACK_HOURS * HOUR_MS);
  const endTime = new Date();
  const intensityByRegion = new Map();
  const cpuByRegion = new Map();

  for (const region of availableRegions) {
    const regionInstances = instances.filter((instance) => instance.region === region);
    if (!regionInstances.length) continue;
    const nemRegion = getNemRegion(region);
    if (!nemRegion) {
      unsupportedRegions.push(region);
      continue;
    }

    try {
      intensityByRegion.set(region, await getGridIntensity(nemRegion, startTime, endTime));
      cpuByRegion.set(region, await getCpuBuckets(region, regionInstances.map((instance) => instance.id), credentials, startTime, endTime));
    } catch (error) {
      warnings.push(`${region}: ${error instanceof Error ? error.message : "Unable to read metrics."}`);
    }
  }

  const rows = instances.map((instance) => {
    const profile = profileByType.get(instance.instanceType);
    const carbon = calculateInstanceCarbon(
      instance,
      cpuByRegion.get(instance.region)?.get(instance.id) || [],
      profile,
      intensityByRegion.get(instance.region) || [],
    );
    return { ...instance, ...carbon, profileFound: Boolean(profile) };
  });

  return {
    instances: rows,
    warnings: [
      ...warnings,
      ...(unsupportedRegions.length ? [`No NEM mapping is configured for: ${unsupportedRegions.join(", ")}.`] : []),
      ...(rows.some((row) => !row.profileFound) ? ["Some instance types are missing from ec2_power_profiles."] : []),
    ],
    lookbackHours: LOOKBACK_HOURS,
    generatedAt: new Date().toISOString(),
  };
}
